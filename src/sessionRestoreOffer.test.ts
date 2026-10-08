import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { offerSessionRestore, savedSecondaryWindows } = await import("./session");
const { useApp } = await import("./store");
const { useUI } = await import("./ui");
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const ws = { id: 1, name: "main-ws", root: "D:\\proj", panes: [] };
const withSecondary = (workspaces: unknown[]) => ({
  version: 2, savedAt: 1, activeWorkspaceId: 1, workspaces, uiPrefs: {},
  windows: [{ label: "main", workspaceIds: workspaces.map((w) => (w as { id: number }).id) }, { label: "fw-1", workspaceIds: [(1 << 24) + 1] }],
});

function serve(doc: unknown) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "is_safe_mode") return false;
    if (cmd === "load_session") return doc;
    return null;
  });
}
const calls = (cmd: string) => mockInvoke.mock.calls.filter((c) => c[0] === cmd).length;
let store: Record<string, string> = {};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("offerSessionRestore decides whether secondary windows may be recreated", () => {
  beforeEach(() => {
    useApp.setState({ workspaces: [], activeId: null, creating: false });
    useUI.setState({ confirm: null });
    // These cases are about the prompt, so pin Settings > Startup to "ask" (QRP9 made reopen the default).
    store = { "flightdeck-startup": "launcher" };
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    mockInvoke.mockReset();
  });

  it("counts only populated secondaries, and none with the flag off", () => {
    const d = withSecondary([ws]);
    expect(savedSecondaryWindows(d, true)).toBe(1);
    expect(savedSecondaryWindows(d, false)).toBe(0);
    expect(savedSecondaryWindows({ windows: [{ label: "fw-2", workspaceIds: [] }] }, true)).toBe(0);
  });

  it("holds the answer until the user clicks; Cancel discards the secondaries and resolves false", async () => {
    serve(withSecondary([ws]));
    let done: boolean | null = null;
    void offerSessionRestore().then((v) => { done = v; });
    await settle();
    expect(useUI.getState().confirm?.title).toBe("Reopen last session?");
    expect(done).toBeNull();
    expect(calls("discard_pending_restores")).toBe(0);
    useUI.getState().confirm!.onCancel!();
    await settle();
    expect(done).toBe(false);
    expect(calls("discard_pending_restores")).toBe(1);
    expect(calls("pty_reap_unclaimed")).toBe(1);
  });

  it("Reopen hydrates main first, then resolves true without discarding", async () => {
    serve(withSecondary([ws]));
    let done: boolean | null = null;
    void offerSessionRestore().then((v) => { done = v; });
    await settle();
    useUI.getState().confirm!.onConfirm();
    await vi.waitFor(() => expect(done).toBe(true));
    expect(useApp.getState().workspaces.map((w) => w.id)).toEqual([1]);
    expect(calls("discard_pending_restores")).toBe(0);
  });

  it("still asks when main holds no workspace but a secondary does", async () => {
    serve(withSecondary([]));
    let done: boolean | null = null;
    void offerSessionRestore().then((v) => { done = v; });
    await settle();
    expect(useUI.getState().confirm?.body).toContain("1 other window");
    expect(done).toBeNull();
    useUI.getState().confirm!.onCancel!();
    await settle();
    expect(done).toBe(false);
  });

  it("flag off and no workspaces in the doc: no prompt, nothing to hold back", async () => {
    store["flightdeck-multiwindow"] = "0";
    serve(withSecondary([]));
    expect(await offerSessionRestore()).toBe(true);
    expect(useUI.getState().confirm).toBeNull();
  });

  it("startup set to reopen: no prompt, secondaries restore after main's hydrate", async () => {
    store["flightdeck-startup"] = "reopen";
    serve(withSecondary([ws]));
    expect(await offerSessionRestore()).toBe(true);
    expect(useUI.getState().confirm).toBeNull();
    expect(useApp.getState().workspaces.map((w) => w.id)).toEqual([1]);
  });
});
