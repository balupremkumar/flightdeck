// orphans.rs — "recover orphaned processes" (203). Finds stray process trees
// whose root image name matches a vendor's `root_exe()` (pwsh.exe, agy.exe,
// cmd.exe, bash.exe, wsl.exe — kept in sync with the vendor registry rather
// than a separate hand-maintained list) but which aren't a descendant of any
// currently live pane. Best-effort heuristic, not a guarantee: two Flightdeck
// windows, or a manually-opened pwsh the user is using for something else,
// can share the same image name and would show up here too — this is a
// human-in-the-loop recovery tool, not an automatic reaper.

use std::collections::HashSet;

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

// pub(crate): also reused by procname.rs's foreground-process sampler, which
// shares one snapshot per tick across panes rather than duplicating the
// toolhelp walk.
#[cfg(windows)]
pub(crate) fn snapshot_processes() -> Vec<(u32, u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return out;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                out.push((entry.th32ProcessID, entry.th32ParentProcessID, name));

                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snap);
    }
    out
}

#[cfg(not(windows))]
pub(crate) fn snapshot_processes() -> Vec<(u32, u32, String)> {
    Vec::new()
}

// Every pid transitively descended from `roots` (inclusive) — these are
// "known", i.e. owned by a live pane, and never candidates.
fn descendants(roots: &[u32], all: &[(u32, u32, String)]) -> HashSet<u32> {
    let mut known: HashSet<u32> = roots.iter().copied().collect();
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, ppid, _) in all {
            if known.contains(ppid) && !known.contains(pid) {
                known.insert(*pid);
                changed = true;
            }
        }
    }
    known
}

/// `root_pids` = live panes' process ids (and their descendants are excluded
/// too). `vendor_exe_names` = lowercased root image names to look for
/// (`vendors::registry().iter().map(|v| v.root_exe())`).
pub fn find_orphans(root_pids: &[u32], vendor_exe_names: &HashSet<String>) -> Vec<OrphanInfo> {
    let all = snapshot_processes();
    let known = descendants(root_pids, &all);

    let candidate_pids: HashSet<u32> = all
        .iter()
        .filter(|(pid, _, name)| !known.contains(pid) && vendor_exe_names.contains(&name.to_lowercase()))
        .map(|(pid, _, _)| *pid)
        .collect();

    // Only surface tree roots among the candidates (a candidate whose parent
    // is also a candidate is a child of an already-reported tree).
    all.into_iter()
        .filter(|(pid, ppid, _)| candidate_pids.contains(pid) && !candidate_pids.contains(ppid))
        .map(|(pid, ppid, name)| OrphanInfo { pid, ppid, name })
        .collect()
}
