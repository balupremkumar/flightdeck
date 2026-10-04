// ports.rs — H6: listening TCP ports owned by a workspace's pane process trees,
// plus the guarded kill, and the bounded subprocess helper shared with ghpr.rs.
//
// Listeners come from `netstat -ano -p TCP` (parsed, bounded by a timeout, off
// the main thread via `#[tauri::command(async)]`). Ownership is always decided
// in Rust from the live pane roots: the frontend only names pane model ids.

use serde::Serialize;
use std::io::Read;
use std::time::{Duration, Instant};
use tauri::State;

use crate::{orphans, paneout, procname, Registry};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub port: u16,
    pub pid: u32,
    pub process_name: String,
    pub pane_id: u32,
}

/// Run `cmd`, returning stdout if it exits successfully within `limit`.
/// The child is killed on timeout. Output is capped so a runaway cannot balloon.
pub(crate) fn run_bounded(mut cmd: std::process::Command, limit: Duration) -> Option<String> {
    use std::process::Stdio;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(4 * 1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes = reader.join().ok()?;
    if ok { Some(String::from_utf8_lossy(&bytes).into_owned()) } else { None }
}

/// Parse `netstat -ano -p TCP` into (port, pid) for listening sockets.
/// Locale-proof: a listener is a 5-column TCP row whose foreign address ends `:0`.
pub fn parse_netstat(text: &str) -> Vec<(u16, u32)> {
    let mut out: Vec<(u16, u32)> = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() != 5 || !cols[0].eq_ignore_ascii_case("TCP") || !cols[2].ends_with(":0") {
            continue;
        }
        let Some(port) = cols[1].rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else { continue };
        let Some(pid) = cols[4].parse::<u32>().ok() else { continue };
        if port == 0 || pid == 0 || out.contains(&(port, pid)) {
            continue;
        }
        out.push((port, pid));
    }
    out
}

/// Listeners that belong to one of `roots` (pane_id, root_pid) trees. Pure.
pub fn owned_ports(
    listeners: &[(u16, u32)],
    roots: &[(u32, u32)],
    all: &[(u32, u32, String)],
) -> Vec<PortInfo> {
    let mut out: Vec<PortInfo> = Vec::new();
    for (pane_id, root) in roots {
        let tree = orphans::descendants(&[*root], all);
        for (port, pid) in listeners {
            if !tree.contains(pid) || out.iter().any(|p| p.port == *port && p.pid == *pid) {
                continue;
            }
            let name = all
                .iter()
                .find(|(p, _, _)| p == pid)
                .map(|(_, _, n)| procname::normalize(n))
                .unwrap_or_default();
            out.push(PortInfo { port: *port, pid: *pid, process_name: name, pane_id: *pane_id });
        }
    }
    out.sort_by_key(|p| p.port);
    out
}

/// A pid may be killed only if it is strictly inside a pane tree (never a pane's own root).
pub fn may_kill(pid: u32, roots: &[u32], all: &[(u32, u32, String)]) -> bool {
    !roots.contains(&pid) && orphans::descendants(roots, all).contains(&pid)
}

fn pane_roots(reg: &Registry, pane_ids: &[u32]) -> Vec<(u32, u32)> {
    let ptys: Vec<(u32, u32)> = {
        let bm = paneout::lock_map(&reg.by_model);
        pane_ids.iter().filter_map(|m| bm.get(*m).map(|e| (*m, e.pty_id))).collect()
    };
    let panes = reg.panes.lock().unwrap();
    ptys.into_iter()
        .filter_map(|(m, pty)| panes.get(&pty).and_then(|p| p.child.process_id()).map(|pid| (m, pid)))
        .collect()
}

fn listeners() -> Vec<(u16, u32)> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("netstat");
        cmd.args(["-ano", "-p", "TCP"]);
        run_bounded(cmd, Duration::from_secs(5)).map(|t| parse_netstat(&t)).unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command(async)]
pub fn workspace_ports(reg: State<Registry>, pane_ids: Vec<u32>) -> Vec<PortInfo> {
    let roots = pane_roots(&reg, &pane_ids);
    if roots.is_empty() {
        return Vec::new();
    }
    owned_ports(&listeners(), &roots, &orphans::snapshot_processes())
}

#[tauri::command(async)]
pub fn kill_port_process(reg: State<Registry>, pane_ids: Vec<u32>, pid: u32) -> Result<(), String> {
    let roots: Vec<u32> = pane_roots(&reg, &pane_ids).into_iter().map(|(_, r)| r).collect();
    if !may_kill(pid, &roots, &orphans::snapshot_processes()) {
        return Err("That process does not belong to this workspace's panes.".into());
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        run_bounded(cmd, Duration::from_secs(10)).ok_or_else(|| "taskkill failed".to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NETSTAT: &str = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       300
  TCP    [::1]:5173             [::]:0                 LISTENING       300
  TCP    [::]:3000              [::]:0                 ABHOEREN        400
  TCP    127.0.0.1:5173         127.0.0.1:51000        ESTABLISHED     300
  UDP    0.0.0.0:5353           *:*                                    1000
  TCP    garbage
";

    fn snap() -> Vec<(u32, u32, String)> {
        vec![
            (100, 1, "pwsh.exe".into()),
            (200, 100, "cmd.exe".into()),
            (300, 200, "node.exe".into()),
            (400, 1, "other.exe".into()),
            (1000, 1, "svchost.exe".into()),
        ]
    }

    #[test]
    fn parses_listeners_dedupes_and_skips_noise() {
        assert_eq!(parse_netstat(NETSTAT), vec![(135, 1000), (5173, 300), (3000, 400)]);
        assert!(parse_netstat("").is_empty());
    }

    #[test]
    fn only_pane_tree_ports_are_returned_with_names() {
        let l = parse_netstat(NETSTAT);
        let got = owned_ports(&l, &[(7, 100)], &snap());
        assert_eq!(got, vec![PortInfo { port: 5173, pid: 300, process_name: "node".into(), pane_id: 7 }]);
        assert!(owned_ports(&l, &[], &snap()).is_empty());
    }

    #[test]
    fn kill_ownership_refuses_outsiders_and_pane_roots() {
        let all = snap();
        assert!(may_kill(300, &[100], &all));
        assert!(!may_kill(400, &[100], &all), "unrelated process");
        assert!(!may_kill(100, &[100], &all), "the pane's own root");
        assert!(!may_kill(300, &[], &all), "no panes, no kills");
    }
}
