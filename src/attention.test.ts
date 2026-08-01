import { describe, expect, it } from "vitest";
import {
  ambientQueue,
  attentionKind,
  attentionQueue,
  forMins,
  isOpenQuestion,
  needsHumanQueue,
  stateSince,
  lastLine,
  lastOutputAt,
  recordOutput,
  mostRecentOutputPane,
} from "./attention";
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
    lastLine.clear();
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

describe("isOpenQuestion (UX-559)", () => {
  it("recognises a genuine open question", () => {
    expect(isOpenQuestion("Which package manager should I use?")).toBe(true);
    expect(isOpenQuestion("What should I name this branch?")).toBe(true);
  });

  it("rejects standard approval/permission prompts even though they end in a question", () => {
    expect(isOpenQuestion("Do you want to proceed?")).toBe(false);
    expect(isOpenQuestion("Would you like to continue?")).toBe(false);
    expect(isOpenQuestion("Allow this command? (y/n)")).toBe(false);
  });

  it("rejects text with no trailing question mark, and empty/undefined input", () => {
    expect(isOpenQuestion("Running tests now")).toBe(false);
    expect(isOpenQuestion("")).toBe(false);
    expect(isOpenQuestion(undefined)).toBe(false);
  });
});

describe("needs-you gate (UX-601, owner ruling 2026-08-01)", () => {
  const scene = () =>
    ws(9, [
      { id: 21, state: "waiting" }, // plain quiet — ambient, must never notify
      { id: 22, state: "waiting" }, // quiet AND asking something — needs a human
      { id: 23, state: "error" },
      { id: 24, state: "permission" },
      { id: 25, state: "running" },
      { id: 26, state: "idle" },
    ]);

  const seed = () => {
    lastLine.clear();
    const now = Date.now();
    for (const id of [21, 22, 23, 24, 25, 26]) stateSince.set(id, now - 1000);
    lastLine.set(21, "Running the test suite...");
    lastLine.set(22, "Which environment should this deploy to?");
  };

  it("classifies each pane: permission/error always, quiet only when it asked something", () => {
    seed();
    const kinds = Object.fromEntries(scene().panes.map((p) => [p.id, attentionKind(p)]));
    expect(kinds).toEqual({ 21: null, 22: "question", 23: "error", 24: "permission", 25: null, 26: null });
  });

  it("keeps a merely-quiet pane OUT of the queue — quiet is ambient, not a notification", () => {
    seed();
    const q = needsHumanQueue([scene()]);
    expect(q.map((x) => x.p.id)).not.toContain(21);
    expect(ambientQueue([scene()]).map((x) => x.p.id)).toEqual([21]);
  });

  it("puts an open-question pane IN the queue, and permission/error always", () => {
    seed();
    const q = needsHumanQueue([scene()]);
    // Grouped by urgency: approvals, then errors, then questions.
    expect(q.map((x) => x.p.id)).toEqual([24, 23, 22]);
    expect(q.map((x) => x.kind)).toEqual(["permission", "error", "question"]);
  });

  it("goes completely empty when every pane is quiet or working — the bell can rest", () => {
    lastLine.clear();
    lastLine.set(31, "Compiling...");
    const q = needsHumanQueue([ws(3, [{ id: 31, state: "waiting" }, { id: 32, state: "running" }, { id: 33, state: "idle" }])]);
    expect(q).toHaveLength(0);
  });

  it("a quiet pane with no captured output at all stays ambient", () => {
    lastLine.clear();
    const q = needsHumanQueue([ws(4, [{ id: 41, state: "waiting" }])]);
    expect(q).toHaveLength(0);
    expect(ambientQueue([ws(4, [{ id: 41, state: "waiting" }])])).toHaveLength(1);
  });

  it("snooze still removes a pane from both halves", () => {
    seed();
    const snoozed = { 24: Date.now() + 60_000, 21: Date.now() + 60_000 };
    expect(needsHumanQueue([scene()], snoozed).map((x) => x.p.id)).toEqual([23, 22]);
    expect(ambientQueue([scene()], snoozed)).toHaveLength(0);
  });

  it("attentionQueue (navigation call sites) still sees needs-you first, then quiet", () => {
    seed();
    expect(attentionQueue([scene()]).map((x) => x.p.id)).toEqual([24, 23, 22, 21]);
  });
});
