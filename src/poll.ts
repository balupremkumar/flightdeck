// poll.ts — shared polling + request dedupe (UI-234/227/228, QOL 380).
//
// Before this, a 6-pane workspace on one repo fired 6 git_status + 6
// git_diff_summary + 6 pane_usage invokes per cycle, forever, including while
// the window was minimised or the pane was hidden behind another workspace.
// Now: one in-flight request per (command, cwd) shared by every caller, a
// short TTL cache, and polls that stand down when nothing can see them.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

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
