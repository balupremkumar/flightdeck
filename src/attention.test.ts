import { describe, expect, it } from "vitest";
import { attentionQueue, forMins, stateSince, lastOutputAt, recordOutput, mostRecentOutputPane } from "./attention";
import type { PaneState, Workspace } from "./store";

function ws(id: number, panes: { id: number; state: PaneState }[]): Workspace {
  return {
    id,
    name: `ws${id}`,
    root: `/w${id}`,
    focused: null,
    panes: panes.map((p) => ({ id: p.id, vendor: "claude", cwd: `/w${id}`, state: p.state, epoch: 0 })),
  };
}

describe("attention queue", () => {
  it("ranks approval > error > waiting, longest-needed first within a rank", () => {
    const now = Date.now();
    stateSince.set(1, now - 60_000); // waiting, 1m
    stateSince.set(2, now - 300_000); // waiting, 5m — older, should lead its rank
    stateSince.set(3, now - 10_000); // error
    stateSince.set(4, now - 5_000); // permission — newest but top rank
    const q = attentionQueue([
      ws(1, [{ id: 1, state: "waiting" }, { id: 3, state: "error" }, { id: 5, state: "running" }]),
      ws(2, [{ id: 2, state: "waiting" }, { id: 4, state: "permission" }, { id: 6, state: "idle" }]),
    ]);
    expect(q.map((x) => x.p.id)).toEqual([4, 3, 2, 1]);
  });

  it("running/idle/starting panes never enter the queue", () => {
    const q = attentionQueue([ws(1, [{ id: 10, state: "running" }, { id: 11, state: "starting" }, { id: 12, state: "idle" }])]);
    expect(q).toHaveLength(0);
  });

  it("forMins buckets durations", () => {
    const now = Date.now();
    expect(forMins(now - 10_000)).toBe("just now");
    expect(forMins(now - 3 * 60_000)).toBe("3m");
    expect(forMins(now - 65 * 60_000)).toBe("1h 5m");
  });
});

describe("mostRecentOutputPane (UX-537)", () => {
  it("returns null when nothing has ever been recorded", () => {
    lastOutputAt.clear();
    expect(mostRecentOutputPane([ws(1, [{ id: 1, state: "running" }])])).toBeNull();
  });

  it("picks the pane with the latest recorded output, across workspaces", () => {
    lastOutputAt.clear();
    recordOutput(1, 100);
    recordOutput(2, 300);
    recordOutput(3, 200);
    const result = mostRecentOutputPane([
      ws(1, [{ id: 1, state: "running" }, { id: 3, state: "waiting" }]),
      ws(2, [{ id: 2, state: "idle" }]),
    ]);
    expect(result?.p.id).toBe(2);
    expect(result?.w.id).toBe(2);
  });

  it("excludes panes with no recorded output rather than treating them as oldest", () => {
    lastOutputAt.clear();
    recordOutput(5, 50);
    const result = mostRecentOutputPane([ws(1, [{ id: 5, state: "running" }, { id: 6, state: "running" }])]);
    expect(result?.p.id).toBe(5);
  });
});
