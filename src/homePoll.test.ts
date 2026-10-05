import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// useHomePoll is a thin wrapper: capture what it hands to usePoll / useEffect
// instead of rendering (the suite runs in node, no DOM).
const usePollMock = vi.fn();
const effects: Array<() => void | (() => void)> = [];
vi.mock("./poll", async (orig) => ({ ...(await orig<typeof import("./poll")>()), usePoll: (...a: unknown[]) => usePollMock(...a) }));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (fn: () => void | (() => void)) => { effects.push(fn); } }));

const {
  buildTargets, dedupe, runLimited, runDiffCycle, runPrCycle, resetHomePoll, useHomePoll, useHomePollStore,
  HOME_DIFF_POLL_MS, HOME_PR_POLL_MS, HOME_DIFF_TTL_MS, HOME_PR_TTL_MS, HOME_POLL_CONCURRENCY,
} = await import("./homePoll");
const { cachedInvoke, invalidateCwd } = await import("./poll");
const { useUI } = await import("./ui");

import type { HomePollTarget } from "./homePoll";
import type { HomeColumn } from "./home";
import type { Workspace } from "./store";

const target = (n: number, over: Partial<HomePollTarget> = {}): HomePollTarget =>
  ({ diffKey: `/wt/${n}|`, cwd: `/wt/${n}`, baseBranch: null, prCwd: `/wt/${n}`, priority: 3, ...over });

const summary = (files: number, added = 4, deleted = 1) => ({ base: "main", files: Array.from({ length: files }, (_, i) => ({ path: `f${i}` })), totalAdded: added, totalDeleted: deleted });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  usePollMock.mockReset();
  effects.length = 0;
  invalidateCwd("");
  resetHomePoll();
});

describe("buildTargets", () => {
  const ws: Workspace[] = [{
    id: 1, name: "w", root: "/r", focused: null,
    panes: [
      { id: 1, vendor: "claude", cwd: "/r", state: "idle", epoch: 0 },
      { id: 2, vendor: "claude", cwd: "/wt/a", state: "idle", epoch: 0, worktreePath: "/wt/a", baseBranch: "main" },
      { id: 3, vendor: "pwsh", cwd: "/r", state: "idle", epoch: 0 },
    ],
  }];

  it("maps each shown pane to its cache keys and priority, and skips panes Home does not show", () => {
    const col = new Map<number, HomeColumn>([[1, "idle"], [2, "needs"]]);
    const t = buildTargets(ws, col);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ cwd: "/r", baseBranch: null, prCwd: "/r", priority: 3 });
    expect(t[1]).toMatchObject({ cwd: "/wt/a", baseBranch: "main", prCwd: "/wt/a", priority: 0 });
  });

  it("orders Needs you, Ready, Working, then the rest", () => {
    const order = (["idle", "working", "review", "needs", "merged"] as HomeColumn[]).map((c) => {
      const w: Workspace[] = [{ id: 1, name: "w", root: "/r", focused: null, panes: [{ id: 1, vendor: "claude", cwd: "/r", state: "idle", epoch: 0 }] }];
      return buildTargets(w, new Map([[1, c]]))[0].priority;
    });
    expect(order).toEqual([3, 2, 1, 0, 3]);
  });
});

describe("dedupe", () => {
  it("one target per key, the most urgent one wins", () => {
    const out = dedupe([target(1, { prCwd: "/r", priority: 3 }), target(2, { prCwd: "/r", priority: 0 }), target(3, { priority: 2 })], (t) => t.prCwd);
    expect(out.map((t) => t.cwd)).toEqual(["/wt/2", "/wt/3"]);
  });
});

describe("runLimited", () => {
  it(`never has more than ${HOME_POLL_CONCURRENCY} in flight, and does use all of them`, async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const run = runLimited(Array.from({ length: 10 }, (_, i) => i), HOME_POLL_CONCURRENCY, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight--;
    });
    for (let i = 0; i < 40 && gates.length < 10; i++) {
      await Promise.resolve();
      gates.splice(0).forEach((g) => g());
    }
    await run;
    expect(peak).toBe(HOME_POLL_CONCURRENCY);
  });

  it("a throwing worker does not stop the rest", async () => {
    const seen: number[] = [];
    await runLimited([1, 2, 3], 1, async (n) => { seen.push(n); if (n === 1) throw new Error("x"); });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("shared cache keys", () => {
  it("diff cycle uses PaneView's exact command, args and TTL, so a visible pane's own poll is a cache hit", async () => {
    invokeMock.mockResolvedValue(summary(2));
    await cachedInvoke("git_diff_summary", { cwd: "/wt/1", base: null }, HOME_DIFF_TTL_MS); // PaneView's call
    await runDiffCycle([target(1)]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("git_diff_summary", { cwd: "/wt/1", base: null });
    expect(useHomePollStore.getState().diff["/wt/1|"]).toEqual({ files: 2, added: 4, deleted: 1 });
  });

  it("an isolated pane diffs against its base branch, same args as PaneView", async () => {
    invokeMock.mockResolvedValue(summary(1));
    await runDiffCycle([target(1, { baseBranch: "main" })]);
    expect(invokeMock).toHaveBeenCalledWith("git_diff_summary", { cwd: "/wt/1", base: "main" });
  });

  it("PR cycle uses WorkspaceChips' exact command and args, so the chip's poll is a cache hit", async () => {
    const pr = { number: 7, url: "https://x/7", state: "OPEN", checks: "passed" };
    invokeMock.mockResolvedValue(pr);
    await cachedInvoke("pr_status", { cwd: "/wt/1" }, HOME_PR_TTL_MS); // WorkspaceChips' call
    await runPrCycle([target(1)]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("pr_status", { cwd: "/wt/1" });
    expect(useHomePollStore.getState().pr["/wt/1"]).toEqual(pr);
  });

  it("panes sharing a repo cost one invoke each, not one per pane", async () => {
    invokeMock.mockResolvedValue(summary(0));
    const same = Array.from({ length: 6 }, (_, i) => target(i, { diffKey: "/r|", cwd: "/r", prCwd: "/r" }));
    await runDiffCycle(same);
    await runPrCycle(same);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("failure memo and overlap", () => {
  it("a rejecting cwd is memoised as none for the open session, not re-spawned each cycle", async () => {
    invokeMock.mockRejectedValue(new Error("not a repo"));
    await runDiffCycle([target(1)]);
    expect(useHomePollStore.getState().diff["/wt/1|"]).toBeNull();
    await runDiffCycle([target(1)]);
    await runDiffCycle([target(1)]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("the memo ends with the open session: after a reset the cwd is tried again", async () => {
    invokeMock.mockRejectedValue(new Error("not a repo"));
    await runDiffCycle([target(1)]);
    resetHomePoll();
    expect(useHomePollStore.getState().diff).toEqual({});
    await runDiffCycle([target(1)]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("a cycle that starts while the previous one is still running is dropped", async () => {
    let release: (v: unknown) => void = () => {};
    invokeMock.mockImplementation(() => new Promise((r) => { release = r; }));
    const first = runDiffCycle([target(1)]);
    await Promise.resolve();
    await runDiffCycle([target(2)]); // dropped
    expect(invokeMock).toHaveBeenCalledTimes(1);
    release(summary(1));
    await first;
  });

  it("a cycle that outlives the close never publishes into the next session", async () => {
    let release: (v: unknown) => void = () => {};
    invokeMock.mockImplementation(() => new Promise((r) => { release = r; }));
    const run = runDiffCycle([target(1)]);
    await Promise.resolve();
    resetHomePoll();
    release(summary(3));
    await run;
    expect(useHomePollStore.getState().diff).toEqual({});
  });

  it("an unchanged reading does not republish (no re-render every 15s)", async () => {
    invokeMock.mockResolvedValue(summary(2));
    await runDiffCycle([target(1)]);
    const before = useHomePollStore.getState().diff;
    invalidateCwd("");
    await runDiffCycle([target(1)]);
    expect(useHomePollStore.getState().diff).toBe(before);
  });

  it("a null PR (no PR, or gh missing) is stored as none and never throws or toasts", async () => {
    const toast = vi.spyOn(useUI.getState(), "pushToast");
    invokeMock.mockResolvedValue(null);
    await runPrCycle([target(1)]);
    expect(useHomePollStore.getState().pr["/wt/1"]).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    invokeMock.mockRejectedValue(new Error("gh not found"));
    await runPrCycle([target(2)]);
    expect(useHomePollStore.getState().pr["/wt/2"]).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    toast.mockRestore();
  });
});

describe("useHomePoll", () => {
  it("hands usePoll enabled=false while Home is closed, so nothing is invoked", () => {
    useHomePoll(false, [target(1)]);
    expect(usePollMock).toHaveBeenCalledTimes(2);
    for (const call of usePollMock.mock.calls) expect(call[3]).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("runs the diff loop at 15s and the PR loop at 60s while open, each calling its own cycle", async () => {
    invokeMock.mockResolvedValue(null);
    useHomePoll(true, [target(1)]);
    const [diffCall, prCall] = usePollMock.mock.calls;
    expect(diffCall[1]).toBe(HOME_DIFF_POLL_MS);
    expect(prCall[1]).toBe(HOME_PR_POLL_MS);
    expect(diffCall[3]).toBe(true);
    expect(prCall[3]).toBe(true);
    await diffCall[0]();
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(["git_diff_summary"]);
    await prCall[0]();
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(["git_diff_summary", "pr_status"]);
  });

  it("closing Home resets the store", async () => {
    invokeMock.mockResolvedValue(summary(1));
    useHomePoll(true, [target(1)]);
    await usePollMock.mock.calls[0][0]();
    expect(Object.keys(useHomePollStore.getState().diff)).toHaveLength(1);
    const cleanup = effects[0]();
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(useHomePollStore.getState().diff).toEqual({});
  });
});
