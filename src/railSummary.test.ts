import { afterEach, describe, expect, it } from "vitest";
import { lastLine } from "./attention";
import { railSentence, railSummary } from "./railSummary";
import type { PaneModel, PaneState } from "./store";

function pane(id: number, state: PaneState, vendor = "claude"): PaneModel {
  return { id, state, vendor, cwd: "C:/repo", epoch: 0 };
}

afterEach(() => lastLine.clear());

describe("railSummary", () => {
  it("keeps quiet shells and quiet agents idle, including a shell with a question", () => {
    lastLine.set(1, "Which option do you want?");
    expect(railSummary([pane(1, "waiting", "pwsh"), pane(2, "waiting")])).toEqual({
      needs: 0, working: 0, idle: 2, total: 2, worst: null,
    });
  });

  it("counts an agent question as needing a human", () => {
    lastLine.set(1, "Which option do you want?");
    expect(railSummary([pane(1, "waiting")])).toEqual({
      needs: 1, working: 0, idle: 0, total: 1, worst: "question",
    });
  });

  it("ranks approvals above questions and errors above both, in any order", () => {
    lastLine.set(1, "Which option do you want?");
    const question = pane(1, "waiting");
    const approval = pane(2, "permission");
    const error = pane(3, "error");
    expect(railSummary([question, approval])).toEqual({
      needs: 2, working: 0, idle: 0, total: 2, worst: "permission",
    });
    for (const panes of [[question, approval, error], [error, approval, question]]) {
      expect(railSummary(panes)).toEqual({
        needs: 3, working: 0, idle: 0, total: 3, worst: "error",
      });
    }
  });

  it("never counts shell approvals or errors as needing a human", () => {
    expect(railSummary([pane(1, "permission", "pwsh"), pane(2, "error", "pwsh")])).toEqual({
      needs: 0, working: 0, idle: 2, total: 2, worst: null,
    });
  });

  it("groups starting and running panes as working, with exclusive counts", () => {
    const summary = railSummary([
      pane(1, "permission"), pane(2, "starting"), pane(3, "running"),
      pane(4, "running", "pwsh"), pane(5, "waiting"), pane(6, "idle"),
    ]);
    expect(summary).toEqual({ needs: 1, working: 3, idle: 2, total: 6, worst: "permission" });
    expect(railSentence(summary)).toBe("1 needs you \u00b7 3 working \u00b7 2 idle");
  });
});

describe("railSentence", () => {
  it("labels empty and wholly idle workspaces", () => {
    expect(railSentence(railSummary([]))).toBe("No panes");
    expect(railSentence(railSummary([pane(1, "waiting")]))).toBe("All idle");
  });

  it("omits zero parts without leaving separators", () => {
    expect(railSentence(railSummary([pane(1, "running")]))).toBe("1 working");
    expect(railSentence(railSummary([pane(1, "error")]))).toBe("1 needs you");
    expect(railSentence(railSummary([pane(1, "error"), pane(2, "idle")]))).toBe("1 needs you \u00b7 1 idle");
    expect(railSentence(railSummary([pane(1, "running"), pane(2, "idle")]))).toBe("1 working \u00b7 1 idle");
  });
});
