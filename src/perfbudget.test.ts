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

const { cachedInvoke, invalidateCwd } = await import("./poll");

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
const COLD_START_BUDGET_BYTES = 1_450_000;
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
