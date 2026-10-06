//! Window drag (D3), the runtime around `dragwin`: the three commands, the 16 ms
//! poll thread that exists only while a drag is armed, the OS cursor source and the
//! Canary-only scripted source.
//!
//! JS arms a drag (`drag_arm`) once a rail tile has moved past its own threshold,
//! and never sends coordinates. Rust reads the OS cursor and the primary button,
//! decides tear-out, hover and release with `dragwin::step`, and tells windows what
//! happened with events:
//!
//!   source  <- `drag://state {phase}`      armed | torn | refused
//!   source  <- `drag://drop {id, target}`  target = {kind:"new", at?} | {kind:"label", label}
//!   source  <- `drag://end {outcome}`      released | cancelled | dropped | moved | timeout
//!   hovered <- `drag://hover {name, tint, from}` / `drag://hover-end`, only on change
//!
//! After `drag://drop` the source runs the existing transfer (`ws_transfer`), which
//! is the only thing here that can focus a window, because the user's own release
//! caused it. Nothing in this file calls `set_focus`.
//!
//! Every command is `async`: a sync command runs on the main thread and blocks
//! every pane (see the 2026-09-19 note in gitstatus.rs).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::dragwin::{self, Action, CursorSource, DragState, DropPick, Outcome, Pt, Rect, Sample, Topmost, World};
use crate::windows::{self, WindowState};

/// Poll period while a drag is armed.
pub const POLL_MS: u64 = 16;
/// A drag that never ends (a missed button-up) is dropped after this long.
pub const TIMEOUT_MS: u64 = 120_000;
/// Window handles are re-read this often (a window opened mid-drag still counts).
const HWND_REFRESH_TICKS: u32 = 30;
/// A scripted drag waits this long for its `drag_arm` before it is forgotten.
const SCRIPT_TTL_MS: u64 = 30_000;

pub const STATE_EVENT: &str = "drag://state";
pub const END_EVENT: &str = "drag://end";
pub const DROP_EVENT: &str = "drag://drop";
pub const HOVER_EVENT: &str = "drag://hover";
pub const HOVER_END_EVENT: &str = "drag://hover-end";

const STOP_NONE: u8 = 0;
const STOP_CANCEL: u8 = 1;
const STOP_DISARM: u8 = 2;

#[derive(Clone)]
struct Session {
    id: u64,
    source: String,
    ws_id: u32,
    tearable: bool,
    name: String,
    tint: String,
    stop: Arc<AtomicU8>,
}

static ACTIVE: Mutex<Option<Session>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn active<T>(f: impl FnOnce(&mut Option<Session>) -> T) -> T {
    f(&mut ACTIVE.lock().unwrap_or_else(|e| e.into_inner()))
}

fn is_current(id: u64) -> bool {
    active(|a| a.as_ref().is_some_and(|s| s.id == id))
}

/// Scripted cursor samples for the Canary harness: one point per tick, then the
/// button is released (or stays down when `release` is false, until Escape or the
/// timeout). Keyed by the window that will arm, so a stray script cannot hijack
/// another window's drag.
struct Script {
    label: String,
    points: VecDeque<Pt>,
    last: Pt,
    release: bool,
    made: Instant,
}

static SCRIPT: Mutex<Option<Script>> = Mutex::new(None);

fn script<T>(f: impl FnOnce(&mut Option<Script>) -> T) -> T {
    f(&mut SCRIPT.lock().unwrap_or_else(|e| e.into_inner()))
}

/// `(label, hwnd)` for every window the hit test knows. HWND is held as `isize` so
/// it can cross threads.
type HwndMap = Arc<Mutex<Vec<(String, isize)>>>;

fn refresh_hwnds(app: &AppHandle, map: &HwndMap) {
    let labels: Vec<String> = app.state::<WindowState>().lock().windows.keys().cloned().collect();
    let fresh: Vec<(String, isize)> = labels.into_iter().filter_map(|l| os::hwnd_of(app, &l).map(|h| (l, h))).collect();
    *map.lock().unwrap_or_else(|e| e.into_inner()) = fresh;
}

/// The OS source, or the script when one is waiting for this window.
struct PollSource {
    label: String,
    hwnds: HwndMap,
}

impl CursorSource for PollSource {
    fn sample(&mut self) -> Sample {
        let scripted = script(|s| {
            let live = s.as_ref().is_some_and(|x| x.label == self.label && x.made.elapsed() < Duration::from_millis(SCRIPT_TTL_MS));
            if !live {
                return None;
            }
            let x = s.as_mut().expect("checked above");
            if let Some(p) = x.points.pop_front() {
                x.last = p;
                return Some(Sample { cursor: p, down: true, topmost: Topmost::Unknown });
            }
            Some(Sample { cursor: x.last, down: !x.release, topmost: Topmost::Unknown })
        });
        scripted.unwrap_or_else(|| os::sample(&self.hwnds.lock().unwrap_or_else(|e| e.into_inner())))
    }
}

fn emit_to(app: &AppHandle, label: &str, event: &str, payload: serde_json::Value) {
    if let Err(e) = app.emit_to(label, event, payload) {
        crate::applog::log("warn", "drag", &format!("emit {event} to {label} failed: {e}"));
    }
}

/// Where a new window dropped at `cursor` goes: the monitor under it (else the
/// primary), sized like the source scaled to that monitor.
fn placement(app: &AppHandle, source: &str, cursor: Pt) -> Option<Rect> {
    let w = app.get_webview_window(source)?;
    let scale = w.scale_factor().ok().filter(|s| *s > 0.0)?;
    let outer = w.outer_size().ok()?;
    let logical = (outer.width as f64 / scale, outer.height as f64 / scale);
    let mon = app
        .monitor_from_point(cursor.x as f64, cursor.y as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let wa = mon.work_area();
    let work = Rect::new(wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32);
    let ms = mon.scale_factor();
    let grab = dragwin::default_grab(((logical.0 * ms).round() as i32, (logical.1 * ms).round() as i32), ms);
    Some(dragwin::place_at(cursor, grab, work, ms, logical))
}

/// Apply a decided drop. Returns the outcome to report: `Moved` when the source was
/// a secondary's only workspace and the window itself was repositioned (no transfer,
/// nothing to recreate), else `Dropped` after sending `drag://drop`.
fn apply_drop(app: &AppHandle, s: &Session, pick: DropPick) -> Outcome {
    match pick {
        DropPick::Cancel => Outcome::Cancelled,
        DropPick::Join(label) => {
            emit_to(app, &s.source, DROP_EVENT, json!({ "id": s.ws_id, "target": { "kind": "label", "label": label } }));
            Outcome::Dropped
        }
        DropPick::NewAt(cursor) => {
            let at = placement(app, &s.source, cursor);
            if windows::is_sole_workspace(app, &s.source, s.ws_id) {
                if let (Some(at), Some(w)) = (at, app.get_webview_window(&s.source)) {
                    windows::apply_placement(&w, at);
                    crate::applog::log("info", "drag", &format!("{} moved to ({}, {}): its only workspace was dragged out", s.source, at.x, at.y));
                    return Outcome::Moved;
                }
            }
            let target = match at {
                Some(a) => json!({ "kind": "new", "at": a }),
                None => json!({ "kind": "new" }),
            };
            emit_to(app, &s.source, DROP_EVENT, json!({ "id": s.ws_id, "target": target }));
            Outcome::Dropped
        }
    }
}

/// Run one batch of actions. Returns the final outcome once the drag ended.
fn apply(app: &AppHandle, s: &Session, actions: Vec<Action>, silent: bool) -> Option<Outcome> {
    let mut moved = None;
    for a in actions {
        match a {
            Action::Phase(p) => emit_to(app, &s.source, STATE_EVENT, json!({ "phase": p.name() })),
            Action::HoverStart(l) => emit_to(app, &l, HOVER_EVENT, json!({ "name": s.name, "tint": s.tint, "from": s.source })),
            Action::HoverEnd(l) => emit_to(app, &l, HOVER_END_EVENT, json!({})),
            Action::Drop(pick) => moved = Some(apply_drop(app, s, pick)),
            Action::End(o) => {
                let o = if o == Outcome::Dropped { moved.unwrap_or(o) } else { o };
                if !silent {
                    emit_to(app, &s.source, END_EVENT, json!({ "outcome": o.name() }));
                }
                return Some(o);
            }
        }
    }
    None
}

fn run(app: AppHandle, s: Session) {
    let hwnds: HwndMap = Arc::new(Mutex::new(Vec::new()));
    refresh_hwnds(&app, &hwnds);
    let mut src = PollSource { label: s.source.clone(), hwnds: hwnds.clone() };
    let mut state = DragState::new(s.tearable);
    let started = Instant::now();
    let mut ticks: u32 = 0;
    let outcome = loop {
        if ticks > 0 {
            std::thread::sleep(Duration::from_millis(POLL_MS));
        }
        // Ended from outside: Escape, JS done, replaced by a newer arm, quitting, timeout.
        if !is_current(s.id) {
            // Replaced or already ended: end any hint quietly, say nothing to the source.
            apply(&app, &s, dragwin::abort(&state, Outcome::Cancelled), true);
            return;
        }
        let stop = s.stop.load(Ordering::SeqCst);
        let ended = if stop == STOP_DISARM {
            Some((Outcome::Cancelled, true))
        } else if stop == STOP_CANCEL {
            Some((Outcome::Cancelled, false))
        } else if app.state::<WindowState>().lock().exiting {
            Some((Outcome::Cancelled, true))
        } else if started.elapsed() >= Duration::from_millis(TIMEOUT_MS) {
            Some((Outcome::Timeout, false))
        } else {
            None
        };
        if let Some((o, silent)) = ended {
            break apply(&app, &s, dragwin::abort(&state, o), silent);
        }
        if ticks % HWND_REFRESH_TICKS == 0 && ticks > 0 {
            refresh_hwnds(&app, &hwnds);
        }
        ticks = ticks.wrapping_add(1);

        let infos = {
            let map = hwnds.lock().unwrap_or_else(|e| e.into_inner()).clone();
            windows::drag_infos(&app.state::<WindowState>().lock(), |l| os::geometry(map.iter().find(|(n, _)| n == l).map(|(_, h)| *h)))
        };
        let Some(source_rect) = infos.iter().find(|w| w.label == s.source).map(|w| w.rect) else {
            // The source window is gone (closed, destroyed): nobody to tell.
            break apply(&app, &s, dragwin::abort(&state, Outcome::Cancelled), true);
        };
        let sample = src.sample();
        let (next, actions) = dragwin::step(&state, &sample, &World { source: &s.source, source_rect, windows: &infos });
        state = next;
        if let Some(o) = apply(&app, &s, actions, false) {
            break Some(o);
        }
    };
    if let Some(o) = outcome {
        crate::applog::log("info", "drag", &format!("drag of workspace {} from {} ended: {}", s.ws_id, s.source, o.name()));
    }
    active(|a| {
        if a.as_ref().is_some_and(|x| x.id == s.id) {
            *a = None;
        }
    });
    script(|x| {
        if x.as_ref().is_some_and(|x| x.label == s.source) {
            *x = None;
        }
    });
}

/// Arm a drag for `id`, which `window` must own. One drag at a time: arming again
/// from the same window replaces its previous drag (a reload may have lost it),
/// from another window is refused.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn drag_arm(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, WindowState>,
    kind: String,
    id: u32,
    tearable: bool,
    name: String,
    tint: String,
    panes: u32,
) -> Result<(), String> {
    let _ = panes;
    if kind != "workspace" {
        return Err(format!("cannot drag a {kind:?}"));
    }
    let label = window.label().to_string();
    {
        let reg = state.lock();
        windows::check_registered(&reg, &label)?;
        reg.require_multiwindow()?;
        if !reg.owns(&label, id) {
            return Err(format!("window {label} does not own workspace {id}"));
        }
    }
    let session = Session {
        id: NEXT_ID.fetch_add(1, Ordering::SeqCst),
        source: label.clone(),
        ws_id: id,
        tearable,
        name,
        tint,
        stop: Arc::new(AtomicU8::new(STOP_NONE)),
    };
    active(|a| match a {
        Some(cur) if cur.source != label => Err(format!("a drag from {} is already in progress", cur.source)),
        _ => {
            *a = Some(session.clone());
            Ok(())
        }
    })?;
    emit_to(&app, &label, STATE_EVENT, json!({ "phase": "armed" }));
    std::thread::Builder::new()
        .name("drag-poll".into())
        .spawn(move || run(app, session))
        .map_err(|e| {
            active(|a| *a = None);
            e.to_string()
        })?;
    Ok(())
}

fn stop_own(window: &tauri::Window, how: u8) {
    active(|a| {
        if let Some(s) = a.as_ref().filter(|s| s.source == window.label()) {
            s.stop.store(how, Ordering::SeqCst);
        }
    });
}

/// JS is done with the drag (a reorder committed, the tile unmounted): stop polling
/// quietly. Idempotent.
#[tauri::command(async)]
pub fn drag_disarm(window: tauri::Window) {
    stop_own(&window, STOP_DISARM);
}

/// Escape: end the drag, nothing moves. The source gets `drag://end {cancelled}`.
/// Idempotent.
#[tauri::command(async)]
pub fn drag_cancel(window: tauri::Window) {
    stop_own(&window, STOP_CANCEL);
}

/// Canary only: feed `points` (physical cursor positions, one per 16 ms tick)
/// through the same state machine as the real cursor, then release the button when
/// `release` is set. Call it before the `drag_arm` it should drive (or after, within
/// the drag). Refused on any other flavour, so a stable build cannot be scripted.
#[tauri::command(async)]
pub fn drag_debug_script(app: AppHandle, window: tauri::Window, points: Vec<[i32; 2]>, release: bool) -> Result<(), String> {
    if !crate::canary::is_canary_identifier(&app.config().identifier) {
        return Err("drag_debug_script is only available in Canary".into());
    }
    let Some(first) = points.first().copied() else { return Err("drag_debug_script needs at least one point".into()) };
    let pts: VecDeque<Pt> = points.iter().map(|p| Pt { x: p[0], y: p[1] }).collect();
    script(|s| {
        *s = Some(Script { label: window.label().to_string(), points: pts, last: Pt { x: first[0], y: first[1] }, release, made: Instant::now() })
    });
    Ok(())
}

/// The OS half: cursor, button, window under the cursor, window geometry.
#[cfg(windows)]
mod os {
    use super::*;
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, GetSystemMetrics, GetWindowRect, IsIconic, IsWindow, IsWindowVisible, WindowFromPoint, GA_ROOT, SM_SWAPBUTTON,
    };

    pub fn hwnd_of(app: &AppHandle, label: &str) -> Option<isize> {
        app.get_webview_window(label)?.hwnd().ok().map(|h| h.0 as isize)
    }

    pub fn sample(hwnds: &[(String, isize)]) -> Sample {
        let mut p = POINT { x: 0, y: 0 };
        // On failure the point stays at the origin; the button is then judged alone.
        let _ = unsafe { GetCursorPos(&mut p) };
        let vk = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
        let down = unsafe { GetAsyncKeyState(vk as i32) } < 0;
        let top = unsafe { WindowFromPoint(p) };
        let topmost = if top.is_null() {
            Topmost::Unknown
        } else {
            let root = unsafe { GetAncestor(top, GA_ROOT) };
            let root = if root.is_null() { top } else { root };
            match hwnds.iter().find(|(_, h)| *h == root as isize) {
                Some((l, _)) => Topmost::Ours(l.clone()),
                None => Topmost::Foreign,
            }
        };
        Sample { cursor: Pt { x: p.x, y: p.y }, down, topmost }
    }

    /// Visible frame rect (DWM, so the invisible resize border is not counted),
    /// minimised, visible. None when the window is gone.
    pub fn geometry(hwnd: Option<isize>) -> Option<(Rect, bool, bool)> {
        let h = hwnd? as *mut core::ffi::c_void;
        if unsafe { IsWindow(h) } == 0 {
            return None;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let ok = unsafe {
            DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS as u32, &mut r as *mut RECT as *mut core::ffi::c_void, core::mem::size_of::<RECT>() as u32)
        } == 0;
        if !ok && unsafe { GetWindowRect(h, &mut r) } == 0 {
            return None;
        }
        let minimised = unsafe { IsIconic(h) } != 0;
        let visible = unsafe { IsWindowVisible(h) } != 0;
        Some((Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top), minimised, visible))
    }
}

#[cfg(not(windows))]
mod os {
    use super::*;

    pub fn hwnd_of(_: &AppHandle, _: &str) -> Option<isize> {
        None
    }

    pub fn sample(_: &[(String, isize)]) -> Sample {
        Sample { cursor: Pt::default(), down: false, topmost: Topmost::Unknown }
    }

    pub fn geometry(_: Option<isize>) -> Option<(Rect, bool, bool)> {
        None
    }
}
