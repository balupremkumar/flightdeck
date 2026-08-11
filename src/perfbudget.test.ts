// perfbudget.test.ts — UX-595: cold-start and steady-state cost, as numbers
// that fail a build rather than claims in STATE.md.
//
// Two budgets, because two different things get slow:
//   1. COLD START — how many bytes the webview must fetch, parse and execute
//      before the cockpit can paint. Measured off the real build output
//      (dist/index.html plus everything it pulls in eagerly), because the app
//      itself must never be launched from here (Balu works out of the
//      installed build).
//   2. STEADY STATE — how many IPC round trips an idle cockpit costs per poll
//      cycle. The claim in STATE.md is that a 6-pane workspace on one repo
//      costs 3 invokes per cycle, not 18. That is a property of poll.ts's
//      dedupe + TTL, so it can be asserted directly.
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const { cachedInvoke, invalidateCwd, refreshMemoryHealth, MEMORY_POLL_MS } = await import("./poll");

// ---------------------------------------------------------------------------
// Steady state
// ---------------------------------------------------------------------------

/** What one pane asks the backend for on a poll cycle (PaneView.tsx): branch
 *  pill, diff-stat badge, token chip. TTLs are the ones that file passes. */
const PANE_POLLS: [string, number][] = [
  ["git_status", 15_000],
  ["git_diff_summary", 15_000],
  ["pane_usage", 7_000],
];
const PANE_COUNT = 6;
/** The budget: one round trip per distinct question, however many panes ask. */
const IDLE_INVOKES_PER_CYCLE = PANE_POLLS.length;

/** QL-742 raised the budget deliberately, and this is the whole of the raise.
 *
 *  Pane memory health used to be sampled only while Settings > Diagnostics was
 *  open, which meant a runaway child process was invisible from the cockpit.
 *  It is now always on — but on a SECOND, SLOWER cycle, not the 15s one above:
 *
 *    fast cycle (15s, per repo):   3 invokes   ← unchanged by QL-742
 *    slow cycle (30s, app-wide):   1 invoke    ← new
 *
 *  The slow cycle is flat, not per pane and not per repo: `pane_health` returns
 *  every pane in one call and is driven once for the whole app (poll.ts's
 *  useMemoryHealthPoll, mounted in Notifications.tsx), so a 6-pane workspace
 *  and a 60-pane one cost the same. It is skipped entirely when there are no
 *  panes, and stands down with everything else while the window is hidden.
 *  Net steady-state cost of always-on memory health: 2 invokes per minute. */
const SLOW_INVOKES_PER_CYCLE = 1;
const MEMORY_CEILING_MB = 1024;

function pollCycle(cwd: string) {
  // Every pane in the workspace asks at once — the storm this is guarding.
  return Promise.all(
    Array.from({ length: PANE_COUNT }, () =>
      Promise.all(PANE_POLLS.map(([cmd, ttl]) => cachedInvoke(cmd, { cwd }, ttl))),
    ),
  );
}

describe("steady-state IPC budget (UX-595)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    invalidateCwd("");
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it(`a ${PANE_COUNT}-pane workspace on one repo costs ${IDLE_INVOKES_PER_CYCLE} invokes per cycle, not ${PANE_COUNT * PANE_POLLS.length}`, async () => {
    await pollCycle("D:/repo");
    expect(invokeMock).toHaveBeenCalledTimes(IDLE_INVOKES_PER_CYCLE);
    expect(invokeMock).not.toHaveBeenCalledTimes(PANE_COUNT * PANE_POLLS.length);
  });

  it("panes whose timers have drifted apart still share one round trip inside the TTL", async () => {
    // Panes don't tick in lockstep — each poll interval starts when that pane
    // mounted. Inside the TTL the later pane must hit the cache, not the wire.
    await cachedInvoke("git_status", { cwd: "D:/repo" }, 15_000);
    vi.setSystemTime(Date.now() + 14_000);
    await Promise.all(
      Array.from({ length: PANE_COUNT - 1 }, () => cachedInvoke("git_status", { cwd: "D:/repo" }, 15_000)),
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("the rate stays flat over time: a second cycle after the TTL costs the same, not more", async () => {
    await pollCycle("D:/repo");
    vi.setSystemTime(Date.now() + 30_000); // past every TTL above
    await pollCycle("D:/repo");
    expect(invokeMock).toHaveBeenCalledTimes(IDLE_INVOKES_PER_CYCLE * 2);
  });

  it(`the slow memory cycle adds ${SLOW_INVOKES_PER_CYCLE} invoke, flat — ${PANE_COUNT} panes don't make it ${PANE_COUNT} (QL-742)`, async () => {
    // Whoever is interested, one sample serves them all: the command answers
    // for every pane at once and the driver is app-wide.
    await Promise.all(Array.from({ length: PANE_COUNT }, () => refreshMemoryHealth(MEMORY_CEILING_MB)));
    expect(invokeMock).toHaveBeenCalledTimes(SLOW_INVOKES_PER_CYCLE);
    expect(invokeMock).toHaveBeenCalledWith("pane_health", { memoryWarnMb: MEMORY_CEILING_MB });
  });

  it("the fast cycle is untouched by it: a full cycle plus a memory sample is 3 + 1 (QL-742)", async () => {
    await pollCycle("D:/repo");
    expect(invokeMock).toHaveBeenCalledTimes(IDLE_INVOKES_PER_CYCLE);
    await refreshMemoryHealth(MEMORY_CEILING_MB);
    expect(invokeMock).toHaveBeenCalledTimes(IDLE_INVOKES_PER_CYCLE + SLOW_INVOKES_PER_CYCLE);
  });

  it("the memory sample is genuinely slow: a second one inside the interval is free, past it costs 1 (QL-742)", async () => {
    await refreshMemoryHealth(MEMORY_CEILING_MB);
    vi.setSystemTime(Date.now() + MEMORY_POLL_MS / 2);
    await refreshMemoryHealth(MEMORY_CEILING_MB);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + MEMORY_POLL_MS);
    await refreshMemoryHealth(MEMORY_CEILING_MB);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("isolated panes are the honest worst case: separate worktrees can't share a cache key", async () => {
    // Not a regression — it's what worktree isolation means. Asserted so the
    // budget above is never mistaken for a promise about every layout.
    await Promise.all(
      Array.from({ length: PANE_COUNT }, (_, i) =>
        Promise.all(PANE_POLLS.map(([cmd, ttl]) => cachedInvoke(cmd, { cwd: `D:/wt/${i}` }, ttl))),
      ),
    );
    expect(invokeMock).toHaveBeenCalledTimes(PANE_COUNT * PANE_POLLS.length);
  });
});

// ---------------------------------------------------------------------------
// Cold start
// ---------------------------------------------------------------------------

/** Everything the built index.html fetches before first paint (entry chunk,
 *  its modulepreloads, and the stylesheet), in bytes. Fonts are excluded: they
 *  load from CSS and don't block the cockpit rendering. */
/* Raised 1_450_000 -> 1_520_000 on 2026-08-11: the QL wave-5/6 feature set
 * (subagent tree, plan panel, config doctor, session search, hooks UI, hints,
 * sticky scroll) legitimately grew the eager payload by ~21KB after the
 * serialize addon was already made lazy (-15.5KB). The app-chunk budget below
 * stays at 430KB as the tighter guard on our own code. */
const COLD_START_BUDGET_BYTES = 1_520_000;
/** The app's own chunk. React and xterm are separate, rarely-changing vendor
 *  chunks; this is the number our own code moves. */
const APP_CHUNK_BUDGET_BYTES = 430_000;

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const builtIndex = distDir + "index.html";
const built = existsSync(builtIndex);

describe.skipIf(!built)("cold-start payload budget (UX-595)", () => {
  const html = built ? readFileSync(builtIndex, "utf8") : "";
  const refs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => p.endsWith(".js") || p.endsWith(".css"));
  const sizeOf = (rel: string) => statSync(distDir + rel).size;

  it("index.html is what we think it is (entry + vendor preloads + one stylesheet)", () => {
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => r.endsWith(".css"))).toHaveLength(1);
  });

  it(`boot payload stays under ${(COLD_START_BUDGET_BYTES / 1024).toFixed(0)}KB`, () => {
    const total = refs.reduce((n, r) => n + sizeOf(r), 0);
    // Reported on failure so the number to argue about is visible, not hidden
    // behind a boolean.
    expect(total, `boot payload is ${(total / 1024).toFixed(0)}KB across ${refs.length} files: ${refs.join(", ")}`)
      .toBeLessThanOrEqual(COLD_START_BUDGET_BYTES);
  });

  it(`the app chunk alone stays under ${(APP_CHUNK_BUDGET_BYTES / 1024).toFixed(0)}KB`, () => {
    const app = refs.find((r) => /\/index-[^/]+\.js$/.test(r));
    expect(app, "no app entry chunk in dist/index.html").toBeTruthy();
    const size = sizeOf(app!);
    expect(size, `app chunk is ${(size / 1024).toFixed(0)}KB`).toBeLessThanOrEqual(APP_CHUNK_BUDGET_BYTES);
  });
});
