// Eager home of isTypingTarget so Cockpit need not import the lazy Shortcuts chunk.
/** True when the event target is somewhere typing "?" should be treated as
 *  the literal character rather than the cheat-sheet toggle. Exported for
 *  the accompanying test. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], .pbody');
}
