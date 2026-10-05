import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./settingsStore", () => ({ getMultiwindow: () => true }));
vi.mock("./windowBoot", () => ({ otherWindows: async () => [] }));

const { buildAttentionReport, reportKey, sendAttentionReport, summonPane, _resetReportForTests } = await import("./attentionReport");
const { needsHumanQueue } = await import("./attention");
const { windowFooterRows } = await import("./windowSummary");
import type { PaneState, Workspace } from "./store";

function pane(id: number, state: PaneState) {
  return { id, vendor: "claude", title: `pane ${id}`, state, cwd: "C:\\repo" } as unknown as Workspace["panes"][number];
}
function ws(id: number, panes: Workspace["panes"]): Workspace {
  return { id, name: `ws${id}`, panes, focused: panes[0]?.id, cwd: "C:\\repo" } as unknown as Workspace;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  _resetReportForTests();
});

describe("buildAttentionReport", () => {
  it("is empty with no top when nothing needs a human", () => {
    expect(buildAttentionReport(needsHumanQueue([ws(1, [pane(10, "running")])], {}))).toEqual({ count: 0, top: null });
  });

  it("counts the queue and reports its head: approvals outrank errors", () => {
    const queue = needsHumanQueue([ws(1, [pane(10, "error")]), ws(2, [pane(20, "permission")])], {});
    const r = buildAttentionReport(queue);
    expect(r.count).toBe(2);
    expect(r.top).toMatchObject({ kindRank: 0, wsId: 2, paneId: 20 });
  });
});

describe("sendAttentionReport", () => {
  const fallback = vi.fn(async () => {});
  beforeEach(() => fallback.mockClear());

  it("drops an identical report and sends again when it changes", async () => {
    // `since` falls back to Date.now() when stateSince is unset, so pin the clock.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const q = needsHumanQueue([ws(1, [pane(10, "permission")])], {});
    await sendAttentionReport(q, fallback);
    await sendAttentionReport(q, fallback);
    vi.useRealTimers();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("attention_report", { count: 1, top: expect.objectContaining({ wsId: 1, paneId: 10 }) });
    await sendAttentionReport([], fallback);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("attention_report", { count: 0, top: null });
  });

  it("sends 0 first time round so a cold start clears a stale overlay", async () => {
    await sendAttentionReport([], fallback);
    expect(invoke).toHaveBeenCalledWith("attention_report", { count: 0, top: null });
  });

  it("falls back to the local count and retries on the next change when the command fails", async () => {
    invoke.mockRejectedValue(new Error("window main is not registered"));
    const q = needsHumanQueue([ws(1, [pane(10, "permission")])], {});
    await sendAttentionReport(q, fallback);
    expect(fallback).toHaveBeenCalledWith(1);
    invoke.mockResolvedValue(undefined);
    await sendAttentionReport(q, fallback);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keys differ by top item so a reordered queue is a new report", () => {
    const a = { count: 2, top: { kindRank: 0, since: 5, wsId: 1, paneId: 10 } };
    expect(reportKey(a)).not.toBe(reportKey({ ...a, top: { ...a.top, paneId: 11 } }));
  });
});

describe("summonPane", () => {
  const spaces = [ws(1, [pane(10, "running")]), ws(2, [pane(20, "permission")])];
  it("lands on the pane in the payload", () => {
    expect(summonPane({ wsId: 2, paneId: 20 }, spaces)).toEqual({ wsId: 2, paneId: 20 });
  });
  it("does nothing for null payloads or a workspace this window no longer holds", () => {
    expect(summonPane({ wsId: null, paneId: null }, spaces)).toBeNull();
    expect(summonPane(undefined, spaces)).toBeNull();
    expect(summonPane({ wsId: 9, paneId: 90 }, spaces)).toBeNull();
  });
  it("keeps the workspace but not a vanished pane", () => {
    expect(summonPane({ wsId: 2, paneId: 99 }, spaces)).toEqual({ wsId: 2, paneId: null });
  });
});

describe("windowFooterRows (bell footer)", () => {
  it("makes one row per other window with something pending, none for quiet windows", () => {
    const rows = windowFooterRows([
      { label: "fw-1", livePanes: 2, title: "Window 2", needsYou: 2, top: { wsId: 5, paneId: 9 }, workspaces: [{ id: 5, name: "a", root: "", paneId: 8, livePanes: 2 }] },
      { label: "fw-2", livePanes: 1, title: "Window 3", needsYou: 0 },
    ]);
    expect(rows).toEqual([{ label: "fw-1", text: "2 need you in Window 2", wsId: 5, paneId: 9 }]);
  });
  it("uses singular grammar and falls back to the first workspace without a top", () => {
    const rows = windowFooterRows([{ label: "fw-1", livePanes: 1, title: "Window 2", needsYou: 1, workspaces: [{ id: 5, name: "a", root: "", paneId: 8, livePanes: 1 }] }]);
    expect(rows[0]).toMatchObject({ text: "1 needs you in Window 2", wsId: 5, paneId: 8 });
  });
  it("is empty with one window", () => {
    expect(windowFooterRows([])).toEqual([]);
  });
});
