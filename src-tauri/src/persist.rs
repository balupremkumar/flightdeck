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

use std::fs;
use std::path::{Path, PathBuf};
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
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspace {
    pub id: u32,
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub panes: Vec<PersistedPane>,
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

#[tauri::command]
pub fn save_session(app: AppHandle, mut doc: SessionDoc) -> Result<(), String> {
    doc.version = default_version();
    doc.saved_at = now_ms();
    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;

    write_atomic(&session_path(&app)?, &json)?;
    snapshot(&app, &json)?;
    Ok(())
}

// Ok(None) means "nothing to restore" — either a first run or safe mode is
// active. Only a genuinely corrupt session.json is an Err.
#[tauri::command]
pub fn load_session(app: AppHandle) -> Result<Option<SessionDoc>, String> {
    if safe_mode_active() {
        return Ok(None);
    }
    read_session_file(&app)
}

// (80) Independent of safe mode: safe mode only suppresses auto-restore, it
// doesn't hide that a previous session exists — the UI can still offer a
// "reopen last session" prompt while safe mode is on.
#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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

#[tauri::command]
pub fn export_backup(app: AppHandle, dest_path: String) -> Result<(), String> {
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
#[tauri::command]
pub fn import_backup(app: AppHandle, src_path: String) -> Result<Option<SessionDoc>, String> {
    let s = fs::read_to_string(&src_path).map_err(|e| e.to_string())?;
    let bundle: BackupBundle =
        serde_json::from_str(&s).map_err(|e| format!("backup file is corrupt: {e}"))?;

    if let Some(session) = &bundle.session {
        let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
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
