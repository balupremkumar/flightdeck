// attention.ts — shared attention-queue model (UI-1). One ranking, two
// surfaces: the bell dropdown (Notifications.tsx) and the standalone queue
// overlay (AttentionQueue.tsx). Notifications owns the transition tracking —
// it's always mounted — and records into the module-level map here.
//
// UX-601 (owner ruling 2026-08-01) split the model in two. "Needs you" =
// approval, error, or a genuinely-asked question → needsHumanQueue, and that
// is the ONLY thing allowed to light the bell, badge the taskbar, toast, or
// chime. "Ambient" = a pane that has merely gone quiet → ambientQueue, shown
// as context and nothing more. attentionQueue is the union of the two and is
// for navigation call sites only.
import type { PaneModel, PaneState, Workspace } from "./store";

/** UX-601 (owner ruling 2026-08-01): the three things that genuinely need a
 *  HUMAN. Everything else — including a pane that has merely gone quiet — is
 *  ambient state, not a notification. */
export type AttentionKind = "permission" | "error" | "question";

/** Approvals first (the agent is literally blocked on a keystroke), then
 *  errors (work has stopped), then genuine questions (work has stopped but
 *  the agent may still be holding context). */
export const KIND_RANK: Record<AttentionKind, number> = { permission: 0, error: 1, question: 2 };

/** Row/section labels for the two attention surfaces. Deliberately phrased as
 *  what the AGENT did, not what state a machine is in — "Waiting" told the
 *  owner nothing about whether he was needed. */
export const KIND_LABEL: Record<AttentionKind, string> = {
  permission: "Needs approval",
  error: "Error",
  question: "Asked you a question",
};

/** Plural section headings, same order as KIND_RANK. */
export const KIND_HEADING: Record<AttentionKind, string> = {
  permission: "Waiting on your approval",
  error: "Errored",
  question: "Asked you something",
};

/** When each pane entered its current state (ms epoch). Written by
 *  Notifications' transition watcher; read by both attention surfaces. */
export const stateSince = new Map<number, number>();

export interface AttentionItem {
  w: Workspace;
  p: PaneModel;
  since: number;
  /** UX-601: which kind of human input this needs, or null when the pane is
   *  merely quiet (ambient — never notifies). */
  kind: AttentionKind | null;
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
 *  with the result. UX-601 promoted it from a ranking tweak to a GATE: it is
 *  what separates a quiet pane (ambient, silent) from one that actually asked
 *  you something (notifies). PaneView badges it too. */
export function isOpenQuestion(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t.endsWith("?")) return false;
  return !STANDARD_PROMPT_RE.some((re) => re.test(t));
}

/** UX-601, THE GATE. Does this pane need a human, and for what?
 *
 *  `waiting` is NOT the agent asking anything — Terminal.tsx derives it from a
 *  quiet timer (~3s of no output), so with 4-6 agents running, panes are quiet
 *  constantly. Treating that as a notification kept the bell permanently lit,
 *  which taught the owner to ignore it. A quiet pane returns null here and
 *  stays ambient: still shown on the pane dot, the band, and the workspace
 *  tile roll-up, but it never rings, badges, toasts, or counts.
 *
 *  Only three things reach a human: an explicit approval prompt, an error, and
 *  a quiet pane whose last line reads as a genuine open question (isOpenQuestion). */
export function attentionKind(p: PaneModel): AttentionKind | null {
  if (p.state === "permission") return "permission";
  if (p.state === "error") return "error";
  if (p.state === "waiting" && isOpenQuestion(lastLine.get(p.id))) return "question";
  return null;
}

function collect(
  workspaces: Workspace[],
  snoozed: Record<number, number>,
  keep: (kind: AttentionKind | null, p: PaneModel) => boolean
): AttentionItem[] {
  const now = Date.now();
  return workspaces.flatMap((w) =>
    w.panes
      // UI-143: a snoozed pane drops out until its timer expires.
      .filter((p) => !(snoozed[p.id] && snoozed[p.id] > now))
      .map((p) => ({ w, p, since: stateSince.get(p.id) ?? now, kind: attentionKind(p) }))
      .filter((it) => keep(it.kind, it.p))
  );
}

/** The bell's one source of truth (UX-601): only panes that need a human,
 *  ranked approvals > errors > questions, and within a rank the pane that has
 *  been blocked longest comes first — a scan order, not a pile. */
export function needsHumanQueue(workspaces: Workspace[], snoozed: Record<number, number> = {}): AttentionItem[] {
  return collect(workspaces, snoozed, (kind) => kind !== null).sort((a, b) => {
    const ra = KIND_RANK[a.kind!];
    const rb = KIND_RANK[b.kind!];
    return ra === rb ? a.since - b.since : ra - rb;
  });
}

/** The other half of the split: panes that have simply gone quiet. Ambient —
 *  worth showing as context ("3 panes quiet"), never worth an alert. */
export function ambientQueue(workspaces: Workspace[], snoozed: Record<number, number> = {}): AttentionItem[] {
  return collect(workspaces, snoozed, (kind, p) => kind === null && p.state === "waiting").sort(
    (a, b) => a.since - b.since
  );
}

/** Everything a pane could be flagged for: needs-human first, then ambient
 *  quiet. Kept for the NAVIGATION call sites (Cockpit's cycle-to-next-blocked
 *  shortcut, LeftPanel's open-workspace-and-focus-its-neediest-pane), which
 *  are deliberate user actions rather than notifications and should still be
 *  able to land on a quiet pane. Notification surfaces must use
 *  needsHumanQueue instead. */
export function attentionQueue(workspaces: Workspace[], snoozed: Record<number, number> = {}): AttentionItem[] {
  return [...needsHumanQueue(workspaces, snoozed), ...ambientQueue(workspaces, snoozed)];
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
