// Flightdeck — Phase 0 spike: PTY host over portable-pty (ConPTY on Windows).
// Passthrough only: spawns the real interactive CLIs, inherits the user's normal
// environment (so ~/.claude, ~/.gemini, CLAUDE.md etc. resolve exactly as in a
// VS Code terminal), and strips only cross-vendor API keys so auth stays on the
// subscription. No API keys, no headless mode.

mod gitstatus;
mod health;
mod job;
mod orphans;
mod persist;
mod support;
mod vendors;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

struct Pane {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    vendor: String,
    cwd: String,
    // Health sampling (202) baseline: previous cumulative CPU time (100ns
    // units) and the wall-clock timestamp of that sample, so pane_health can
    // compute a CPU% delta between polls. 0/0 until first sampled.
    last_cpu_100ns: AtomicU64,
    last_sample_ms: AtomicU64,
}

#[derive(Default)]
struct Registry {
    panes: Mutex<HashMap<u32, Pane>>,
    next_id: Mutex<u32>,
}

#[derive(Clone, Serialize)]
struct OutputPayload {
    pane_id: u32,
    b64: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    pane_id: u32,
    crashed: bool,
}

#[derive(Clone, Serialize)]
struct StatePayload {
    pane_id: u32,
    state: String,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Serialize)]
struct Entry {
    name: String,
    dir: bool,
}

// First-run detection + the frontend's single source of truth for which
// agents/shells exist. Env stripping now lives per-adapter in vendors.rs
// (BASE_ENV_STRIP + PROXY_ENV_STRIP), enforced by its conformance tests.
#[tauri::command]
fn detect_vendors() -> Vec<vendors::VendorInfo> {
    vendors::detect()
}

fn build_command(vendor: &str, cwd: &str) -> CommandBuilder {
    let adapter = vendors::find(vendor);
    let mut cmd = adapter.command(cwd);
    for k in adapter.env_strip() {
        cmd.env_remove(k);
    }
    // Force colour: Node-based CLIs (claude) and others suppress ANSI colour unless
    // the environment advertises a colour TTY, which a ConPTY doesn't always trip.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_COLOR", "3");
    cmd.env("CLICOLOR_FORCE", "1");
    cmd
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    reg: State<Registry>,
    vendor: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let adapter = vendors::find(&vendor);
    adapter.prepare(&cwd);
    let cmd = build_command(&vendor, &cwd);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    drop(pair.slave); // close our slave handle so the reader sees EOF on child exit

    // Windows Job Object (R2): join the shared job so this tree is reaped even
    // if Flightdeck.exe itself hard-crashes. Clean-exit reaping (below /
    // RunEvent::ExitRequested) already covers the graceful-shutdown path.
    if let Some(pid) = child.process_id() {
        job::assign(pid);
    }

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = {
        let mut n = reg.next_id.lock().unwrap();
        *n += 1;
        *n
    };

    // Activity-based status: the reader marks the pane "running" on output; a monitor
    // thread flips it to "waiting" after a quiet spell (agent idle, likely awaiting
    // input). Vendor-agnostic v1; pattern-based per-vendor detection is a later refinement.
    let last = std::sync::Arc::new(AtomicU64::new(now_ms()));
    let waiting = std::sync::Arc::new(AtomicU8::new(0)); // 0 = running, 1 = waiting
    let alive = std::sync::Arc::new(AtomicBool::new(true));

    // Reader thread: blocking read -> base64 -> Tauri event, plus activity bookkeeping.
    let (app_r, last_r, waiting_r, alive_r) = (app.clone(), last.clone(), waiting.clone(), alive.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    last_r.store(now_ms(), Ordering::Relaxed);
                    if waiting_r.swap(0, Ordering::Relaxed) != 0 {
                        let _ = app_r.emit("pty://state", StatePayload { pane_id: id, state: "running".into() });
                    }
                    let b64 = STANDARD.encode(&buf[..n]);
                    let _ = app_r.emit("pty://output", OutputPayload { pane_id: id, b64 });
                }
                Err(_) => break,
            }
        }
        alive_r.store(false, Ordering::Relaxed);
        // Natural-exit path (pty_kill is NOT called here): read the child's exit
        // status to tell a crash from a clean quit, prune the dead pane from the
        // registry so its master/writer/child handles don't leak, then notify.
        let reg = app_r.state::<Registry>();
        let crashed = {
            let mut panes = reg.panes.lock().unwrap();
            let crashed = panes
                .get_mut(&id)
                .and_then(|p| p.child.try_wait().ok().flatten())
                .map(|status| !status.success())
                .unwrap_or(false);
            panes.remove(&id);
            crashed
        };
        let _ = app_r.emit("pty://exit", ExitPayload { pane_id: id, crashed });
    });

    // Monitor thread: emit "waiting" once output has been quiet past the threshold.
    let (app_m, last_m, waiting_m, alive_m) = (app.clone(), last.clone(), waiting.clone(), alive.clone());
    std::thread::spawn(move || {
        const QUIET_MS: u64 = 3000;
        loop {
            std::thread::sleep(Duration::from_millis(700));
            if !alive_m.load(Ordering::Relaxed) {
                break;
            }
            let quiet_for = now_ms().saturating_sub(last_m.load(Ordering::Relaxed));
            if quiet_for > QUIET_MS && waiting_m.swap(1, Ordering::Relaxed) == 0 {
                let _ = app_m.emit("pty://state", StatePayload { pane_id: id, state: "waiting".into() });
            }
        }
    });

    reg.panes.lock().unwrap().insert(
        id,
        Pane {
            master: pair.master,
            writer,
            child,
            vendor,
            cwd,
            last_cpu_100ns: AtomicU64::new(0),
            last_sample_ms: AtomicU64::new(0),
        },
    );
    Ok(id)
}

#[tauri::command]
fn pty_write(reg: State<Registry>, pane_id: u32, data: String) -> Result<(), String> {
    let mut panes = reg.panes.lock().unwrap();
    if let Some(p) = panes.get_mut(&pane_id) {
        p.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        p.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(reg: State<Registry>, pane_id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let panes = reg.panes.lock().unwrap();
    if let Some(p) = panes.get(&pane_id) {
        p.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Kill a pane's whole process tree and drop its handles. Node-based CLIs
// (claude/agy/kimi) spawn children that child.kill() alone would orphan, so we
// taskkill /T the tree. Idempotent: a pane already pruned (natural exit) is a no-op.
fn reap_pane(reg: &Registry, pane_id: u32) {
    if let Some(mut p) = reg.panes.lock().unwrap().remove(&pane_id) {
        let pid = p.child.process_id();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            if let Some(pid) = pid {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .output();
            }
        }
        let _ = pid;
        let _ = p.child.kill();
    }
}

#[tauri::command]
fn pty_kill(reg: State<Registry>, pane_id: u32) -> Result<(), String> {
    reap_pane(reg.inner(), pane_id);
    Ok(())
}

// One-level directory listing for the Explorer sidebar (folders first, then files).
#[tauri::command]
fn fs_list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let e = e.map_err(|x| x.to_string())?;
        let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            dir,
        });
    }
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

// Per-pane health metrics (202): pid, CPU%, memory. CPU% is a delta between
// this call and the previous one, so the first poll for a pane always reads 0.
#[tauri::command]
fn pane_health(reg: State<Registry>) -> Vec<health::PaneHealth> {
    let panes = reg.panes.lock().unwrap();
    let now = now_ms();
    let mut out = Vec::new();
    for (id, p) in panes.iter() {
        let Some(pid) = p.child.process_id() else { continue };
        let Some((cpu_100ns, mem_bytes)) = health::sample(pid) else { continue };
        let last_cpu = p.last_cpu_100ns.swap(cpu_100ns, Ordering::Relaxed);
        let last_ts = p.last_sample_ms.swap(now, Ordering::Relaxed);
        let cpu_percent = if last_ts == 0 {
            0.0
        } else {
            let elapsed_ms = now.saturating_sub(last_ts).max(1) as f64;
            let delta_100ns = cpu_100ns.saturating_sub(last_cpu) as f64;
            (delta_100ns / 10_000.0 / elapsed_ms) * 100.0
        };
        out.push(health::PaneHealth {
            pane_id: *id,
            pid,
            cpu_percent,
            memory_mb: mem_bytes as f64 / (1024.0 * 1024.0),
        });
    }
    out
}

// "Recover orphaned processes" (203): stray claude/agy/pwsh/shell trees not
// owned by any live pane.
#[tauri::command]
fn recover_orphans(reg: State<Registry>) -> Vec<orphans::OrphanInfo> {
    let root_pids: Vec<u32> = {
        let panes = reg.panes.lock().unwrap();
        panes.values().filter_map(|p| p.child.process_id()).collect()
    };
    let names: std::collections::HashSet<String> =
        vendors::registry().iter().map(|v| v.root_exe().to_lowercase()).collect();
    orphans::find_orphans(&root_pids, &names)
}

// Kills the given (orphaned) process trees. Best-effort per pid; a pid that's
// already gone or fails to kill doesn't fail the whole batch.
#[tauri::command]
fn kill_orphans(pids: Vec<u32>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for pid in pids {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pids;
    }
    Ok(())
}

// Redacted support bundle export (204/159) — see support.rs.
#[tauri::command]
fn export_support_bundle(app: AppHandle, reg: State<Registry>, dest_path: String) -> Result<(), String> {
    let panes: Vec<support::SupportPaneInput> = {
        let panes = reg.panes.lock().unwrap();
        panes
            .iter()
            .map(|(id, p)| support::SupportPaneInput {
                pane_id: *id,
                vendor: p.vendor.clone(),
                cwd: p.cwd.clone(),
                pid: p.child.process_id(),
            })
            .collect()
    };
    let json = support::build_bundle(&app.package_info().version.to_string(), panes)?;
    std::fs::write(&dest_path, json).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Registry::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            fs_list_dir,
            detect_vendors,
            pane_health,
            recover_orphans,
            kill_orphans,
            export_support_bundle,
            gitstatus::git_status,
            persist::save_session,
            persist::load_session,
            persist::has_previous_session,
            persist::is_safe_mode,
            persist::list_restore_points,
            persist::restore_from_point,
            persist::export_backup,
            persist::import_backup,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Reap every live pane's process tree when the app is asked to exit, so
        // closing the window never leaves orphaned claude/agy/pwsh trees running.
        if let RunEvent::ExitRequested { .. } = event {
            let reg = app_handle.state::<Registry>();
            let ids: Vec<u32> = reg.panes.lock().unwrap().keys().copied().collect();
            for id in ids {
                reap_pane(reg.inner(), id);
            }
        }
    });
}
