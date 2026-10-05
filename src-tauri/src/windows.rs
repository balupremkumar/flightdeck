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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::persist::{self, PersistedWindow, SessionDoc};

pub const MAIN: &str = "main";
/// JS sends `window_heartbeat` this often.
pub const HEARTBEAT_EVERY_MS: u64 = 2_000;
/// A booted secondary silent this long is treated as a dead webview.
pub const HEARTBEAT_TIMEOUT_MS: u64 = 8_000;
const WATCH_TICK_MS: u64 = 2_000;
/// A new window that has not called `window_boot` this long is treated as stuck.
pub const BOOT_TIMEOUT_MS: u64 = 15_000;
/// Closing a secondary waits this long for its final slice.
pub const CLOSE_FLUSH_MS: u64 = 500;
/// Quitting waits this long, in total, for every window's final slice.
pub const QUIT_FLUSH_MS: u64 = 1_500;
/// Rust to a window: push your slice now (`session_put_slice` with flush).
pub const FLUSH_EVENT: &str = "app://flush";
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
    /// When Rust minted the window (0 for main); the boot watchdog's clock.
    pub created_ms: u64,
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

/// A secondary to recreate at launch (Phase 4 D2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreWindow {
    pub label: String,
    pub ordinal: u32,
    pub workspace_ids: Vec<u32>,
    pub active_ws: Option<u32>,
}

/// Which secondaries to recreate: the doc's `fw-*` entries that hold workspaces, by
/// ordinal. Flag off, nothing (the doc loader already merged every slice into main).
/// Main, bad labels, duplicates and empty entries are skipped.
pub fn restore_plan(windows: &[PersistedWindow], multiwindow: bool) -> Vec<RestoreWindow> {
    if !multiwindow {
        return Vec::new();
    }
    let mut out: Vec<RestoreWindow> = Vec::new();
    for w in windows {
        let Ok(ordinal) = validate_label(&w.label) else { continue };
        if ordinal == 0 || w.workspace_ids.is_empty() || out.iter().any(|r| r.label == w.label) {
            continue;
        }
        out.push(RestoreWindow {
            label: w.label.clone(),
            ordinal,
            workspace_ids: w.workspace_ids.clone(),
            active_ws: w.active_workspace_id.filter(|a| w.workspace_ids.contains(a)),
        });
    }
    out.sort_by_key(|r| r.ordinal);
    out
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

    /// Register the windows a launch restore will create, under their persisted
    /// labels (the window-state plugin stores geometry by label), and move
    /// `next_ordinal` past them so a later mint can never reuse one.
    pub fn apply_restore(&mut self, plan: &[RestoreWindow]) {
        for r in plan {
            self.windows.entry(r.label.clone()).or_insert_with(|| WindowRec {
                workspace_ids: r.workspace_ids.clone(),
                active_ws: r.active_ws,
                ordinal: r.ordinal,
                ..WindowRec::default()
            });
            self.floor_ordinal(r.ordinal);
        }
    }

    /// Restored windows still waiting to be created: registered, never stamped,
    /// holding workspaces. By ordinal.
    pub fn pending_restores(&self) -> Vec<String> {
        let mut v: Vec<(u32, String)> = self
            .windows
            .iter()
            .filter(|(l, r)| l.as_str() != MAIN && !r.booted && r.created_ms == 0 && !r.workspace_ids.is_empty())
            .map(|(l, r)| (r.ordinal, l.clone()))
            .collect();
        v.sort();
        v.into_iter().map(|(_, l)| l).collect()
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

    /// A window gained focus (any way: click, Alt+Tab, summon). Feeds "last focused"
    /// for the summon fallback and the next-window ring. Unknown labels are ignored.
    pub fn note_focus(&mut self, label: &str, now: u64) {
        if let Some(r) = self.windows.get_mut(label) {
            r.last_focus_ms = now;
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

    /// A workspace made inside a secondary has no holder yet (main owns whatever
    /// nobody lists). Give each unheld id in the partition of `label`'s ordinal to
    /// `label`, so its slice survives the ownership check and merges back with it.
    /// Never main (it owns the unheld by default), never an unregistered label, never
    /// an id from another window's partition. Returns the ids claimed.
    pub fn claim_unheld(&mut self, label: &str, ids: &[u32]) -> Vec<u32> {
        let Some(ordinal) = self.windows.get(label).map(|r| r.ordinal) else { return Vec::new() };
        if label == MAIN || ordinal == 0 {
            return Vec::new();
        }
        let held: HashSet<u32> = self.windows.values().flat_map(|r| r.workspace_ids.iter().copied()).collect();
        let fresh: Vec<u32> = ids.iter().copied().filter(|id| id >> 24 == ordinal && !held.contains(id)).collect();
        let rec = self.windows.get_mut(label).expect("checked above");
        for id in &fresh {
            if !rec.workspace_ids.contains(id) {
                rec.workspace_ids.push(*id);
            }
        }
        fresh
    }

    /// Move `ws_id` to the booted window `target`, which must differ from `source`.
    /// Errors if `source` does not own it or `target` is not up.
    pub fn assign_to_window(&mut self, source: &str, target: &str, ws_id: u32) -> Result<(), String> {
        validate_label(target)?;
        if source == target {
            return Err("that workspace is already in this window".into());
        }
        if !self.owns(source, ws_id) {
            return Err(format!("window {source} does not own workspace {ws_id}"));
        }
        if !self.windows.get(target).is_some_and(|r| r.booted) {
            return Err(format!("window {target} is not open"));
        }
        self.reassign(ws_id, target);
        Ok(())
    }

    /// Make `to` the only owner of `ws_id`.
    pub fn reassign(&mut self, ws_id: u32, to: &str) {
        for r in self.windows.values_mut() {
            r.workspace_ids.retain(|i| *i != ws_id);
            if r.active_ws == Some(ws_id) {
                r.active_ws = None;
            }
        }
        if let Some(r) = self.windows.get_mut(to) {
            r.workspace_ids.push(ws_id);
            r.active_ws = Some(ws_id);
        }
    }

    /// Refuse window-creating work while the flag is off.
    pub fn require_multiwindow(&self) -> Result<(), String> {
        if self.multiwindow {
            Ok(())
        } else {
            Err("Multiple windows are turned off in Settings.".into())
        }
    }

    /// Start the boot watchdog's clock for a window just minted.
    pub fn stamp_created(&mut self, label: &str, now: u64) {
        if let Some(r) = self.windows.get_mut(label) {
            r.created_ms = now;
        }
    }

    /// A booted secondary whose assignment is empty has nothing left to show:
    /// forget it and say so. Never main; false if it still lists a workspace.
    pub fn retire_if_empty(&mut self, label: &str) -> bool {
        let empty = label != MAIN && self.windows.get(label).is_some_and(|r| r.booted && r.workspace_ids.is_empty());
        if empty {
            self.windows.remove(label);
        }
        empty
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

/// The watcher's memory between ticks. A sleep, clock jump or paused webview
/// makes every heartbeat look old at once, so a silent window is only reaped on
/// its second consecutive miss, and a tick that arrives long after the last one
/// judges nothing (finding 1).
#[derive(Debug, Default)]
pub struct Judge {
    last_tick: Option<u64>,
    misses: BTreeMap<String, u32>,
}

impl Judge {
    /// Windows to reap this tick.
    pub fn tick(&mut self, reg: &WindowRegistry, now: u64) -> Vec<String> {
        let gap = self.last_tick.map(|t| now.saturating_sub(t));
        self.last_tick = Some(now);
        if gap.is_some_and(|g| g > 2 * WATCH_TICK_MS) {
            self.misses.clear();
            return Vec::new();
        }
        let dead = dead_windows(reg, now);
        self.misses.retain(|l, _| dead.contains(l));
        for l in &dead {
            *self.misses.entry(l.clone()).or_insert(0) += 1;
        }
        dead.into_iter().filter(|l| self.misses.get(l).copied().unwrap_or(0) >= 2).collect()
    }
}

/// Secondaries that never booted: minted, then silent past the boot timeout.
/// Nothing is judged while the app is exiting.
pub fn stalled_boots(reg: &WindowRegistry, now: u64) -> Vec<String> {
    if reg.exiting {
        return Vec::new();
    }
    reg.windows
        .iter()
        .filter(|(l, r)| l.as_str() != MAIN && !r.booted && r.created_ms > 0 && now.saturating_sub(r.created_ms) > BOOT_TIMEOUT_MS)
        .map(|(l, _)| l.clone())
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    /// Main (quit is its own path), an unknown label, or the app is exiting.
    Ignore,
    /// Fold the window into main. `flush` asks its webview for a final slice first,
    /// which only makes sense once it has booted.
    Merge { flush: bool },
}

pub fn close_action(reg: &WindowRegistry, label: &str) -> CloseAction {
    if reg.exiting || label == MAIN {
        return CloseAction::Ignore;
    }
    match reg.windows.get(label) {
        Some(r) => CloseAction::Merge { flush: r.booted },
        None => CloseAction::Ignore,
    }
}

/// Labels whose webview should be asked for a final slice when the app quits.
pub fn quit_labels(reg: &WindowRegistry) -> Vec<String> {
    reg.windows.iter().filter(|(_, r)| r.booted).map(|(l, _)| l.clone()).collect()
}

/// Pane model ids inside a parked transfer payload (`{ panes: { "<id>": .. } }`).
pub fn transfer_pane_ids(transfer: &serde_json::Value) -> Vec<u32> {
    transfer["panes"].as_object().map(|m| m.keys().filter_map(|k| k.parse().ok()).collect()).unwrap_or_default()
}

/// Poll `done` every `poll_ms` until it is true or `timeout_ms` passes.
pub fn wait_for(timeout_ms: u64, poll_ms: u64, mut done: impl FnMut() -> bool) -> bool {
    let end = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if done() {
            return true;
        }
        if std::time::Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(poll_ms));
    }
}

/// How long the source waits for the target of a move to acknowledge `win://adopt`.
pub const ADOPT_ACK_MS: u64 = 3_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdoptState {
    Waiting,
    Acked,
    Cancelled,
}

/// Move-to-existing-window handshake (finding 2). The source emits `win://adopt`
/// with a transfer id and waits for the target to ack it; the ack is the target
/// saying "my listener is up and I am adopting now". A transfer the source gave
/// up on is cancelled, and a late ack for it is refused, so the workspace is never
/// adopted by a target after the source resumed its panes and kept it.
#[derive(Debug, Default)]
pub struct AdoptLedger {
    next: u64,
    by_id: HashMap<u64, AdoptState>,
}

impl AdoptLedger {
    pub fn begin(&mut self) -> u64 {
        self.next += 1;
        self.by_id.insert(self.next, AdoptState::Waiting);
        self.next
    }

    /// The target adopts. True when it may.
    pub fn ack(&mut self, id: u64) -> bool {
        match self.by_id.get_mut(&id) {
            Some(s @ AdoptState::Waiting) => {
                *s = AdoptState::Acked;
                true
            }
            Some(AdoptState::Cancelled) => {
                self.by_id.remove(&id);
                false
            }
            _ => false,
        }
    }

    pub fn is_acked(&self, id: u64) -> bool {
        self.by_id.get(&id) == Some(&AdoptState::Acked)
    }

    /// The source gives up. True when the transfer is now cancelled; false when
    /// the target had already acked (the move stands).
    pub fn cancel(&mut self, id: u64) -> bool {
        match self.by_id.get_mut(&id) {
            Some(s @ AdoptState::Waiting) => {
                *s = AdoptState::Cancelled;
                true
            }
            Some(AdoptState::Cancelled) => true,
            _ => false,
        }
    }

    /// The source is done with this id (the move stands).
    pub fn finish(&mut self, id: u64) {
        self.by_id.remove(&id);
    }
}

static ADOPTS: Mutex<Option<AdoptLedger>> = Mutex::new(None);

fn with_ledger<T>(f: impl FnOnce(&mut AdoptLedger) -> T) -> T {
    let mut g = ADOPTS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(AdoptLedger::default))
}

/// Folds into main that main has not confirmed (finding 6). `emit_to` is fire and
/// forget, so a payload sent while main was mid-reload is lost; it stays here until
/// main acks it, and main replays what is left once its listener is up.
#[derive(Debug)]
pub struct AdoptQueue<T> {
    next: u64,
    items: Vec<(u64, T)>,
}

impl<T> Default for AdoptQueue<T> {
    fn default() -> Self {
        AdoptQueue { next: 0, items: Vec::new() }
    }
}

impl<T: Clone> AdoptQueue<T> {
    /// Park a payload built from its id (main must ack that id); returns the id.
    pub fn push(&mut self, make: impl FnOnce(u64) -> T) -> u64 {
        self.next += 1;
        self.items.push((self.next, make(self.next)));
        self.next
    }

    pub fn ack(&mut self, id: u64) {
        self.items.retain(|(i, _)| *i != id);
    }

    /// Unacked payloads, oldest first.
    pub fn pending(&self) -> Vec<T> {
        self.items.iter().map(|(_, v)| v.clone()).collect()
    }
}

/// Windows whose close is already running (finding 5): every X press used to spawn
/// its own close thread, each waiting out the 500 ms flush.
#[derive(Debug, Default)]
pub struct CloseGuard(HashSet<String>);

impl CloseGuard {
    /// True when the caller should run the close; false when one is in progress.
    pub fn begin(&mut self, label: &str) -> bool {
        self.0.insert(label.to_string())
    }

    pub fn end(&mut self, label: &str) {
        self.0.remove(label);
    }
}

static MAIN_ADOPTS: Mutex<Option<AdoptQueue<AdoptPayload>>> = Mutex::new(None);

fn with_main_adopts<T>(f: impl FnOnce(&mut AdoptQueue<AdoptPayload>) -> T) -> T {
    let mut g = MAIN_ADOPTS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(AdoptQueue::default))
}

static CLOSING: Mutex<Option<CloseGuard>> = Mutex::new(None);

fn with_closing<T>(f: impl FnOnce(&mut CloseGuard) -> T) -> T {
    let mut g = CLOSING.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(CloseGuard::default))
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

/// Main plans the launch restore at most once per process; a main reload must not
/// resurrect a secondary the user closed since.
static RESTORE_PLANNED: AtomicBool = AtomicBool::new(false);

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
    // Launch restore: once per run, main only, flag on. Read the doc before taking the lock.
    let restore = if label == MAIN && multiwindow && !RESTORE_PLANNED.swap(true, Ordering::SeqCst) { persist::restore_doc(&app) } else { None };
    let plan = restore.as_ref().map(|d| restore_plan(&d.windows, true)).unwrap_or_default();
    if let Some(d) = restore.as_ref().filter(|_| !plan.is_empty()) {
        persist::seed_restored(d);
    }
    let ids = {
        let mut reg = state.lock();
        let now = now_ms();
        if label == MAIN {
            reg.multiwindow = multiwindow;
            reg.floor_ordinal(floor);
            reg.ensure_main();
            reg.apply_restore(&plan);
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
    /// An existing, booted window (S9): it receives the workspace over `win://adopt`.
    Label { label: String },
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
    let source = window.label().to_string();
    validate_label(&source)?;
    let ws_id = ws_snapshot.workspace_id;
    let label = match target {
        TransferTarget::New => {
            let label = {
                let mut reg = state.lock();
                // The flag lives in JS; this is the second lock on the same door.
                reg.require_multiwindow()?;
                reg.ensure_main();
                let label = reg.assign_new_window(&source, ws_id)?;
                reg.stamp_created(&label, now_ms());
                label
            };
            persist::seed_slice(&label, ws_snapshot.slice);
            pending_put(&label, ws_snapshot.transfer);
            if let Err(e) = create_window(&app, &label, true) {
                pending_take(&label);
                persist::drop_slice(&label);
                state.lock().rollback_new_window(&label, &source, ws_id);
                crate::applog::log("error", "window", &format!("ws_transfer: could not create {label}: {e}"));
                return Err(e);
            }
            crate::applog::log("info", "window", &format!("workspace {ws_id} moved from {source} to new window {label}"));
            label
        }
        TransferTarget::Label { label } => {
            {
                let mut reg = state.lock();
                reg.require_multiwindow()?;
                reg.assign_to_window(&source, &label, ws_id)?;
            }
            persist::append_to_slice(&label, &ws_snapshot.slice);
            let pane_ids = transfer_pane_ids(&ws_snapshot.transfer);
            let transfer_id = with_ledger(|l| l.begin());
            let payload = AdoptPayload {
                from: source.clone(),
                workspace_ids: vec![ws_id],
                active_ws: Some(ws_id),
                slice: Some(ws_snapshot.slice),
                transfer: Some(ws_snapshot.transfer),
                transfer_id: Some(transfer_id),
            };
            // Undo the assignment: the source keeps the workspace and its panes go
            // back on the air.
            let give_back = |why: &str| {
                with_ledger(|l| l.finish(transfer_id));
                state.lock().reassign(ws_id, &source);
                persist::remove_from_slice(&label, ws_id);
                for id in &pane_ids {
                    if let Err(e) = crate::resume_pane_model(&app, *id) {
                        crate::applog::log("warn", "window", &format!("pane_resume {id} after a failed move to {label}: {e}"));
                    }
                }
                crate::applog::log("error", "window", &format!("ws_transfer: {why}"));
            };
            if let Err(e) = app.emit_to(label.as_str(), ADOPT_EVENT, payload) {
                give_back(&format!("could not reach {label}: {e}"));
                return Err(e.to_string());
            }
            // The target acks before it adopts. `win://adopt` is fire and forget: a
            // target whose listener is not up yet drops it, and releasing the source
            // now would leave the panes paused for good.
            let acked = tauri::async_runtime::spawn_blocking(move || wait_for(ADOPT_ACK_MS, 10, || with_ledger(|l| l.is_acked(transfer_id))))
                .await
                .map_err(|e| e.to_string())?;
            if !acked && with_ledger(|l| l.cancel(transfer_id)) {
                give_back(&format!("{label} did not acknowledge the workspace within {ADOPT_ACK_MS} ms; it stays on {source}"));
                return Err(format!("{label} did not respond. The workspace stays here."));
            }
            with_ledger(|l| l.finish(transfer_id));
            // The user just asked for this: follow the workspace.
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            crate::applog::log("info", "window", &format!("workspace {ws_id} moved from {source} to window {label}"));
            label
        }
    };
    // The last workspace left a secondary: nothing to show, so Rust closes it. A
    // slice workspace the registry never heard of (made in that window) keeps it open.
    if source != MAIN && !persist::slice_has_other_workspace(&source, ws_id) && state.lock().retire_if_empty(&source) {
        persist::drop_slice(&source);
        crate::applog::log("info", "window", &format!("{source} has no workspaces left: closing it"));
        if let Some(w) = app.get_webview_window(&source) {
            let _ = w.destroy();
        }
    }
    Ok(label)
}

fn create_window(app: &AppHandle, label: &str, focus: bool) -> Result<(), String> {
    // Same minimum as tauri.conf.json; created hidden, shown once built.
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Flightdeck")
        .inner_size(1200.0, 800.0)
        .min_inner_size(940.0, 620.0)
        .visible(false)
        .focused(focus)
        .build()
        .map_err(|e| e.to_string())?;
    // `focused(false)` makes tao's first show SW_SHOWNOACTIVATE, so a launch restore
    // never takes focus from whatever the user is in front of.
    w.show().map_err(|e| e.to_string())?;
    if focus {
        let _ = w.set_focus();
    }
    Ok(())
}

/// Launch restore (D2), called by main once it has hydrated: create each secondary
/// `window_boot` registered, under its persisted label, hidden until built and
/// never focused. Each then boots as any secondary does and takes its slice. One
/// that cannot be built folds back into main. Async like every new command.
#[tauri::command]
pub async fn restore_windows(app: AppHandle, window: tauri::Window, state: State<'_, WindowState>) -> Result<Vec<String>, String> {
    if window.label() != MAIN {
        return Err("only main restores windows".into());
    }
    let labels = {
        let reg = state.lock();
        if !reg.multiwindow {
            return Ok(Vec::new());
        }
        reg.pending_restores()
    };
    let mut created = Vec::new();
    for label in labels {
        state.lock().stamp_created(&label, now_ms());
        match create_window(&app, &label, false) {
            Ok(()) => created.push(label),
            Err(e) => {
                crate::applog::log("error", "window", &format!("restore: could not create {label}: {e}"));
                merge_window(&app, &label, "could not be restored");
            }
        }
    }
    Ok(created)
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
pub struct AdoptPayload {
    from: String,
    workspace_ids: Vec<u32>,
    active_ws: Option<u32>,
    slice: Option<SessionDoc>,
    /// Set when a workspace is moved to this window alive (S9): the paused panes'
    /// screens and offsets, as `window_boot` hands them to a new window.
    transfer: Option<serde_json::Value>,
    /// Set with `transfer` on a move into an existing window: the target must
    /// `window_adopted` this id before adopting (finding 2).
    transfer_id: Option<u64>,
}

/// Main confirms it processed a fold (`transferId` of a payload without a `transfer`).
#[tauri::command]
pub async fn main_adopt_done(transfer_id: u64) {
    with_main_adopts(|q| q.ack(transfer_id));
}

/// Folds main has not confirmed. Main replays them once its adopt listener is up
/// (a reload can drop the live event); each is idempotent by workspace id.
#[tauri::command]
pub async fn main_pending_adopts() -> Vec<AdoptPayload> {
    with_main_adopts(|q| q.pending())
}

/// The target of a move calls this just before it adopts. False means the source
/// already gave up and kept the workspace: do not adopt.
#[tauri::command]
pub async fn window_adopted(transfer_id: u64) -> bool {
    with_ledger(|l| l.ack(transfer_id))
}

/// Rust to a window: take these workspaces (a merge into main, or a move into it).
pub const ADOPT_EVENT: &str = "win://adopt";

/// Fold a secondary into main and destroy it. Never called for main. `why` goes
/// in the log. The window is destroyed even when the registry no longer knows it
/// (a close we prevented must still end).
fn merge_window(app: &AppHandle, label: &str, why: &str) -> Vec<u32> {
    let mut moved = Vec::new();
    let adopted = app.state::<WindowState>().lock().adopt_into_main(label);
    if let Some((workspace_ids, active_ws)) = adopted {
        let slice = persist::fold_slice_into_main(label);
        crate::applog::log("info", "window", &format!("window {label} {why}: re-adopting {} workspace(s) into main", workspace_ids.len()));
        if !workspace_ids.is_empty() {
            moved = workspace_ids.clone();
            let base = AdoptPayload { from: label.to_string(), workspace_ids, active_ws, slice, transfer: None, transfer_id: None };
            // Kept until main acks it (`main_adopt_done`), so a reload that eats the
            // event does not lose the fold.
            let p = with_main_adopts(|q| {
                let mut sent = None;
                q.push(|id| {
                    let p = AdoptPayload { transfer_id: Some(id), ..base };
                    sent = Some(p.clone());
                    p
                });
                sent.expect("push ran its closure")
            });
            let _ = app.emit_to(MAIN, ADOPT_EVENT, p);
        }
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.destroy();
    }
    moved
}

/// "Merge all windows": flush every booted secondary, then fold each into main.
/// Returns the workspace ids that moved, so the caller can wait for main to hold
/// them. Blocking (the flush waits up to CLOSE_FLUSH_MS); call off the async runtime.
fn merge_all(app: &AppHandle) -> Vec<u32> {
    let (flush, others): (Vec<String>, Vec<String>) = {
        let state = app.state::<WindowState>();
        let reg = state.lock();
        let mut flush = Vec::new();
        let mut others = Vec::new();
        for l in reg.windows.keys() {
            if let CloseAction::Merge { flush: f } = close_action(&reg, l) {
                others.push(l.clone());
                if f {
                    flush.push(l.clone());
                }
            }
        }
        (flush, others)
    };
    if !flush.is_empty() && !flush_windows(app, &flush, CLOSE_FLUSH_MS) {
        crate::applog::log("warn", "window", "merge all: a window did not flush in time; using its last slice");
    }
    others.iter().flat_map(|l| merge_window(app, l, "merged by Merge all windows")).collect()
}

/// Palette "Merge all windows". The caller may itself be a secondary and goes away
/// with the rest; main is then brought forward, since the user just asked.
#[tauri::command]
pub async fn merge_all_windows(app: AppHandle, window: tauri::Window) -> Result<Vec<u32>, String> {
    let caller = window.label().to_string();
    let a = app.clone();
    let moved = tauri::async_runtime::spawn_blocking(move || merge_all(&a)).await.map_err(|e| e.to_string())?;
    if caller != MAIN {
        if let Some(m) = app.get_webview_window(MAIN) {
            let _ = m.show();
            let _ = m.unminimize();
            let _ = m.set_focus();
        }
    }
    Ok(moved)
}

/// Re-adopt a dead secondary into main and destroy it.
fn reap_window(app: &AppHandle, label: &str) {
    let _ = merge_window(app, label, &format!("silent for {}s", HEARTBEAT_TIMEOUT_MS / 1000));
}

/// Ask `labels` for a final slice and wait until each has pushed one, or the
/// timeout. Shared by closing a secondary and quitting. True when all answered.
fn flush_windows(app: &AppHandle, labels: &[String], timeout_ms: u64) -> bool {
    let base: Vec<(String, u64)> = labels.iter().map(|l| (l.clone(), persist::slice_puts(l))).collect();
    for l in labels {
        let _ = app.emit_to(l.as_str(), FLUSH_EVENT, ());
    }
    wait_for(timeout_ms, 10, || base.iter().all(|(l, b)| persist::slice_puts(l) > *b))
}

/// A secondary's X (or its own request to close): flush, then merge into main
/// and destroy. A hung webview just costs the 500 ms wait; the last slice is used.
fn close_secondary(app: &AppHandle, label: &str) {
    let action = close_action(&app.state::<WindowState>().lock(), label);
    if let CloseAction::Merge { flush } = action {
        if flush && !flush_windows(app, &[label.to_string()], CLOSE_FLUSH_MS) {
            crate::applog::log("warn", "window", &format!("{label} did not flush within {CLOSE_FLUSH_MS} ms: using its last slice"));
        }
        let _ = merge_window(app, label, "closed");
    }
}

/// `on_window_event` hook for CloseRequested. Returns true when it took over (the
/// caller must `prevent_close`): a secondary closes through Rust, never a kill.
pub fn on_close_requested(app: &AppHandle, label: &str) -> bool {
    if validate_label(label).is_err() || close_action(&app.state::<WindowState>().lock(), label) == CloseAction::Ignore {
        return false;
    }
    // Still the close is ours to prevent, but a press while one runs does nothing.
    if !with_closing(|g| g.begin(label)) {
        return true;
    }
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        close_secondary(&app, &label);
        with_closing(|g| g.end(&label));
    });
    true
}

/// `on_window_event` hook for Destroyed. A secondary that went without a merge
/// (webview crashed or hung and the OS tore it down) is re-adopted from its last
/// slice. Main going means the app is quitting: stop judging secondaries.
pub fn on_destroyed(app: &AppHandle, label: &str) {
    if label == MAIN {
        app.state::<WindowState>().lock().exiting = true;
        return;
    }
    if validate_label(label).is_err() {
        return;
    }
    if matches!(close_action(&app.state::<WindowState>().lock(), label), CloseAction::Merge { .. }) {
        let _ = merge_window(app, label, "was destroyed without a merge");
    }
}

/// `on_window_event` hook for Focused(true). Only records the time; never focuses.
pub fn on_focused(app: &AppHandle, label: &str) {
    if validate_label(label).is_ok() {
        app.state::<WindowState>().lock().note_focus(label, now_ms());
    }
}

pub fn mark_exiting(app: &AppHandle) {
    app.state::<WindowState>().lock().exiting = true;
}

/// A window that never booted: put its paused panes back on the air, then fold the
/// workspace into main from the slice the transfer seeded.
fn reap_unbooted(app: &AppHandle, label: &str) {
    if let Some(t) = pending_take(label) {
        for id in transfer_pane_ids(&t) {
            if let Err(e) = crate::resume_pane_model(app, id) {
                crate::applog::log("warn", "window", &format!("pane_resume {id} after a stuck boot of {label}: {e}"));
            }
        }
    }
    let _ = merge_window(app, label, &format!("never booted in {}s", BOOT_TIMEOUT_MS / 1000));
}

pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut judge = Judge::default();
        loop {
        std::thread::sleep(Duration::from_millis(WATCH_TICK_MS));
        let dead = judge.tick(&app.state::<WindowState>().lock(), now_ms());
        for label in dead {
            // A webview that answers a flush is alive (its timers were throttled):
            // revive it instead of merging. Only a silent one is folded into main.
            if flush_windows(&app, &[label.clone()], CLOSE_FLUSH_MS) {
                app.state::<WindowState>().lock().heartbeat(&label, now_ms());
                continue;
            }
            reap_window(&app, &label);
        }
        let stuck = stalled_boots(&app.state::<WindowState>().lock(), now_ms());
        for label in stuck {
            reap_unbooted(&app, &label);
        }
        }
    });
}

/// A secondary asks to close itself (its store is empty). Same path as its X.
#[tauri::command(async)]
pub fn window_close_self(app: AppHandle, window: tauri::Window, state: State<'_, WindowState>) -> Result<(), String> {
    let label = window.label().to_string();
    if validate_label(&label)? == 0 {
        return Err("main closes by quitting the app".into());
    }
    if state.lock().retire_if_empty(&label) {
        persist::drop_slice(&label);
        let _ = window.destroy();
        return Ok(());
    }
    close_secondary(&app, &label);
    Ok(())
}

/// The Settings toggle: Rust's copy of the `flightdeck-multiwindow` flag, which
/// `ws_transfer` checks. Turning it off runs "Merge all windows", so a secondary
/// never outlives the flag. Async like every new command.
#[tauri::command]
pub async fn set_multiwindow(app: AppHandle, state: State<'_, WindowState>, enabled: bool) -> Result<(), String> {
    let was = std::mem::replace(&mut state.lock().multiwindow, enabled);
    if was && !enabled {
        let a = app.clone();
        tauri::async_runtime::spawn_blocking(move || merge_all(&a)).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One workspace of another window, for the palette's "Go to workspace" and Home.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryWorkspace {
    pub id: u32,
    pub name: String,
    pub root: String,
    /// The pane to focus: the first one (a slice does not carry focus).
    pub pane_id: Option<u32>,
    pub live_panes: u32,
}

/// A window other than the caller's: live panes (the quit guard), plus its title and
/// workspaces (palette, Home). Built from each window's last slice, so it trails the
/// window by the 800 ms save debounce.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSummary {
    pub label: String,
    pub live_panes: u32,
    pub title: String,
    pub needs_you: u32,
    /// Its most urgent item, so the bell footer can jump to the exact pane.
    pub top: Option<AttentionTop>,
    pub workspaces: Vec<SummaryWorkspace>,
}

#[tauri::command(async)]
pub fn window_summary(app: AppHandle, window: tauri::Window, reg: State<'_, crate::Registry>, state: State<'_, WindowState>) -> Vec<WindowSummary> {
    let windows = state.lock().clone();
    windows
        .windows
        .iter()
        .filter(|(l, r)| r.booted && l.as_str() != window.label())
        .map(|(label, rec)| {
            let by_model = crate::paneout::lock_map(&reg.by_model);
            let workspaces: Vec<SummaryWorkspace> = persist::slice_workspaces(label)
                .into_iter()
                .filter(|w| windows.owns(label, w.id))
                .map(|w| SummaryWorkspace {
                    id: w.id,
                    pane_id: w.panes.first().map(|p| p.id),
                    live_panes: w.panes.iter().filter(|p| by_model.get(p.id).is_some()).count() as u32,
                    name: w.name,
                    root: w.root,
                })
                .collect();
            let title = app.get_webview_window(label).and_then(|w| w.title().ok()).unwrap_or_else(|| label.clone());
            let live_panes = workspaces.iter().map(|w| w.live_panes).sum();
            WindowSummary { label: label.clone(), live_panes, title, needs_you: rec.attention.map_or(0, |a| a.count), top: rec.attention.and_then(|a| a.top), workspaces }
        })
        .collect()
}

/// Main closed and the user confirmed: flush every window's slice, write the
/// session document, exit. `RunEvent::ExitRequested` reaps the ptys as before.
#[tauri::command(async)]
pub fn app_quit(app: AppHandle, state: State<'_, WindowState>) {
    let labels = {
        let mut reg = state.lock();
        reg.exiting = true;
        quit_labels(&reg)
    };
    if !flush_windows(&app, &labels, QUIT_FLUSH_MS) {
        crate::applog::log("warn", "window", "quit: a window did not flush in time; using its last slice");
    }
    persist::wait_idle();
    app.exit(0);
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

    fn pw(label: &str, ids: &[u32], active: Option<u32>) -> PersistedWindow {
        PersistedWindow { label: label.into(), workspace_ids: ids.to_vec(), active_workspace_id: active }
    }

    #[test]
    fn restore_plan_lists_populated_secondaries_by_ordinal() {
        let doc = [pw("main", &[1], Some(1)), pw("fw-3", &[3], Some(9)), pw("fw-1", &[2, 4], Some(4)), pw("fw-2", &[], None), pw("fw-1", &[7], None), pw("bogus", &[8], None)];
        let plan = restore_plan(&doc, true);
        assert_eq!(
            plan,
            vec![
                RestoreWindow { label: "fw-1".into(), ordinal: 1, workspace_ids: vec![2, 4], active_ws: Some(4) },
                RestoreWindow { label: "fw-3".into(), ordinal: 3, workspace_ids: vec![3], active_ws: None },
            ]
        );
    }

    #[test]
    fn restore_plan_is_empty_with_the_flag_off_so_every_slice_stays_in_main() {
        assert!(restore_plan(&[pw("main", &[1], None), pw("fw-1", &[2], None)], false).is_empty());
    }

    #[test]
    fn restored_labels_are_never_minted_again() {
        let mut r = WindowRegistry::default();
        r.apply_restore(&restore_plan(&[pw("fw-2", &[5], Some(5)), pw("fw-4", &[6], None)], true));
        assert_eq!(r.windows["fw-2"].workspace_ids, vec![5]);
        assert_eq!(r.windows["fw-2"].ordinal, 2);
        assert_eq!(r.mint_label().unwrap(), "fw-5");
        // Applying twice (a reload of main) neither duplicates nor resets a window.
        r.windows.get_mut("fw-2").unwrap().booted = true;
        r.apply_restore(&restore_plan(&[pw("fw-2", &[5], Some(5))], true));
        assert!(r.windows["fw-2"].booted);
        assert_eq!(r.mint_label().unwrap(), "fw-6");
    }

    #[test]
    fn pending_restores_are_the_unstamped_populated_secondaries() {
        let mut r = WindowRegistry::default();
        r.ensure_main().workspace_ids = vec![1];
        r.apply_restore(&restore_plan(&[pw("fw-2", &[5], None), pw("fw-1", &[6], None)], true));
        assert_eq!(r.pending_restores(), vec!["fw-1", "fw-2"]);
        r.stamp_created("fw-1", 10);
        assert_eq!(r.pending_restores(), vec!["fw-2"]);
        // A never-booted restored window is then folded back by the existing watchdog.
        assert_eq!(stalled_boots(&r, 10 + BOOT_TIMEOUT_MS + 1), vec!["fw-1"]);
        assert!(stalled_boots(&r, 5).is_empty());
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

    fn reg_with_secondary(ordinal: u32, ids: &[u32]) -> WindowRegistry {
        let mut r = WindowRegistry::default();
        r.ensure_main().booted = true;
        let label = format!("fw-{ordinal}");
        r.windows.insert(label, WindowRec { ordinal, ..rec(ids, true, 0) });
        r
    }

    #[test]
    fn a_secondary_claims_only_unheld_ids_from_its_own_partition() {
        let own = (1 << 24) | 5;
        let other = (2 << 24) | 5;
        let mut r = reg_with_secondary(1, &[]);
        r.windows.insert("fw-2".into(), WindowRec { ordinal: 2, ..rec(&[other], true, 0) });
        assert_eq!(r.claim_unheld("fw-1", &[own, other, 9]), vec![own], "not another window's, not main's partition");
        assert!(r.owns("fw-1", own));
        assert!(!r.owns("main", own), "main no longer owns it by default");
        assert_eq!(r.claim_unheld("fw-1", &[own]), Vec::<u32>::new(), "claiming twice adds nothing");
        assert_eq!(r.windows["fw-1"].workspace_ids, vec![own]);
    }

    #[test]
    fn main_and_unknown_labels_claim_nothing() {
        let mut r = reg_with_secondary(1, &[]);
        assert!(r.claim_unheld("main", &[7]).is_empty());
        assert!(r.claim_unheld("fw-9", &[(9 << 24) | 1]).is_empty());
    }

    #[test]
    fn a_workspace_made_in_a_secondary_merges_back_with_it() {
        let id = (1 << 24) | 3;
        let mut r = reg_with_secondary(1, &[]);
        r.claim_unheld("fw-1", &[id]);
        let (moved, _) = r.adopt_into_main("fw-1").expect("registered");
        assert_eq!(moved, vec![id]);
        assert!(r.owns("main", id));
    }

    #[test]
    fn moving_to_an_existing_window_hands_over_ownership() {
        let mut r = reg_with_secondary(1, &[]);
        r.assign_to_window("main", "fw-1", 4).expect("main owns 4 by default");
        assert!(r.owns("fw-1", 4) && !r.owns("main", 4));
        assert_eq!(r.windows["fw-1"].active_ws, Some(4));
        r.assign_to_window("fw-1", "main", 4).expect("and back");
        assert!(r.windows["main"].workspace_ids.contains(&4) && r.windows["fw-1"].workspace_ids.is_empty());
    }

    #[test]
    fn a_move_to_a_window_refuses_bad_targets_and_foreign_workspaces() {
        let mut r = reg_with_secondary(1, &[8]);
        assert!(r.assign_to_window("main", "main", 1).is_err(), "same window");
        assert!(r.assign_to_window("main", "fw-5", 1).is_err(), "unknown window");
        assert!(r.assign_to_window("main", "bogus", 1).is_err(), "bad label");
        assert!(r.assign_to_window("main", "fw-1", 8).is_err(), "fw-1 holds 8, main does not own it");
        r.windows.get_mut("fw-1").unwrap().booted = false;
        assert!(r.assign_to_window("main", "fw-1", 1).is_err(), "not booted yet");
        assert!(r.owns("main", 1), "a refused move changes nothing");
    }

    #[test]
    fn transfer_target_parses_both_shapes() {
        let new: TransferTarget = serde_json::from_str(r#"{"kind":"new"}"#).unwrap();
        assert!(matches!(new, TransferTarget::New));
        let to: TransferTarget = serde_json::from_str(r#"{"kind":"label","label":"fw-2"}"#).unwrap();
        assert!(matches!(to, TransferTarget::Label { label } if label == "fw-2"));
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
    fn a_silent_window_is_reaped_only_on_its_second_miss() {
        let mut r = WindowRegistry::default();
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        let mut j = Judge::default();
        let t1 = HEARTBEAT_TIMEOUT_MS + 1;
        assert!(j.tick(&r, t1).is_empty(), "first miss only counts");
        assert_eq!(j.tick(&r, t1 + WATCH_TICK_MS), vec!["fw-1".to_string()]);
    }

    #[test]
    fn a_heartbeat_between_ticks_clears_the_miss() {
        let mut r = WindowRegistry::default();
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        let mut j = Judge::default();
        let t1 = HEARTBEAT_TIMEOUT_MS + 1;
        assert!(j.tick(&r, t1).is_empty());
        r.heartbeat("fw-1", t1 + 10);
        assert!(j.tick(&r, t1 + WATCH_TICK_MS).is_empty());
        assert!(j.tick(&r, t1 + 2 * WATCH_TICK_MS).is_empty(), "the earlier miss no longer counts");
    }

    #[test]
    fn a_tick_after_a_long_gap_judges_nothing_and_resets() {
        let mut r = WindowRegistry::default();
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        let mut j = Judge::default();
        let t1 = HEARTBEAT_TIMEOUT_MS + 1;
        assert!(j.tick(&r, t1).is_empty());
        // The machine slept: the next tick lands far past the interval.
        let t2 = t1 + 60_000;
        assert!(j.tick(&r, t2).is_empty(), "a sleep gap is not evidence of death");
        assert!(j.tick(&r, t2 + WATCH_TICK_MS).is_empty(), "the miss count restarted");
        assert_eq!(j.tick(&r, t2 + 2 * WATCH_TICK_MS), vec!["fw-1".to_string()]);
    }

    #[test]
    fn an_acked_adopt_stands_and_a_late_cancel_is_refused() {
        let mut l = AdoptLedger::default();
        let id = l.begin();
        assert!(!l.is_acked(id));
        assert!(l.ack(id));
        assert!(l.is_acked(id));
        assert!(!l.cancel(id), "the target already took it: the source must not resume");
    }

    #[test]
    fn a_cancelled_adopt_refuses_a_late_ack() {
        let mut l = AdoptLedger::default();
        let id = l.begin();
        assert!(l.cancel(id), "no ack in time: the source keeps the workspace");
        assert!(!l.ack(id), "a target that wakes up late must not adopt");
        assert!(!l.is_acked(id));
    }

    #[test]
    fn an_unknown_transfer_id_is_never_acked() {
        let mut l = AdoptLedger::default();
        assert!(!l.ack(99));
        let a = l.begin();
        let b = l.begin();
        assert_ne!(a, b);
        l.finish(a);
        assert!(!l.ack(a));
    }

    #[test]
    fn a_second_close_press_does_not_start_another_close() {
        let mut g = CloseGuard::default();
        assert!(g.begin("fw-1"));
        assert!(!g.begin("fw-1"), "a close for fw-1 is already running");
        assert!(g.begin("fw-2"), "other windows are independent");
        g.end("fw-1");
        assert!(g.begin("fw-1"), "once it ends a new close may start");
    }

    #[test]
    fn an_unacked_fold_into_main_is_replayed_and_an_acked_one_is_not() {
        let mut q: AdoptQueue<&str> = AdoptQueue::default();
        let a = q.push(|_| "fw-1 folded");
        let b = q.push(|_| "fw-2 folded");
        assert_ne!(a, b);
        assert_eq!(q.pending(), vec!["fw-1 folded", "fw-2 folded"], "main reloaded before acking: both replay, oldest first");
        q.ack(a);
        assert_eq!(q.pending(), vec!["fw-2 folded"]);
        q.ack(a);
        q.ack(99);
        assert_eq!(q.pending(), vec!["fw-2 folded"], "double and unknown acks change nothing");
        q.ack(b);
        assert!(q.pending().is_empty());
    }

    #[test]
    fn focus_event_updates_last_focus_and_ignores_unknown() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[1], true, 0));
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        r.note_focus("fw-1", 7_000);
        r.note_focus("fw-9", 8_000);
        assert_eq!(r.windows["fw-1"].last_focus_ms, 7_000);
        assert_eq!(r.windows["main"].last_focus_ms, 0);
        assert!(!r.windows.contains_key("fw-9"));
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

    #[test]
    fn close_merges_a_secondary_and_ignores_main_unknown_and_exit() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[1], true, 0));
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        r.windows.insert("fw-2".into(), rec(&[3], false, 0));
        assert_eq!(close_action(&r, "fw-1"), CloseAction::Merge { flush: true });
        assert_eq!(close_action(&r, "fw-2"), CloseAction::Merge { flush: false }, "never booted: nothing to flush");
        assert_eq!(close_action(&r, "main"), CloseAction::Ignore, "main quits through app_quit");
        assert_eq!(close_action(&r, "fw-9"), CloseAction::Ignore);
        r.exiting = true;
        assert_eq!(close_action(&r, "fw-1"), CloseAction::Ignore, "no re-adopting while the app exits");
    }

    #[test]
    fn a_merged_window_is_not_merged_again_on_destroy() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[1], true, 0));
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        assert_eq!(close_action(&r, "fw-1"), CloseAction::Merge { flush: true });
        r.adopt_into_main("fw-1");
        assert_eq!(close_action(&r, "fw-1"), CloseAction::Ignore, "Destroyed after the merge finds nothing to do");
    }

    #[test]
    fn boot_watchdog_flags_only_stuck_new_windows() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[1], false, 0));
        let mut stuck = rec(&[2], false, 0);
        stuck.created_ms = 1_000;
        let mut fresh = rec(&[3], false, 0);
        fresh.created_ms = 10_000;
        let mut booted = rec(&[4], true, 0);
        booted.created_ms = 1_000;
        r.windows.insert("fw-1".into(), stuck);
        r.windows.insert("fw-2".into(), fresh);
        r.windows.insert("fw-3".into(), booted);
        r.windows.insert("fw-4".into(), rec(&[5], false, 0)); // restored with no clock: not ours
        assert!(stalled_boots(&r, 1_000 + BOOT_TIMEOUT_MS).is_empty(), "exactly at the limit is still booting");
        assert_eq!(stalled_boots(&r, 1_000 + BOOT_TIMEOUT_MS + 1), vec!["fw-1".to_string()]);
        r.exiting = true;
        assert!(stalled_boots(&r, u64::MAX).is_empty());
    }

    #[test]
    fn stamping_starts_the_boot_clock() {
        let mut r = WindowRegistry::default();
        r.ensure_main();
        let l = r.assign_new_window("main", 4).unwrap();
        assert_eq!(r.windows[&l].created_ms, 0);
        r.stamp_created(&l, 77);
        assert_eq!(r.windows[&l].created_ms, 77);
        assert_eq!(stalled_boots(&r, 77 + BOOT_TIMEOUT_MS + 1), vec![l]);
    }

    #[test]
    fn transfer_pane_ids_come_from_the_parked_payload() {
        let t = serde_json::json!({ "workspace": { "id": 2 }, "panes": { "7": {}, "16777217": {}, "x": {} } });
        let mut ids = transfer_pane_ids(&t);
        ids.sort();
        assert_eq!(ids, vec![7, 16_777_217]);
        assert!(transfer_pane_ids(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn a_secondary_with_nothing_assigned_is_retired_main_never() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[], true, 0));
        r.windows.insert("fw-1".into(), rec(&[], true, 0));
        r.windows.insert("fw-2".into(), rec(&[9], true, 0));
        r.windows.insert("fw-3".into(), rec(&[], false, 0));
        assert!(!r.retire_if_empty("main"));
        assert!(!r.retire_if_empty("fw-2"), "still lists a workspace");
        assert!(!r.retire_if_empty("fw-3"), "not booted yet: the boot path owns it");
        assert!(r.retire_if_empty("fw-1"));
        assert!(!r.windows.contains_key("fw-1"));
        assert!(!r.retire_if_empty("fw-1"), "already gone");
    }

    #[test]
    fn moving_the_last_workspace_out_of_a_secondary_empties_it() {
        let mut r = WindowRegistry::default();
        r.ensure_main();
        r.windows.insert("fw-1".into(), rec(&[5], true, 0));
        r.next_ordinal = 2;
        r.assign_new_window("fw-1", 5).unwrap();
        assert!(r.retire_if_empty("fw-1"));
        assert_eq!(r.windows["fw-2"].workspace_ids, vec![5]);
    }

    #[test]
    fn flag_off_refuses_a_transfer() {
        let mut r = WindowRegistry::default();
        assert!(r.require_multiwindow().is_err());
        r.multiwindow = true;
        assert!(r.require_multiwindow().is_ok());
    }

    #[test]
    fn quit_asks_every_booted_window_for_a_slice() {
        let mut r = WindowRegistry::default();
        r.windows.insert("main".into(), rec(&[1], true, 0));
        r.windows.insert("fw-1".into(), rec(&[2], true, 0));
        r.windows.insert("fw-2".into(), rec(&[3], false, 0));
        assert_eq!(quit_labels(&r), vec!["fw-1".to_string(), "main".to_string()]);
    }

    #[test]
    fn wait_for_returns_early_and_times_out() {
        let t = std::time::Instant::now();
        let mut n = 0;
        assert!(wait_for(1_000, 5, || { n += 1; n >= 3 }));
        assert!(t.elapsed() < Duration::from_millis(500));
        assert!(!wait_for(40, 5, || false));
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
