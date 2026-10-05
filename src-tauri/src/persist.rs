// persist.rs — JSON-document session persistence in the Tauri app-data dir.
// Atomic writes (temp file + rename), timestamped restore points, and a
// one-file backup/restore. Uses only what's already in Cargo.toml (serde,
// serde_json, std::fs) — no new dependency. SQLite (scrollback, querying) is
// a later upgrade noted in BACKLOG.md R4; this is the JSON-document version.
//
// NOT wired into lib.rs yet (out of this module's ownership). To activate:
//   1. add `mod persist;` near the top of lib.rs
//   2. add these commands to the existing `.invoke_handler(tauri::generate_handler![ ... ])` list:
//      persist::save_session, persist::load_session, persist::has_previous_session,
//      persist::is_safe_mode, persist::list_restore_points, persist::restore_from_point,
//      persist::export_backup, persist::import_backup
//
// Correctness: `PersistedPane` deliberately carries no `state` field. Panes are
// live processes; a restored pane is always dead/idle until the user relaunches
// it (the store's `restartPane`). This module never claims a process survived
// an app restart.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SESSION_FILE: &str = "session.json";
const SNAPSHOTS_DIR: &str = "snapshots";
const MAX_RESTORE_POINTS: usize = 10;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn default_version() -> u32 {
    1
}

// ---------------------------------------------------------------------------
// Document shape. `rename_all = "camelCase"` so the JSON (and the TS side)
// matches the app's existing camelCase conventions (PaneModel, Workspace, ...).
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPane {
    pub id: u32,
    pub vendor: String,
    pub cwd: String,
    #[serde(default)]
    pub title: Option<String>,
    // Worktree isolation (Tier 0): recorded so restore can reattach/recreate
    // the pane's worktree and launch-time GC knows which worktrees are claimed.
    // All None for a non-isolated pane; old session docs load with defaults.
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base_branch: Option<String>,
    // UX-581: the pane's unsent input line, so it survives an app restart.
    // Absent for a pane with nothing typed; old session docs load with None.
    #[serde(default)]
    pub draft: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspace {
    pub id: u32,
    pub name: String,
    pub root: String,
    // Worktree setup command (Tier 0 follow-up): re-runs when restore has to
    // recreate a pane's worktree (fresh dir — node_modules gone).
    #[serde(default)]
    pub setup_cmd: Option<String>,
    #[serde(default)]
    pub panes: Vec<PersistedPane>,
}

// Phase 4 doc v2: which window owns which workspaces. No geometry (the
// window-state plugin owns that). `workspaces` stays flat, so a build that
// predates this field ignores it and loads every workspace into one window.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWindow {
    pub label: String,
    #[serde(default)]
    pub workspace_ids: Vec<u32>,
    #[serde(default)]
    pub active_workspace_id: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDoc {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub saved_at: u64,
    #[serde(default)]
    pub active_workspace_id: Option<u32>,
    #[serde(default)]
    pub workspaces: Vec<PersistedWorkspace>,
    // Opaque UI-preference blob (theme, ui scale, panel collapsed, ...). Kept as
    // a raw JSON value rather than a Rust struct so the frontend can evolve its
    // own prefs shape without a matching change here.
    #[serde(default)]
    pub ui_prefs: serde_json::Value,
    #[serde(default)]
    pub windows: Vec<PersistedWindow>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePointInfo {
    pub id: String,
    pub saved_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEntry {
    id: String,
    doc: SessionDoc,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupBundle {
    version: u32,
    exported_at: u64,
    session: Option<SessionDoc>,
    snapshots: Vec<SnapshotEntry>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base_dir(app)?.join(SESSION_FILE))
}

fn snapshots_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = base_dir(app)?.join(SNAPSHOTS_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Write-then-rename so a crash mid-write can never leave a truncated/corrupt
// file behind: the rename is the only atomic step, and it either lands the
// whole new file or leaves whatever was there before untouched. `fs::rename`
// on Windows replaces an existing destination (MoveFileExW + REPLACE_EXISTING).
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Safe mode (199). No lib.rs wiring required — reads argv/env directly, so it
// takes effect as soon as this module is compiled in and `load_session` is
// called from the frontend on boot.
// ---------------------------------------------------------------------------

pub fn safe_mode_active() -> bool {
    if std::env::args().any(|a| a == "--safe-mode") {
        return true;
    }
    matches!(
        std::env::var("FLIGHTDECK_SAFE_MODE").ok().as_deref(),
        Some("1") | Some("true")
    )
}

#[tauri::command]
pub fn is_safe_mode() -> bool {
    safe_mode_active()
}

// ---------------------------------------------------------------------------
// Core save/load
// ---------------------------------------------------------------------------

fn read_session_file(app: &AppHandle) -> Result<Option<SessionDoc>, String> {
    let path = session_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if s.trim().is_empty() {
        return Ok(None);
    }
    let doc: SessionDoc =
        serde_json::from_str(&s).map_err(|e| format!("session.json is corrupt: {e}"))?;
    Ok(Some(doc))
}

// Single-writer coalescer for autosave. `submit` parks the payload in `pending`
// (replacing any older unwritten one, so the backlog never exceeds one), then
// takes the write lock. Whoever holds the lock writes the newest pending
// payload; a caller that finds `pending` already taken was superseded and its
// data is covered by a later write, so it returns Ok once that write is done
// (the lock wait guarantees it). Every caller therefore returns only after the
// latest payload is on disk, which keeps the quit-time flush honest.
struct Coalescer {
    pending: Mutex<Option<String>>,
    writing: Mutex<()>,
}

impl Coalescer {
    const fn new() -> Self {
        Coalescer { pending: Mutex::new(None), writing: Mutex::new(()) }
    }

    fn submit(&self, json: String, write: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(json);
        let _w = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let next = self.pending.lock().unwrap_or_else(|e| e.into_inner()).take();
        match next {
            Some(j) => write(&j),
            None => Ok(()),
        }
    }

    // Blocks until any in-flight write has finished, then writes a payload
    // that was parked behind it (its submitter may not have taken the lock
    // yet, and the process can exit before it does).
    fn wait_idle(&self, write: impl FnOnce(&str) -> Result<(), String>) {
        let _w = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let next = self.pending.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(j) = next {
            let _ = write(&j);
        }
    }
}

static SAVER: Coalescer = Coalescer::new();
// Set on the first save so the exit-time drain can write a parked payload.
static SAVE_APP: OnceLock<AppHandle> = OnceLock::new();

fn write_session(app: &AppHandle, path: &Path, j: &str) -> Result<(), String> {
    write_atomic(path, j)?;
    snapshot(app, j)
}

/// Called on app exit so a save still running on a pool thread lands, and a
/// payload parked behind it is written, before the process dies.
pub fn wait_idle() {
    flush_slices();
    SHADOW_SAVER.wait_idle(|_| Ok(()));
    match SAVE_APP.get() {
        Some(app) => match session_path(app) {
            Ok(path) => SAVER.wait_idle(|j| write_session(app, &path, j)),
            Err(_) => SAVER.wait_idle(|_| Ok(())),
        },
        None => SAVER.wait_idle(|_| Ok(())),
    }
}

#[tauri::command(async)]
pub fn save_session(app: AppHandle, mut doc: SessionDoc) -> Result<(), String> {
    doc.version = default_version();
    doc.saved_at = now_ms();
    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let path = session_path(&app)?;
    let _ = SAVE_APP.set(app.clone());
    SAVER.submit(json, |j| write_session(&app, &path, j))
}

// ---------------------------------------------------------------------------
// Per-window slices (Phase 4 S6). Each window pushes its own slice through
// `session_put_slice`; Rust owns the merge and is the only writer of the doc.
// The label comes from the calling Window, never from JS.
// ---------------------------------------------------------------------------

const MAIN_LABEL: &str = "main";
const SLICE_DEBOUNCE_MS: u64 = 800;
const SHADOW_FILE: &str = "session.v2.json";
// S6b: the slice writer owns session.json (save_session stays one release for
// import/export paths). Set false for shadow mode: session.v2.json beside it.
const SLICE_WRITER_PRIMARY: bool = true;

struct Slices {
    by_label: BTreeMap<String, SessionDoc>,
    /// How many times each label has pushed a slice (not seeded ones). A close or
    /// quit flush is acknowledged when its label's count moves past the baseline.
    puts: BTreeMap<String, u64>,
    generation: u64,
    dirty: bool,
}

static SLICES: Mutex<Slices> = Mutex::new(Slices { by_label: BTreeMap::new(), puts: BTreeMap::new(), generation: 0, dirty: false });
static SHADOW_SAVER: Coalescer = Coalescer::new();

/// Merge per-label slices into one flat doc plus the window table. Workspaces a
/// label does not own (per `owns`) are dropped and returned for logging; a
/// workspace id is accepted once, main first.
fn merge_slices(
    slices: &BTreeMap<String, SessionDoc>,
    owns: impl Fn(&str, u32) -> bool,
) -> (SessionDoc, Vec<(String, u32)>) {
    let mut labels: Vec<&String> = slices.keys().collect();
    labels.sort_by_key(|l| (l.as_str() != MAIN_LABEL, l.to_string()));
    let mut doc = SessionDoc {
        version: default_version(),
        saved_at: 0,
        active_workspace_id: None,
        workspaces: Vec::new(),
        ui_prefs: serde_json::Value::Null,
        windows: Vec::new(),
    };
    let mut rejected = Vec::new();
    let mut seen = HashSet::new();
    let mut prefs = serde_json::Map::new();
    for (i, label) in labels.iter().enumerate() {
        let slice = &slices[*label];
        let mut ids = Vec::new();
        for w in &slice.workspaces {
            if !owns(label, w.id) {
                rejected.push((label.to_string(), w.id));
            } else if seen.insert(w.id) {
                ids.push(w.id);
                doc.workspaces.push(w.clone());
            }
        }
        if i == 0 {
            doc.active_workspace_id = slice.active_workspace_id;
        }
        doc.windows.push(PersistedWindow {
            label: label.to_string(),
            active_workspace_id: slice.active_workspace_id.filter(|a| ids.contains(a)),
            workspace_ids: ids,
        });
        merge_prefs(&mut prefs, &slice.ui_prefs, i == 0);
    }
    if !slices.is_empty() {
        doc.ui_prefs = serde_json::Value::Object(prefs);
    }
    (doc, rejected)
}

// uiPrefs: groups from the first (main) slice only, summary arrays concatenated,
// object values (scrollback, paneChat, paneColor: pane ids are global) unioned,
// any other key first-wins.
fn merge_prefs(out: &mut serde_json::Map<String, serde_json::Value>, add: &serde_json::Value, first: bool) {
    use serde_json::Value;
    let Some(add) = add.as_object() else { return };
    for (k, v) in add {
        if k == "groups" {
            if first {
                out.insert(k.clone(), v.clone());
            }
            continue;
        }
        match (out.get_mut(k), v) {
            (None, _) => {
                out.insert(k.clone(), v.clone());
            }
            (Some(Value::Array(a)), Value::Array(b)) if k == "summary" => a.extend(b.iter().cloned()),
            (Some(Value::Object(a)), Value::Object(b)) => {
                for (ik, iv) in b {
                    a.entry(ik.clone()).or_insert_with(|| iv.clone());
                }
            }
            _ => {}
        }
    }
}

/// Load-time validation of `windows[]`. Flag off: one main window holding every
/// workspace. Flag on: unknown workspace ids dropped, workspaces nobody claims
/// go to main, and a non-main window left empty (never booted) collapses to main.
fn normalize_windows(mut doc: SessionDoc, multiwindow: bool) -> SessionDoc {
    let known: Vec<u32> = doc.workspaces.iter().map(|w| w.id).collect();
    if !multiwindow {
        doc.windows = vec![PersistedWindow {
            label: MAIN_LABEL.into(),
            active_workspace_id: doc.active_workspace_id.filter(|a| known.contains(a)),
            workspace_ids: known,
        }];
        return doc;
    }
    let mut claimed = HashSet::new();
    let mut out: Vec<PersistedWindow> = Vec::new();
    for mut w in std::mem::take(&mut doc.windows) {
        w.workspace_ids.retain(|id| known.contains(id) && claimed.insert(*id));
        w.active_workspace_id = w.active_workspace_id.filter(|a| w.workspace_ids.contains(a));
        if w.workspace_ids.is_empty() && w.label != MAIN_LABEL {
            continue;
        }
        out.push(w);
    }
    if !out.iter().any(|w| w.label == MAIN_LABEL) {
        out.insert(0, PersistedWindow { label: MAIN_LABEL.into(), workspace_ids: vec![], active_workspace_id: None });
    }
    if let Some(main) = out.iter_mut().find(|w| w.label == MAIN_LABEL) {
        main.workspace_ids.extend(known.iter().filter(|id| !claimed.contains(id)));
    }
    doc.windows = out;
    doc
}

// Merge whatever is held and write it. Runs on a worker or command thread,
// never the main thread.
fn write_merged(app: &AppHandle) -> Result<(), String> {
    // Registry first: it is never taken while SLICES is held.
    let windows = crate::windows::snapshot(app);
    let (mut doc, rejected) = {
        let mut g = SLICES.lock().unwrap_or_else(|e| e.into_inner());
        if !g.dirty {
            return Ok(());
        }
        g.dirty = false;
        merge_slices(&g.by_label, |label, id| windows.owns(label, id))
    };
    for (label, id) in rejected {
        crate::applog::log("warn", "session", &format!("dropped workspace {id} from window {label}: not assigned to it"));
    }
    doc.saved_at = now_ms();
    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    if SLICE_WRITER_PRIMARY {
        let path = session_path(app)?;
        SAVER.submit(json, |j| write_session(app, &path, j))
    } else {
        let path = base_dir(app)?.join(SHADOW_FILE);
        SHADOW_SAVER.submit(json, |j| write_atomic(&path, j))
    }
}

/// Exit-time drain for a slice still inside its debounce window.
fn flush_slices() {
    if let Some(app) = SAVE_APP.get() {
        let _ = write_merged(app);
    }
}

/// A window pushes its slice (its workspaces, active id, uiPrefs). Debounced
/// 800 ms and written off the main thread; `flush` writes now (beforeunload).
#[tauri::command(async)]
pub fn session_put_slice(app: AppHandle, window: tauri::Window, slice: SessionDoc, flush: Option<bool>) -> Result<(), String> {
    let label = window.label().to_string();
    let gen = {
        let mut g = SLICES.lock().unwrap_or_else(|e| e.into_inner());
        *g.puts.entry(label.clone()).or_insert(0) += 1;
        g.by_label.insert(label, slice);
        g.generation += 1;
        g.dirty = true;
        g.generation
    };
    let _ = SAVE_APP.set(app.clone());
    if flush.unwrap_or(false) {
        return write_merged(&app);
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(SLICE_DEBOUNCE_MS));
        let latest = SLICES.lock().unwrap_or_else(|e| e.into_inner()).generation;
        if latest == gen {
            let _ = write_merged(&app);
        }
    });
    Ok(())
}

// Ok(None) means "nothing to restore" — either a first run or safe mode is
// active. Only a genuinely corrupt session.json is an Err.
#[tauri::command(async)]
pub fn load_session(app: AppHandle) -> Result<Option<SessionDoc>, String> {
    if safe_mode_active() {
        return Ok(None);
    }
    // The flag is whatever main reported in window_boot (false until it has).
    let multiwindow = crate::windows::multiwindow_on(&app);
    Ok(read_session_file(&app)?.map(|d| normalize_windows(d, multiwindow)))
}

/// Largest window ordinal baked into persisted workspace and pane ids, so a
/// fresh run never mints an `fw-<n>` whose id partition is already in use.
pub(crate) fn session_id_ordinal_floor(app: &AppHandle) -> u32 {
    let Some(doc) = read_session_file(app).ok().flatten() else { return 0 };
    crate::windows::max_ordinal(doc.workspaces.iter().flat_map(|w| std::iter::once(w.id).chain(w.panes.iter().map(|p| p.id))))
}

/// The slice a secondary boots with: the last one it pushed, else its assigned
/// workspaces cut out of the session document.
pub(crate) fn boot_slice(app: &AppHandle, label: &str, ids: &[u32]) -> Option<SessionDoc> {
    if let Some(s) = SLICES.lock().unwrap_or_else(|e| e.into_inner()).by_label.get(label) {
        return Some(s.clone());
    }
    let mut doc = read_session_file(app).ok().flatten()?;
    let active = doc.windows.iter().find(|w| w.label == label).and_then(|w| w.active_workspace_id);
    doc.workspaces.retain(|w| ids.contains(&w.id));
    doc.active_workspace_id = active.filter(|a| ids.contains(a));
    doc.windows.clear();
    Some(doc)
}

/// A workspace transfer: the new window's slice exists from the moment the
/// workspace is assigned to it, so a crash before its first push loses nothing.
pub(crate) fn seed_slice(label: &str, slice: SessionDoc) {
    let mut g = SLICES.lock().unwrap_or_else(|e| e.into_inner());
    g.by_label.insert(label.to_string(), slice);
    g.generation += 1;
    g.dirty = true;
}

/// Undo `seed_slice` when the window could not be created.
pub(crate) fn drop_slice(label: &str) {
    let mut g = SLICES.lock().unwrap_or_else(|e| e.into_inner());
    if g.by_label.remove(label).is_some() {
        g.generation += 1;
        g.dirty = true;
    }
}

/// Pushes `label` has made so far; see `Slices::puts`.
pub(crate) fn slice_puts(label: &str) -> u64 {
    SLICES.lock().unwrap_or_else(|e| e.into_inner()).puts.get(label).copied().unwrap_or(0)
}

/// Pane model ids in `label`'s last slice (the quit guard counts the live ones).
pub(crate) fn slice_pane_ids(label: &str) -> Vec<u32> {
    let g = SLICES.lock().unwrap_or_else(|e| e.into_inner());
    g.by_label.get(label).map(|s| s.workspaces.iter().flat_map(|w| w.panes.iter().map(|p| p.id)).collect()).unwrap_or_default()
}

/// Does `label`'s last slice hold a workspace other than `moved`?
pub(crate) fn slice_has_other_workspace(label: &str, moved: u32) -> bool {
    let g = SLICES.lock().unwrap_or_else(|e| e.into_inner());
    g.by_label.get(label).is_some_and(|s| s.workspaces.iter().any(|w| w.id != moved))
}

/// A secondary closed or died: drop its slice and fold its workspaces and uiPrefs
/// (pane view, colour, scrollback) into main's, so the next write keeps them until
/// main pushes a slice of its own. Returns the slice.
pub(crate) fn fold_slice_into_main(label: &str) -> Option<SessionDoc> {
    let mut g = SLICES.lock().unwrap_or_else(|e| e.into_inner());
    let dead = fold_slice(&mut g.by_label, label)?;
    g.puts.remove(label);
    g.generation += 1;
    g.dirty = true;
    Some(dead)
}

fn fold_slice(by_label: &mut BTreeMap<String, SessionDoc>, label: &str) -> Option<SessionDoc> {
    let dead = by_label.remove(label)?;
    if let Some(main) = by_label.get_mut(MAIN_LABEL) {
        for w in &dead.workspaces {
            if !main.workspaces.iter().any(|m| m.id == w.id) {
                main.workspaces.push(w.clone());
            }
        }
        let mut prefs = main.ui_prefs.as_object().cloned().unwrap_or_default();
        merge_prefs(&mut prefs, &dead.ui_prefs, false);
        main.ui_prefs = serde_json::Value::Object(prefs);
    }
    Some(dead)
}

// Pane model ids in session.json, for the post-reload PTY reaper (lib.rs).
// None means "could not tell" (no file, unreadable, corrupt): the reaper must
// treat that as unknown, never as an empty doc.
pub(crate) fn session_pane_ids(app: &AppHandle) -> Option<std::collections::HashSet<u32>> {
    let doc = read_session_file(app).ok().flatten()?;
    Some(doc.workspaces.iter().flat_map(|w| w.panes.iter().map(|p| p.id)).collect())
}

// (80) Independent of safe mode: safe mode only suppresses auto-restore, it
// doesn't hide that a previous session exists — the UI can still offer a
// "reopen last session" prompt while safe mode is on.
#[tauri::command(async)]
pub fn has_previous_session(app: AppHandle) -> Result<bool, String> {
    Ok(read_session_file(&app)?.is_some())
}

// ---------------------------------------------------------------------------
// Restore points (200) — last N snapshots taken on every save, restorable.
// ---------------------------------------------------------------------------

fn snapshot(app: &AppHandle, json: &str) -> Result<(), String> {
    let dir = snapshots_dir(app)?;
    let file = dir.join(format!("snapshot-{}.json", now_ms()));
    write_atomic(&file, json)?;
    prune_snapshots(&dir)?;
    Ok(())
}

fn prune_snapshots(dir: &Path) -> Result<(), String> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    entries.sort(); // filenames embed millis (fixed digit count), so lexicographic == chronological
    while entries.len() > MAX_RESTORE_POINTS {
        let oldest = entries.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn list_restore_points(app: AppHandle) -> Result<Vec<RestorePointInfo>, String> {
    let dir = snapshots_dir(&app)?;
    let mut out: Vec<RestorePointInfo> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with("snapshot-") || !name.ends_with(".json") {
                return None;
            }
            let millis: u64 = name
                .trim_start_matches("snapshot-")
                .trim_end_matches(".json")
                .parse()
                .ok()?;
            Some(RestorePointInfo { id: name, saved_at: millis })
        })
        .collect();
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at)); // newest first
    Ok(out)
}

// Reads a restore point's content. Deliberately does NOT overwrite
// session.json — a caller that wants it to become the active session should
// follow up with save_session(doc).
#[tauri::command(async)]
pub fn restore_from_point(app: AppHandle, id: String) -> Result<SessionDoc, String> {
    if id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err("invalid restore point id".into());
    }
    let path = snapshots_dir(&app)?.join(&id);
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| format!("restore point is corrupt: {e}"))
}

// ---------------------------------------------------------------------------
// Backup & restore (201) — export/import everything this module owns as one file.
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn export_backup(app: AppHandle, dest_path: String) -> Result<(), String> {
    crate::pathguard::check(&dest_path)?;
    // Reads the raw file directly (not the `load_session` command) so an
    // explicit export always includes the current session even under safe mode.
    let session = read_session_file(&app)?;

    let points = list_restore_points(app.clone())?;
    let mut snapshots = Vec::with_capacity(points.len());
    for p in points {
        if let Ok(doc) = restore_from_point(app.clone(), p.id.clone()) {
            snapshots.push(SnapshotEntry { id: p.id, doc });
        }
    }

    let bundle = BackupBundle { version: 1, exported_at: now_ms(), session, snapshots };
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    fs::write(&dest_path, json).map_err(|e| e.to_string())
}

// Returns the restored session (if the backup had one) so the caller can load
// it straight into the store without a second round trip.
#[tauri::command(async)]
pub fn import_backup(app: AppHandle, src_path: String) -> Result<Option<SessionDoc>, String> {
    crate::pathguard::check(&src_path)?;
    let s = fs::read_to_string(&src_path).map_err(|e| e.to_string())?;
    let bundle: BackupBundle =
        serde_json::from_str(&s).map_err(|e| format!("backup file is corrupt: {e}"))?;

    if let Some(session) = &bundle.session {
        let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
        // Same tmp file as autosave: hold the writer lock so they can't interleave.
        let _w = SAVER.writing.lock().unwrap_or_else(|e| e.into_inner());
        write_atomic(&session_path(&app)?, &json)?;
    }

    let dir = snapshots_dir(&app)?;
    for entry in &bundle.snapshots {
        if entry.id.contains("..") || entry.id.contains('/') || entry.id.contains('\\') {
            continue;
        }
        let json = serde_json::to_string_pretty(&entry.doc).map_err(|e| e.to_string())?;
        write_atomic(&dir.join(&entry.id), &json)?;
    }

    Ok(bundle.session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fd-persist-{tag}-{}-{}", std::process::id(), now_ms()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_atomic_replaces_and_leaves_no_tmp() {
        let d = tmp_dir("atomic");
        let f = d.join("session.json");
        write_atomic(&f, "one").unwrap();
        write_atomic(&f, "two").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "two");
        assert!(!f.with_extension("tmp").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn failed_write_leaves_previous_file_intact() {
        let d = tmp_dir("fail");
        let f = d.join("session.json");
        write_atomic(&f, "good").unwrap();
        // Block the temp path with a directory so the write step fails.
        fs::create_dir(f.with_extension("tmp")).unwrap();
        assert!(write_atomic(&f, "bad").is_err());
        assert_eq!(fs::read_to_string(&f).unwrap(), "good");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn failed_rename_does_not_touch_other_files() {
        let d = tmp_dir("rename");
        let f = d.join("session.json");
        write_atomic(&f, "good").unwrap();
        // Destination is a directory: tmp write succeeds, rename fails.
        let dest_dir = d.join("dest");
        fs::create_dir(&dest_dir).unwrap();
        assert!(write_atomic(&dest_dir, "bad").is_err());
        assert_eq!(fs::read_to_string(&f).unwrap(), "good");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn coalescer_keeps_only_latest_pending() {
        let c = Arc::new(Coalescer::new());
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let (gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();

        // First save blocks inside its write until released.
        let t1 = {
            let (c, w, n) = (c.clone(), written.clone(), calls.clone());
            std::thread::spawn(move || {
                c.submit("first".into(), |j| {
                    n.fetch_add(1, Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    gate_rx.recv().unwrap();
                    w.lock().unwrap().push(j.to_string());
                    Ok(())
                })
            })
        };
        started_rx.recv().unwrap();

        // Five more arrive while it is in flight; only the last may be written.
        let mut handles = Vec::new();
        for i in 0..5 {
            let (c, w, n) = (c.clone(), written.clone(), calls.clone());
            handles.push(std::thread::spawn(move || {
                c.submit(format!("p{i}"), |j| {
                    n.fetch_add(1, Ordering::SeqCst);
                    w.lock().unwrap().push(j.to_string());
                    Ok(())
                })
            }));
            // Let each park its payload before the next so ordering is deterministic.
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        gate_tx.send(()).unwrap();
        t1.join().unwrap().unwrap();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        assert_eq!(*written.lock().unwrap(), vec!["first".to_string(), "p4".to_string()]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn wait_idle_writes_a_parked_save() {
        let c = Coalescer::new();
        *c.pending.lock().unwrap() = Some("parked".into());
        let mut got = String::new();
        c.wait_idle(|j| { got = j.into(); Ok(()) });
        assert_eq!(got, "parked");
        assert!(c.pending.lock().unwrap().is_none());
        // Nothing parked: no write.
        c.wait_idle(|_| panic!("unexpected write"));
    }

    #[test]
    fn coalescer_error_does_not_poison_later_saves() {
        let c = Coalescer::new();
        assert!(c.submit("a".into(), |_| Err("boom".into())).is_err());
        let mut got = String::new();
        c.submit("b".into(), |j| { got = j.into(); Ok(()) }).unwrap();
        assert_eq!(got, "b");
    }

    fn ws(id: u32, pane: u32) -> PersistedWorkspace {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": format!("w{id}"), "root": "C:\\r",
            "panes": [{ "id": pane, "vendor": "claude", "cwd": "C:\\r" }]
        }))
        .unwrap()
    }

    fn slice(workspaces: Vec<PersistedWorkspace>, active: Option<u32>, prefs: serde_json::Value) -> SessionDoc {
        SessionDoc {
            version: 1,
            saved_at: 0,
            active_workspace_id: active,
            workspaces,
            ui_prefs: prefs,
            windows: vec![],
        }
    }

    #[test]
    fn merge_unions_workspaces_and_builds_window_table() {
        let mut m = BTreeMap::new();
        m.insert("main".to_string(), slice(vec![ws(1, 10)], Some(1), serde_json::json!({})));
        m.insert("fw-1".to_string(), slice(vec![ws(2, 20)], Some(2), serde_json::json!({})));
        let (doc, rejected) = merge_slices(&m, |_, _| true);
        assert!(rejected.is_empty());
        assert_eq!(doc.workspaces.iter().map(|w| w.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(doc.active_workspace_id, Some(1));
        assert_eq!(doc.windows[0], PersistedWindow { label: "main".into(), workspace_ids: vec![1], active_workspace_id: Some(1) });
        assert_eq!(doc.windows[1].label, "fw-1");
    }

    #[test]
    fn merge_rejects_foreign_workspaces_and_dedupes() {
        let mut m = BTreeMap::new();
        m.insert("main".to_string(), slice(vec![ws(1, 10)], Some(1), serde_json::json!({})));
        m.insert("fw-1".to_string(), slice(vec![ws(1, 10), ws(2, 20)], Some(2), serde_json::json!({})));
        // Only main owns anything.
        let (doc, rejected) = merge_slices(&m, |l, _| l == MAIN_LABEL);
        assert_eq!(doc.workspaces.len(), 1);
        assert_eq!(rejected, vec![("fw-1".to_string(), 1), ("fw-1".to_string(), 2)]);
        assert!(doc.windows[1].workspace_ids.is_empty());
        // A registry that assigns ws 1 to both still yields it once, to main.
        let (doc, _) = merge_slices(&m, |_, id| id == 1 || id == 2);
        assert_eq!(doc.workspaces.iter().map(|w| w.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(doc.windows[1].workspace_ids, vec![2]);
    }

    #[test]
    fn merge_prefs_union_across_labels_replace_within_label() {
        let mut m = BTreeMap::new();
        m.insert("main".to_string(), slice(vec![], None, serde_json::json!({
            "groups": [{ "id": 1 }], "summary": [{ "p": 1 }], "scrollback": { "10": "a" }, "paneColor": { "10": "red" }
        })));
        m.insert("fw-1".to_string(), slice(vec![], None, serde_json::json!({
            "groups": [{ "id": 9 }], "summary": [{ "p": 2 }], "scrollback": { "20": "b" }, "paneColor": { "20": "blue" }
        })));
        let (doc, _) = merge_slices(&m, |_, _| true);
        let p = &doc.ui_prefs;
        assert_eq!(p["groups"], serde_json::json!([{ "id": 1 }]));
        assert_eq!(p["summary"], serde_json::json!([{ "p": 1 }, { "p": 2 }]));
        assert_eq!(p["scrollback"], serde_json::json!({ "10": "a", "20": "b" }));
        assert_eq!(p["paneColor"], serde_json::json!({ "10": "red", "20": "blue" }));
        // Re-putting a label replaces its old slice (a dropped pane's scrollback goes).
        m.insert("fw-1".to_string(), slice(vec![], None, serde_json::json!({ "scrollback": {} })));
        let (doc, _) = merge_slices(&m, |_, _| true);
        assert_eq!(doc.ui_prefs["scrollback"], serde_json::json!({ "10": "a" }));
    }

    #[test]
    fn folding_a_window_keeps_its_workspaces_and_pane_prefs_in_main() {
        let mut m = BTreeMap::new();
        m.insert("main".to_string(), slice(vec![ws(1, 10)], Some(1), serde_json::json!({
            "groups": [{ "id": 1 }], "scrollback": { "10": "a" }, "paneColor": { "10": "red" }
        })));
        m.insert("fw-1".to_string(), slice(vec![ws(2, 20)], Some(2), serde_json::json!({
            "groups": [{ "id": 9 }], "scrollback": { "20": "b", "10": "stale" },
            "paneChat": { "20": { "view": "chat" } }, "paneColor": { "20": "blue" }
        })));
        let dead = fold_slice(&mut m, "fw-1").expect("slice existed");
        assert_eq!(dead.workspaces.len(), 1);
        assert!(!m.contains_key("fw-1"));
        let main = &m["main"];
        assert_eq!(main.workspaces.iter().map(|w| w.id).collect::<Vec<_>>(), vec![1, 2]);
        let p = &main.ui_prefs;
        assert_eq!(p["paneChat"], serde_json::json!({ "20": { "view": "chat" } }), "view survives the fold");
        assert_eq!(p["paneColor"], serde_json::json!({ "10": "red", "20": "blue" }), "colour survives the fold");
        assert_eq!(p["scrollback"], serde_json::json!({ "10": "a", "20": "b" }), "main's own scrollback wins a clash");
        assert_eq!(p["groups"], serde_json::json!([{ "id": 1 }]), "groups stay main's");
        assert!(fold_slice(&mut m, "fw-1").is_none(), "a second fold finds nothing");
    }

    // S6b: a single-window save through the slice writer yields the same
    // document as the old save_session path (same workspaces, activeWorkspaceId, uiPrefs).
    #[test]
    fn single_window_slice_matches_the_old_save_path() {
        let prefs = serde_json::json!({
            "groups": [{ "id": 1 }], "summary": [{ "p": 1 }],
            "scrollback": { "10": "a" }, "paneChat": { "10": { "view": "chat" } }, "paneColor": { "10": "red" }
        });
        let draft = slice(vec![ws(1, 10), ws(2, 20)], Some(2), prefs);
        // Old path: save_session stamps version and savedAt on the draft as-is.
        let old = serde_json::to_value(&draft).unwrap();
        let mut m = BTreeMap::new();
        m.insert("main".to_string(), draft);
        let (new, rejected) = merge_slices(&m, |l, _| l == MAIN_LABEL);
        assert!(rejected.is_empty());
        let new = serde_json::to_value(&new).unwrap();
        for k in ["workspaces", "activeWorkspaceId", "uiPrefs"] {
            assert_eq!(old[k], new[k], "{k} differs");
        }
        assert_eq!(new["windows"][0]["workspaceIds"], serde_json::json!([1, 2]));
    }

    // The v1 reader, as it was before `windows` existed: no deny_unknown_fields.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct V1Doc {
        #[serde(default)]
        active_workspace_id: Option<u32>,
        #[serde(default)]
        workspaces: Vec<PersistedWorkspace>,
        #[serde(default)]
        ui_prefs: serde_json::Value,
    }

    #[test]
    fn v2_json_parses_in_the_v1_struct() {
        let mut m = BTreeMap::new();
        m.insert("main".to_string(), slice(vec![ws(1, 10)], Some(1), serde_json::json!({ "x": 1 })));
        let (doc, _) = merge_slices(&m, |_, _| true);
        let json = serde_json::to_string_pretty(&doc).unwrap();
        assert!(json.contains("\"windows\""));
        let v1: V1Doc = serde_json::from_str(&json).unwrap();
        assert_eq!(v1.workspaces.len(), 1);
        assert_eq!(v1.active_workspace_id, Some(1));
        assert_eq!(v1.ui_prefs["x"], 1);
        // And an old doc (no windows key) loads into v2 with an empty table.
        let old: SessionDoc = serde_json::from_str(r#"{"workspaces":[]}"#).unwrap();
        assert!(old.windows.is_empty());
    }

    #[test]
    fn normalize_flag_off_puts_everything_in_main() {
        let mut d = slice(vec![ws(1, 10), ws(2, 20)], Some(2), serde_json::Value::Null);
        d.windows = vec![
            PersistedWindow { label: "main".into(), workspace_ids: vec![1], active_workspace_id: Some(1) },
            PersistedWindow { label: "fw-1".into(), workspace_ids: vec![2], active_workspace_id: Some(2) },
        ];
        let d = normalize_windows(d, false);
        assert_eq!(d.windows, vec![PersistedWindow { label: "main".into(), workspace_ids: vec![1, 2], active_workspace_id: Some(2) }]);
    }

    #[test]
    fn normalize_flag_on_validates_windows() {
        let mut d = slice(vec![ws(1, 10), ws(2, 20), ws(3, 30)], None, serde_json::Value::Null);
        d.windows = vec![
            PersistedWindow { label: "fw-1".into(), workspace_ids: vec![2, 99], active_workspace_id: Some(99) },
            PersistedWindow { label: "fw-2".into(), workspace_ids: vec![99], active_workspace_id: None }, // never booted
        ];
        let d = normalize_windows(d, true);
        let labels: Vec<_> = d.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, vec!["main", "fw-1"]);
        assert_eq!(d.windows[0].workspace_ids, vec![1, 3]); // unclaimed go to main
        assert_eq!(d.windows[1].workspace_ids, vec![2]); // unknown 99 dropped
        assert_eq!(d.windows[1].active_workspace_id, None);
    }
}
