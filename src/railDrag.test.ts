import { describe, expect, it, vi } from "vitest";
import { canTearOut, idleRailDrag, pointerDragEnabled, stepRailDrag, type RailDragEvent } from "./railDrag";

const payload = { kind: "workspace" as const, id: 7, tearable: true, name: "Acme", tint: "#123456", panes: 2 };
const press = () => stepRailDrag(idleRailDrag(), { type: "press", x: 10, y: 10, payload }).state;
const move = (inside = true): RailDragEvent => ({ type: "move", x: 15, y: 10, inside, over: 8, reorder: true });
describe("rail pointer drag", () => {
  it("leaves selection to the click below the 5 px threshold", () => {
    let state = stepRailDrag(press(), { ...move(), x: 14 } as RailDragEvent).state;
    expect(state.dragging).toBe(false);
    const released = stepRailDrag(state, { type: "release", inside: true });
    expect(released.actions).toEqual([]);
    state = released.state;
    expect(state.suppressClick).toBe(false);
  });
  it("reorders on release and suppresses the following click once", () => {
    const dragging = stepRailDrag(press(), move()).state;
    const released = stepRailDrag(dragging, { type: "release", inside: true });
    expect(released.actions).toEqual([{ type: "reorder", id: 7, over: 8 }]);
    expect(released.state.suppressClick).toBe(true);
    expect(stepRailDrag(released.state, { type: "click" }).state.suppressClick).toBe(false);
  });
  it("arms once with the contract payload, including across re-entry", () => {
    const first = stepRailDrag(press(), move(false));
    expect(first.actions).toEqual([{ type: "arm", payload }]);
    const returned = stepRailDrag(first.state, move()).state;
    expect(stepRailDrag(returned, move(false)).actions).toEqual([]);
  });
  it("Escape cancels, clears drag state and keeps click suppression", () => {
    const result = stepRailDrag(stepRailDrag(press(), move(false)).state, { type: "escape" });
    expect(result.actions).toEqual([{ type: "cancel" }]);
    expect(result.state.dragging).toBe(false);
    expect(result.state.suppressClick).toBe(true);
  });
  it("disarms on release inside after arming without reordering", () => {
    const result = stepRailDrag(stepRailDrag(press(), move(false)).state, { type: "release", inside: true });
    expect(result.actions).toEqual([{ type: "disarm" }]);
  });
  it("leaves release outside to Rust and ends on its end event", () => {
    const state = stepRailDrag(press(), move(false)).state;
    expect(stepRailDrag(state, { type: "release", inside: false })).toEqual({ state, actions: [] });
    expect(stepRailDrag(state, { type: "end" }).state.payload).toBeNull();
  });
  it("sort-by-last disables reorder while still allowing tear-out", () => {
    const state = stepRailDrag(press(), { ...move(), reorder: false } as RailDragEvent).state;
    expect(state.over).toBeNull();
    expect(stepRailDrag(state, move(false)).actions[0].type).toBe("arm");
  });
  it("refuses with one toast action and allows main's only workspace", () => {
    expect(canTearOut(1)).toBe(true);
    const state = stepRailDrag(press(), move(false)).state;
    const refused = stepRailDrag(state, { type: "state", phase: "refused" });
    expect(refused.actions).toEqual([{ type: "refused" }]);
    expect(stepRailDrag(refused.state, { type: "state", phase: "refused" }).actions).toEqual([]);
  });
});

// Render the actual rail in node, with its unrelated application services stubbed.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => {},
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("./PaneView", () => ({ PANE_DRAG_TYPE: "pane-test" }));
vi.mock("./poll", () => ({ usePoll: () => {}, cachedInvoke: vi.fn() }));
const selection = vi.hoisted(() => vi.fn());
vi.mock("./store", () => ({ useApp: Object.assign((select: (s: unknown) => unknown) => select({
  workspaces: [{ id: 7, name: "Acme", root: "D:/repo", panes: [] }], activeId: 7,
  switchWorkspace: selection, focusPane: vi.fn(), startCreate: vi.fn(), createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(), reorderWorkspaces: vi.fn(), movePaneToWorkspace: vi.fn(),
}), { getState: () => ({ workspaces: [] }) }) }));
vi.mock("./ui", () => ({ useUI: (select: (s: unknown) => unknown) => select({ snoozed: {}, pushToast: vi.fn(), requestConfirm: vi.fn() }), useOverlayEsc: vi.fn() }));
vi.mock("./worktrees", () => ({ closeWorkspaceWithCleanup: vi.fn(), preparePanes: vi.fn(), isolationPref: vi.fn(), rememberedOrSuggestedSetup: vi.fn() }));
vi.mock("./windowMove", () => ({ listenWorkspaceDrag: vi.fn() }));
vi.mock("./paneSessions", () => ({ get: vi.fn() }));

describe("HTML5 tile fallback", () => {
  it("defaults window drag on and honours an explicit zero", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null });
    const { getWindowDrag } = await import("./settingsStore");
    expect(getWindowDrag()).toBe(true);
    values.set("flightdeck-window-drag", "0");
    expect(getWindowDrag()).toBe(false);
    vi.unstubAllGlobals();
  });
  it.each([[false, true], [true, false], [false, false], [true, true]])("multiwindow=%s, windowDrag=%s", async (multiwindow, windowDrag) => {
    const values = new Map([["flightdeck-multiwindow", multiwindow ? "1" : "0"], ["flightdeck-window-drag", windowDrag ? "1" : "0"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { LeftPanel } = await import("./LeftPanel");
    const html = renderToStaticMarkup(createElement(LeftPanel, { expanded: true }));
    expect(html).toContain(`draggable="${!pointerDragEnabled(multiwindow, windowDrag)}"`);
    if (!pointerDragEnabled(multiwindow, windowDrag)) {
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockClear();
      const row = LeftPanel({ expanded: true }).props.children[2].props.children[1][0];
      const setPointerCapture = vi.fn();
      row.props.onPointerDown({ button: 0, isPrimary: true, currentTarget: { setPointerCapture } });
      expect(setPointerCapture).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      const dataTransfer = { effectAllowed: "copy" };
      row.props.onDragStart({ dataTransfer });
      expect(dataTransfer.effectAllowed).toBe("move");
    }
    vi.unstubAllGlobals();
  });
  it("wires pointer exit, re-entry and release to the mocked Rust commands", async () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "flightdeck-multiwindow" ? "1" : null });
    vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
    vi.stubGlobal("document", { elementFromPoint: () => null });
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    const { LeftPanel } = await import("./LeftPanel");
    const { useOverlayEsc } = await import("./ui");
    vi.mocked(useOverlayEsc).mockClear();
    selection.mockClear();
    const tree = LeftPanel({ expanded: true });
    // The real expanded list's first workspace row.
    const row = tree.props.children[2].props.children[1][0];
    const element = { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
    const event = (x: number) => ({ button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: 10, currentTarget: element, target: { closest: () => null }, preventDefault: vi.fn() });
    row.props.onPointerDown(event(10));
    row.props.onPointerMove(event(14));
    expect(invoke).not.toHaveBeenCalled();
    row.props.onPointerUp(event(14));
    row.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(selection).toHaveBeenCalledWith(7);
    row.props.onPointerDown(event(10));
    row.props.onPointerMove(event(801));
    row.props.onPointerMove(event(20));
    row.props.onPointerMove(event(801));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("drag_arm", { kind: "workspace", id: 7, tearable: true, name: "Acme", tint: expect.any(String), panes: 0 });
    row.props.onPointerUp(event(20));
    expect(invoke).toHaveBeenLastCalledWith("drag_disarm", undefined);
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    row.props.onClick(click);
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(selection).toHaveBeenCalledTimes(1);
    row.props.onPointerDown(event(10));
    row.props.onPointerMove(event(801));
    const cancel = vi.mocked(useOverlayEsc).mock.calls.find((call) => call[2]?.restoreFocus === false)![1];
    cancel();
    expect(invoke).toHaveBeenLastCalledWith("drag_cancel", undefined);
    vi.unstubAllGlobals();
  });
});
