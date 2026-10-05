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
      activity: ctx.lastLine.get(p.id) ?? null,
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
