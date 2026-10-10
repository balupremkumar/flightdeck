import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "./store";
import type { SessionDraft } from "./persist";
import type { TransferPayload } from "./windowBoot";

const m = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listenHere: vi.fn(), globalListen: vi.fn(), getMultiwindow: vi.fn(),
  setWindowOrdinal: vi.fn(), isMainWindow: vi.fn(),
  state: { workspaces: [] as Workspace[], adoptWorkspace: vi.fn(), switchWorkspace: vi.fn(), focusPane: vi.fn() },
  subscribe: vi.fn(), pushToast: vi.fn(), addRestoredUiPrefs: vi.fn(),
  hydrateFrom: vi.fn(), parseUiPrefs: vi.fn(), markRestoredPane: vi.fn(),
  stageTransfers: vi.fn(), getSession: vi.fn(), remeasureAttached: vi.fn(),
  getCurrentWindow: vi.fn(), onScaleChanged: vi.fn(), destroy: vi.fn(),
  logEvent: vi.fn(), announce: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: m.globalListen }));
vi.mock("./eventScope", () => ({ listenHere: m.listenHere }));
vi.mock("./settingsStore", () => ({ getMultiwindow: m.getMultiwindow }));
vi.mock("./store", () => ({ setWindowOrdinal: m.setWindowOrdinal, useApp: { getState: () => m.state, subscribe: m.subscribe } }));
vi.mock("./ui", () => ({ useUI: { getState: () => ({ pushToast: m.pushToast }) } }));
vi.mock("./persist", () => ({ isMainWindow: m.isMainWindow }));
vi.mock("./session", () => ({ addRestoredUiPrefs: m.addRestoredUiPrefs, hydrateFrom: m.hydrateFrom, parseUiPrefs: m.parseUiPrefs }));
vi.mock("./ptyAttach", () => ({ markRestoredPane: m.markRestoredPane }));
vi.mock("./transferSnap", () => ({ stageTransfers: m.stageTransfers }));
vi.mock("./paneSessions", () => ({ get: m.getSession, remeasureAttached: m.remeasureAttached }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: m.getCurrentWindow }));
vi.mock("./applog", () => ({ logEvent: m.logEvent }));
vi.mock("./windowAnnounce", () => ({ announce: m.announce }));

let boot: typeof import("./windowBoot");
const workspace = (): Workspace => ({
  id: 7, name: "Flightdeck", root: "D:/Dev/flightdeck", focused: 12,
  panes: [12, 13].map((id) => ({ id, vendor: "codex", cwd: "D:/Dev/flightdeck", state: "running", epoch: 0 })),
});
const slice = (): SessionDraft => ({ activeWorkspaceId: 7, workspaces: [workspace()], uiPrefs: { theme: "dark" } });
const transfer = (): TransferPayload => ({ workspace: workspace(), panes: { 12: { serialized: "screen", seq: 4, cols: 80, rows: 24 } } });
const payload = () => ({ from: "secondary-2", workspaceIds: [7], activeWs: 7, slice: slice(), transferId: 42 });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules(); // The heartbeat guard belongs to each freshly booted webview.
  m.state.workspaces = [];
  m.invoke.mockResolvedValue(undefined);
  m.listenHere.mockResolvedValue(() => {});
  m.getMultiwindow.mockReturnValue(true);
  m.isMainWindow.mockReturnValue(true);
  m.hydrateFrom.mockResolvedValue(undefined);
  m.parseUiPrefs.mockReturnValue({ theme: "dark" });
  m.onScaleChanged.mockResolvedValue(() => {});
  m.destroy.mockResolvedValue(undefined);
  m.getCurrentWindow.mockReturnValue({ onScaleChanged: m.onScaleChanged, destroy: m.destroy });
  boot = await import("./windowBoot");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("boot and restore", () => {
  it("partitions pane ids and starts just one heartbeat after valid boots", async () => {
    vi.useFakeTimers();
    expect(boot.HEARTBEAT_MS).toBe(2000);
    const info = { label: "secondary-2", ordinal: 2, idFloor: 500 };
    m.invoke.mockResolvedValue(info);
    await expect(boot.bootWindow()).resolves.toBe(info);
    await expect(boot.bootWindow()).resolves.toBe(info);
    expect(m.invoke.mock.calls).toEqual(Array(2).fill(["window_boot", { multiwindow: true }]));
    expect(m.setWindowOrdinal).toHaveBeenCalledWith(2, 500);
    expect(vi.getTimerCount()).toBe(1);
    m.invoke.mockRejectedValue(new Error("Rust gone"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(m.invoke.mock.calls.slice(2)).toEqual([["window_heartbeat"], ["window_heartbeat"]]);
  });

  it.each([null, undefined, { ordinal: "2" }])("ignores invalid boot information (%#)", async (info) => {
    vi.useFakeTimers();
    m.getMultiwindow.mockReturnValue(false);
    m.invoke.mockResolvedValue(info);
    await expect(boot.bootWindow()).resolves.toBeNull();
    expect(m.invoke).toHaveBeenCalledWith("window_boot", { multiwindow: false });
    expect(m.setWindowOrdinal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null when boot fails", async () => {
    m.invoke.mockRejectedValue(new Error("Unavailable"));
    await expect(boot.bootWindow()).resolves.toBeNull();
    expect(m.setWindowOrdinal).not.toHaveBeenCalled();
  });

  it.each([[true, true], [false, true], [true, false]])("restores only main with multiwindow enabled (%s, %s)", (main, enabled) => {
    m.isMainWindow.mockReturnValue(main);
    m.getMultiwindow.mockReturnValue(enabled);
    expect(boot.restoreWindows()).toBeUndefined();
    expect(m.invoke.mock.calls).toEqual(main && enabled ? [["restore_windows"]] : []);
  });

  it("logs a restore failure", async () => {
    m.invoke.mockRejectedValue(new Error("Unavailable"));
    boot.restoreWindows();
    await flush();
    expect(m.logEvent).toHaveBeenCalledWith("warn", "windowBoot", "restore_windows failed: Error: Unavailable");
  });
});

describe("boot adoption", () => {
  it.each([null, { label: "main", ordinal: 0, slice: slice() }, { label: "secondary", ordinal: 1, slice: { ...slice(), workspaces: [] } }])(
    "does nothing without a secondary workspace (%#)", async (info) => {
      await expect(boot.adoptBootInfo(info)).resolves.toBeUndefined();
      expect(m.hydrateFrom).not.toHaveBeenCalled();
      expect(m.state.adoptWorkspace).not.toHaveBeenCalled();
    },
  );

  it("restores preferences before hydrating a secondary slice", async () => {
    const saved = slice();
    await expect(boot.adoptBootInfo({ label: "secondary", ordinal: 1, slice: saved })).resolves.toBeUndefined();
    expect(m.parseUiPrefs).toHaveBeenCalledWith(saved.uiPrefs);
    expect(m.addRestoredUiPrefs).toHaveBeenCalledWith({ theme: "dark" });
    expect(m.hydrateFrom).toHaveBeenCalledWith(saved.workspaces, 7);
    expect(m.addRestoredUiPrefs.mock.invocationCallOrder[0]).toBeLessThan(m.hydrateFrom.mock.invocationCallOrder[0]);
  });

  it("adopts live panes without mutating the transfer, then focuses and announces", async () => {
    vi.useFakeTimers();
    const t = transfer();
    const focus = vi.fn();
    m.getSession.mockReturnValue({ ptyId: 123, term: { focus } });
    await boot.adoptBootInfo({ label: "secondary", ordinal: 1, transfer: t, slice: slice() });
    expect(m.markRestoredPane.mock.calls).toEqual([[12], [13]]);
    expect(m.stageTransfers).toHaveBeenCalledWith(t.panes);
    expect(m.state.adoptWorkspace).toHaveBeenCalledWith({ ...t.workspace, panes: t.workspace.panes.map((p) => ({ ...p, state: "starting" })) });
    expect(t.workspace.panes.every((p) => p.state === "running")).toBe(true);
    expect(m.hydrateFrom).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(focus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.getSession).toHaveBeenLastCalledWith(12);
    expect(focus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(m.announce).toHaveBeenCalledWith("Workspace Flightdeck moved to this window. 2 panes.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for all panes and falls back to the first pane when no focus was saved", async () => {
    vi.useFakeTimers();
    const t = transfer(); t.workspace.focused = null;
    const focus = vi.fn();
    m.getSession.mockImplementation((id: number) => id === 12 ? { ptyId: 123, term: { focus } } : undefined);
    await boot.adoptBootInfo({ label: "secondary", ordinal: 1, transfer: t });
    await vi.advanceTimersByTimeAsync(1000);
    expect(focus).not.toHaveBeenCalled();
    m.getSession.mockReturnValue({ ptyId: 123, term: { focus } });
    await vi.advanceTimersByTimeAsync(300);
    expect(m.getSession).toHaveBeenLastCalledWith(12);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("ends the attachment wait after six seconds even if a pane never attaches", async () => {
    vi.useFakeTimers();
    await boot.adoptBootInfo({ label: "secondary", ordinal: 1, transfer: transfer() });
    await vi.advanceTimersByTimeAsync(6200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs hydration failure without rejecting", async () => {
    m.hydrateFrom.mockRejectedValue(new Error("Hydration failed"));
    await expect(boot.adoptBootInfo({ label: "secondary", ordinal: 1, slice: slice() })).resolves.toBeUndefined();
    expect(m.logEvent).toHaveBeenCalledWith("error", "windowBoot", "could not adopt the boot slice: Error: Hydration failed");
  });
});

describe("adopt events", () => {
  it("receives a transfer through listenHere, acknowledges before adopting, and never uses global listen", async () => {
    vi.useFakeTimers();
    m.isMainWindow.mockReturnValue(false);
    let acknowledge!: (accepted: boolean) => void;
    m.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    expect(boot.listenForAdopt()).toBeUndefined();
    expect(m.listenHere).toHaveBeenCalledWith("win://adopt", expect.any(Function));
    const callback = m.listenHere.mock.calls[0][1];
    const handling = callback({ payload: { ...payload(), transfer: transfer() } });
    expect(m.invoke).toHaveBeenCalledWith("window_adopted", { transferId: 42 });
    expect(m.state.adoptWorkspace).not.toHaveBeenCalled();
    acknowledge(true);
    await expect(handling).resolves.toBeUndefined();
    expect(m.state.adoptWorkspace).toHaveBeenCalledTimes(1);
    expect(m.globalListen).not.toHaveBeenCalled();
  });

  it("leaves a cancelled transfer at its source", async () => {
    m.invoke.mockResolvedValue(false);
    await boot.handleAdopt({ ...payload(), transfer: transfer() });
    expect(m.state.adoptWorkspace).not.toHaveBeenCalled();
    expect(m.stageTransfers).not.toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledWith("warn", "windowBoot", "win://adopt from secondary-2 was cancelled; leaving it with the source");
  });

  it("acknowledges duplicate transfers without adopting twice", async () => {
    m.state.workspaces = [workspace()];
    m.invoke.mockResolvedValue(true);
    await boot.handleAdopt({ ...payload(), transfer: transfer() });
    expect(m.invoke.mock.calls).toEqual([["window_adopted", { transferId: 42 }]]);
    expect(m.state.adoptWorkspace).not.toHaveBeenCalled();
  });

  it("adopts legacy transfers without an acknowledgement id", async () => {
    vi.useFakeTimers();
    await boot.handleAdopt({ ...payload(), transfer: transfer(), transferId: null });
    expect(m.invoke).not.toHaveBeenCalled();
    expect(m.state.adoptWorkspace).toHaveBeenCalledTimes(1);
  });

  it("reports an acknowledgement failure without adopting", async () => {
    m.invoke.mockRejectedValue(new Error("Ack failed"));
    await expect(boot.handleAdopt({ ...payload(), transfer: transfer() })).resolves.toBeUndefined();
    expect(m.state.adoptWorkspace).not.toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledWith("error", "windowBoot", "win://adopt from secondary-2 failed: Error: Ack failed");
  });

  it("restores only requested unknown workspaces and confirms the fold after hydration", async () => {
    m.state.workspaces = [{ ...workspace(), id: 8 }];
    const p = payload();
    p.slice.workspaces.push({ ...workspace(), id: 8 }, { ...workspace(), id: 9 });
    p.workspaceIds.push(8);
    await boot.handleAdopt(p);
    expect(m.parseUiPrefs).toHaveBeenCalledWith(p.slice.uiPrefs);
    expect(m.addRestoredUiPrefs).toHaveBeenCalledWith({ theme: "dark" });
    expect(m.hydrateFrom).toHaveBeenCalledWith([p.slice.workspaces[0]], 7, true);
    expect(m.pushToast).toHaveBeenCalledWith("info", "Window secondary-2 closed: Flightdeck moved back here");
    expect(m.invoke.mock.calls).toEqual([["main_adopt_done", { transferId: 42 }]]);
    expect(m.hydrateFrom.mock.invocationCallOrder[0]).toBeLessThan(m.invoke.mock.invocationCallOrder[0]);
  });

  it("ignores folds in a secondary", async () => {
    m.isMainWindow.mockReturnValue(false);
    await boot.handleAdopt(payload());
    expect(m.hydrateFrom).not.toHaveBeenCalled();
    expect(m.invoke).not.toHaveBeenCalled();
  });

  it("warns and confirms a fold with no slice", async () => {
    await boot.handleAdopt({ ...payload(), slice: null });
    expect(m.hydrateFrom).not.toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledWith("warn", "windowBoot", "win://adopt from secondary-2 carried no slice; its workspaces cannot be restored");
    expect(m.invoke).toHaveBeenCalledWith("main_adopt_done", { transferId: 42 });
  });

  it("confirms a duplicate fold without hydration", async () => {
    m.state.workspaces = [workspace()];
    await boot.handleAdopt(payload());
    expect(m.hydrateFrom).not.toHaveBeenCalled();
    expect(m.pushToast).not.toHaveBeenCalled();
    expect(m.invoke).toHaveBeenCalledWith("main_adopt_done", { transferId: 42 });
  });

  it("logs a failed fold hydration and still confirms it", async () => {
    m.hydrateFrom.mockRejectedValue(new Error("Hydration failed"));
    await boot.handleAdopt(payload());
    expect(m.pushToast).not.toHaveBeenCalled();
    expect(m.invoke).toHaveBeenCalledWith("main_adopt_done", { transferId: 42 });
    expect(m.logEvent).toHaveBeenCalledWith("error", "windowBoot", "win://adopt from secondary-2 failed: Error: Hydration failed");
  });

  it("tolerates a missing fold confirmation command", async () => {
    m.invoke.mockRejectedValue(new Error("Missing command"));
    await expect(boot.handleAdopt(payload())).resolves.toBeUndefined();
    expect(m.hydrateFrom).toHaveBeenCalledTimes(1);
    expect(m.logEvent).not.toHaveBeenCalled();
  });

  it("skips confirmation for folds without a transfer id", async () => {
    await boot.handleAdopt({ ...payload(), transferId: null });
    expect(m.hydrateFrom).toHaveBeenCalledTimes(1);
    expect(m.invoke).not.toHaveBeenCalled();
  });

  it("tolerates an unavailable adopt listener", async () => {
    m.listenHere.mockRejectedValue(new Error("Browser preview"));
    expect(boot.listenForAdopt()).toBeUndefined();
    await flush();
    expect(m.globalListen).not.toHaveBeenCalled();
  });
});

describe("pending folds", () => {
  it("replays main's pending folds through adoption", async () => {
    m.invoke.mockResolvedValueOnce([payload()]);
    await expect(boot.replayPendingAdopts()).resolves.toBeUndefined();
    expect(m.invoke.mock.calls).toEqual([["main_pending_adopts"], ["main_adopt_done", { transferId: 42 }]]);
    expect(m.hydrateFrom).toHaveBeenCalledWith(slice().workspaces, 7, true);
  });
  it("does not request pending folds in a secondary", async () => {
    m.isMainWindow.mockReturnValue(false);
    await boot.replayPendingAdopts();
    expect(m.invoke).not.toHaveBeenCalled();
  });
  it.each([null, []])("handles no pending folds (%#)", async (pending) => {
    m.invoke.mockResolvedValue(pending);
    await boot.replayPendingAdopts();
    expect(m.invoke.mock.calls).toEqual([["main_pending_adopts"]]);
    expect(m.hydrateFrom).not.toHaveBeenCalled();
  });
  it("tolerates an unavailable pending-fold command", async () => {
    m.invoke.mockRejectedValue(new Error("Unavailable"));
    await expect(boot.replayPendingAdopts()).resolves.toBeUndefined();
    expect(m.hydrateFrom).not.toHaveBeenCalled();
  });
});

describe("focus and scale listeners", () => {
  it.each([[7, 12, true, true], [7, 999, true, false], [999, 12, false, false]])(
    "selects only existing workspaces and panes (%s, %s)", (wsId, paneId, switches, focuses) => {
      m.state.workspaces = [workspace()];
      expect(boot.listenForFocusPane()).toBeUndefined();
      expect(m.listenHere).toHaveBeenCalledWith("app://focus-pane", expect.any(Function));
      m.listenHere.mock.calls[0][1]({ payload: { wsId, paneId } });
      expect(m.state.switchWorkspace.mock.calls).toEqual(switches ? [[7]] : []);
      expect(m.state.focusPane.mock.calls).toEqual(focuses ? [[7, 12]] : []);
      expect(m.globalListen).not.toHaveBeenCalled();
    },
  );
  it("tolerates an unavailable focus listener", async () => {
    m.listenHere.mockRejectedValue(new Error("Browser preview"));
    expect(boot.listenForFocusPane()).toBeUndefined();
    await flush();
  });
  it("remeasures attached terminals on this window's scale change", () => {
    expect(boot.listenForScaleChange()).toBeUndefined();
    expect(m.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(m.onScaleChanged).toHaveBeenCalledWith(expect.any(Function));
    expect(m.remeasureAttached).not.toHaveBeenCalled();
    m.onScaleChanged.mock.calls[0][0]({ payload: { scaleFactor: 2 } });
    expect(m.remeasureAttached).toHaveBeenCalledTimes(1);
  });
  it("tolerates missing window and rejected scale registration", async () => {
    m.getCurrentWindow.mockImplementationOnce(() => { throw new Error("No window"); });
    expect(boot.listenForScaleChange()).toBeUndefined();
    m.onScaleChanged.mockRejectedValue(new Error("Unavailable"));
    expect(boot.listenForScaleChange()).toBeUndefined();
    await flush();
    expect(m.remeasureAttached).not.toHaveBeenCalled();
  });
});

describe("settings and empty windows", () => {
  it.each([true, false])("pushes multiwindow setting %s", (enabled) => {
    expect(boot.pushMultiwindow(enabled)).toBeUndefined();
    expect(m.invoke.mock.calls).toEqual([["set_multiwindow", { enabled }]]);
  });
  it("tolerates a missing settings command", async () => {
    m.invoke.mockRejectedValue(new Error("Unavailable"));
    boot.pushMultiwindow(false);
    await flush();
    expect(m.logEvent).not.toHaveBeenCalled();
  });
  it("never closes or subscribes in main", () => {
    expect(boot.closeWhenEmpty()).toBeUndefined();
    expect(m.subscribe).not.toHaveBeenCalled();
    expect(m.invoke).not.toHaveBeenCalled();
  });
  it("closes an already empty secondary once", () => {
    m.isMainWindow.mockReturnValue(false);
    expect(boot.closeWhenEmpty()).toBeUndefined();
    expect(m.subscribe).toHaveBeenCalledWith(expect.any(Function));
    m.subscribe.mock.calls[0][0]();
    expect(m.invoke.mock.calls).toEqual([["window_close_self"]]);
  });
  it("waits for the store to empty and retries after a close failure", async () => {
    m.isMainWindow.mockReturnValue(false);
    m.state.workspaces = [workspace()];
    boot.closeWhenEmpty();
    expect(m.invoke).not.toHaveBeenCalled();
    const check = m.subscribe.mock.calls[0][0];
    m.invoke.mockRejectedValueOnce(new Error("Close failed"));
    m.state.workspaces = [];
    check();
    await flush();
    expect(m.logEvent).toHaveBeenCalledWith("warn", "windowBoot", "window_close_self failed: Error: Close failed");
    check(); check();
    expect(m.invoke.mock.calls).toEqual([["window_close_self"], ["window_close_self"]]);
  });
});

describe("window summaries and quit", () => {
  it("returns the backend window summaries unchanged", async () => {
    const rows = [{ label: "secondary-2", livePanes: 2, title: "Flightdeck", needsYou: 1, top: { wsId: 7, paneId: 12 }, workspaces: [{ id: 7, name: "Flightdeck", root: "D:/Dev/flightdeck", paneId: 12, livePanes: 2 }] }];
    m.invoke.mockResolvedValue(rows);
    await expect(boot.otherWindows()).resolves.toBe(rows);
    expect(m.invoke.mock.calls).toEqual([["window_summary"]]);
  });
  it.each([null, undefined, {}, "invalid", []])("returns an empty summary for absent or invalid rows (%#)", async (rows) => {
    m.invoke.mockResolvedValue(rows);
    await expect(boot.otherWindows()).resolves.toEqual([]);
    expect(m.invoke).toHaveBeenCalledWith("window_summary");
  });
  it("returns no summaries when the command fails", async () => {
    m.invoke.mockRejectedValue(new Error("Unavailable"));
    await expect(boot.otherWindows()).resolves.toEqual([]);
  });
  it("quits through Rust without destroying the current window directly", async () => {
    await expect(boot.quitApp()).resolves.toBeUndefined();
    expect(m.invoke.mock.calls).toEqual([["app_quit"]]);
    expect(m.destroy).not.toHaveBeenCalled();
  });
  it("falls back to destroying the current window", async () => {
    m.invoke.mockRejectedValue(new Error("Missing command"));
    await expect(boot.quitApp()).resolves.toBeUndefined();
    expect(m.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(m.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(["window", "destroy"])("tolerates failure in quit fallback %s", async (failure) => {
    m.invoke.mockRejectedValue(new Error("Missing command"));
    if (failure === "window") m.getCurrentWindow.mockImplementation(() => { throw new Error("Gone"); });
    else m.destroy.mockRejectedValue(new Error("Gone"));
    await expect(boot.quitApp()).resolves.toBeUndefined();
  });
});
