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
  /** SF3: agent CLIs (claude, codex, agy...) never use right-click, so mouse
   *  tracking does not hand it to the app. Plain shells keep "app" (vim, htop). */
  agentVendor?: boolean;
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
  if (i.mouseTracking && !i.agentVendor) return "app";
  if (i.hasSelection) return "copy";
  return i.confirmPaste ? "paste-confirm" : "paste";
}

/** Copy-on-select fires only for a user drag/click that actually changed the
 *  selection, never for programmatic selection or an empty one. */
export function shouldCopyOnSelect(i: { enabled: boolean; userGesture: boolean; changed: boolean; text: string }): boolean {
  return i.enabled && i.userGesture && i.changed && i.text.length > 0;
}

/** K11: Quiet terminal runs Claude in the alternate screen with its own mouse
 *  capture off (chatlog.rs claude_env), so xterm has no scrollback and turns
 *  every wheel notch into an Up/Down arrow, which Claude reads as prompt-box
 *  history. Claude still parses SGR wheel reports (verified live 2026-10-08,
 *  one line per report), so the wheel is sent as those instead. Pixel deltas
 *  accumulate so a trackpad scrolls in proportion; 40 px is one line, three
 *  lines per 120 px mouse notch, the usual terminal step. */
export const WHEEL_PX_PER_LINE = 40;

export interface WheelAcc { px: number }

/** The SGR wheel reports for one wheel event, or "" while the accumulated
 *  delta is under a line. col/row are 1-based cells under the pointer. */
export function quietWheelReports(acc: WheelAcc, e: { deltaY: number; deltaMode: number }, col: number, row: number, rows: number): string {
  const px = e.deltaMode === 1 ? e.deltaY * WHEEL_PX_PER_LINE : e.deltaMode === 2 ? e.deltaY * WHEEL_PX_PER_LINE * rows : e.deltaY;
  // A direction change drops the remainder so reversing responds at once.
  if (px !== 0 && acc.px !== 0 && Math.sign(px) !== Math.sign(acc.px)) acc.px = 0;
  acc.px += px;
  const lines = Math.trunc(acc.px / WHEEL_PX_PER_LINE);
  if (lines === 0) return "";
  acc.px -= lines * WHEEL_PX_PER_LINE;
  const button = lines < 0 ? 64 : 65;
  return `\x1b[<${button};${col};${row}M`.repeat(Math.min(Math.abs(lines), rows));
}
