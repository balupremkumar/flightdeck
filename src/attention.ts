// attention.ts — shared attention-queue model (UI-1). One ranking, two
// surfaces: the bell dropdown (Notifications.tsx) and the standalone queue
// overlay (AttentionQueue.tsx). Notifications owns the transition tracking —
// it's always mounted — and records into the module-level map here.
import type { PaneModel, PaneState, Workspace } from "./store";

// An explicit approval prompt outranks everything — the agent is blocked
// purely on the user (UI-2); then errors, then plain waiting.
export const ATTENTION_RANK: Partial<Record<PaneState, number>> = { permission: 0, error: 1, waiting: 2 };

/** When each pane entered its current state (ms epoch). Written by
 *  Notifications' transition watcher; read by both attention surfaces. */
export const stateSince = new Map<number, number>();

export interface AttentionItem {
  w: Workspace;
  p: PaneModel;
  since: number;
}

/** Ranked "needs you now" list: approval > error > waiting, and within a rank
 *  the pane that has needed you longest comes first — a scan order, not a pile. */
export function attentionQueue(workspaces: Workspace[], snoozed: Record<number, number> = {}): AttentionItem[] {
  const now = Date.now();
  return workspaces
    .flatMap((w) =>
      w.panes
        .filter((p) => p.state in ATTENTION_RANK)
        // UI-143: a snoozed pane drops out of the queue until its timer expires.
        .filter((p) => !(snoozed[p.id] && snoozed[p.id] > now))
        .map((p) => ({ w, p, since: stateSince.get(p.id) ?? Date.now() }))
    )
    .sort((a, b) => {
      const ra = ATTENTION_RANK[a.p.state] ?? 9;
      const rb = ATTENTION_RANK[b.p.state] ?? 9;
      return ra === rb ? a.since - b.since : ra - rb;
    });
}

// Re-exported from the shared formatter (UI-220) so existing imports keep working.
export { duration as forMins } from "./format";

export const STATE_LABEL: Record<PaneState, string> = {
  starting: "Starting",
  running: "Running",
  idle: "Idle",
  waiting: "Waiting",
  permission: "Needs approval",
  error: "Error",
};

/** UI-141: the pane's most recent output line, so the queue says WHAT it's
 *  asking rather than just that it's asking. Written by Terminal's tail
 *  tracker; capped, ANSI already stripped by the caller. */
export const lastLine = new Map<number, string>();
