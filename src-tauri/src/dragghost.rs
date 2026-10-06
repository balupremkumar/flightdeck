//! The drag ghost (D6): a small borderless window that follows the cursor while a
//! workspace is torn out, showing its name and what a release would do.
//!
//! One window, label `drag-ghost`, built hidden when a tearable drag is armed
//! (prewarmed, so it is ready by the time the cursor leaves the window) and
//! destroyed on every way a drag can end. It is positioned from the same 16 ms poll
//! that decides the drop (`dragrun::run`), so there is no second cursor reader.
//!
//! Focus safety. The window never takes focus, by construction:
//!   - `focusable(false)` makes tao add `WS_EX_NOACTIVATE` to the extended style, so
//!     neither a click nor `ShowWindow` can activate it;
//!   - `focused(false)` keeps the first show non-activating and keeps wry from
//!     moving focus into the webview;
//!   - `set_ignore_cursor_events(true)` adds `WS_EX_TRANSPARENT | WS_EX_LAYERED`, so
//!     every mouse event falls through to whatever is underneath;
//!   - nothing here calls `set_focus`, and the label does not match `fw-*`, so
//!     `capabilities/default.json` grants the page no IPC at all.
//! The hit test also ignores it: `dragrun::os::sample` maps the ghost's HWND to
//! `Topmost::Unknown`, never `Foreign`, so the rects decide as if it were not there.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::dragwin::{self, GhostMode, Pt, Rect, GHOST_H, GHOST_W};

pub const LABEL: &str = "drag-ghost";

/// How often the monitor list is re-read and the current mode is re-sent (the first
/// `eval` can land before the page has loaded and be lost).
const REFRESH_TICKS: u32 = 30;
/// A previous drag's ghost may still be going away; wait for its label to free up.
const BUILD_TRIES: u32 = 20;
const BUILD_RETRY_MS: u64 = 50;

/// The drag session that owns the live ghost, if one is built.
static OWNER: Mutex<Option<u64>> = Mutex::new(None);

fn owner<T>(f: impl FnOnce(&mut Option<u64>) -> T) -> T {
    f(&mut OWNER.lock().unwrap_or_else(|e| e.into_inner()))
}

fn build(app: &AppHandle, path: &str) -> Result<WebviewWindow, String> {
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(path.into()))
        .title("Flightdeck drag")
        .inner_size(GHOST_W, GHOST_H)
        .resizable(false)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    // Belt and braces on the two flags that matter: both are idempotent.
    let _ = w.set_focusable(false);
    w.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    Ok(w)
}

/// Build the ghost for `session` on its own thread, hidden. Failure only costs the
/// ghost: the drag, the hover hint and the drop all work without it.
pub fn spawn(app: &AppHandle, session: u64, name: &str, tint: &str, panes: u32) {
    let app = app.clone();
    let path = dragwin::ghost_path(name, tint, panes, GhostMode::New);
    let _ = std::thread::Builder::new().name("drag-ghost-build".into()).spawn(move || {
        let mut last = String::new();
        for _ in 0..BUILD_TRIES {
            if !crate::dragrun::is_current(session) {
                return;
            }
            match build(&app, &path) {
                Ok(w) => {
                    // Under the lock, so `destroy` (which clears the session first, then
                    // takes this lock) either sees the owner or this sees the drag gone.
                    let mut o = OWNER.lock().unwrap_or_else(|e| e.into_inner());
                    if crate::dragrun::is_current(session) {
                        *o = Some(session);
                    } else {
                        let _ = w.destroy();
                    }
                    return;
                }
                Err(e) => {
                    last = e;
                    std::thread::sleep(Duration::from_millis(BUILD_RETRY_MS));
                }
            }
        }
        crate::applog::log("warn", "drag", &format!("drag ghost not built: {last}"));
    });
}

/// Destroy the ghost if `session` owns it. Call after the session is no longer
/// current. Idempotent, and safe when the ghost never got built.
pub fn destroy(app: &AppHandle, session: u64) {
    let mine = owner(|o| if *o == Some(session) { o.take().is_some() } else { false });
    if mine {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
    }
}

/// Per-drag ghost driver, owned by the poll thread.
pub struct Ghost {
    session: u64,
    shown: bool,
    mode: Option<GhostMode>,
    monitors: Vec<(Rect, f64)>,
    last_pos: Option<Pt>,
    last_scale: f64,
    ticks: u32,
}

impl Ghost {
    pub fn new(session: u64) -> Ghost {
        Ghost { session, shown: false, mode: None, monitors: Vec::new(), last_pos: None, last_scale: 0.0, ticks: 0 }
    }

    fn read_monitors(app: &AppHandle) -> Vec<(Rect, f64)> {
        app.available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| (Rect::new(m.position().x, m.position().y, m.size().width as i32, m.size().height as i32), m.scale_factor()))
            .collect()
    }

    /// One tick. `want` is where to draw (cursor, mode) while torn, `None` otherwise
    /// (armed, refused, ended). Returns true when the ghost was just shown, so the
    /// caller can refresh the hit-test window list at once.
    pub fn update(&mut self, app: &AppHandle, want: Option<(Pt, GhostMode)>) -> bool {
        self.ticks = self.ticks.wrapping_add(1);
        let refresh = self.ticks % REFRESH_TICKS == 0;
        let Some((cursor, mode)) = want else {
            if self.shown {
                self.shown = false;
                self.mode = None;
                if let Some(w) = self.window(app) {
                    let _ = w.hide();
                }
            }
            return false;
        };
        let Some(w) = self.window(app) else { return false };
        if self.monitors.is_empty() || refresh {
            self.monitors = Self::read_monitors(app);
        }
        if let Some((rect, scale)) = dragwin::monitor_at(&self.monitors, cursor).or_else(|| self.monitors.first().copied()) {
            let at = dragwin::ghost_origin(cursor, scale, rect);
            if self.last_pos != Some(at) {
                // Position first, then size, so a DPI change lands before the resize.
                let _ = w.set_position(PhysicalPosition::new(at.x, at.y));
                if (scale - self.last_scale).abs() > f64::EPSILON {
                    let _ = w.set_size(PhysicalSize::new((GHOST_W * scale).round() as u32, (GHOST_H * scale).round() as u32));
                    self.last_scale = scale;
                }
                self.last_pos = Some(at);
            }
        }
        let just_shown = !self.shown;
        if just_shown {
            // `show` on a NOACTIVATE window does not activate it.
            let _ = w.show();
            self.shown = true;
        }
        if self.mode != Some(mode) || refresh {
            let _ = w.eval(format!("window.__ghostMode&&window.__ghostMode({:?})", mode.name()));
            self.mode = Some(mode);
        }
        just_shown
    }

    /// The ghost window, only while this session owns it.
    fn window(&self, app: &AppHandle) -> Option<WebviewWindow> {
        if owner(|o| *o) != Some(self.session) {
            return None;
        }
        app.get_webview_window(LABEL)
    }
}
