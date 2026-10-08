import { describe, expect, it } from "vitest";
import { paneStateWord } from "./paneHeader";

describe("paneStateWord", () => {
  it.each([
    ["starting", false, "Working", "starting"],
    ["running", true, "Working", "running"],
    ["permission", false, "Needs you", "waiting"],
    ["permission", true, "Needs you", "waiting"],
    ["waiting", true, "Has a question", "waiting"],
    ["error", true, "Error", "error"],
    ["error", false, "Error", "error"],
  ] as const)("labels %s (question %s) without an idle age", (state, question, text, tone) => {
    expect(paneStateWord(state, question, 7_200_000)).toEqual({ text, tone });
  });

  it.each(["idle", "waiting"] as const)("ages quiet %s panes at minute and hour boundaries", (state) => {
    for (const [ms, text] of [
      [0, "Idle"], [59_999, "Idle"], [60_000, "Idle 1m"],
      [240_000, "Idle 4m"], [3_599_999, "Idle 59m"],
      [3_600_000, "Idle 1h"], [7_200_000, "Idle 2h"],
    ] as const) {
      // A quiet pane is ambient: muted (idle tone) whether its state is idle or waiting.
      expect(paneStateWord(state, false, ms)).toEqual({ text, tone: "idle" });
    }
  });
  it("ignores a question flag for idle panes", () => {
    expect(paneStateWord("idle", true, 60_000)).toEqual({ text: "Idle 1m", tone: "idle" });
  });
});
