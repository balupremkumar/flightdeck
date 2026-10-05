// homePoll.ts: the shared diff and PR poll store behind Home (phase 5 plan,
// "Shared poll store"). Runs only while Home is open, through the same
// cachedInvoke keys and TTLs as PaneView (git_diff_summary) and WorkspaceChips
// (pr_status), so a visible pane's own poll and Home share cache entries.
//
// Bounded fan-out: targets are de-duplicated by cache key, ordered by how much
// the user cares (Needs you, Ready, Working, rest), run at most 3 at a time, and
// a cycle is dropped if the previous one is still going. A cwd that rejects is
// remembered as "none" for the life of the open session so a non-repo is not
// re-spawned every 15 s. Never raises toasts or CI transitions: the bell stays
// the only alert source.
import { create } from "zustand";
import { useEffect } from "react";
import { cachedInvoke, usePoll } from "./poll";
import type { PrInfo } from "./chipState";
import type { DiffSummary } from "./worktrees";
import type { Workspace } from "./store";
import { diffKey, prCwd, type DiffStat, type HomeColumn } from "./home";

export const HOME_DIFF_POLL_MS = 15_000;
export const HOME_PR_POLL_MS = 60_000;
/** The exact TTLs PaneView.tsx (GIT_POLL_MS / 2) and WorkspaceChips.tsx pass,
 *  so the cache entries are shared rather than duplicated. */
export const HOME_DIFF_TTL_MS = 7_500;
export const HOME_PR_TTL_MS = 55_000;
export const HOME_POLL_CONCURRENCY = 3;

export interface HomePollTarget {
  /** Cache key the result is published under: home.diffKey(pane). */
  diffKey: string;
  cwd: string;
  baseBranch: string | null;
  /** Cache key for the PR result: home.prCwd(pane, workspace). */
  prCwd: string;
  /** Lower runs first: 0 Needs you, 1 Ready, 2 Working, 3 everything else. */
  priority: number;
}

const PRIORITY: Record<HomeColumn, number> = { needs: 0, review: 1, working: 2, idle: 3, merged: 3 };

/** One target per pane Home shows. `columnOf` is the pane's current column. */
export function buildTargets(workspaces: Workspace[], columnOf: ReadonlyMap<number, HomeColumn>): HomePollTarget[] {
  const out: HomePollTarget[] = [];
  for (const w of workspaces) {
    for (const p of w.panes) {
      const col = columnOf.get(p.id);
      if (!col) continue;
      out.push({ diffKey: diffKey(p), cwd: p.cwd, baseBranch: p.baseBranch ?? null, prCwd: prCwd(p, w), priority: PRIORITY[col] });
    }
  }
  return out;
}

/** First occurrence of each key wins, after ordering by priority (stable). */
export function dedupe<T extends { priority: number }>(items: T[], keyOf: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of [...items].sort((a, b) => a.priority - b.priority)) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/** Run `worker` over `items` with at most `limit` in flight. Never rejects. */
export async function runLimited<T>(items: T[], limit: number, worker: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const it = items[next++];
      try { await worker(it); } catch { /* a worker handles its own failure */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

interface HomePollState {
  /** `undefined` = not fetched yet, `null` = fetched, none (or failed). */
  diff: Record<string, DiffStat | null | undefined>;
  pr: Record<string, PrInfo | null | undefined>;
}
export const useHomePollStore = create<HomePollState>(() => ({ diff: {}, pr: {} }));

const sameStat = (a: DiffStat | null | undefined, b: DiffStat | null) =>
  a !== undefined && (a === b || (!!a && !!b && a.files === b.files && a.added === b.added && a.deleted === b.deleted));
const samePr = (a: PrInfo | null | undefined, b: PrInfo | null) =>
  a !== undefined && (a === b || (!!a && !!b && a.number === b.number && a.url === b.url && a.state === b.state && a.checks === b.checks));

// Bumped by resetHomePoll so a cycle that outlives the close never publishes.
let epoch = 0;
let diffRunning = false;
let prRunning = false;
// Keys that rejected this open session: memoised as "none", not retried.
const failedDiff = new Set<string>();
const failedPr = new Set<string>();

/** Home closed: forget everything, so the next open starts from skeletons. */
export function resetHomePoll() {
  epoch++;
  diffRunning = false;
  prRunning = false;
  failedDiff.clear();
  failedPr.clear();
  useHomePollStore.setState({ diff: {}, pr: {} });
}

export async function runDiffCycle(targets: HomePollTarget[]): Promise<void> {
  if (diffRunning) return; // the previous cycle is still going: drop this one
  diffRunning = true;
  const mine = epoch;
  try {
    await runLimited(dedupe(targets, (t) => t.diffKey), HOME_POLL_CONCURRENCY, async (t) => {
      let next: DiffStat | null;
      if (failedDiff.has(t.diffKey)) next = null;
      else {
        try {
          // Same args and TTL as PaneView's diff-stat poll.
          const s = await cachedInvoke<DiffSummary>("git_diff_summary", { cwd: t.cwd, base: t.baseBranch }, HOME_DIFF_TTL_MS);
          next = { files: s.files.length, added: s.totalAdded, deleted: s.totalDeleted };
        } catch {
          failedDiff.add(t.diffKey);
          next = null;
        }
      }
      if (mine !== epoch) return;
      const cur = useHomePollStore.getState().diff;
      if (sameStat(cur[t.diffKey], next)) return;
      useHomePollStore.setState({ diff: { ...cur, [t.diffKey]: next } });
    });
  } finally {
    if (mine === epoch) diffRunning = false;
  }
}

export async function runPrCycle(targets: HomePollTarget[]): Promise<void> {
  if (prRunning) return;
  prRunning = true;
  const mine = epoch;
  try {
    await runLimited(dedupe(targets, (t) => t.prCwd), HOME_POLL_CONCURRENCY, async (t) => {
      let next: PrInfo | null;
      if (failedPr.has(t.prCwd)) next = null;
      else {
        try {
          // Same args and TTL as WorkspaceChips' PR chip. `pr_status` returns
          // null both for "no PR" and for "gh missing"; Home shows no chip either way.
          next = (await cachedInvoke<PrInfo | null>("pr_status", { cwd: t.prCwd }, HOME_PR_TTL_MS)) ?? null;
        } catch {
          failedPr.add(t.prCwd);
          next = null;
        }
      }
      if (mine !== epoch) return;
      const cur = useHomePollStore.getState().pr;
      if (samePr(cur[t.prCwd], next)) return;
      useHomePollStore.setState({ pr: { ...cur, [t.prCwd]: next } });
    });
  } finally {
    if (mine === epoch) prRunning = false;
  }
}

/** Drive both loops while `open`. `usePoll` stands them down while the window is
 *  hidden and runs once immediately on open. `targets` may change every render:
 *  the loops read the latest through usePoll's own fn ref. */
export function useHomePoll(open: boolean, targets: HomePollTarget[]) {
  usePoll(() => runDiffCycle(targets), HOME_DIFF_POLL_MS, [], open);
  usePoll(() => runPrCycle(targets), HOME_PR_POLL_MS, [], open);
  useEffect(() => {
    if (!open) return;
    return () => resetHomePoll();
  }, [open]);
}
