import { describe, expect, it, vi } from "vitest";

// Phase 4: pane/workspace/group ids are (window ordinal << 24) | local. Each
// simulated JS context is a fresh copy of the store module.
async function context(ordinal: number) {
  vi.resetModules();
  const m = await import("./store");
  m.setWindowOrdinal(ordinal);
  return m;
}

const SPAN = 2 ** 24;

function mint(m: Awaited<ReturnType<typeof context>>, n: number) {
  m.useApp.setState({ workspaces: [], activeId: null, groups: [] });
  for (let i = 0; i < n; i++) m.useApp.getState().createWorkspace(`D:\\r${i}`, [{ vendor: "claude", cwd: `D:\\r${i}` }]);
  const ws = m.useApp.getState().workspaces;
  return { wsIds: ws.map((w) => w.id), paneIds: ws.flatMap((w) => w.panes.map((p) => p.id)) };
}

describe("window id partition", () => {
  it("main (ordinal 0) mints the same small ids as before", async () => {
    const main = await context(0);
    const { wsIds, paneIds } = mint(main, 2);
    expect(wsIds).toEqual([1, 2]);
    expect(paneIds).toEqual([1, 2]);
  });

  it("two contexts never collide", async () => {
    const main = await context(0);
    const a = mint(main, 3);
    const fw = await context(1);
    const b = mint(fw, 3);
    const all = [...a.wsIds, ...a.paneIds, ...b.wsIds, ...b.paneIds];
    expect(b.wsIds.every((id) => Math.floor(id / SPAN) === 1)).toBe(true);
    expect(b.paneIds.every((id) => Math.floor(id / SPAN) === 1)).toBe(true);
    expect(new Set(a.wsIds.concat(b.wsIds)).size).toBe(6);
    expect(new Set(a.paneIds.concat(b.paneIds)).size).toBe(6);
    expect(all.every((id) => Number.isSafeInteger(id) && id < 2 ** 31)).toBe(true);
  });

  it("hydrate keeps the max LOCAL id and ignores another window's partition", async () => {
    const main = await context(0);
    const pane = (id: number) => ({ id, vendor: "claude", cwd: "D:\\x", state: "idle" as const, epoch: 0 });
    // main restores its own ws 5 / pane 9 plus an adopted workspace from window 1.
    main.useApp.getState().hydrate(
      [
        { id: 5, name: "a", root: "D:\\a", panes: [pane(9)], focused: 9 },
        { id: SPAN + 40, name: "b", root: "D:\\b", panes: [pane(SPAN + 77)], focused: SPAN + 77 },
      ],
      5,
    );
    main.useApp.getState().createWorkspace("D:\\n", [{ vendor: "claude", cwd: "D:\\n" }]);
    const made = main.useApp.getState().workspaces.slice(-1)[0];
    expect(made.id).toBe(6);
    expect(made.panes[0].id).toBe(10);
  });

  it("a secondary hydrating its slice continues after its own max, not main's ids", async () => {
    const fw = await context(2);
    const pane = (id: number) => ({ id, vendor: "claude", cwd: "D:\\x", state: "idle" as const, epoch: 0 });
    fw.useApp.getState().hydrate(
      [{ id: 2 * SPAN + 3, name: "a", root: "D:\\a", panes: [pane(2 * SPAN + 8), pane(11)], focused: null }],
      null,
    );
    fw.useApp.getState().createWorkspace("D:\\n", [{ vendor: "claude", cwd: "D:\\n" }]);
    const made = fw.useApp.getState().workspaces.slice(-1)[0];
    expect(made.id).toBe(2 * SPAN + 4);
    expect(made.panes[0].id).toBe(2 * SPAN + 9);
  });

  it("RT-H1: an id floor from window_boot keeps main off ids a secondary still holds", async () => {
    const main = await context(0);
    // Main's view of the doc holds only ws 1 (panes 1-4); fw-1 holds ws 2 with panes 5-6.
    // Rust computes the floor from the full doc (6) and hands it over with the ordinal.
    main.setWindowOrdinal(0, 6);
    const pane = (id: number) => ({ id, vendor: "claude", cwd: "D:\\x", state: "idle" as const, epoch: 0 });
    main.useApp.getState().hydrate([{ id: 1, name: "a", root: "D:\\a", panes: [1, 2, 3, 4].map(pane), focused: 1 }], 1);
    main.useApp.getState().addPane(1, "claude", "D:\\a");
    const added = main.useApp.getState().workspaces[0].panes.slice(-1)[0];
    expect(added.id).toBe(7);
    main.useApp.getState().createWorkspace("D:\\n", [{ vendor: "claude", cwd: "D:\\n" }]);
    const made = main.useApp.getState().workspaces.slice(-1)[0];
    expect(made.id).toBe(7);
  });

  it("RT-H1: a floor from another partition is ignored", async () => {
    const fw = await context(1);
    fw.setWindowOrdinal(1, 9);
    fw.useApp.getState().createWorkspace("D:\\n", [{ vendor: "claude", cwd: "D:\\n" }]);
    expect(fw.useApp.getState().workspaces[0].panes[0].id).toBe(SPAN + 1);
  });
});
