import type { PaneState } from "./store";

/** Plain status for the pane owner. Age applies only to quiet panes. */
export function paneStateWord(state: PaneState, openQuestion: boolean, idleMs: number): { text: string; tone: string } {
  // A quiet pane is ambient (UX-601): muted unless it is asking something.
  const tone = state === "permission" || (state === "waiting" && openQuestion) ? "waiting" : state === "waiting" ? "idle" : state;
  if (state === "starting" || state === "running") return { text: "Working", tone };
  if (state === "permission") return { text: "Needs you", tone };
  if (state === "waiting" && openQuestion) return { text: "Has a question", tone };
  if (state === "error") return { text: "Error", tone };
  const age = idleMs < 60_000 ? "" : idleMs < 3_600_000
    ? ` ${Math.floor(idleMs / 60_000)}m`
    : ` ${Math.floor(idleMs / 3_600_000)}h`;
  return { text: `Idle${age}`, tone };
}
