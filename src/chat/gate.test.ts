import { describe, expect, it } from "vitest";
import { promptGate } from "./gate";

describe("promptGate", () => {
  it.each(["idle", "waiting"] as const)("allows %s panes with a PTY", (state) => {
    expect(promptGate(state, true)).toEqual({ canSend: true, reason: "ok", message: "" });
  });
  it.each(["running", "starting"] as const)("blocks %s panes as busy", (state) => {
    expect(promptGate(state, true)).toEqual({ canSend: false, reason: "busy",
      message: "Agent is working. You can send when it is waiting for input." });
  });
  it("blocks a missing PTY before considering idle or busy state", () => {
    for (const state of ["idle", "waiting", "running"] as const) {
      expect(promptGate(state, false)).toEqual({ canSend: false, reason: "nopty", message: "Session is not running" });
    }
  });
  it("prioritises permission prompts over missing PTYs", () => {
    for (const hasPty of [true, false]) {
      expect(promptGate("permission", hasPty)).toEqual({ canSend: false, reason: "permission",
        message: "Agent is waiting on a prompt, switch to Terminal" });
    }
  });
  it("prioritises exited panes over every other gate", () => {
    for (const state of ["idle", "permission", "running"] as const) {
      for (const hasPty of [true, false]) {
        expect(promptGate(state, hasPty, true)).toEqual({ canSend: false, reason: "exited",
          message: "This pane has exited. Restart it to continue" });
      }
    }
  });
});
