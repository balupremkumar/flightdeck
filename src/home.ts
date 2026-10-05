// home.ts: Phase 5 Home view, pure model (docs/plans/phase5-home-plan.md).
//
// One screen listing every agent pane in THIS window, grouped by a computed
// column. Nothing here touches React, the store or the backend: classification,
// card building, sort orders, the Approve key and the keyboard guard are plain
// functions so they can be pinned by vitest. HomeOverlay.tsx is the view.
//
// File naming (CLAUDE.md): the component is HomeOverlay.tsx, never Home.tsx.
import type { PaneModel, Workspace } from "./store";
import { attentionKind, CODEX_PROMPT_RE, needsHumanQueue, type AttentionKind } from "./attention";
import type { PrInfo } from "./chipState";

export type HomeColumn = "needs" | "working" | "merged" | "review" | "idle";
export const HOME_COLUMNS: HomeColumn[] = ["needs", "working", "review", "idle", "merged"];

export const COLUMN_LABEL: Record<HomeColumn, string> = {
  needs: "Needs you",
  working: "Working",
  review: "Ready to review",
  idle: "Idle",
  merged: "Merged",
};

/** One muted line per empty column (UX spec section 7). */
export const COLUMN_EMPTY: Record<HomeColumn, string> = {
  needs: "Nothing is waiting on you.",
  working: "No agents working.",
  review: "No finished work to review.",
  idle: "None idle.",
  merged: "Nothing merged yet.",
};

export interface DiffStat { files: number; added: number; deleted: number }

/** `undefined` = not fetched yet (skeleton row); `null` = fetched, none (row omitted). */
export interface HomeCtx {
  now: number;
  snoozed: Record<number, number>;
  lastLine: ReadonlyMap<number, string>;
  stateSince: ReadonlyMap<number, number>;
  lastOutputAt: ReadonlyMap<number, number>;
  diff: Record<string, DiffStat | null | undefined>;
  pr: Record<string, PrInfo | null | undefined>;
  merged: ReadonlySet<number>;
  isAgent: (vendor: string) => boolean;
}

export interface HomeCard {
  paneId: number;
  wsId: number;
  column: HomeColumn;
  vendor: string;
  /** The pane's own title, "" when unnamed (the view falls back to the vendor name). */
  title: string;
  wsName: string;
  branch?: string;
  since: number;
  activity: string | null;
  kind: AttentionKind | null;
  diff?: DiffStat | null;
  pr?: PrInfo | null;
  snoozedUntil?: number;
}

// ---------------------------------------------------------------------------
// Card text: identity and activity line
// ---------------------------------------------------------------------------

/** PaneView auto-titles a pane with its foreground process (node, pwsh, ...).
 *  That is not an identity, so Home ignores a title that is just such a name. */
const PROCESS_NAMES = new Set([
  "node", "nodejs", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python", "python3", "py", "pip", "uv",
  "pwsh", "powershell", "cmd", "bash", "zsh", "sh", "fish", "wsl", "git", "cargo", "rustc", "go", "java",
  "claude", "codex", "agy", "gemini", "kimi", "conhost", "openconsole", "windowsterminal",
]);
export function isProcessTitle(title: string): boolean {
  return PROCESS_NAMES.has(title.trim().toLowerCase().replace(/\.exe$/, ""));
}

/** The card's name: the pane's own title if it set one, else the vendor short
 *  name plus the branch. `branchShown` tells the view the branch is already in
 *  the name so the where-line does not repeat it. */
export function cardName(title: string, vendorShortName: string, branch?: string): { name: string; branchShown: boolean } {
  const t = title.trim();
  if (t && !isProcessTitle(t)) return { name: t, branchShown: false };
  return branch ? { name: `${vendorShortName} · ${branch}`, branchShown: true } : { name: vendorShortName, branchShown: false };
}

const OPTION_LINE_RE = /^\s*[❯>›]?\s*\d+[.)]\s+\S/;
const isOptionLine = (l: string): boolean => OPTION_LINE_RE.test(l);
/** A line with no letter or digit is a prompt or spinner glyph (">", "▸", "☾", box rules). */
const hasText = (l: string): boolean => /[\p{L}\p{N}]/u.test(l);
const stripBox = (l: string): string => l.replace(/^[\s│┃|]+|[\s│┃|]+$/g, "");

/** The activity line to show: null for a bare glyph, and for a permission card
 *  never one of the menu options (the question above them is the useful line). */
export function activityLine(line: string | undefined, kind: AttentionKind | null): string | null {
  if (!line || !hasText(line)) return null;
  if (kind === "permission" && isOptionLine(line)) return null;
  return line;
}

/** The question or tool request above a permission menu in `tail`, or null. */
export function permissionAsk(tail: string[]): string | null {
  const lines = tail.slice(-TAIL_WINDOW * 2);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (isOptionLine(stripBox(lines[i]))) { last = i; break; }
  if (last < 0) return null;
  let first = last;
  while (first > 0 && isOptionLine(stripBox(lines[first - 1]))) first--;
  for (let i = first - 1; i >= 0; i--) {
    const l = stripBox(lines[i]);
    if (l && hasText(l)) return l.length > 160 ? l.slice(0, 159) + "…" : l;
  }
  return null;
}

/** Same cache key as PaneView's diff poll: cwd plus base branch. */
export const diffKey = (p: PaneModel): string => p.cwd + "|" + (p.baseBranch ?? "");

/** Same cwd WorkspaceChips polls `pr_status` with, so the cache is shared. */
export function prCwd(p: PaneModel, ws: Workspace): string {
  return p.worktreePath ?? ws.root;
}

const snoozedUntilOf = (p: PaneModel, ctx: HomeCtx): number | undefined => {
  const until = ctx.snoozed[p.id];
  return until && until > ctx.now ? until : undefined;
};

/** Precedence, first match wins: needs > working > merged > review > idle. */
export function classifyPane(p: PaneModel, ws: Workspace, ctx: HomeCtx): HomeColumn {
  const snoozed = snoozedUntilOf(p, ctx) !== undefined;
  if (attentionKind(p) !== null) {
    // Snooze means "do not nag", not "hide": the pane parks in Idle.
    return snoozed ? "idle" : "needs";
  }
  if (p.state === "running" || p.state === "starting") return "working";
  const pr = ctx.pr[prCwd(p, ws)];
  if (ctx.merged.has(p.id) || pr?.state.toUpperCase() === "MERGED") return "merged";
  const diff = ctx.diff[diffKey(p)];
  if ((diff && diff.files > 0) || (pr && pr.state.toUpperCase() === "OPEN" && pr.checks !== "running")) return "review";
  return "idle";
}

const checksRank = (pr: PrInfo | null | undefined): number =>
  pr?.checks === "failed" ? 0 : pr?.checks === "passed" ? 1 : 2;
const diffSize = (d: DiffStat | null | undefined): number => (d ? d.added + d.deleted : 0);

/** Per-column order. Needs is left to `needsHumanQueue` (see buildHome). */
const SORTERS: Record<Exclude<HomeColumn, "needs">, (a: HomeCard, b: HomeCard, ctx: HomeCtx) => number> = {
  // Most recent output first.
  working: (a, b, ctx) => (ctx.lastOutputAt.get(b.paneId) ?? 0) - (ctx.lastOutputAt.get(a.paneId) ?? 0),
  // Newest first.
  merged: (a, b) => b.since - a.since,
  // Failed CI first, then passed, then by diff size.
  review: (a, b) => checksRank(a.pr) - checksRank(b.pr) || diffSize(b.diff) - diffSize(a.diff),
  // Longest idle first.
  idle: (a, b) => a.since - b.since,
};

export function buildHome(
  workspaces: Workspace[],
  ctx: HomeCtx
): { columns: Record<HomeColumn, HomeCard[]>; needsCount: number } {
  const columns: Record<HomeColumn, HomeCard[]> = { needs: [], working: [], merged: [], review: [], idle: [] };
  const wsOf = new Map<number, Workspace>();
  for (const w of workspaces) for (const p of w.panes) wsOf.set(p.id, w);

  const card = (p: PaneModel, w: Workspace, column: HomeColumn, kind: AttentionKind | null, since?: number): HomeCard => {
    const c: HomeCard = {
      paneId: p.id,
      wsId: w.id,
      column,
      vendor: p.vendor,
      title: p.title ?? "",
      wsName: w.name,
      since: since ?? ctx.stateSince.get(p.id) ?? ctx.lastOutputAt.get(p.id) ?? ctx.now,
      activity: activityLine(ctx.lastLine.get(p.id), kind),
      kind,
    };
    if (p.branch) c.branch = p.branch;
    const diff = ctx.diff[diffKey(p)];
    if (diff !== undefined) c.diff = diff;
    const pr = ctx.pr[prCwd(p, w)];
    if (pr !== undefined) c.pr = pr;
    const snoozedUntil = snoozedUntilOf(p, ctx);
    if (snoozedUntil !== undefined) c.snoozedUntil = snoozedUntil;
    return c;
  };

  // Needs you is the bell's own queue, shell panes included, so the header
  // count can never disagree with the bell badge.
  for (const it of needsHumanQueue(workspaces, ctx.snoozed)) {
    columns.needs.push(card(it.p, it.w, "needs", it.kind, it.since));
  }
  const inNeeds = new Set(columns.needs.map((c) => c.paneId));

  for (const w of workspaces) {
    for (const p of w.panes) {
      if (inNeeds.has(p.id) || !ctx.isAgent(p.vendor)) continue;
      const col = classifyPane(p, wsOf.get(p.id)!, ctx);
      columns[col].push(card(p, w, col, null));
    }
  }
  for (const col of ["working", "merged", "review", "idle"] as const) {
    columns[col].sort((a, b) => SORTERS[col](a, b, ctx) || a.paneId - b.paneId);
  }
  return { columns, needsCount: columns.needs.length };
}

// ---------------------------------------------------------------------------
// Approve: send the key the pane's prompt expects, or nothing at all.
// ---------------------------------------------------------------------------

const TAIL_WINDOW = 12;
const MENU_YES_RE = /❯\s*1\.\s*yes/i;
const MENU_CURSOR_ELSEWHERE_RE = /❯\s*([2-9])\./;
const YN_RE = /\((y\/n|yes\/no)\)|\[(y\/n|yes\/no)\]/i;

/** The affirmative keystroke for the prompt visible in `tail` (plain, ANSI
 *  already stripped), or null when it is not certain. A wrong guess runs a
 *  command, so anything unfamiliar, or a menu whose cursor has moved off
 *  "1. Yes", returns null and Home offers Open only. */
export function approveKeyFor(vendor: string, tail: string[]): string | null {
  const lines = tail.filter((l) => l.trim() !== "").slice(-TAIL_WINDOW);
  if (lines.length === 0) return null;
  if (lines.some((l) => MENU_CURSOR_ELSEWHERE_RE.test(l))) return null;
  if (vendor === "codex" && lines.some((l) => CODEX_PROMPT_RE.some((re) => re.test(l)))) return "y";
  if (lines.some((l) => MENU_YES_RE.test(l))) return "\r";
  if (lines.slice(-3).some((l) => YN_RE.test(l))) return "y\r";
  return null;
}

// ---------------------------------------------------------------------------
// Keyboard guard
// ---------------------------------------------------------------------------

/** While Home is open Cockpit's global handler acts on only these: Ctrl+Shift+H,
 *  Ctrl+Shift+A, Ctrl+, and the app zoom keys. Everything else (backtick, bare
 *  1-9, Alt+1-9, Ctrl+Alt arrows, Ctrl+Tab, Ctrl+W, Ctrl+B) returns early so no
 *  pane behind Home is focused. Escape is handled before this guard. */
export function homeKeyAllowed(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">
): boolean {
  if (!e.ctrlKey || e.metaKey) return false;
  const k = e.key;
  if (e.shiftKey && !e.altKey && (k === "h" || k === "H" || k === "a" || k === "A")) return true;
  if (e.altKey) return false;
  return k === "," || k === "=" || k === "+" || k === "-" || k === "_" || k === "0";
}

// ---------------------------------------------------------------------------
// Send state (reply and Approve), per pane
// ---------------------------------------------------------------------------

/** `key` on "sent" is the card's state key at send time (column, kind, since):
 *  the "Sent" note holds until that changes, i.e. until the pane's next state
 *  change, which also moves the card by itself. */
export type SendState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; key: string }
  | { phase: "failed"; error: string };

export type SendAction =
  | { type: "start" }
  | { type: "ok"; key: string }
  | { type: "fail"; error: string }
  | { type: "reset" };

export const SEND_IDLE: SendState = { phase: "idle" };

export function sendReducer(s: SendState, a: SendAction): SendState {
  switch (a.type) {
    case "start": return s.phase === "sending" ? s : { phase: "sending" }; // never a double send
    case "ok": return s.phase === "sending" ? { phase: "sent", key: a.key } : s;
    case "fail": return s.phase === "sending" ? { phase: "failed", error: a.error } : s;
    case "reset": return SEND_IDLE;
  }
}

/** What a card shows now: a "sent" whose state key has moved on is idle again. */
export function effectiveSend(s: SendState | undefined, key: string): SendState {
  if (!s) return SEND_IDLE;
  return s.phase === "sent" && s.key !== key ? SEND_IDLE : s;
}

export const sendsReducer = (m: Record<number, SendState>, a: SendAction & { paneId: number }): Record<number, SendState> => {
  const { paneId, ...act } = a;
  const next = sendReducer(m[paneId] ?? SEND_IDLE, act as SendAction);
  return next === (m[paneId] ?? SEND_IDLE) ? m : { ...m, [paneId]: next };
};

export const cardStateKey = (c: Pick<HomeCard, "column" | "kind" | "since">): string => `${c.column}|${c.kind}|${c.since}`;

// ---------------------------------------------------------------------------
// Session-only state
// ---------------------------------------------------------------------------

/** Unsent reply text per pane; Escape closes Home and keeps it. */
export const replyDrafts = new Map<number, string>();

/** Panes whose worktree was fully merged this session (Review marks it). */
export const mergedPanes = new Set<number>();
export function markPaneMerged(paneId: number): void {
  mergedPanes.add(paneId);
}

// ---------------------------------------------------------------------------
// Multi-window seam
// ---------------------------------------------------------------------------

export interface OtherWindowSummary { label: string; title: string; needsYou: number; working: number }

/** v1: no other-window data yet, so the footer strip renders nothing. Phase 4
 *  S11 wires this to `win://summary`. */
export function otherWindowSummaries(): OtherWindowSummary[] {
  return [];
}
