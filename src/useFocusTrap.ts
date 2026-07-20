// useFocusTrap — UI-30.
//
// Tab could walk out of an open modal into the app behind the scrim, leaving
// focus somewhere the user can't see and can't get back from without a mouse.
// This keeps Tab inside the dialog, restores focus to whatever opened it on
// close, and moves focus INTO the dialog on open so a keyboard user starts
// somewhere sensible.
import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const returnTo = document.activeElement as HTMLElement | null;

    // Move focus in, but don't steal it from a field the dialog auto-focused.
    if (!root.contains(document.activeElement)) {
      const first = focusable(root)[0];
      (first ?? root).focus?.();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;

      // Focus escaped the dialog entirely (or never entered) — pull it back.
      if (!current || !root.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Capture phase: xterm and other handlers stop propagation on some keys.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // Return focus where it came from, if that element still exists.
      if (returnTo && document.contains(returnTo)) returnTo.focus?.();
    };
  }, [ref, active]);
}
