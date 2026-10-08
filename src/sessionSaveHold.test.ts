import { beforeEach, describe, expect, it, vi } from "vitest";

// Data-loss guard: before main has answered "Reopen last session?" its store is empty,
// and pushing that as main's slice (reload, quit, app://flush) wiped its saved workspaces.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const handlers: Record<string, () => void> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (ev: string, cb: () => void) => { handlers[ev] = cb; return () => {}; }),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
let session: typeof import("./session");
let useApp: typeof import("./store").useApp;
let useUI: typeof import("./ui").useUI;

const ws = { id: 1, name: "main-ws", root: "D:\\proj", panes: [] };
const doc = { version: 2, savedAt: 1, activeWorkspaceId: 1, workspaces: [ws], uiPrefs: {}, windows: [{ label: "main", workspaceIds: [1] }] };
const puts = () => mockInvoke.mock.calls.filter((c) => c[0] === "session_put_slice").map((c) => (c[1] as { slice: { workspaces: { id: number }[] } }).slice.workspaces.map((w) => w.id));
const settle = () => new Promise((r) => setTimeout(r, 0));

// Node test env: a tiny window/document with a listener registry stands in for the DOM.
const listeners: Record<string, (() => void)[]> = {};
const fire = (t: string) => (listeners[t] ?? []).forEach((l) => l());
const fakeTarget = () => ({ addEventListener: (t: string, l: () => void) => { (listeners[t] ??= []).push(l); } });

describe("main does not overwrite its saved workspaces before the restore answer", () => {
  beforeEach(async () => {
    // Each case needs a freshly held autosave (the hold is released by the first answer).
    vi.resetModules();
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.stubGlobal("window", fakeTarget());
    vi.stubGlobal("document", { ...fakeTarget(), visibilityState: "visible" });
    // The prompt path is under test: Settings > Startup "ask" (QRP9 made reopen the default).
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "flightdeck-startup" ? "launcher" : null), setItem: () => {} });
    session = await import("./session");
    ({ useApp } = await import("./store"));
    ({ useUI } = await import("./ui"));
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === "is_safe_mode" ? false : cmd === "load_session" ? doc : null));
    session.startAutosave();
    await settle();
  });

  it("beforeunload and app://flush with the prompt open push the saved slice, never an empty one", async () => {
    let done: boolean | null = null;
    void session.offerSessionRestore().then((v) => { done = v; });
    await settle();
    expect(useUI.getState().confirm?.title).toBe("Reopen last session?");
    fire("beforeunload");
    handlers["app://flush"]?.();
    await settle();
    const sent = puts();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((ids) => ids.length === 1 && ids[0] === 1)).toBe(true);
    useUI.getState().confirm!.onCancel!();
    await vi.waitFor(() => expect(done).toBe(false));
  });

  it("before the doc has loaded nothing is pushed at all", async () => {
    fire("beforeunload");
    handlers["app://flush"]?.();
    await settle();
    expect(puts()).toEqual([]);
  });

  it("after Reopen the real store is saved again", async () => {
    let done: boolean | null = null;
    void session.offerSessionRestore().then((v) => { done = v; });
    await settle();
    useUI.getState().confirm!.onConfirm();
    await vi.waitFor(() => expect(done).toBe(true));
    mockInvoke.mockClear();
    fire("beforeunload");
    await settle();
    expect(puts().slice(-1)[0]).toEqual([1]);
  });

  it("after Cancel the empty store is what main saves (Cancel discards)", async () => {
    let done: boolean | null = null;
    void session.offerSessionRestore().then((v) => { done = v; });
    await settle();
    useUI.getState().confirm!.onCancel!();
    await vi.waitFor(() => expect(done).toBe(false));
    expect(useApp.getState().workspaces).toEqual([]);
  });
});
