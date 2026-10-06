import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { invoke } = await import("@tauri-apps/api/core");
const { hydrateFrom, addRestoredUiPrefs, parseUiPrefs, setRestoredPaneChat, setRestoredPaneColor, setRestoredScrollback, restoredScrollbackFor, PANE_VIEW_REV } = await import("./session");
const { otherWindows } = await import("./windowBoot");
const { useApp } = await import("./store");
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const ws = (id: number, pane: number) => ({ id, name: `w${id}`, root: "D:\\p", panes: [{ id: pane, vendor: "claude", cwd: "D:\\p" }] });

describe("Phase 4 close: a closed or crashed window's pane prefs survive the merge into main", () => {
  beforeEach(() => {
    useApp.setState({ workspaces: [], activeId: null, creating: false });
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(null);
    setRestoredPaneChat({});
    setRestoredPaneColor({});
    setRestoredScrollback({});
  });

  it("adds the dead window's view, colour and scrollback without replacing main's staged prefs", async () => {
    setRestoredPaneChat({ 10: { view: "chat" } });
    setRestoredPaneColor({ 10: "red" });
    setRestoredScrollback({ 10: "main-screen" });
    const dead = parseUiPrefs({
      scrollback: { 20: "fw-screen" },
      paneViewRev: PANE_VIEW_REV,
      paneChat: { 20: { view: "chat", focusMode: true } },
      paneColor: { 20: "blue" },
    });
    addRestoredUiPrefs(dead);
    expect(restoredScrollbackFor(10)).toBe("main-screen");
    expect(restoredScrollbackFor(20)).toBe("fw-screen");

    await hydrateFrom([ws(1, 10)], 1);
    await hydrateFrom([ws(2, 20)], 2, true);
    const panes = useApp.getState().workspaces.flatMap((w) => w.panes);
    const p10 = panes.find((p) => p.id === 10)!;
    const p20 = panes.find((p) => p.id === 20)!;
    expect(p10.view).toBe("chat");
    expect(p10.color).toBe("red");
    expect(p20.view).toBe("chat");
    expect(p20.focusMode).toBe(true);
    expect(p20.color).toBe("blue");
  });

  it("a slice without prefs adds nothing", () => {
    setRestoredPaneColor({ 10: "red" });
    addRestoredUiPrefs(parseUiPrefs(undefined));
    expect(useApp.getState().workspaces).toEqual([]);
  });
});

describe("quit guard helpers", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("otherWindows is empty when the command is missing or fails", async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === "window_summary" ? Promise.reject(new Error("no such command")) : Promise.resolve(null)));
    expect(await otherWindows()).toEqual([]);
  });

  it("otherWindows passes Rust's summary through", async () => {
    mockInvoke.mockResolvedValue([{ label: "fw-1", livePanes: 2 }]);
    expect(await otherWindows()).toEqual([{ label: "fw-1", livePanes: 2 }]);
    expect(mockInvoke).toHaveBeenCalledWith("window_summary");
  });
});
