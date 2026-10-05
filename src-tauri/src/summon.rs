// summon.rs — QL-780: the global summon hotkey.
//
// One chord, owned by the OS rather than the webview, that fetches Flightdeck
// from behind whatever is on top of it and puts it away again on a second
// press. This is the counterpart to the attention machinery: the badge and the
// toast tell you an agent needs you, the summon key is how you get there in
// one keystroke from inside an editor, a browser, or anything else.
//
// Registered AFTER the app is built (the pattern the plugin documents), so a
// chord the OS refuses to hand over — another app already owns it — logs and
// carries on instead of stopping the app from booting.

#[cfg(desktop)]
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The default summon chord, and for now the only one.
///
/// Ctrl+Alt+F is deliberately conservative: Windows itself claims Win+<key>
/// and Ctrl+Shift+Esc, not Ctrl+Alt+<letter>, and no agent TUI Flightdeck
/// ships binds it either. It is a single obvious constant so a future Settings
/// control can make it user-editable — swapping the chord is unregister the
/// old, register the new, and nothing else in the codebase knows what it is.
/// Keep this string and `chord()` in step; the string is what the UI shows.
#[allow(dead_code)] // shown by a future Settings control; also used in log output
pub(crate) const DEFAULT_SUMMON_CHORD: &str = "Ctrl+Alt+F";

/// Emitted every time the hotkey BRINGS THE WINDOW FORWARD (never on the
/// dismiss leg). The frontend listens for this to jump to the pane that needs
/// a human most — see the listener in src/Notifications.tsx. No payload: the
/// frontend already owns the attention ranking (attention.ts), and the backend
/// has no business duplicating it.
pub(crate) const SUMMON_EVENT: &str = "app://summon";

/// What a hotkey press should do, given the window's current state. Split out
/// from the window calls so the one piece of real logic here is testable
/// without a GUI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SummonAction {
    /// Already in front of the user: put it away.
    Dismiss,
    /// Anywhere else (hidden, minimised, or just behind another window):
    /// show it, restore it, focus it.
    Bring,
}

/// A minimised window still reports `visible`, so "minimised" has to veto
/// `focused`/`visible` explicitly — otherwise the first press after minimising
/// would hide the window rather than restore it, and the user would have to
/// press the chord twice to get anything.
pub(crate) fn decide(focused: bool, visible: bool, minimized: bool) -> SummonAction {
    if focused && visible && !minimized {
        SummonAction::Dismiss
    } else {
        SummonAction::Bring
    }
}

#[cfg(desktop)]
fn chord() -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyF)
}

/// Hide, not minimise (per the brief): minimising leaves an animation and a
/// taskbar dance every time, hiding is instant and makes the chord feel like a
/// toggle. The trade-off is that a hidden window has no taskbar button, so the
/// hotkey is the only way back — which is why `decide` never hides a window
/// the user isn't already looking at.
#[cfg(desktop)]
fn toggle<R: Runtime>(app: &AppHandle<R>) {
    use crate::windows::{WindowState, MAIN};
    let state = app.state::<WindowState>();
    let labels: Vec<String> = {
        let reg = state.lock();
        let mut l: Vec<String> = reg.windows.keys().cloned().collect();
        if !l.iter().any(|x| x == MAIN) {
            l.push(MAIN.to_string());
        }
        l
    };
    let views: Vec<WinView> = labels
        .iter()
        .filter_map(|l| {
            let w = app.get_webview_window(l)?;
            Some(WinView {
                label: l.clone(),
                focused: w.is_focused().unwrap_or(false),
                visible: w.is_visible().unwrap_or(true),
                minimized: w.is_minimized().unwrap_or(false),
            })
        })
        .collect();
    let plan = {
        let mut reg = state.lock();
        let last_focus: Vec<(String, u64)> = reg.windows.iter().map(|(l, r)| (l.clone(), r.last_focus_ms)).collect();
        let top = reg.global_attention().1;
        let plan = plan(&views, &reg.summon_hidden, top.as_ref().map(|(l, _)| l.as_str()), &last_focus);
        match &plan {
            SummonPlan::Dismiss { hide, focused } => {
                reg.summon_hidden = hide.clone();
                if let Some(r) = focused.as_ref().and_then(|f| reg.windows.get_mut(f)) {
                    r.last_focus_ms = crate::windows::now_ms();
                }
            }
            SummonPlan::Bring { target, .. } => {
                reg.summon_hidden.clear();
                if let Some(r) = reg.windows.get_mut(target) {
                    r.last_focus_ms = crate::windows::now_ms();
                }
            }
        }
        (plan, top)
    };
    match plan {
        (SummonPlan::Dismiss { hide, .. }, _) => {
            for l in hide {
                if let Some(w) = app.get_webview_window(&l) {
                    let _ = w.hide();
                }
            }
        }
        (SummonPlan::Bring { show, target }, top) => {
            for l in show {
                if let Some(w) = app.get_webview_window(&l) {
                    let _ = w.show();
                }
            }
            if let Some(w) = app.get_webview_window(&target) {
                let _ = w.show();
                let _ = w.unminimize();
                // The only set_focus in the cross-window attention path: it is
                // the summon chord, a direct user action.
                let _ = w.set_focus();
            }
            let payload = SummonPayload {
                ws_id: top.as_ref().map(|(_, t)| t.ws_id),
                pane_id: top.as_ref().map(|(_, t)| t.pane_id),
            };
            let _ = app.emit_to(target.as_str(), SUMMON_EVENT, payload);
        }
    }
}

/// `app://summon` payload: the global top attention item, if any.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummonPayload {
    pub ws_id: Option<u32>,
    pub pane_id: Option<u32>,
}

/// One window as the chord sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WinView {
    pub label: String,
    pub focused: bool,
    pub visible: bool,
    pub minimized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SummonPlan {
    /// Hide these (visible, not minimised) and remember them; `focused` is the
    /// window the user was in, kept as "last focused".
    Dismiss { hide: Vec<String>, focused: Option<String> },
    /// Show `show` (the remembered set, still existing) and focus `target`.
    Bring { show: Vec<String>, target: String },
}

/// Pure decision for one chord press across every Flightdeck window.
/// `last_focus` is `(label, last_focus_ms)`; `top_label` is the window holding
/// the global top attention item. With only main registered this reduces to
/// `decide`: dismiss when focused, otherwise show, unminimise and focus main.
pub(crate) fn plan(views: &[WinView], remembered: &[String], top_label: Option<&str>, last_focus: &[(String, u64)]) -> SummonPlan {
    let any_focused = views.iter().any(|v| decide(v.focused, v.visible, v.minimized) == SummonAction::Dismiss);
    if any_focused {
        // Minimised windows are ones the user put away: leave them alone.
        let hide = views.iter().filter(|v| v.visible && !v.minimized).map(|v| v.label.clone()).collect();
        let focused = views.iter().find(|v| v.focused).map(|v| v.label.clone());
        return SummonPlan::Dismiss { hide, focused };
    }
    let exists = |l: &str| views.iter().any(|v| v.label == l);
    let target = top_label
        .filter(|l| exists(l))
        .map(str::to_string)
        .or_else(|| {
            last_focus.iter().filter(|(l, _)| exists(l)).max_by_key(|(_, t)| *t).map(|(l, _)| l.clone())
        })
        .unwrap_or_else(|| crate::windows::MAIN.to_string());
    let show = remembered.iter().filter(|l| exists(l) && **l != target).cloned().collect();
    SummonPlan::Bring { show, target }
}

/// Register the plugin and the chord. Never fatal: an unavailable hotkey costs
/// the user one shortcut, and refusing to boot over it would cost them the app.
#[cfg(desktop)]
pub(crate) fn init<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_global_shortcut::{Builder, GlobalShortcutExt, ShortcutState};

    let plugin = Builder::new()
        .with_handler(|app, shortcut, event| {
            // Pressed only: the plugin reports press AND release, and acting on
            // both would summon then immediately dismiss on a single tap.
            if event.state != ShortcutState::Pressed || shortcut != &chord() {
                return;
            }
            toggle(app);
        })
        .build();

    if let Err(e) = app.plugin(plugin) {
        eprintln!("summon hotkey unavailable (plugin): {e}");
        return;
    }
    if let Err(e) = app.global_shortcut().register(chord()) {
        eprintln!("summon hotkey {DEFAULT_SUMMON_CHORD} unavailable (already taken?): {e}");
    }
}

#[cfg(not(desktop))]
pub(crate) fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_the_user_is_looking_at_is_dismissed() {
        assert_eq!(decide(true, true, false), SummonAction::Dismiss);
    }

    #[test]
    fn a_hidden_window_is_brought_forward() {
        assert_eq!(decide(false, false, false), SummonAction::Bring);
    }

    /// The regression the `minimized` veto exists for: without it, a minimised
    /// window that still reports focused+visible would get hidden by the first
    /// press instead of restored.
    #[test]
    fn a_minimised_window_is_restored_not_hidden() {
        assert_eq!(decide(true, true, true), SummonAction::Bring);
        assert_eq!(decide(false, true, true), SummonAction::Bring);
    }

    /// The common case: visible, but buried under an editor or a browser.
    #[test]
    fn a_background_window_is_brought_forward_not_hidden() {
        assert_eq!(decide(false, true, false), SummonAction::Bring);
    }

    fn v(label: &str, focused: bool, visible: bool, minimized: bool) -> WinView {
        WinView { label: label.into(), focused, visible, minimized }
    }

    fn s(x: &[&str]) -> Vec<String> {
        x.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn single_window_matches_decide() {
        assert_eq!(
            plan(&[v("main", true, true, false)], &[], None, &[]),
            SummonPlan::Dismiss { hide: s(&["main"]), focused: Some("main".into()) }
        );
        assert_eq!(plan(&[v("main", false, false, false)], &[], None, &[]), SummonPlan::Bring { show: vec![], target: "main".into() });
        assert_eq!(plan(&[v("main", true, true, true)], &[], None, &[]), SummonPlan::Bring { show: vec![], target: "main".into() });
    }

    #[test]
    fn dismiss_hides_every_visible_window_but_not_minimised_ones() {
        let views = [v("main", false, true, false), v("fw-1", true, true, false), v("fw-2", false, true, true)];
        assert_eq!(plan(&views, &[], None, &[]), SummonPlan::Dismiss { hide: s(&["main", "fw-1"]), focused: Some("fw-1".into()) });
    }

    #[test]
    fn bring_shows_only_the_remembered_set_and_targets_the_top_item() {
        let views = [v("main", false, false, false), v("fw-1", false, false, false), v("fw-2", false, false, false)];
        let p = plan(&views, &s(&["main", "fw-2", "gone"]), Some("fw-2"), &[("main".into(), 9)]);
        assert_eq!(p, SummonPlan::Bring { show: s(&["main"]), target: "fw-2".into() });
    }

    #[test]
    fn bring_without_top_uses_last_focused_and_never_shows_unremembered() {
        let views = [v("main", false, false, false), v("fw-1", false, false, false)];
        let lf = [("main".to_string(), 5), ("fw-1".to_string(), 8)];
        assert_eq!(plan(&views, &s(&["main"]), None, &lf), SummonPlan::Bring { show: s(&["main"]), target: "fw-1".into() });
        // top item in a window that no longer exists falls back to last focused
        assert_eq!(plan(&views, &[], Some("fw-7"), &lf), SummonPlan::Bring { show: vec![], target: "fw-1".into() });
    }

    #[test]
    fn a_minimised_window_is_not_shown_by_bring() {
        // fw-1 was minimised by the user after the dismiss was recorded: it
        // is not in the remembered set (dismiss skipped it), so it stays put.
        let views = [v("main", false, false, false), v("fw-1", false, true, true)];
        let dismiss = plan(&[v("main", true, true, false), v("fw-1", false, true, true)], &[], None, &[]);
        let SummonPlan::Dismiss { hide, .. } = dismiss else { panic!("expected dismiss") };
        assert_eq!(hide, s(&["main"]));
        assert_eq!(plan(&views, &hide, None, &[]), SummonPlan::Bring { show: vec![], target: "main".into() });
    }

    /// Two presses from the front must land back where they started.
    #[test]
    fn the_chord_is_a_toggle() {
        assert_eq!(decide(true, true, false), SummonAction::Dismiss);
        assert_eq!(decide(false, false, false), SummonAction::Bring);
    }
}
