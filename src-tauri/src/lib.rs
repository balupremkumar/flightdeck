// Flightdeck — Phase 0 spike: PTY host over portable-pty (ConPTY on Windows).
// Passthrough only: spawns the real interactive CLIs, inherits the user's normal
// environment (so ~/.claude, ~/.gemini, CLAUDE.md etc. resolve exactly as in a
// VS Code terminal), and strips only cross-vendor API keys so auth stays on the
// subscription. No API keys, no headless mode.

mod applog;
mod canary;
mod chatlog;
mod codexsessions;
mod doctor;
mod editor;
mod gitstatus;
mod health;
mod hooks;
mod job;
mod orphans;
mod oscprogress;
mod outbuf;
mod paneout;
mod pathcheck;
mod pathguard;
mod overlay;
mod persist;
mod procname;
mod readscope;
mod reveal;
mod ring;
mod shellmarks;
mod summon;
mod support;
mod updates;
mod usage;
mod vendors;
mod worktree;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

pub(crate) struct Pane {
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
    // Live foreground process name (procname.rs), kept so pane_health can
    // report it and the sampler can diff against it to avoid event spam.
    proc_name: Mutex<String>,
    // Claude session pin/resolve state (chatlog.rs).
    session: Mutex<chatlog::SessionState>,
    // Replay ring + buffer-only switch (paneout.rs). Shared with the pty threads.
    out: std::sync::Arc<Mutex<paneout::PaneOut>>,
}

#[derive(Default)]
pub(crate) struct Registry {
    panes: Mutex<HashMap<u32, Pane>>,
    next_id: Mutex<u32>,
    // PaneModel id -> live pty (paneout.rs); what pty_attach answers from.
    by_model: Mutex<paneout::ByModel>,
    // Bumped on every main-webview load; a reaper pass only acts if it is still
    // the latest load when its grace period ends.
    load_gen: AtomicU64,
}

#[derive(Clone, Serialize)]
struct OutputPayload {
    pane_id: u32,
    b64: String,
    /// Ring seq after this chunk. A chunk is inside a pty_attach snapshot iff
    /// seq <= snapshot.next_seq.
    seq: u64,
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

#[derive(Clone, Serialize)]
struct ProcPayload {
    pane_id: u32,
    name: String,
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
#[tauri::command(async)]
fn detect_vendors() -> Vec<vendors::VendorInfo> {
    vendors::detect()
}

// The user-facing manifest folder (#218): where JSON vendor files live. The
// Settings > Agents "Open vendors folder" button reveals it.
#[tauri::command(async)]
fn manifest_problems() -> Vec<vendors::ManifestProblem> {
    vendors::manifest_problems()
}

#[tauri::command]
fn vendors_dir() -> Option<String> {
    vendors::manifest_dir().map(|p| p.to_string_lossy().into_owned())
}

fn build_command(
    vendor: &str,
    cwd: &str,
    setup: Option<&str>,
    focus_mode: bool,
) -> (CommandBuilder, chatlog::SessionPlan) {
    let adapter = vendors::find(vendor);
    // QL-764: one-shot args staged by the session launcher for this exact spawn
    // (`--resume <id>`, optionally `--fork-session`). Empty for every ordinary
    // launch — see usage.rs for why the handoff lives there. Applied to the
    // vendor's own command BEFORE any setup wrapper, so the args reach the
    // agent rather than the pwsh wrapper.
    let mut base = adapter.command(cwd);
    let staged = usage::take_launch_args(vendor, cwd);
    let plan = chatlog::plan_session(vendor, &staged, &chatlog::new_uuid_v4());
    for a in &plan.extra_args {
        base.arg(a);
    }
    // TN5: pin Claude's view (focus vs default) via a Flightdeck-owned settings
    // file. Skipped if the launch already carries its own --settings.
    if vendor == "claude" {
        let has_settings = base.get_argv().iter().any(|a| {
            let a = a.to_string_lossy();
            a == "--settings" || a.starts_with("--settings=")
        });
        if !has_settings {
            if let Some(args) = chatlog::view_settings_args(focus_mode) {
                base.args(args);
            }
        }
    }
    let mut cmd = match setup.map(str::trim).filter(|s| !s.is_empty()) {
        // Worktree setup phase (Tier 0 follow-up): run e.g. `npm ci` in the
        // fresh worktree, then launch the vendor; failure never starts the agent.
        Some(s) => vendors::wrap_with_setup(&base, s, cwd),
        None => base,
    };
    // QL-752: shell integration (OSC 133 command marks + OSC 9;9 cwd) for an
    // interactive PowerShell pane. shellmarks owns the whole decision — it only
    // wraps a pwsh with NO arguments, so an agent launched through pwsh (and
    // the setup wrapper above, which is also argv-heavy) is never touched and
    // can never be double-marked against its own sequences.
    shellmarks::inject(&mut cmd);
    for k in adapter.env_strip() {
        cmd.env_remove(k);
    }
    // Force colour: Node-based CLIs (claude) and others suppress ANSI colour unless
    // the environment advertises a colour TTY, which a ConPTY doesn't always trip.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_COLOR", "3");
    cmd.env("CLICOLOR_FORCE", "1");
    if vendor == "claude" {
        for (k, v) in chatlog::claude_env(focus_mode) {
            cmd.env(k, v);
        }
    }
    (cmd, plan)
}

#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    reg: State<'_, Registry>,
    model_id: u32,
    gen: String,
    vendor: String,
    cwd: String,
    cols: u16,
    rows: u16,
    setup: Option<String>,
    focus_mode: Option<bool>,
) -> Result<u32, String> {
    crate::pathguard::check(&cwd)?;
    // prepare() reads/parses/rewrites a vendor config (e.g. codex config.toml),
    // so it runs off the main thread. It is awaited before openpty/spawn_command,
    // so trust is still in place before the agent starts, and nothing else here
    // (id allocation, registry insert) moves: ordering is unchanged.
    {
        let (v, c) = (vendor.clone(), cwd.clone());
        tauri::async_runtime::spawn_blocking(move || vendors::find(&v).prepare(&c))
            .await
            .map_err(|e| e.to_string())?;
    }
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
    let spawn_ms = now_ms();
    let (cmd, plan) = build_command(&vendor, &cwd, setup.as_deref(), focus_mode.unwrap_or(false));
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

    // Live foreground process name (audit item): the root name is known
    // immediately (the vendor's own root_exe), before the sampler's first
    // tick ever runs.
    // With a setup phase the actual root process is the pwsh wrapper.
    let root_proc_name = if setup.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some() {
        procname::normalize("pwsh.exe")
    } else {
        procname::normalize(adapter.root_exe())
    };
    let _ = app.emit(
        "pty://proc",
        ProcPayload { pane_id: id, name: root_proc_name.clone() },
    );

    // Activity-based status: the reader marks the pane "running" on output; a monitor
    // thread flips it to "waiting" after a quiet spell (agent idle, likely awaiting
    // input). Vendor-agnostic v1; pattern-based per-vendor detection is a later refinement.
    let last = std::sync::Arc::new(AtomicU64::new(now_ms()));
    let waiting = std::sync::Arc::new(AtomicU8::new(0)); // 0 = running, 1 = waiting
    let alive = std::sync::Arc::new(AtomicBool::new(true));
    // OSC 9;4 progress (G3): a program advertising progress is busy, so the quiet
    // timer must not call it "waiting". Holds an expiry (ms epoch), 0 = clear; the
    // expiry means a program that dies mid-progress can't pin the pane busy forever.
    let osc_busy_until = std::sync::Arc::new(AtomicU64::new(0));
    // UX-594: output coalescing/backpressure — see outbuf.rs. The reader only
    // buffers; a separate flusher thread (below) is what actually emits.
    let coalescer = std::sync::Arc::new(outbuf::OutputCoalescer::new());
    let out = std::sync::Arc::new(Mutex::new(paneout::PaneOut::new(cols, rows)));

    // Register the pane and its model mapping BEFORE any thread starts: a child that
    // dies instantly has its reader prune both entries, and that must find them
    // (registering afterwards would leave a dead entry that a reload attaches to).
    let (epoch, _, _) = paneout::parse_gen(&gen);
    let entry = paneout::ModelEntry {
        pty_id: id,
        vendor: vendor.clone(),
        cwd: cwd.clone(),
        epoch,
        out: out.clone(),
        attached: true,
    };
    reg.panes.lock().unwrap().insert(
        id,
        Pane {
            master: pair.master,
            writer,
            child,
            vendor,
            cwd: cwd.clone(),
            out: out.clone(),
            last_cpu_100ns: AtomicU64::new(0),
            last_sample_ms: AtomicU64::new(0),
            proc_name: Mutex::new(root_proc_name),
            session: Mutex::new(chatlog::SessionState {
                session_id: plan.session_id,
                pinned: plan.pinned,
                needs_resolve: plan.needs_resolve,
                spawn_ms,
                cwd,
            }),
        },
    );
    // One model, one pty. A live predecessor here means a restart whose kill has
    // not landed yet, or a stray double spawn: reap it so it cannot linger as an
    // invisible agent.
    let superseded = paneout::lock_map(&reg.by_model).insert(model_id, entry);
    if let Some(old) = superseded {
        applog::log(
            "warn",
            "pty",
            &format!("pty_spawn for model {model_id} superseded live pty {}; reaping it", old.pty_id),
        );
        reap_pane(reg.inner(), old.pty_id);
    }

    // Reader thread: blocking read -> coalescer, plus activity bookkeeping.
    // Emitting the output event is the flusher thread's job now, so a flood
    // of small reads can't turn into a flood of IPC events.
    let (app_r, last_r, waiting_r, alive_r, coal_r, out_r, osc_r) = (
        app.clone(),
        last.clone(),
        waiting.clone(),
        alive.clone(),
        coalescer.clone(),
        out.clone(),
        osc_busy_until.clone(),
    );
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut osc = oscprogress::ProgressScanner::default();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    last_r.store(now_ms(), Ordering::Relaxed);
                    if waiting_r.swap(0, Ordering::Relaxed) != 0 {
                        let _ = app_r.emit("pty://state", StatePayload { pane_id: id, state: "running".into() });
                    }
                    if let Some(p) = osc.feed(&buf[..n]) {
                        osc_r.store(if p.busy { now_ms() + 60_000 } else { 0 }, Ordering::Relaxed);
                    }
                    coal_r.push(&buf[..n]);
                }
                Err(_) => break,
            }
        }
        alive_r.store(false, Ordering::Relaxed);
        // Flush whatever's still buffered now, synchronously, so the pane's
        // last output reaches the frontend BEFORE the exit event — the async
        // flusher thread would otherwise race it by up to one flush interval.
        if let Some(chunk) = coal_r.drain() {
            emit_output(&app_r, &out_r, id, &chunk);
        }
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
        paneout::lock_map(&reg.by_model).remove_pty(id);
        let _ = app_r.emit("pty://exit", ExitPayload { pane_id: id, crashed });
    });

    // Monitor thread: emit "waiting" once output has been quiet past the threshold.
    let (app_m, last_m, waiting_m, alive_m, osc_m) =
        (app.clone(), last.clone(), waiting.clone(), alive.clone(), osc_busy_until.clone());
    std::thread::spawn(move || {
        const QUIET_MS: u64 = 3000;
        loop {
            std::thread::sleep(Duration::from_millis(700));
            if !alive_m.load(Ordering::Relaxed) {
                break;
            }
            let quiet_for = now_ms().saturating_sub(last_m.load(Ordering::Relaxed));
            let osc_busy = osc_m.load(Ordering::Relaxed) > now_ms();
            if quiet_for > QUIET_MS && !osc_busy && waiting_m.swap(1, Ordering::Relaxed) == 0 {
                let _ = app_m.emit("pty://state", StatePayload { pane_id: id, state: "waiting".into() });
            }
        }
    });

    // Flusher thread (UX-594): drains the coalescer into ONE `pty://output`
    // event per interval, decoupling emit rate from however fast the pane is
    // actually producing bytes. ~60fps interval matches the frontend's own
    // per-frame batching, so this never adds perceptible latency in the
    // common case — it only kicks in as backpressure during a real flood.
    let (app_f, alive_f, coal_f, out_f) = (app.clone(), alive.clone(), coalescer.clone(), out.clone());
    std::thread::spawn(move || {
        const FLUSH_MS: u64 = 16;
        loop {
            std::thread::sleep(Duration::from_millis(FLUSH_MS));
            match coal_f.drain() {
                Some(chunk) => emit_output(&app_f, &out_f, id, &chunk),
                None if !alive_f.load(Ordering::Relaxed) => break,
                None => {}
            }
        }
    });

    Ok(id)
}

/// Feed a chunk to the pane's ring and, unless the pane is buffer-only, emit it.
/// Push and emit happen under one lock so emit order equals seq order and a
/// concurrent pty_attach snapshot lands cleanly between two chunks.
fn emit_output(app: &AppHandle, out: &Mutex<paneout::PaneOut>, pane_id: u32, chunk: &[u8]) {
    let b64 = STANDARD.encode(chunk);
    let mut o = paneout::lock_out(out);
    if let Some(seq) = o.push(chunk) {
        let _ = app.emit("pty://output", OutputPayload { pane_id, b64, seq });
    }
}

#[derive(Serialize)]
struct AttachSnapshot {
    /// Base64: mode-restoring escapes to write first.
    head: String,
    /// Base64: buffered output, starting at a safe cut.
    body: String,
    start_seq: u64,
    next_seq: u64,
}

#[derive(Serialize)]
struct AttachInfo {
    pty_id: u32,
    snapshot: AttachSnapshot,
    /// The pty's current size: the snapshot bytes were written at this width.
    cols: u16,
    rows: u16,
    proc_name: String,
}

/// Reattach to the live pty for this pane model instead of spawning (webview
/// reload). None when there is none, or its vendor/cwd differ from `gen`.
/// Async so a 4 MiB snapshot never runs on the main thread.
#[tauri::command]
async fn pty_attach(reg: State<'_, Registry>, model_id: u32, gen: String) -> Result<Option<AttachInfo>, String> {
    let (req_epoch, vendor, cwd) = paneout::parse_gen(&gen);
    // Registry ids first (panes is never taken while by_model is held).
    let live: std::collections::HashSet<u32> = reg.panes.lock().unwrap().keys().copied().collect();
    let claimed = paneout::lock_map(&reg.by_model).claim_live(model_id, &vendor, &cwd, req_epoch, &live);
    let Some((pty_id, out)) = claimed else { return Ok(None) };
    // Snapshot under the PaneOut lock: any chunk is either inside it (its event
    // seq <= next_seq, which the frontend drops) or after it (delivered live).
    let (snap, cols, rows) = {
        let o = paneout::lock_out(&out);
        (o.snapshot(), o.cols, o.rows)
    };
    let proc_name = reg
        .panes
        .lock()
        .unwrap()
        .get(&pty_id)
        .map(|p| p.proc_name.lock().unwrap().clone())
        .unwrap_or_default();
    Ok(Some(AttachInfo {
        pty_id,
        snapshot: AttachSnapshot {
            head: STANDARD.encode(&snap.head),
            body: STANDARD.encode(&snap.body),
            start_seq: snap.start_seq,
            next_seq: snap.next_seq,
        },
        cols,
        rows,
        proc_name,
    }))
}

fn out_for_model(reg: &Registry, model_id: u32) -> Result<(u32, std::sync::Arc<Mutex<paneout::PaneOut>>), String> {
    let bm = paneout::lock_map(&reg.by_model);
    bm.get(model_id)
        .map(|e| (e.pty_id, e.out.clone()))
        .ok_or_else(|| format!("no live pty for pane model {model_id}"))
}

/// Buffer-only mode for the later workspace transfer: output keeps filling the
/// ring but is no longer emitted. Returns the seq at which emits stopped.
#[tauri::command]
async fn pane_pause(reg: State<'_, Registry>, model_id: u32) -> Result<u64, String> {
    let (_, out) = out_for_model(reg.inner(), model_id)?;
    let seq = paneout::lock_out(&out).pause();
    Ok(seq)
}

/// Undo pane_pause: live emits resume, preceded by one catch-up chunk holding
/// whatever arrived while paused. If the gap was evicted from the ring it cannot
/// be replayed; the full snapshot comes back instead and the caller repaints from
/// it (None means the live stream is complete).
#[tauri::command]
async fn pane_resume(app: AppHandle, reg: State<'_, Registry>, model_id: u32) -> Result<Option<AttachSnapshot>, String> {
    let (pty_id, out) = out_for_model(reg.inner(), model_id)?;
    let mut o = paneout::lock_out(&out);
    match o.resume() {
        paneout::Resumed::Bytes(bytes, seq) => {
            let _ = app.emit("pty://output", OutputPayload { pane_id: pty_id, b64: STANDARD.encode(&bytes), seq });
            Ok(None)
        }
        paneout::Resumed::Gap => {
            let snap = o.snapshot();
            Ok(Some(AttachSnapshot {
                head: STANDARD.encode(&snap.head),
                body: STANDARD.encode(&snap.body),
                start_seq: snap.start_seq,
                next_seq: snap.next_seq,
            }))
        }
        paneout::Resumed::Nothing => Ok(None),
    }
}

/// The user declined to reopen last session (or started from the launcher): every
/// pty still unclaimed is last session's agent with no pane to show it. Kill them
/// now instead of waiting for the one-shot reaper. Returns how many were reaped.
#[tauri::command]
async fn pty_reap_unclaimed(reg: State<'_, Registry>) -> Result<u32, String> {
    let unclaimed = paneout::lock_map(&reg.by_model).unattached();
    let mut n = 0;
    for (model_id, pty_id) in unclaimed {
        let still = paneout::lock_map(&reg.by_model).get(model_id).is_some_and(|e| e.pty_id == pty_id && !e.attached);
        if !still {
            continue;
        }
        applog::log("info", "pty", &format!("reopen declined: killing unclaimed pty {pty_id} (pane model {model_id})"));
        reap_pane(reg.inner(), pty_id);
        n += 1;
    }
    Ok(n)
}

/// Called on every main-webview load. A fresh load has no frontend attached to
/// anything, so mark every pty unclaimed and, after a grace period, reap the ones
/// still unclaimed whose model is no longer in the session doc (the pane was
/// closed, or its workspace is gone). Safe mode never reaps.
fn on_main_webview_load(app: &AppHandle) {
    let reg = app.state::<Registry>();
    paneout::lock_map(&reg.by_model).mark_all_unattached();
    let my_gen = reg.load_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(paneout::REAP_GRACE_SECS));
        reap_unclaimed(&app, my_gen);
    });
}

fn reap_unclaimed(app: &AppHandle, my_gen: u64) {
    let reg = app.state::<Registry>();
    if reg.load_gen.load(Ordering::SeqCst) != my_gen {
        return; // a newer load owns the next pass
    }
    let safe = persist::safe_mode_active();
    let unclaimed = paneout::lock_map(&reg.by_model).unattached();
    if unclaimed.is_empty() {
        return;
    }
    if safe {
        applog::log("info", "pty", &format!("reaper skipped in safe mode ({} unclaimed pty)", unclaimed.len()));
        return;
    }
    let doc = persist::session_pane_ids(app);
    for (model_id, pty_id) in paneout::reap_targets(&unclaimed, doc.as_ref(), false) {
        // Re-check: it may have been claimed or replaced since the snapshot.
        let still = paneout::lock_map(&reg.by_model).get(model_id).is_some_and(|e| e.pty_id == pty_id && !e.attached);
        if !still {
            continue;
        }
        applog::log(
            "warn",
            "pty",
            &format!("reaper: killing pty {pty_id} (pane model {model_id}) unclaimed {}s after reload and not in the session doc", paneout::REAP_GRACE_SECS),
        );
        reap_pane(reg.inner(), pty_id);
    }
}

/// Largest single write handed to the PTY (QL-759). Interactive input is a few
/// bytes, so it never trips this; a multi-KB paste is split into segments so a
/// single huge WriteFile can't sit on ConPTY's input pipe and stall the pane.
const WRITE_CHUNK_BYTES: usize = 4 * 1024;

/// Split off at most one chunk, snapped back to a UTF-8 char boundary so a
/// multi-byte character is never cut across two writes (ConPTY decodes the
/// input pipe incrementally). A char is at most 4 bytes and the chunk size is
/// far larger, so the boundary search always terminates above 0.
fn split_write_chunk(s: &str) -> (&str, &str) {
    if s.len() <= WRITE_CHUNK_BYTES {
        return (s, "");
    }
    let mut end = WRITE_CHUNK_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.split_at(end)
}

/// Write one payload to a pane. Small interactive writes take the exact path
/// they always did — one `write_all` + one `flush`, no extra syscalls, no
/// added latency. Only oversized payloads (pastes, Broadcast, Review) go
/// through the chunk loop, which flushes once at the end; the yield between
/// chunks gives the pane's reader/flusher threads a slot during a big paste.
/// No sleep: whether ConPTY needs a pause between chunks can't be established
/// without a live ConPTY run, so this stays conservative.
fn write_to_pty(w: &mut dyn Write, data: &str) -> std::io::Result<()> {
    if data.len() <= WRITE_CHUNK_BYTES {
        w.write_all(data.as_bytes())?;
        return w.flush();
    }
    let mut rest = data;
    while !rest.is_empty() {
        let (chunk, tail) = split_write_chunk(rest);
        w.write_all(chunk.as_bytes())?;
        rest = tail;
        if !rest.is_empty() {
            std::thread::yield_now();
        }
    }
    w.flush()
}

#[tauri::command]
fn pty_write(reg: State<Registry>, pane_id: u32, data: String) -> Result<(), String> {
    // The registry mutex is held for the whole write, so concurrent callers
    // are serialised and byte order is preserved exactly as before — a paste
    // can't interleave with a keystroke mid-chunk.
    let mut panes = reg.panes.lock().unwrap();
    if let Some(p) = panes.get_mut(&pane_id) {
        write_to_pty(p.writer.as_mut(), &data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(reg: State<Registry>, pane_id: u32, cols: u16, rows: u16) -> Result<(), String> {
    // Clone the PaneOut Arc out and release `panes` before locking it, so the
    // lock-order rule in paneout.rs holds.
    let out = {
        let panes = reg.panes.lock().unwrap();
        let Some(p) = panes.get(&pane_id) else { return Ok(()) };
        p.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        p.out.clone()
    };
    paneout::lock_out(&out).resized(cols, rows);
    Ok(())
}

// Every pane id currently in the registry. Used by install_update (updates.rs)
// to reap the same set ExitRequested would, without exposing the `panes` field
// itself outside this module.
pub(crate) fn live_pane_ids(reg: &Registry) -> Vec<u32> {
    reg.panes.lock().unwrap().keys().copied().collect()
}

// Kill a pane's whole process tree and drop its handles. Node-based CLIs
// (claude/agy/kimi) spawn children that child.kill() alone would orphan, so we
// taskkill /T the tree. Idempotent: a pane already pruned (natural exit) is a no-op.
pub(crate) fn reap_pane(reg: &Registry, pane_id: u32) {
    paneout::lock_map(&reg.by_model).kill_pty(pane_id);
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
#[tauri::command(async)]
fn fs_list_dir(path: String) -> Result<Vec<Entry>, String> {
    pathguard::check(&path)?;
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

// Read-only file preview (UX-505). Text only, with a size cap so a huge log or
// a binary can't stall the UI thread. Lossy decode on purpose: a preview should
// show something useful for a mostly-text file rather than refuse it.
#[tauri::command(async)]
fn fs_read_text_file(path: String) -> Result<String, String> {
    pathguard::check(&path)?;
    let canon = readscope::check_read(std::path::Path::new(&path))?;
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("too large to preview (over 5MB)".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct FsStat {
    mtime_ms: u64,
    size: u64,
    is_dir: bool,
}

fn stat_of(path: &std::path::Path) -> Result<FsStat, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FsStat { mtime_ms, size: meta.len(), is_dir: meta.is_dir() })
}

// Cheap change probe for the preview's "follow file" poll (QL-704): metadata
// only, never content. Same guard + read-scope gate as the content reads.
#[tauri::command(async)]
fn fs_stat(path: String) -> Result<FsStat, String> {
    pathguard::check(&path)?;
    let canon = readscope::check_read(std::path::Path::new(&path))?;
    stat_of(&canon)
}

// Images referenced from a previewed markdown file (UX-508), returned as base64
// for a data: URI. Never fetched over the network.
#[tauri::command(async)]
fn fs_read_file_base64(path: String) -> Result<String, String> {
    pathguard::check(&path)?;
    let canon = readscope::check_read(std::path::Path::new(&path))?;
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("too large to preview (over 10MB)".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(&bytes))
}

// Per-pane health metrics (202): pid, CPU%, memory. CPU% is a delta between
// this call and the previous one, so the first poll for a pane always reads 0.
// `memory_warn_mb` (UX-596): caller-supplied warning threshold — Settings can
// wire a stored preference through; omitted/invalid falls back to a sane
// default (health::resolve_memory_warn_mb).
#[tauri::command]
fn pane_health(reg: State<Registry>, memory_warn_mb: Option<f64>) -> Vec<health::PaneHealth> {
    let warn_mb = health::resolve_memory_warn_mb(memory_warn_mb);
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
        let memory_mb = mem_bytes as f64 / (1024.0 * 1024.0);
        out.push(health::PaneHealth {
            pane_id: *id,
            pid,
            cpu_percent,
            memory_mb,
            proc_name: p.proc_name.lock().unwrap().clone(),
            memory_warn_mb: warn_mb,
            over_memory_warn: memory_mb >= warn_mb,
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
    crate::pathguard::check(&dest_path)?;
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
    let json = support::build_bundle(
        &app.package_info().version.to_string(),
        panes,
        applog::tail(64 * 1024),
    )?;
    std::fs::write(&dest_path, json).map_err(|e| e.to_string())
}

// Live foreground process name sampler (audit item): one thread, ~2s
// interval, one shared toolhelp snapshot per tick (not per-pane). Walks each
// live pane's process tree from its root pid and picks the deepest/most-recent
// descendant's image name (procname.rs) as an approximation of "what's
// actually running". Emits `pty://proc` only when a pane's name changes — the
// initial "root name at spawn" emission happens inline in pty_spawn, so this
// only fires once the tree has actually grown/changed underneath the root
// (e.g. pwsh -> node -> claude). When there are no panes, each tick is just a
// lock + is_empty check — no snapshot walk.
fn spawn_proc_sampler(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));

        let reg = app.state::<Registry>();
        let roots: Vec<(u32, u32)> = {
            let panes = reg.panes.lock().unwrap();
            if panes.is_empty() {
                continue;
            }
            panes
                .iter()
                .filter_map(|(id, p)| p.child.process_id().map(|pid| (*id, pid)))
                .collect()
        };
        if roots.is_empty() {
            continue;
        }

        let snapshot = orphans::snapshot_processes();
        for (pane_id, root_pid) in roots {
            let Some(name) = procname::deepest_descendant_name(root_pid, &snapshot) else {
                continue;
            };
            let panes = reg.panes.lock().unwrap();
            let Some(p) = panes.get(&pane_id) else { continue };
            let mut last = p.proc_name.lock().unwrap();
            if *last == name {
                continue;
            }
            *last = name.clone();
            drop(last);
            drop(panes);
            let _ = app.emit("pty://proc", ProcPayload { pane_id, name });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Canary first boot: clone stable's state BEFORE the builder runs — build()
    // creates the webview and locks the EBWebView profile dir, after which the
    // localStorage half of the clone is impossible. No-op on stable. The
    // summary is logged once applog is up (below).
    let canary_note = canary::prepare(&context.config().identifier);
    let app = tauri::Builder::default()
        // Must be the first plugin. A second launch of the SAME flavour (the
        // plugin keys on the bundle identifier, so stable and canary stay
        // separate) exits and lands here in the running instance.
        // RULE: never take foreground on a background event. The owner often
        // has a fullscreen game up, and tao's show() (SW_SHOW) and
        // unminimize() (SW_RESTORE) both activate the window. So: a visible
        // window (including a minimised one) only gets a taskbar flash; a
        // hidden one is shown with WS_EX_NOACTIVATE set (set_focusable(false))
        // so the show doesn't activate it, then made focusable again so the
        // user can click into it. No unminimize, no set_focus.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                if !win.is_visible().unwrap_or(false) {
                    let _ = win.set_focusable(false);
                    let _ = win.show();
                    let _ = win.set_focusable(true);
                }
                let _ = win.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // QL-779: remember where the window was and how big it was. Only the
        // geometry flags — VISIBLE is deliberately OFF, so a session that
        // ended with the window hidden (the summon chord hides rather than
        // minimises, see summon.rs) can never restore into an invisible app.
        // The plugin validates a restored position against the CURRENT
        // monitors and skips it if none intersect, so unplugging the second
        // screen doesn't strand the window off-desktop.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(Registry::default())
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                on_main_webview_load(webview.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_attach,
            pane_pause,
            pane_resume,
            pty_reap_unclaimed,
            chatlog::pane_session_info,
            chatlog::session_tail,
            usage::session_subagents,
            chatlog::session_record,
            pathcheck::paths_exist,
            doctor::instruction_files,
            doctor::plugin_validate,
            pty_write,
            pty_resize,
            pty_kill,
            fs_list_dir,
            fs_read_text_file,
            fs_read_file_base64,
            fs_stat,
            readscope::set_read_roots,
            detect_vendors,
            vendors_dir,
            manifest_problems,
            pane_health,
            recover_orphans,
            kill_orphans,
            export_support_bundle,
            applog::log_event,
            applog::log_file_path,
            editor::launch_editor,
            reveal::reveal_in_explorer,
            gitstatus::git_status,
            worktree::git_repo_toplevel,
            worktree::git_worktree_add,
            worktree::git_worktree_remove,
            worktree::git_worktree_gc,
            worktree::git_diff_summary,
            worktree::git_file_diff,
            worktree::git_merge_back,
            worktree::detect_setup_command,
            worktree::git_pr_handoff,
            worktree::git_branch_context,
            worktree::git_repo_web_url,
            worktree::git_worktree_list,
            worktree::git_update_from_base,
            usage::pane_usage,
            usage::list_claude_sessions,
            codexsessions::list_codex_sessions,
            usage::search_claude_sessions,
            usage::stage_launch_args,
            usage::pane_subagents,
            usage::pane_subagent_count,
            usage::pane_plans,
            usage::plan_usage,
            persist::save_session,
            persist::load_session,
            persist::has_previous_session,
            persist::is_safe_mode,
            persist::list_restore_points,
            persist::restore_from_point,
            persist::export_backup,
            persist::import_backup,
            updates::check_update,
            updates::default_releases_dir,
            overlay::set_attention_overlay,
            // QL-720: hook-driven session state. install/uninstall are the only
            // things in Flightdeck that write to ~/.claude/settings.json, and
            // both are reachable only from the Settings row's confirm dialog.
            hooks::hook_events_status,
            hooks::install_claude_hooks,
            hooks::uninstall_claude_hooks,
        ])
        .build(context)
        .expect("error while building tauri application");

    // Manifest vendors (#218): point the registry at <app-data>/vendors so a
    // dropped JSON file becomes a launchable agent — no recompile.
    if let Ok(data_dir) = app.handle().path().app_data_dir() {
        readscope::set_data_dir(data_dir.clone());
        readscope::grant_fixed_asset_roots(app.handle());
        // Flight recorder first, so everything after this line — including a
        // panic in any later setup step or command — leaves a durable trace.
        applog::init(data_dir.join("logs"), &app.package_info().version.to_string());
        // Marker for the installer's pre-install backup hook (it names the
        // backup after the version whose state it is copying).
        let _ = updates::write_last_version(&data_dir, &app.package_info().version.to_string());
        if let Some(note) = &canary_note {
            applog::log("info", "canary", note);
        }
        vendors::set_manifest_dir(data_dir.join("vendors"));
        // TN5: Claude view settings files (--settings), written on demand too.
        chatlog::set_view_dir(data_dir.join("claude-view"));
        chatlog::write_view_settings(&data_dir.join("claude-view"));
        // QL-752: (re)write the PowerShell shell-integration preamble that
        // interactive pwsh panes dot-source at spawn. Rewritten every launch so
        // it can't go stale; if the write fails, panes simply launch without
        // marks.
        shellmarks::init(data_dir.join("shell"));
    }

    // QL-780: global summon chord (Ctrl+Alt+F). Registered after build, never
    // fatal — see summon.rs.
    summon::init(app.handle());

    // QL-720: write the hook relay into <app-data>/hooks and start tailing its
    // event log. This only prepares the machinery and reads our OWN folder —
    // the user's ~/.claude/settings.json is untouched until they press Install
    // in Settings › Diagnostics.
    hooks::init(app.handle());

    spawn_proc_sampler(app.handle().clone());
    // UX-586: hot-reload the vendor list when a manifest file changes on disk.
    vendors::spawn_manifest_watcher(app.handle().clone());

    app.run(|app_handle, event| {
        match event {
            // QL-779: the main window is created hidden (tauri.conf.json
            // "visible": false) so the window-state plugin can move/resize it
            // before the first paint — otherwise every launch flashes the
            // default 1200x800 centred window and then jumps to the remembered
            // spot. Restore already happened inside build() (the plugin's
            // on_window_ready hook), so showing here shows it in the right
            // place.
            //
            // UNCONDITIONAL, and on RunEvent::Ready on purpose: whatever the
            // saved state says and whatever the restore did, the window is
            // always shown. A corrupt state file, a missing monitor, or a
            // plugin error can never leave Flightdeck running invisibly with
            // no way to get it back.
            //
            // Ready, NOT before app.run(): a show() issued between build() and
            // run() is silently lost because the event loop isn't pumping yet,
            // and the app runs forever with an invisible window. That was
            // v0.5.2's "installed but never booted" bug (2026-08-11, found by
            // running the release exe and enumerating its windows: the Tauri
            // window existed, restored its geometry, and stayed
            // IsWindowVisible=false indefinitely).
            RunEvent::Ready => {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            // Reap every live pane's process tree when the app is asked to
            // exit, so closing the window never leaves orphaned claude/agy/pwsh
            // trees running.
            RunEvent::ExitRequested { .. } => {
                // A save running on a pool thread must land before we exit.
                persist::wait_idle();
                let reg = app_handle.state::<Registry>();
                let ids: Vec<u32> = reg.panes.lock().unwrap().keys().copied().collect();
                for id in ids {
                    reap_pane(reg.inner(), id);
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(cmd: &CommandBuilder, k: &str) -> Option<String> {
        cmd.get_env(k).map(|v| v.to_string_lossy().into_owned())
    }

    #[test]
    fn claude_spawn_env_follows_focus_mode() {
        let (c, _) = build_command("claude", "D:\\t", None, false);
        assert_eq!(env_of(&c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN").as_deref(), Some("1"));
        assert_eq!(env_of(&c, "CLAUDE_CODE_NO_FLICKER"), None);
        let (c, _) = build_command("claude", "D:\\t", None, true);
        assert_eq!(env_of(&c, "CLAUDE_CODE_NO_FLICKER").as_deref(), Some("1"));
        assert_eq!(env_of(&c, "CLAUDE_CODE_DISABLE_MOUSE").as_deref(), Some("1"));
        assert_eq!(env_of(&c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"), None);
        // Other vendors never get the claude env.
        let (c, plan) = build_command("pwsh", "D:\\t", None, false);
        assert_eq!(env_of(&c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"), None);
        assert!(plan.session_id.is_none());
    }

    fn argv_of(cmd: &CommandBuilder) -> Vec<String> {
        cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn init_test_view_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fd-tn5-view-{}", std::process::id()));
        chatlog::set_view_dir(dir.clone());
        // set_view_dir is first-writer-wins; return whatever is actually set.
        dir
    }

    #[test]
    fn claude_gets_exactly_one_view_settings_arg() {
        init_test_view_dir();
        for focus in [true, false] {
            let (c, _) = build_command("claude", "D:\\t-tn5-a", None, focus);
            let argv = argv_of(&c);
            assert_eq!(argv.iter().filter(|a| *a == "--settings").count(), 1, "{argv:?}");
            let i = argv.iter().position(|a| a == "--settings").unwrap();
            let want = if focus { "claude-view-focus.json" } else { "claude-view-default.json" };
            assert!(argv[i + 1].starts_with('\'') && argv[i + 1].ends_with(&format!("{want}'")), "{argv:?}");
        }
        // Non-claude vendors never get it.
        let (c, _) = build_command("pwsh", "D:\\t-tn5-a", None, true);
        assert!(!argv_of(&c).iter().any(|a| a == "--settings"));
    }

    #[test]
    fn user_supplied_settings_is_not_doubled() {
        init_test_view_dir();
        usage::stage_launch_args("claude".into(), "D:\\t-tn5-user".into(), vec!["--settings".into(), "C:\\mine.json".into()]).unwrap();
        let (c, _) = build_command("claude", "D:\\t-tn5-user", None, true);
        let argv = argv_of(&c);
        assert_eq!(argv.iter().filter(|a| *a == "--settings").count(), 1, "{argv:?}");
        assert!(argv.iter().any(|a| a == "C:\\mine.json"));
        usage::stage_launch_args("claude".into(), "D:\\t-tn5-user2".into(), vec!["--settings=C:\\mine.json".into()]).unwrap();
        let (c, _) = build_command("claude", "D:\\t-tn5-user2", None, false);
        assert!(!argv_of(&c).iter().any(|a| a == "--settings"));
    }

    #[test]
    fn view_settings_files_and_quoting() {
        let dir = std::env::temp_dir().join(format!("fd tn5 o'brien {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let focus = chatlog::view_settings_args_in(&dir, true).unwrap();
        let classic = chatlog::view_settings_args_in(&dir, false).unwrap();
        // Idempotent re-run.
        assert_eq!(chatlog::view_settings_args_in(&dir, true).unwrap(), focus);
        assert_eq!(std::fs::read_to_string(dir.join("claude-view-focus.json")).unwrap(), "{\"viewMode\":\"focus\"}");
        assert_eq!(std::fs::read_to_string(dir.join("claude-view-default.json")).unwrap(), "{\"viewMode\":\"default\"}");
        assert_eq!(focus[0], "--settings");
        let want = format!("'{}'", dir.join("claude-view-focus.json").to_string_lossy().replace('\'', "''"));
        assert_eq!(focus[1], want);
        assert!(focus[1].contains("o''brien") && focus[1].contains("fd tn5"));
        assert!(classic[1].ends_with("claude-view-default.json'"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_claude_spawn_pins_a_session_id_arg() {
        let (c, plan) = build_command("claude", "D:\\t", None, false);
        let argv: Vec<String> = c.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        let i = argv.iter().position(|a| a == "--session-id").expect("--session-id missing");
        assert_eq!(Some(&argv[i + 1]), plan.session_id.as_ref());
    }

    #[test]
    fn fs_commands_refuse_network_paths() {
        for p in [r"\\server\share\x", r"/\server\share\x", r"\/server/x", "//server/share", r"\\?\UNC\s\x", r"\\.\pipe\x"] {
            let e = pathguard::NETWORK_PATH_ERR;
            assert_eq!(fs_read_text_file(p.into()).unwrap_err(), e, "{p}");
            assert_eq!(fs_read_file_base64(p.into()).unwrap_err(), e, "{p}");
            assert_eq!(fs_list_dir(p.into()).map(|_| ()).unwrap_err(), e, "{p}");
            assert_eq!(reveal::reveal_in_explorer(p.into()).unwrap_err(), e, "{p}");
        }
    }

    #[test]
    fn fs_stat_guard_scope_and_shape() {
        for p in [r"\\server\share\x", "//server/share", r"\\.\pipe\x"] {
            assert_eq!(fs_stat(p.into()).unwrap_err(), pathguard::NETWORK_PATH_ERR, "{p}");
        }
        let d = std::env::temp_dir().join(format!("fd-fsstat-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("a.txt");
        std::fs::write(&f, "hello").unwrap();
        // The temp dir is not an allowed root: refused with the scope error.
        assert_eq!(fs_stat(f.to_string_lossy().into_owned()).unwrap_err(), readscope::OUTSIDE_SCOPE_ERR);
        let s = stat_of(&f).unwrap();
        assert_eq!((s.size, s.is_dir), (5, false));
        assert!(s.mtime_ms > 0);
        assert!(stat_of(&d).unwrap().is_dir);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Records every write/flush the PTY writer would have seen, so the tests
    /// can assert on syscall shape without a real ConPTY.
    #[derive(Default)]
    struct RecordingWriter {
        writes: Vec<Vec<u8>>,
        flushes: usize,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes.push(buf.to_vec());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    impl RecordingWriter {
        fn joined(&self) -> Vec<u8> {
            self.writes.concat()
        }
    }

    /// The interactive path must stay exactly what it was: one write, one flush.
    #[test]
    fn small_write_is_one_write_and_one_flush() {
        let mut w = RecordingWriter::default();
        write_to_pty(&mut w, "a").unwrap();
        assert_eq!(w.writes.len(), 1);
        assert_eq!(w.flushes, 1);
        assert_eq!(w.joined(), b"a");
    }

    #[test]
    fn write_at_the_chunk_size_is_still_a_single_write() {
        let data = "x".repeat(WRITE_CHUNK_BYTES);
        let mut w = RecordingWriter::default();
        write_to_pty(&mut w, &data).unwrap();
        assert_eq!(w.writes.len(), 1, "the boundary case must not pay for chunking");
        assert_eq!(w.flushes, 1);
    }

    #[test]
    fn large_paste_is_chunked_and_flushed_once() {
        let data = "y".repeat(100 * 1024);
        let mut w = RecordingWriter::default();
        write_to_pty(&mut w, &data).unwrap();
        assert_eq!(w.writes.len(), 25, "100KB at 4KB chunks");
        assert!(w.writes.iter().all(|c| c.len() <= WRITE_CHUNK_BYTES));
        assert_eq!(w.flushes, 1, "one flush at the end, not one per chunk");
        assert_eq!(w.joined(), data.as_bytes(), "bytes and order must survive chunking");
    }

    /// A paste of multi-byte text must never be cut mid-character: each chunk
    /// has to be valid UTF-8 on its own and the concatenation lossless.
    #[test]
    fn chunks_never_split_a_multi_byte_char() {
        let data = "héllo → 世界 🚀".repeat(2000);
        assert!(data.len() > WRITE_CHUNK_BYTES * 4);
        let mut w = RecordingWriter::default();
        write_to_pty(&mut w, &data).unwrap();
        assert!(w.writes.len() > 1);
        for c in &w.writes {
            assert!(c.len() <= WRITE_CHUNK_BYTES);
            std::str::from_utf8(c).expect("every chunk must be valid UTF-8 on its own");
        }
        assert_eq!(w.joined(), data.as_bytes());
    }

    #[test]
    fn empty_write_still_flushes_like_before() {
        let mut w = RecordingWriter::default();
        write_to_pty(&mut w, "").unwrap();
        assert_eq!(w.writes.len(), 0, "write_all of an empty slice issues no write");
        assert_eq!(w.flushes, 1);
    }

    #[test]
    fn split_write_chunk_walks_the_whole_input() {
        let data = "ü".repeat(WRITE_CHUNK_BYTES); // 2 bytes each, odd boundaries
        let mut rest = data.as_str();
        let mut seen = String::new();
        while !rest.is_empty() {
            let (chunk, tail) = split_write_chunk(rest);
            assert!(!chunk.is_empty(), "split must always make progress");
            seen.push_str(chunk);
            rest = tail;
        }
        assert_eq!(seen, data);
    }
}
