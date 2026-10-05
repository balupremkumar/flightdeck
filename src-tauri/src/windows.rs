//! Window registry (Phase 4 S7): which window owns which workspace, window
//! ordinals for the pane-id partition, and the heartbeat watcher that re-adopts a
//! dead secondary into main.
//!
//! Labels are `main` and `fw-<n>`, minted here only. A label arriving from JS goes
//! through `validate_label`. The decision logic is plain data so it is unit
//! tested without a window; the commands and the watcher thread at the bottom are
//! thin wrappers.

// Minting, the exiting flag and the geometry-free helpers are used by S8 onward.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::persist::{self, SessionDoc};

pub const MAIN: &str = "main";
/// JS sends `window_heartbeat` this often.
pub const HEARTBEAT_EVERY_MS: u64 = 2_000;
/// A booted secondary silent this long is treated as a dead webview.
pub const HEARTBEAT_TIMEOUT_MS: u64 = 8_000;
const WATCH_TICK_MS: u64 = 2_000;
/// Pane/workspace/group ids are `(ordinal << 24) | local`; keeping the ordinal
/// at 127 or below keeps every id inside a signed 32-bit int.
pub const MAX_ORDINAL: u32 = 127;

pub(crate) fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowRec {
    pub workspace_ids: Vec<u32>,
    pub active_ws: Option<u32>,
    pub booted: bool,
    pub last_focus_ms: u64,
    pub last_heartbeat_ms: u64,
    pub ordinal: u32,
    /// Last `attention_report` from this window (S10).
    pub attention: Option<AttentionReport>,
}

/// The window's most urgent attention item. JS owns the ranking; Rust only
/// compares the tuple `(kind_rank, since, ws_id, pane_id)`, smallest wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionTop {
    #[serde(alias = "kind_rank")]
    pub kind_rank: u32,
    pub since: u64,
    #[serde(alias = "ws_id")]
    pub ws_id: u32,
    #[serde(alias = "pane_id")]
    pub pane_id: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttentionReport {
    pub count: u32,
    pub top: Option<AttentionTop>,
}

#[derive(Clone, Debug)]
pub struct WindowRegistry {
    pub windows: BTreeMap<String, WindowRec>,
    pub next_ordinal: u32,
    pub exiting: bool,
    /// The `flightdeck-multiwindow` flag as main last reported it at boot.
    pub multiwindow: bool,
    /// Windows the last summon dismiss hid; the next bring shows only these.
    pub summon_hidden: Vec<String>,
}

impl Default for WindowRegistry {
    fn default() -> Self {
        WindowRegistry { windows: BTreeMap::new(), next_ordinal: 1, exiting: false, multiwindow: false, summon_hidden: Vec::new() }
    }
}

/// `main` or `fw-<n>` with n in 1..=MAX_ORDINAL and no leading zero. Returns the
/// ordinal (main is 0).
pub fn validate_label(label: &str) -> Result<u32, String> {
    if label == MAIN {
        return Ok(0);
    }
    let n = label.strip_prefix("fw-").ok_or_else(|| format!("bad window label {label:?}"))?;
    if n.is_empty() || n.starts_with('0') || !n.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("bad window label {label:?}"));
    }
    match n.parse::<u32>() {
        Ok(v) if (1..=MAX_ORDINAL).contains(&v) => Ok(v),
        _ => Err(format!("bad window label {label:?}")),
    }
}

/// Largest window ordinal already baked into persisted ids.
pub fn max_ordinal(ids: impl IntoIterator<Item = u32>) -> u32 {
    ids.into_iter().map(|i| i >> 24).max().unwrap_or(0)
}

impl WindowRegistry {
    /// Does `label` own workspace `ws_id`? A workspace belongs to the window that
    /// lists it; main owns every workspace nobody else lists.
    pub fn owns(&self, label: &str, ws_id: u32) -> bool {
        let holder = self.windows.iter().find(|(_, r)| r.workspace_ids.contains(&ws_id)).map(|(l, _)| l.as_str());
        match holder {
            Some(h) => h == label,
            None => label == MAIN,
        }
    }

    /// Make sure main is registered (it is created by tauri.conf.json, not minted).
    pub fn ensure_main(&mut self) -> &mut WindowRec {
        self.windows.entry(MAIN.to_string()).or_default()
    }

    /// Mint the next `fw-<n>` label. Ordinals only go up so a moved workspace's
    /// ids can never be minted again by a later window.
    pub fn mint_label(&mut self) -> Result<String, String> {
        if self.next_ordinal > MAX_ORDINAL {
            return Err("no window ordinals left".into());
        }
        let ordinal = self.next_ordinal;
        self.next_ordinal += 1;
        let label = format!("fw-{ordinal}");
        self.windows.insert(label.clone(), WindowRec { ordinal, ..WindowRec::default() });
        Ok(label)
    }

    /// Raise `next_ordinal` past ordinals that persisted ids already use.
    pub fn floor_ordinal(&mut self, used: u32) {
        self.next_ordinal = self.next_ordinal.max(used + 1);
    }

    /// Move every workspace of `label` to main and forget the window. Returns
    /// the moved ids and the active workspace the window had.
    pub fn adopt_into_main(&mut self, label: &str) -> Option<(Vec<u32>, Option<u32>)> {
        if label == MAIN {
            return None;
        }
        let rec = self.windows.remove(label)?;
        let main = self.ensure_main();
        for id in &rec.workspace_ids {
            if !main.workspace_ids.contains(id) {
                main.workspace_ids.push(*id);
            }
        }
        Some((rec.workspace_ids, rec.active_ws))
    }

    /// Store (replace, never add) one window's report. Unknown labels are refused.
    pub fn set_attention(&mut self, label: &str, report: AttentionReport) -> bool {
        match self.windows.get_mut(label) {
            Some(r) => {
                r.attention = Some(report);
                true
            }
            None => false,
        }
    }

    /// Global badge count and the window holding the global top item. Reports
    /// replace per label, so a resend is idempotent. If two windows claim the
    /// same top tuple (mid-transfer), the one that owns the workspace wins, then
    /// the lower label.
    pub fn global_attention(&self) -> (u32, Option<(String, AttentionTop)>) {
        let count = self.windows.values().filter_map(|r| r.attention).fold(0u32, |a, r| a.saturating_add(r.count));
        let top = self
            .windows
            .iter()
            .filter_map(|(l, r)| r.attention.and_then(|a| a.top).map(|t| (l, t)))
            .min_by_key(|(l, t)| ((t.kind_rank, t.since, t.ws_id, t.pane_id), !self.owns(l, t.ws_id), (*l).clone()))
            .map(|(l, t)| (l.clone(), t));
        (count, top)
    }

    pub fn heartbeat(&mut self, label: &str, now: u64) {
        if let Some(r) = self.windows.get_mut(label) {
            r.last_heartbeat_ms = now;
        }
    }

    /// Transfer step 1: mint a window for workspace `ws_id` and make it the only
    /// owner. The source keeps no claim, so from here persist drops any slice data
    /// the source still pushes for it. Errors if `source` does not own the workspace.
    pub fn assign_new_window(&mut self, source: &str, ws_id: u32) -> Result<String, String> {
        if !self.owns(source, ws_id) {
            return Err(format!("window {source} does not own workspace {ws_id}"));
        }
        let label = self.mint_label()?;
        for r in self.windows.values_mut() {
            r.workspace_ids.retain(|i| *i != ws_id);
            if r.active_ws == Some(ws_id) {
                r.active_ws = None;
            }
        }
        let rec = self.windows.get_mut(&label).expect("minted above");
        rec.workspace_ids = vec![ws_id];
        rec.active_ws = Some(ws_id);
        Ok(label)
    }

    /// The new window could not be created: forget it and give the workspace back.
    pub fn rollback_new_window(&mut self, label: &str, source: &str, ws_id: u32) {
        self.windows.remove(label);
        if let Some(r) = self.windows.get_mut(source) {
            if !r.workspace_ids.contains(&ws_id) {
                r.workspace_ids.push(ws_id);
            }
        }
    }
}

/// Window to focus after `current` in a stable ring: main first, then `fw-<n>`
/// by ordinal. None when there is nowhere else to go.
pub fn next_label(labels: &[String], current: &str) -> Option<String> {
    let mut ring: Vec<&String> = labels.iter().collect();
    ring.sort_by_key(|l| validate_label(l).unwrap_or(u32::MAX));
    if ring.len() < 2 {
        return None;
    }
    let at = ring.iter().position(|l| l.as_str() == current).unwrap_or(ring.len() - 1);
    Some(ring[(at + 1) % ring.len()].clone())
}

/// Which secondaries are dead: booted, `fw-*`, and silent past the timeout.
/// Never main. Nothing is judged while the app is exiting.
pub fn dead_windows(reg: &WindowRegistry, now: u64) -> Vec<String> {
    if reg.exiting {
        return Vec::new();
    }
    reg.windows
        .iter()
        .filter(|(l, r)| l.as_str() != MAIN && r.booted && now.saturating_sub(r.last_heartbeat_ms) > HEARTBEAT_TIMEOUT_MS)
        .map(|(l, _)| l.clone())
        .collect()
}

/// Managed state (beside `Registry` in lib.rs).
#[derive(Default)]
pub struct WindowState(pub Mutex<WindowRegistry>);

impl WindowState {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, WindowRegistry> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    pub label: String,
    pub ordinal: u32,
    /// The workspaces assigned to this window. None for main, which loads the
    /// session document itself.
    pub slice: Option<SessionDoc>,
    /// Set for a window created by a workspace transfer, once: the workspace and
    /// its per-pane terminal snapshots exactly as the source handed them over.
    pub transfer: Option<serde_json::Value>,
}

/// Transfers waiting for their new window's `window_boot`, by label. Kept out of
/// the registry because it holds serialised terminals (up to ~1 MB a pane) and the
/// registry is cloned on every session write.
static PENDING: Mutex<Option<HashMap<String, serde_json::Value>>> = Mutex::new(None);

fn pending_put(label: &str, v: serde_json::Value) {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(label.to_string(), v);
}

fn pending_take(label: &str) -> Option<serde_json::Value> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|m| m.remove(label))
}

/// Registry copy for `persist` to decide slice ownership against.
pub fn snapshot(app: &AppHandle) -> WindowRegistry {
    app.state::<WindowState>().lock().clone()
}

pub fn multiwindow_on(app: &AppHandle) -> bool {
    app.state::<WindowState>().lock().multiwindow
}

/// A webview (re)load restarts its heartbeat clock, so a reload is not mistaken
/// for a crash.
pub fn on_webview_load(app: &AppHandle, label: &str) {
    app.state::<WindowState>().lock().heartbeat(label, now_ms());
}

#[tauri::command(async)]
pub fn window_boot(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, WindowState>,
    multiwindow: bool,
) -> Result<BootInfo, String> {
    let label = window.label().to_string();
    let ordinal = validate_label(&label)?;
    let floor = persist::session_id_ordinal_floor(&app);
    let ids = {
        let mut reg = state.lock();
        let now = now_ms();
        if label == MAIN {
            reg.multiwindow = multiwindow;
            reg.floor_ordinal(floor);
            reg.ensure_main();
        } else if !reg.windows.contains_key(&label) {
            // Only Rust mints secondaries; a label nobody minted is refused.
            return Err(format!("window {label} was not created by Flightdeck"));
        }
        let rec = reg.windows.get_mut(&label).expect("registered above");
        rec.ordinal = ordinal;
        rec.booted = true;
        rec.last_heartbeat_ms = now;
        rec.last_focus_ms = now;
        rec.workspace_ids.clone()
    };
    let slice = if label == MAIN { None } else { persist::boot_slice(&app, &label, &ids) };
    let transfer = if label == MAIN { None } else { pending_take(&label) };
    Ok(BootInfo { label, ordinal, slice, transfer })
}

/// What the source window sends to `ws_transfer`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsSnapshot {
    pub workspace_id: u32,
    /// Handed to the target's `window_boot` untouched.
    pub transfer: serde_json::Value,
    /// Persisted-shape slice, so the document keeps the workspace if the new
    /// window dies before its first push.
    pub slice: SessionDoc,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransferTarget {
    New,
}

/// Move a workspace to a new window. Rust assigns it to the new label and parks the
/// snapshot, then creates the window; the target reads both in `window_boot`.
/// The source releases its panes and detaches AFTER this returns.
///
/// Async is mandatory: creating a window from a sync command deadlocks on Windows
/// (tauri docs, wry#583). Focus is taken here and nowhere else because the user
/// just ran the command that opened this window.
#[tauri::command]
pub async fn ws_transfer(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, WindowState>,
    ws_snapshot: WsSnapshot,
    target: TransferTarget,
) -> Result<String, String> {
    let TransferTarget::New = target;
    let source = window.label().to_string();
    validate_label(&source)?;
    let ws_id = ws_snapshot.workspace_id;
    let label = {
        let mut reg = state.lock();
        reg.ensure_main();
        reg.assign_new_window(&source, ws_id)?
    };
    persist::seed_slice(&label, ws_snapshot.slice);
    pending_put(&label, ws_snapshot.transfer);
    if let Err(e) = create_window(&app, &label) {
        pending_take(&label);
        persist::drop_slice(&label);
        state.lock().rollback_new_window(&label, &source, ws_id);
        crate::applog::log("error", "window", &format!("ws_transfer: could not create {label}: {e}"));
        return Err(e);
    }
    crate::applog::log("info", "window", &format!("workspace {ws_id} moved from {source} to new window {label}"));
    Ok(label)
}

fn create_window(app: &AppHandle, label: &str) -> Result<(), String> {
    // Same minimum as tauri.conf.json; created hidden, shown once built.
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Flightdeck")
        .inner_size(1200.0, 800.0)
        .min_inner_size(940.0, 620.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

/// Focus the next window in the ring (the "Next window" chord). A direct reply to
/// the user's keypress, so taking focus here is allowed.
#[tauri::command]
pub async fn window_focus_next(app: AppHandle, window: tauri::Window, state: State<'_, WindowState>) -> Result<Option<String>, String> {
    let labels: Vec<String> = {
        let reg = state.lock();
        reg.windows.iter().filter(|(l, r)| r.booted && app.get_webview_window(l).is_some()).map(|(l, _)| l.clone()).collect()
    };
    let Some(next) = next_label(&labels, window.label()) else { return Ok(None) };
    if let Some(w) = app.get_webview_window(&next) {
        let _ = w.unminimize();
        let _ = w.show();
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(Some(next))
}

#[tauri::command(async)]
pub fn window_heartbeat(window: tauri::Window, state: State<'_, WindowState>) {
    state.lock().heartbeat(window.label(), now_ms());
}

/// Each window reports its own attention count and top item when its queue
/// changes. Rust merges across windows and puts the global count on every
/// window's taskbar overlay. Never focuses anything.
#[tauri::command(async)]
pub fn attention_report(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, WindowState>,
    count: u32,
    top: Option<AttentionTop>,
) -> Result<(), String> {
    validate_label(window.label())?;
    let total = {
        let mut reg = state.lock();
        if !reg.set_attention(window.label(), AttentionReport { count, top }) {
            return Err(format!("window {} is not registered", window.label()));
        }
        reg.global_attention().0
    };
    crate::overlay::apply_all(&app, total);
    Ok(())
}

pub const FOCUS_PANE_EVENT: &str = "app://focus-pane";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusPanePayload {
    ws_id: u32,
    pane_id: u32,
}

/// Is `label` a registered window? Validates the shape first.
pub fn check_registered(reg: &WindowRegistry, label: &str) -> Result<(), String> {
    validate_label(label)?;
    if reg.windows.contains_key(label) {
        Ok(())
    } else {
        Err(format!("window {label} is not registered"))
    }
}

/// Focus `label` and ask it to select a pane. Only for a user click or a
/// notification click inside/from Flightdeck.
#[tauri::command(async)]
pub fn window_focus_pane(
    app: AppHandle,
    state: State<'_, WindowState>,
    label: String,
    ws_id: u32,
    pane_id: u32,
) -> Result<(), String> {
    check_registered(&state.lock(), &label)?;
    let win = app.get_webview_window(&label).ok_or_else(|| format!("window {label} has no webview"))?;
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    if let Some(r) = state.lock().windows.get_mut(&label) {
        r.last_focus_ms = now_ms();
    }
    app.emit_to(label.as_str(), FOCUS_PANE_EVENT, FocusPanePayload { ws_id, pane_id }).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdoptPayload {
    from: String,
    workspace_ids: Vec<u32>,
    active_ws: Option<u32>,
    slice: Option<SessionDoc>,
}

/// Re-adopt a dead secondary into main and destroy it. Never called for main.
fn reap_window(app: &AppHandle, label: &str) {
    let adopted = app.state::<WindowState>().lock().adopt_into_main(label);
    let Some((workspace_ids, active_ws)) = adopted else { return };
    let slice = persist::fold_slice_into_main(label);
    crate::applog::log(
        "warn",
        "window",
        &format!("window {label} silent for {}s: re-adopting {} workspace(s) into main", HEARTBEAT_TIMEOUT_MS / 1000, workspace_ids.len()),
    );
    let _ = app.emit_to(MAIN, "win://adopt", AdoptPayload { from: label.to_string(), workspace_ids, active_ws, slice });
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.destroy();
    }
}

pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(WATCH_TICK_MS));
        let dead = dead_windows(&app.state::<WindowState>().lock(), now_ms());
        for label in dead {
            reap_window(&app, &label);
        }
    });
}

/// Rows for the support bundle: the registry as it stands.
pub fn support_rows(reg: &WindowRegistry, now: u64) -> Vec<crate::support::SupportWindow> {
    reg.windows
        .iter()
        .map(|(l, r)| crate::support::SupportWindow {
            label: l.clone(),
            ordinal: r.ordinal,
            workspace_ids: r.workspace_ids.clone(),
            booted: r.booted,
            heartbeat_age_ms: if r.last_heartbeat_ms == 0 { None } else { Some(now.saturating_sub(r.last_heartbeat_ms)) },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ids: &[u32], booted: bool, hb: u64) -> WindowRec {
        WindowRec { workspace_ids: ids.to_vec(), booted, last_heartbeat_ms: hb, ..WindowRec::default() }
    }

    #[test]
    fn labels_are_validated() {
        assert_eq!(validate_label("main"), Ok(0));
        assert_eq!(validate_label("fw-1"), Ok(1));
        assert_eq!(validate_label("fw-127"), Ok(127));
        for bad in ["", "fw-", "fw-0", "fw-01", "fw-128", "fw-1x", "fw--1", "FW-1", "main ", "fw-1/../x", "other"] {
            assert!(validate_label(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn minting_only_goes_up_and_caps() {
        let mut r = WindowRegistry::default();
        assert_eq!(r.mint_label().unwrap(), "fw-1");
        assert_eq!(r.mint_label().unwrap(), "fw-2");
        r.windows.remove("fw-1");
        assert_eq!(r.mint_label().unwrap(), "fw-3", "a freed ordinal is never reused");
        r.floor_ordinal(10);
        assert_eq!(r.mint_label().unwrap(), "fw-11");
        r.next_ordinal = MAX_ORDINAL;
        assert_eq!(r.mint_label().unwrap(), "fw-127");
        assert!(r.mint_label().is_err());
    }

    #[test]
    fn max_ordinal_reads_the_partition() {
        assert_eq!(max_ordinal([5, 9]), 0);
        assert_eq!(max_ordinal([5, (3 << 24) | 7, (2 << 24) | 1]), 3);
        assert_eq!(max_ordinal([]), 0);
    }

    #[test]
    fn main_owns_whatever_nobody_else_lists() {
        let mut r = WindowRegistry::default();
        r.ensure_main();
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        assert!(r.owns("main", 1));
        assert!(!r.owns("main", 2), "assigned elsewhere");
        assert!(r.owns("fw-1", 2));
        assert!(!r.owns("fw-1", 1), "fw-1 owns only what it lists");
        assert!(!r.owns("fw-2", 2));
    }

    #[test]
    fn adopt_moves_ids_to_main_and_drops_the_window() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[1], true, 0));
        let mut w = rec(&[2, 3], true, 0);
        w.active_ws = Some(3);
        r.windows.insert("fw-1".into(), w);
        assert_eq!(r.adopt_into_main("fw-1"), Some((vec![2, 3], Some(3))));
        assert_eq!(r.windows["main"].workspace_ids, vec![1, 2, 3]);
        assert!(!r.windows.contains_key("fw-1"));
        assert_eq!(r.adopt_into_main("main"), None, "main is never adopted");
        assert_eq!(r.adopt_into_main("fw-9"), None);
    }

    #[test]
    fn silent_booted_secondary_is_dead_main_never() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[1], true, 0)); // silent for ever
        r.windows.insert("fw-1".into(), rec(&[2], true, 1_000));
        r.windows.insert("fw-2".into(), rec(&[3], true, 5_000));
        r.windows.insert("fw-3".into(), rec(&[4], false, 0)); // never booted: the boot watchdog's job
        let now = 1_000 + HEARTBEAT_TIMEOUT_MS + 1;
        assert_eq!(dead_windows(&r, now), vec!["fw-1".to_string()]);
        assert!(dead_windows(&r, 1_000 + HEARTBEAT_TIMEOUT_MS).is_empty(), "exactly at the limit is still alive");
        assert_eq!(dead_windows(&r, 5_000 + HEARTBEAT_TIMEOUT_MS + 1), vec!["fw-1".to_string(), "fw-2".to_string()]);
        r.exiting = true;
        assert!(dead_windows(&r, u64::MAX).is_empty(), "nothing is judged while exiting");
    }

    #[test]
    fn heartbeat_revives_and_ignores_unknown() {
        let mut r = WindowRegistry::default();
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        r.heartbeat("fw-1", 50_000);
        r.heartbeat("fw-9", 50_000);
        assert!(dead_windows(&r, 50_000 + HEARTBEAT_TIMEOUT_MS).is_empty());
        assert!(!r.windows.contains_key("fw-9"));
    }

    #[test]
    fn transfer_assigns_the_workspace_to_a_fresh_window_only() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[1, 2], true, 0));
        r.windows.get_mut("main").unwrap().active_ws = Some(2);
        let label = r.assign_new_window("main", 2).unwrap();
        assert_eq!(label, "fw-1");
        assert_eq!(r.windows["fw-1"].workspace_ids, vec![2]);
        assert_eq!(r.windows["fw-1"].active_ws, Some(2));
        assert_eq!(r.windows["main"].workspace_ids, vec![1], "the source keeps no claim");
        assert_eq!(r.windows["main"].active_ws, None);
        assert!(r.owns("fw-1", 2) && !r.owns("main", 2), "persist now rejects the source's slice data for it");
        assert!(!r.windows["fw-1"].booted, "booted only when window_boot arrives");
    }

    #[test]
    fn transfer_works_for_a_workspace_main_owns_by_default_and_refuses_foreign_ones() {
        let mut r = WindowRegistry::default();
        r.ensure_main();
        r.windows.insert("fw-1".into(), rec(&[5], true, 0));
        r.next_ordinal = 2;
        assert!(r.assign_new_window("main", 5).is_err(), "main does not own what fw-1 lists");
        assert!(r.assign_new_window("fw-9", 7).is_err(), "an unknown window owns nothing");
        let label = r.assign_new_window("main", 7).unwrap();
        assert_eq!(label, "fw-2");
        assert!(r.owns("fw-2", 7) && !r.owns("main", 7));
        assert_eq!(r.windows["fw-1"].workspace_ids, vec![5], "other windows untouched");
    }

    #[test]
    fn rollback_forgets_the_window_and_gives_the_workspace_back() {
        let mut r = WindowRegistry::default();
        r.windows.insert("fw-1".into(), rec(&[3], true, 0));
        r.next_ordinal = 2;
        let label = r.assign_new_window("fw-1", 3).unwrap();
        assert!(!r.windows["fw-1"].workspace_ids.contains(&3));
        r.rollback_new_window(&label, "fw-1", 3);
        assert!(!r.windows.contains_key(&label));
        assert_eq!(r.windows["fw-1"].workspace_ids, vec![3]);
        assert_eq!(r.mint_label().unwrap(), "fw-3", "the ordinal is spent, never reused");
    }

    #[test]
    fn next_window_walks_a_stable_ring() {
        let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let all = l(&["fw-10", "main", "fw-2"]);
        assert_eq!(next_label(&all, "main").as_deref(), Some("fw-2"), "ordinal order, not string order");
        assert_eq!(next_label(&all, "fw-2").as_deref(), Some("fw-10"));
        assert_eq!(next_label(&all, "fw-10").as_deref(), Some("main"));
        assert_eq!(next_label(&l(&["main"]), "main"), None, "nowhere else to go");
    }

    // A missing capability on fw-* shows only at the boot gate, and the gate
    // never opens a secondary, so guard the glob here.
    #[test]
    fn default_capability_covers_secondary_windows() {
        let raw = include_str!("../capabilities/default.json");
        let v: serde_json::Value = serde_json::from_str(raw).expect("default.json parses");
        let windows: Vec<&str> = v["windows"].as_array().expect("windows array").iter().filter_map(|w| w.as_str()).collect();
        assert_eq!(windows, vec!["main", "fw-*"]);
    }

    fn top(rank: u32, since: u64, ws: u32, pane: u32) -> Option<AttentionTop> {
        Some(AttentionTop { kind_rank: rank, since, ws_id: ws, pane_id: pane })
    }

    fn reg_with(reports: &[(&str, u32, Option<AttentionTop>)]) -> WindowRegistry {
        let mut reg = WindowRegistry::default();
        reg.ensure_main();
        for (l, count, t) in reports {
            if *l != MAIN {
                reg.windows.insert(l.to_string(), WindowRec::default());
            }
            assert!(reg.set_attention(l, AttentionReport { count: *count, top: *t }));
        }
        reg
    }

    #[test]
    fn attention_sums_counts_and_picks_smallest_tuple() {
        let reg = reg_with(&[("main", 2, top(1, 50, 1, 2)), ("fw-1", 3, top(0, 90, 1 << 24, (1 << 24) | 1))]);
        let (count, t) = reg.global_attention();
        assert_eq!(count, 5);
        assert_eq!(t.unwrap().0, "fw-1", "permission (rank 0) beats error");
    }

    #[test]
    fn attention_ties_break_on_since_then_ids() {
        let reg = reg_with(&[("main", 1, top(0, 20, 1, 2)), ("fw-1", 1, top(0, 10, 9, 9))]);
        assert_eq!(reg.global_attention().1.unwrap().0, "fw-1");
        let reg = reg_with(&[("main", 1, top(0, 10, 1, 3)), ("fw-1", 1, top(0, 10, 1, 2))]);
        assert_eq!(reg.global_attention().1.unwrap().0, "fw-1");
    }

    #[test]
    fn attention_resend_replaces_and_duplicate_top_goes_to_owner() {
        let mut reg = reg_with(&[("main", 4, top(0, 5, 7, 8)), ("fw-1", 1, top(0, 5, 7, 8))]);
        reg.windows.get_mut("fw-1").unwrap().workspace_ids = vec![7];
        assert_eq!(reg.global_attention().1.unwrap().0, "fw-1");
        reg.set_attention("main", AttentionReport { count: 4, top: None });
        assert_eq!(reg.global_attention().0, 5, "replacing, not adding");
        reg.set_attention("fw-1", AttentionReport { count: 0, top: None });
        assert_eq!(reg.global_attention(), (4, None));
    }

    #[test]
    fn attention_refuses_unknown_labels_and_drops_with_window() {
        let mut reg = reg_with(&[("fw-1", 2, top(0, 1, 1, 1))]);
        assert!(!reg.set_attention("fw-9", AttentionReport { count: 1, top: None }));
        reg.adopt_into_main("fw-1");
        assert_eq!(reg.global_attention(), (0, None));
    }

    #[test]
    fn focus_pane_label_validation() {
        let reg = reg_with(&[("fw-1", 0, None)]);
        assert!(check_registered(&reg, "main").is_ok());
        assert!(check_registered(&reg, "fw-1").is_ok());
        assert!(check_registered(&reg, "fw-2").is_err(), "well formed but not registered");
        assert!(check_registered(&reg, "fw-01").is_err());
        assert!(check_registered(&reg, "evil").is_err());
    }
}
