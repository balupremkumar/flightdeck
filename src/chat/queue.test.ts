import { describe, expect, it } from "vitest";
import { canQueuePrompt, drainQueue, queueClearsOn, queuedLabel, queuedTitle } from "./queue";

describe("prompt queue (H4)", () => {
  it("queues only while running with a live pty", () => {
    expect(canQueuePrompt("running", true)).toBe(true);
    expect(canQueuePrompt("running", false)).toBe(false);
    expect(canQueuePrompt("running", true, true)).toBe(false);
    for (const s of ["starting", "idle", "waiting", "permission", "error"] as const) expect(canQueuePrompt(s, true)).toBe(false);
  });

  it("drains oldest first as user records arrive", () => {
    expect(drainQueue(["a", "b"], 0)).toEqual(["a", "b"]);
    expect(drainQueue(["a", "b"], 1)).toEqual(["b"]);
    expect(drainQueue(["a"], 3)).toEqual([]);
  });

  it("clears when the agent returns to its prompt or exits", () => {
    expect(queueClearsOn("running")).toBe(false);
    expect(queueClearsOn("starting")).toBe(false);
    expect(queueClearsOn("idle")).toBe(true);
    expect(queueClearsOn("waiting")).toBe(true);
    expect(queueClearsOn("running", true)).toBe(true);
  });

  it("labels and titles", () => {
    expect(queuedLabel(2)).toBe("2 queued");
    expect(queuedTitle(["fix x", "y".repeat(200)])).toBe("1. fix x\n2. " + "y".repeat(117) + "...");
  });
});
