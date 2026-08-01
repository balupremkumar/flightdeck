import { useEffect, useState } from "react";
import { getShortcuts, FIXED_SHORTCUTS, CONTEXTUAL_SHORTCUTS } from "./Settings";
import { IconClose } from "./Icons";
import "./overlays.css";

// Shortcuts.tsx — the keyboard cheat-sheet overlay (UX-545, was cited twice
// as #105/#269; built once here). Self-contained like CommandPalette: owns
// its own open state via a global "?" listener, no store wiring needed.
// Everything it lists comes from Settings.tsx's shortcut registries — the
// same source the Settings > Shortcuts panel and the command palette's hints
// read from — so there's exactly one place these can drift from reality
// instead of three hand-typed copies.

/** True when the event target is somewhere typing "?" should be treated as
 *  the literal character rather than the cheat-sheet toggle. Exported for
 *  the accompanying test. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], .pbody');
}

export function Shortcuts() {
  const [open, setOpen] = useState(false);

  // "?" toggles — guarded so it's never stolen from a text field, a select,
  // or a terminal (same .pbody guard the rest of the app's global shortcuts
  // use). No modifier keys: "?" already implies Shift on a US layout, so
  // e.key is "?" directly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target as Element | null)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    };
    // Capture phase: xterm swallows Escape on bubble, same reasoning as
    // every other overlay's dismiss listener in this app.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const general = [...getShortcuts(), ...FIXED_SHORTCUTS];
  const byContext = new Map<string, typeof CONTEXTUAL_SHORTCUTS>();
  for (const s of CONTEXTUAL_SHORTCUTS) {
    const list = byContext.get(s.context) ?? [];
    list.push(s);
    byContext.set(s.context, list);
  }

  return (
    <div className="ov-scrim" onMouseDown={() => setOpen(false)}>
      <div className="cheat-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="cheat-head">
          <h2>Keyboard shortcuts</h2>
          <button className="ov-x" onClick={() => setOpen(false)} title="Close"><IconClose size={16} /></button>
        </div>
        <div className="cheat-body">
          <div className="cheat-group">
            <div className="set-label">General</div>
            <div className="kbd-list">
              {general.map((s) => (
                <div className="kbd-row" key={s.id}>
                  <span>{s.label}</span>
                  <span className="kbd-keys">{s.combo.split("+").map((k) => <kbd key={k}>{k}</kbd>)}</span>
                </div>
              ))}
              <div className="kbd-row"><span>Close any overlay</span><span className="kbd-keys"><kbd>Esc</kbd></span></div>
            </div>
          </div>
          {[...byContext.entries()].map(([context, rows]) => (
            <div className="cheat-group" key={context}>
              <div className="set-label">{context}</div>
              <div className="kbd-list">
                {rows.map((s) => (
                  <div className="kbd-row" key={s.id}>
                    <span>{s.label}</span>
                    <span className="kbd-keys">{s.combo.split("+").map((k) => <kbd key={k}>{k}</kbd>)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="cheat-foot">Rebind any of these in Settings &gt; Shortcuts. Press <kbd>?</kbd> to close.</div>
      </div>
    </div>
  );
}
