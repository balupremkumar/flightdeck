import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getMultiwindow } from "./settingsStore";
import { moveWorkspaceToNewWindow, moveWorkspaceToWindow } from "./windowMove";
import { mergeAllWindows } from "./windowMerge";
import {
  focusNextWindow, focusRemoteWorkspace, mergeAllWindowsCommand,
  MOVE_WINDOW_CHORD, moveActiveWorkspaceToNewWindow, moveActiveWorkspaceToWindow,
  multiwindowEnabled, NEXT_WINDOW_CHORD,
} from "./windowActions";

const state = vi.hoisted(() => ({ activeId: 7 as number | null, pushToast: vi.fn(), getState: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./settingsStore", () => ({ getMultiwindow: vi.fn() }));
vi.mock("./store", () => ({ useApp: { getState: state.getState } }));
vi.mock("./ui", () => ({ useUI: { getState: () => ({ pushToast: state.pushToast }) } }));
vi.mock("./windowMove", () => ({ moveWorkspaceToNewWindow: vi.fn(), moveWorkspaceToWindow: vi.fn() }));
vi.mock("./windowMerge", () => ({ mergeAllWindows: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  state.activeId = 7;
  state.getState.mockImplementation(() => ({ activeId: state.activeId }));
  vi.mocked(getMultiwindow).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue("fw-2");
  vi.mocked(mergeAllWindows).mockResolvedValue([]);
});

describe("window actions", () => {
  it("exports the move and next window shortcut chords", () => {
    expect(MOVE_WINDOW_CHORD).toEqual({ key: "n", label: "Ctrl+Shift+N" });
    expect(NEXT_WINDOW_CHORD).toEqual({ key: "o", label: "Ctrl+Shift+O" });
  });

  it.each([true, false])("multiwindowEnabled returns the setting %s", (enabled) => {
    vi.mocked(getMultiwindow).mockReturnValue(enabled);
    expect(multiwindowEnabled()).toBe(enabled);
  });

  it("gates move, merge and next-window commands when multiwindow is disabled", async () => {
    vi.mocked(getMultiwindow).mockReturnValue(false);
    await moveActiveWorkspaceToNewWindow();
    await moveActiveWorkspaceToWindow("fw-2");
    await mergeAllWindowsCommand();
    await focusNextWindow();
    expect(state.getState).not.toHaveBeenCalled();
    expect(moveWorkspaceToNewWindow).not.toHaveBeenCalled();
    expect(moveWorkspaceToWindow).not.toHaveBeenCalled();
    expect(mergeAllWindows).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(state.pushToast).not.toHaveBeenCalled();
  });

  it("moves the active workspace to a new or named window", async () => {
    await moveActiveWorkspaceToNewWindow();
    await moveActiveWorkspaceToWindow("fw-2");
    expect(moveWorkspaceToNewWindow).toHaveBeenCalledExactlyOnceWith(7);
    expect(moveWorkspaceToWindow).toHaveBeenCalledExactlyOnceWith(7, "fw-2");
    expect(state.pushToast).not.toHaveBeenCalled();
  });

  it("asks for a workspace before either move when none is active", async () => {
    state.activeId = null;
    await moveActiveWorkspaceToNewWindow();
    await moveActiveWorkspaceToWindow("fw-2");
    expect(state.pushToast.mock.calls).toEqual([
      ["info", "Open a workspace first, then move it to a new window."],
      ["info", "Open a workspace first, then move it to a window."],
    ]);
    expect(moveWorkspaceToNewWindow).not.toHaveBeenCalled();
    expect(moveWorkspaceToWindow).not.toHaveBeenCalled();
  });

  it.each([
    { moved: [], message: "There is only one window." },
    { moved: [7], message: "Merged 1 workspace into the main window." },
    { moved: [7, 8], message: "Merged 2 workspaces into the main window." },
  ])("mergeAllWindowsCommand reports $message", async ({ moved, message }) => {
    vi.mocked(mergeAllWindows).mockResolvedValue(moved);
    await mergeAllWindowsCommand();
    expect(mergeAllWindows).toHaveBeenCalledExactlyOnceWith();
    expect(state.pushToast).toHaveBeenCalledExactlyOnceWith("info", message);
  });

  it.each([5, null])("focusRemoteWorkspace focuses the target with pane %s", async (paneId) => {
    await focusRemoteWorkspace("fw-2", 7, paneId);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("window_focus_pane", { label: "fw-2", wsId: 7, paneId: paneId ?? 0 });
    expect(state.pushToast).not.toHaveBeenCalled();
  });

  it("focusRemoteWorkspace reports a failed switch without rejecting", async () => {
    vi.mocked(invoke).mockRejectedValue("window gone");
    await expect(focusRemoteWorkspace("fw-2", 7, 5)).resolves.toBeUndefined();
    expect(state.pushToast).toHaveBeenCalledExactlyOnceWith("info", "Couldn't switch to that window: window gone");
  });

  it("focusNextWindow requests the next window without a toast when one exists", async () => {
    await focusNextWindow();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("window_focus_next");
    expect(state.pushToast).not.toHaveBeenCalled();
  });

  it("focusNextWindow reports when there is only one window", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await focusNextWindow();
    expect(state.pushToast).toHaveBeenCalledExactlyOnceWith("info", "There is only one window.");
  });

  it("focusNextWindow tolerates an unavailable command in browser preview", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("unavailable"));
    await expect(focusNextWindow()).resolves.toBeUndefined();
    expect(state.pushToast).not.toHaveBeenCalled();
  });
});
