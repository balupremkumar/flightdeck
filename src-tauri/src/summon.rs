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
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let action = decide(
        win.is_focused().unwrap_or(false),
        win.is_visible().unwrap_or(true),
        win.is_minimized().unwrap_or(false),
    );
    match action {
        SummonAction::Dismiss => {
            let _ = win.hide();
        }
        SummonAction::Bring => {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
            let _ = app.emit(SUMMON_EVENT, ());
        }
    }
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

    /// Two presses from the front must land back where they started.
    #[test]
    fn the_chord_is_a_toggle() {
        assert_eq!(decide(true, true, false), SummonAction::Dismiss);
        assert_eq!(decide(false, false, false), SummonAction::Bring);
    }
}
