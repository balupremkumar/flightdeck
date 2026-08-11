// poll.ts — shared polling + request dedupe (UI-234/227/228, QOL 380).
//
// Before this, a 6-pane workspace on one repo fired 6 git_status + 6
// git_diff_summary + 6 pane_usage invokes per cycle, forever, including while
// the window was minimised or the pane was hidden behind another workspace.
// Now: one in-flight request per (command, cwd) shared by every caller, a
// short TTL cache, and polls that stand down when nothing can see them.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

interface Entry<T> {
  at: number;
  value: T;
  inflight?: Promise<T>;
}

const cache = new Map<string, Entry<unknown>>();

/** Invoke `cmd` with `args`, sharing the result across callers for `ttlMs`.
 *  Concurrent callers join the same in-flight promise rather than each
 *  spawning their own git subprocess. */
export async function cachedInvoke<T>(cmd: string, args: Record<string, unknown>, ttlMs = 5000): Promise<T> {
  const key = cmd + "|" + JSON.stringify(args);
  const now = Date.now();
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit) {
    if (hit.inflight) return hit.inflight;
    if (now - hit.at < ttlMs) return hit.value;
  }
  const p = invoke<T>(cmd, args)
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((e) => {
      cache.delete(key); // never cache a failure — next caller retries
      throw e;
    });
  cache.set(key, { at: hit?.at ?? 0, value: hit?.value as T, inflight: p });
  return p;
}

/** Drop cached entries for a cwd — call after an action that changes git state
 *  (merge, PR handoff, restart) so the next poll reads fresh. */
export function invalidateCwd(cwd: string) {
  for (const key of [...cache.keys()]) if (key.includes(cwd)) cache.delete(key);
}

/** True while the window is visible AND not minimised. */
function windowActive(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Poll `fn` every `intervalMs`, but only while the window is active and
 * `enabled` is true. Runs once immediately on (re)activation so a returning
 * user sees fresh data without waiting a full interval.
 */
export function usePoll(
  fn: () => void | Promise<void>,
  intervalMs: number,
  deps: unknown[],
  enabled = true
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;

    const tick = () => { if (!stopped && windowActive()) void fnRef.current(); };
    const start = () => {
      if (timer !== undefined) return;
      tick(); // immediate refresh on start/resume
      timer = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = () => (windowActive() ? start() : stop());
    if (windowActive()) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, ...deps]);
}

// ---------------------------------------------------------------------------
// QL-742: pane memory health, always on.
//
// `pane_health` was polled only while Settings > Diagnostics was open, so a
// child process that ballooned to 3GB was invisible from the cockpit — the one
// place the user is actually looking. It now runs on a SLOW app-wide cycle:
// one invoke every 30s no matter how many panes exist (the command already
// returns every pane in a single call), and none at all when there are no
// panes. The fast 15s cycle above is untouched; see perfbudget.test.ts for the
// budget this pins.
//
// Only panes OVER the ceiling are published. Everything downstream (the pane
// header chip, the ambient attention entry) is therefore a pure function of
// "is this pane in the heavy list", and a pane that drops back under, closes,
// or restarts simply stops appearing.
// ---------------------------------------------------------------------------

/** Memory creeps over minutes, so 30s is soon enough to catch a runaway and
 *  rare enough to disappear next to the 15s git cycle. */
export const MEMORY_POLL_MS = 30_000;
/** Slightly under the poll interval: two consecutive slow ticks each reach the
 *  backend, but a Diagnostics table refreshing alongside can share the result. */
export const MEMORY_HEALTH_TTL_MS = 25_000;

/** The subset of `pane_health` (src-tauri/src/health.rs) this cycle cares
 *  about. CPU, pid history and process name stay a Diagnostics concern. */
export interface PaneMemory {
  paneId: number;
  memoryMb: number;
  /** The ceiling the BACKEND compared against (echoed back, already clamped),
   *  so the UI labels the number it was actually judged by. */
  memoryWarnMb: number;
}
interface HealthRow extends PaneMemory { overMemoryWarn?: boolean }

const NO_HEAVY: PaneMemory[] = [];
let heavyList: PaneMemory[] = NO_HEAVY;
let heavyById = new Map<number, PaneMemory>();
let heavySig = "";
const heavyListeners = new Set<() => void>();

function subscribeHeavy(fn: () => void): () => void {
  heavyListeners.add(fn);
  return () => heavyListeners.delete(fn);
}

/** Republish only when the rendered facts change — an unchanged reading must
 *  not re-render every pane header every 30s. */
function publishHeavy(next: PaneMemory[]) {
  const sig = next.map((h) => `${h.paneId}:${h.memoryMb.toFixed(0)}:${h.memoryWarnMb}`).join("|");
  if (sig === heavySig) return;
  heavySig = sig;
  heavyList = next.length ? next : NO_HEAVY;
  heavyById = new Map(next.map((h) => [h.paneId, h]));
  for (const fn of [...heavyListeners]) fn();
}

/** Sample every pane against `memoryWarnMb` and publish the ones over it.
 *  Shared through `cachedInvoke`, so the slow cycle and an open Diagnostics
 *  table don't double-sample. Any failure (no backend, browser preview)
 *  publishes an empty list rather than leaving a stale warning on screen. */
export async function refreshMemoryHealth(memoryWarnMb: number): Promise<void> {
  try {
    const rows = await cachedInvoke<HealthRow[]>("pane_health", { memoryWarnMb }, MEMORY_HEALTH_TTL_MS);
    publishHeavy(
      (Array.isArray(rows) ? rows : [])
        .filter((r) => r.overMemoryWarn)
        .map((r) => ({ paneId: r.paneId, memoryMb: r.memoryMb, memoryWarnMb: r.memoryWarnMb }))
    );
  } catch {
    publishHeavy([]);
  }
}

/** Drop one pane's warning immediately — used when a pane restarts, so the
 *  chip clears with the process rather than lingering until the next tick. */
export function clearPaneMemory(paneId: number) {
  if (!heavyById.has(paneId)) return;
  publishHeavy(heavyList.filter((h) => h.paneId !== paneId));
}

/** The slow cycle's single driver. Mount ONCE (Notifications.tsx — the only
 *  always-mounted surface); `paneCount` of 0 stands the whole thing down, and
 *  `usePoll` already stands it down while the window is hidden. */
export function useMemoryHealthPoll(paneCount: number, memoryWarnMb: number) {
  usePoll(() => refreshMemoryHealth(memoryWarnMb), MEMORY_POLL_MS, [memoryWarnMb], paneCount > 0);
  useEffect(() => { if (paneCount === 0) publishHeavy([]); }, [paneCount]);
}

/** Every pane currently over the ceiling, or an empty list. */
export function useHeavyPanes(): PaneMemory[] {
  return useSyncExternalStore(subscribeHeavy, () => heavyList, () => NO_HEAVY);
}

/** This pane's reading while it is over the ceiling, else undefined. Pass the
 *  pane's `epoch` so a restart clears the warning on the spot — the new
 *  process starts from nothing and hasn't earned the old one's chip. */
export function usePaneMemory(paneId: number, epoch?: number): PaneMemory | undefined {
  const seenEpoch = useRef(epoch);
  useEffect(() => {
    if (seenEpoch.current === epoch) return;
    seenEpoch.current = epoch;
    clearPaneMemory(paneId);
  }, [paneId, epoch]);
  return useSyncExternalStore(subscribeHeavy, () => heavyById.get(paneId), () => undefined);
}

/** Tracks whether an element is on-screen — panes hidden behind another
 *  workspace or a maximised sibling shouldn't poll at all (UI-227). */
export function useVisible<T extends HTMLElement>(ref: React.RefObject<T | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setVisible(entries[entries.length - 1]?.isIntersecting ?? true),
      { threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}
