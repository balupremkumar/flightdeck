// Pure decisions for terminal copy-on-select and right-click (H2). Kept free of
// xterm and React so the rules are unit-testable.

export type RightClickBehaviour = "paste" | "menu";
export type RightClickAction = "menu" | "link" | "app" | "copy" | "paste" | "paste-confirm";

export interface RightClickInput {
  hasSelection: boolean;
  overLink: boolean;
  /** The app in the pane has mouse tracking on (xterm forwards clicks to it). */
  mouseTracking: boolean;
  shift: boolean;
  setting: RightClickBehaviour;
  /** SF2: a stray right-click paste could answer a prompt or land in the wrong
   *  pane, so it goes through the confirm dialog (see shouldConfirmPaste). */
  confirmPaste?: boolean;
}

/** SF2: right-click paste needs a confirm when the pane is waiting on a human
 *  (permission dialog or open question) or is not the focused pane. */
export function shouldConfirmPaste(i: { attention: "permission" | "question" | "error" | null; focused: boolean }): boolean {
  return !i.focused || i.attention === "permission" || i.attention === "question";
}

/** What a right-click on a terminal should do.
 *  "menu": open the pane context menu. "link": the LinkMenu (handled by the
 *  link listener). "app": do nothing, xterm forwards it to the TUI. */
export function rightClickAction(i: RightClickInput): RightClickAction {
  if (i.shift) return "menu";
  if (i.setting === "menu") return "menu";
  if (i.overLink) return "link";
  if (i.mouseTracking) return "app";
  if (i.hasSelection) return "copy";
  return i.confirmPaste ? "paste-confirm" : "paste";
}

/** Copy-on-select fires only for a user drag/click that actually changed the
 *  selection, never for programmatic selection or an empty one. */
export function shouldCopyOnSelect(i: { enabled: boolean; userGesture: boolean; changed: boolean; text: string }): boolean {
  return i.enabled && i.userGesture && i.changed && i.text.length > 0;
}
