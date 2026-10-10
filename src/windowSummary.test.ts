import { describe, expect, it, vi } from "vitest";
import { SUMMARY_POLL_MS, windowFooterRows } from "./windowSummary";
import type { WindowSummary } from "./windowBoot";

vi.mock("./settingsStore", () => ({ getMultiwindow: vi.fn() }));
vi.mock("./windowBoot", () => ({ otherWindows: vi.fn() }));

describe("window summaries", () => {
  it("exports a 2500 ms summary polling interval", () => {
    expect(SUMMARY_POLL_MS).toBe(2500);
  });

  it("windowFooterRows omits windows with no pending items", () => {
    expect(windowFooterRows([])).toEqual([]);
    expect(windowFooterRows([
      { label: "fw-1", livePanes: 1 },
      { label: "fw-2", livePanes: 1, needsYou: 0 },
    ])).toEqual([]);
  });

  it("windowFooterRows preserves order, pluralises counts and prefers top-item targets", () => {
    const rows: WindowSummary[] = [
      { label: "fw-1", livePanes: 1, needsYou: 1, title: "Build", top: { wsId: 7, paneId: 8 } },
      { label: "fw-idle", livePanes: 1, needsYou: 0 },
      { label: "fw-2", livePanes: 2, needsYou: 2, title: "Review", top: { wsId: 9, paneId: 10 } },
    ];
    expect(windowFooterRows(rows)).toEqual([
      { label: "fw-1", text: "1 needs you in Build", wsId: 7, paneId: 8 },
      { label: "fw-2", text: "2 need you in Review", wsId: 9, paneId: 10 },
    ]);
    expect(rows).toHaveLength(3);
  });

  it("windowFooterRows falls back to the label and first workspace, or null targets", () => {
    const first = { id: 11, paneId: 12 } as NonNullable<WindowSummary["workspaces"]>[number];
    const second = { id: 13, paneId: 14 } as NonNullable<WindowSummary["workspaces"]>[number];
    expect(windowFooterRows([
      { label: "fw-1", title: "", livePanes: 2, needsYou: 1, top: null, workspaces: [first, second] },
      { label: "fw-2", livePanes: 0, needsYou: 3, workspaces: [] },
    ])).toEqual([
      { label: "fw-1", text: "1 needs you in fw-1", wsId: 11, paneId: 12 },
      { label: "fw-2", text: "3 need you in fw-2", wsId: null, paneId: null },
    ]);
    expect(windowFooterRows([
      { label: "fw-3", livePanes: 2, needsYou: 1, top: { wsId: 21, paneId: 22 }, workspaces: [first] },
    ])[0]).toEqual({ label: "fw-3", text: "1 needs you in fw-3", wsId: 21, paneId: 22 });
  });
});
