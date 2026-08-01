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

/** UX-559: a "waiting" pane's tail matches a plain yes/no or single-key
 *  approval prompt — Terminal.tsx already classifies these as "permission",
 *  so anything that reaches here as "waiting" has already cleared that bar.
 *  Kept in sync by eye with Terminal.tsx's PERMISSION_PATTERNS (that file
 *  isn't ours — see HANDOFF EDITS for wiring this in at the source instead of
 *  re-deriving it here from lastLine). */
const STANDARD_PROMPT_RE = [
  /do you want to/i,
  /would you like to/i,
  /\b(allow|approve|grant|trust) (this|these|it|access|edits?|command)/i,
  /\((y\/n|yes\/no)\)|\[(y\/n|yes\/no)\]/i,
  /❯?\s*1\.\s*yes/i,
  /press enter to (continue|confirm|approve)/i,
  /waiting for (your )?(approval|confirmation|permission)/i,
];

/** UX-559: true when a pane's last output line reads as the agent asking a
 *  genuine open-ended question ("which package manager should I use?",
 *  "what should I name this branch?") rather than a standard yes/no/approval
 *  prompt. Deliberately conservative — requires a literal "?" so plain
 *  narration ("checking your config...") never false-positives — but a
 *  question mark alone is a weak signal on its own (rhetorical asides, code
 *  comments), so it's additionally required NOT to match any of the standard
 *  prompt shapes above. Pure and unit-tested; the caller decides what to do
 *  with the result (attentionQueue below ranks it; PaneView badges it). */
export function isOpenQuestion(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t.endsWith("?")) return false;
  return !STANDARD_PROMPT_RE.some((re) => re.test(t));
}

/** Ranked "needs you now" list: approval > a genuine open question > error >
 *  plain waiting, and within a rank the pane that has needed you longest
 *  comes first — a scan order, not a pile. A "waiting" pane whose last line
 *  reads as an open question (UX-559) is promoted above plain waiting (and
 *  above error — an unanswered question blocks progress at least as much as
 *  a crash, and unlike an error it's actively expecting you right now) but
 *  stays below an explicit approval prompt, which is the most literally
 *  blocked state there is. */
export function attentionQueue(workspaces: Workspace[], snoozed: Record<number, number> = {}): AttentionItem[] {
  const now = Date.now();
  const rankOf = (p: AttentionItem["p"]): number => {
    if (p.state === "waiting" && isOpenQuestion(lastLine.get(p.id))) return 0.5;
    return ATTENTION_RANK[p.state] ?? 9;
  };
  return workspaces
    .flatMap((w) =>
      w.panes
        .filter((p) => p.state in ATTENTION_RANK)
        // UI-143: a snoozed pane drops out of the queue until its timer expires.
        .filter((p) => !(snoozed[p.id] && snoozed[p.id] > now))
        .map((p) => ({ w, p, since: stateSince.get(p.id) ?? Date.now() }))
    )
    .sort((a, b) => {
      const ra = rankOf(a.p);
      const rb = rankOf(b.p);
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

/** UX-537: when each pane last produced output (ms epoch) — companion to
 *  `lastLine` above, same writer (PaneView's `onLine`, see HANDOFF EDITS for
 *  the one-line call-site addition). Powers "jump to the pane that most
 *  recently produced output". */
export const lastOutputAt = new Map<number, number>();

/** Records a fresh line of output for `paneId` at `at` (defaults to now).
 *  Call this alongside `lastLine.set` wherever a pane's tail tracker fires —
 *  kept as a separate function (not folded into a `lastLine.set` override)
 *  so the write site stays a plain, greppable one-liner. */
export function recordOutput(paneId: number, at: number = Date.now()) {
  lastOutputAt.set(paneId, at);
}

export interface RecentOutputItem { w: Workspace; p: PaneModel; at: number }

/** UX-537: the single pane across every workspace that produced output most
 *  recently, or null if nothing has ever been recorded (a fresh launch, or
 *  every pane is a shell that's never printed a tracked line). Panes with no
 *  recorded output are excluded rather than sorted last with `at: 0` — an
 *  untouched pane isn't "the oldest activity", it's simply not a candidate. */
export function mostRecentOutputPane(workspaces: Workspace[]): RecentOutputItem | null {
  let best: RecentOutputItem | null = null;
  for (const w of workspaces) {
    for (const p of w.panes) {
      const at = lastOutputAt.get(p.id);
      if (at == null) continue;
      if (!best || at > best.at) best = { w, p, at };
    }
  }
  return best;
}
