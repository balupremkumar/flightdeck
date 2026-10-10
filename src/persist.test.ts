import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportBackup, hasPreviousSession, importBackup, isMainWindow, isSafeMode,
  listRestorePoints, loadSession, makeDebouncedSave, putSlice, restoreFromPoint,
  saveSession, type SessionDoc, type SessionDraft,
} from "./persist";

const mocks = vi.hoisted(() => ({
  responses: new Map<string, unknown>(),
  failures: new Map<string, Error>(),
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  getCurrentWindow: vi.fn<() => { label: string }>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: mocks.getCurrentWindow }));

const draft: SessionDraft = {
  activeWorkspaceId: 7,
  workspaces: [{
    id: 7, name: "Flightdeck", root: "D:/Dev/flightdeck", setupCmd: "prepare",
    panes: [{
      id: 12, vendor: "codex", cwd: "D:/Dev/flightdeck", title: "Persistence",
      worktreePath: "D:/Dev/worktree", branch: "tests", baseBranch: "main",
      draft: "Unsent input", titleManual: true,
    }],
  }],
  uiPrefs: { theme: "dark", scale: 1.2 },
  windows: [{ label: "main", workspaceIds: [7], activeWorkspaceId: 7 }],
};
const doc: SessionDoc = { ...draft, version: 1, savedAt: 123456 };

beforeEach(() => {
  mocks.responses.clear();
  mocks.failures.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command) => {
    const failure = mocks.failures.get(command);
    if (failure) throw failure;
    if (!mocks.responses.has(command)) throw new Error(`Unexpected command: ${command}`);
    return mocks.responses.get(command);
  });
  mocks.getCurrentWindow.mockReset();
  mocks.getCurrentWindow.mockReturnValue({ label: "main" });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("session queries", () => {
  it.each([true, false])("returns safe mode %s", async (value) => {
    mocks.responses.set("is_safe_mode", value);
    await expect(isSafeMode()).resolves.toBe(value);
    expect(mocks.invoke.mock.calls).toEqual([["is_safe_mode"]]);
  });

  it.each([true, false])("returns previous-session presence %s", async (value) => {
    mocks.responses.set("has_previous_session", value);
    await expect(hasPreviousSession()).resolves.toBe(value);
    expect(mocks.invoke.mock.calls).toEqual([["has_previous_session"]]);
  });

  it.each([doc, null])("loads the backend session value %#", async (value) => {
    mocks.responses.set("load_session", value);
    await expect(loadSession()).resolves.toBe(value);
    expect(mocks.invoke.mock.calls).toEqual([["load_session"]]);
  });

  it("saves the complete draft and waits for the backend", async () => {
    let complete!: (value: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    let settled = false;
    const saving = saveSession(draft).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mocks.invoke.mock.calls).toEqual([["save_session", { doc: draft }]]);
    complete("backend acknowledgement");
    await expect(saving).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
});

describe("window persistence", () => {
  it.each(["main", "workspace-2"])("identifies the %s window", (label) => {
    mocks.getCurrentWindow.mockReturnValue({ label });
    expect(isMainWindow()).toBe(label === "main");
    expect(mocks.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("treats browser preview as the main window", () => {
    mocks.getCurrentWindow.mockImplementation(() => { throw new Error("No Tauri window"); });
    expect(isMainWindow()).toBe(true);
    expect(mocks.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])("writes a slice with flush %s", async (flush) => {
    mocks.responses.set("session_put_slice", "backend acknowledgement");
    await expect(putSlice(draft, flush)).resolves.toBeUndefined();
    expect(mocks.invoke.mock.calls).toEqual([["session_put_slice", { slice: draft, flush: flush ?? false }]]);
    expect(mocks.getCurrentWindow).not.toHaveBeenCalled();
  });

  it("absorbs an unavailable slice command", async () => {
    mocks.failures.set("session_put_slice", new Error("Command unavailable"));
    await expect(putSlice(draft, true)).resolves.toBeUndefined();
    expect(mocks.invoke.mock.calls).toEqual([["session_put_slice", { slice: draft, flush: true }]]);
  });
});

describe("debounced saver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.responses.set("session_put_slice", undefined);
  });

  it("resets the delay, writes the latest draft, and saves subsequent changes", async () => {
    const saver = makeDebouncedSave(100);
    const latest = { ...draft, uiPrefs: { theme: "light" } };
    saver.schedule(draft);
    await vi.advanceTimersByTimeAsync(60);
    saver.schedule(latest);
    await vi.advanceTimersByTimeAsync(99);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.invoke.mock.calls).toEqual([["session_put_slice", { slice: latest, flush: false }]]);
    saver.schedule(draft);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.invoke.mock.calls).toEqual([
      ["session_put_slice", { slice: latest, flush: false }],
      ["session_put_slice", { slice: draft, flush: false }],
    ]);
  });

  it("defaults to an 800 ms delay", async () => {
    makeDebouncedSave().schedule(draft);
    await vi.advanceTimersByTimeAsync(799);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.invoke.mock.calls).toEqual([["session_put_slice", { slice: draft, flush: false }]]);
  });

  it.each([undefined, false, true])("flushes immediately with final %s and clears pending work", async (final) => {
    const saver = makeDebouncedSave(100);
    saver.schedule(doc);
    saver.schedule(draft);
    expect(saver.flush(final)).toBeUndefined();
    expect(mocks.invoke.mock.calls).toEqual([["session_put_slice", { slice: draft, flush: final ?? false }]]);
    expect(vi.getTimerCount()).toBe(0);
    saver.flush(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    saver.schedule(doc);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.invoke).toHaveBeenLastCalledWith("session_put_slice", { slice: doc, flush: false });
  });

  it("does nothing when flushed without a pending draft", () => {
    const saver = makeDebouncedSave();
    saver.flush();
    saver.flush(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("restore points and backups", () => {
  it.each([
    { points: [{ id: "newest", savedAt: 200 }, { id: "older", savedAt: 100 }] },
    { points: [] },
  ])(
    "returns restore points unchanged %#", async ({ points }) => {
      mocks.responses.set("list_restore_points", points);
      await expect(listRestorePoints()).resolves.toBe(points);
      expect(mocks.invoke.mock.calls).toEqual([["list_restore_points"]]);
    },
  );

  it("reads a restore point without saving it as the current session", async () => {
    mocks.responses.set("restore_from_point", doc);
    await expect(restoreFromPoint("snapshot-123")).resolves.toBe(doc);
    expect(mocks.invoke.mock.calls).toEqual([["restore_from_point", { id: "snapshot-123" }]]);
  });

  it("exports to the supplied destination and returns void", async () => {
    mocks.responses.set("export_backup", "backend acknowledgement");
    await expect(exportBackup("D:/Backups/session.zip")).resolves.toBeUndefined();
    expect(mocks.invoke.mock.calls).toEqual([["export_backup", { destPath: "D:/Backups/session.zip" }]]);
  });

  it.each([doc, null])("imports the backup session value %#", async (value) => {
    mocks.responses.set("import_backup", value);
    await expect(importBackup("D:/Backups/session.zip")).resolves.toBe(value);
    expect(mocks.invoke.mock.calls).toEqual([["import_backup", { srcPath: "D:/Backups/session.zip" }]]);
  });
});

describe("backend error propagation", () => {
  const cases: [string, () => Promise<unknown>, unknown[]][] = [
    ["is_safe_mode", isSafeMode, ["is_safe_mode"]],
    ["has_previous_session", hasPreviousSession, ["has_previous_session"]],
    ["load_session", loadSession, ["load_session"]],
    ["save_session", () => saveSession(draft), ["save_session", { doc: draft }]],
    ["list_restore_points", listRestorePoints, ["list_restore_points"]],
    ["restore_from_point", () => restoreFromPoint("missing"), ["restore_from_point", { id: "missing" }]],
    ["export_backup", () => exportBackup("backup.zip"), ["export_backup", { destPath: "backup.zip" }]],
    ["import_backup", () => importBackup("backup.zip"), ["import_backup", { srcPath: "backup.zip" }]],
  ];

  it.each(cases)("propagates %s rejection", async (command, call, expected) => {
    const failure = new Error("Backend failure");
    mocks.failures.set(command, failure);
    await expect(call()).rejects.toBe(failure);
    expect(mocks.invoke.mock.calls).toEqual([expected]);
  });
});
