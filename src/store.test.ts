import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "./store";

// The store is a singleton; reset the observable slice before each test.
// (wseq/pseq id counters are module-level and keep incrementing — tests only
// assert on relative behaviour, never on specific id values.)
const reset = () => useApp.setState({ workspaces: [], activeId: null, creating: false });

describe("app store", () => {
  beforeEach(reset);

  it("createWorkspace: adds it, names it from the folder, focuses pane 1, closes the dialog", () => {
    useApp.getState().startCreate();
    useApp.getState().createWorkspace("D:\\Dev\\ai\\Harness", [
      { vendor: "claude", cwd: "D:\\Dev\\ai\\Harness" },
      { vendor: "agy", cwd: "D:\\Dev\\ai\\Harness" },
    ]);
    const s = useApp.getState();
    expect(s.workspaces).toHaveLength(1);
    const ws = s.workspaces[0];
    expect(ws.name).toBe("Harness");
    expect(ws.panes).toHaveLength(2);
    expect(ws.panes.every((p) => p.state === "starting")).toBe(true);
    expect(ws.focused).toBe(ws.panes[0].id);
    expect(s.activeId).toBe(ws.id);
    expect(s.creating).toBe(false);
  });

  it("needsSetup: only set when the workspace has a setup command, cleared once consumed", () => {
    useApp.getState().createWorkspace("/tmp/proj", [
      { vendor: "claude", cwd: "/tmp/wt/a", worktreePath: "/tmp/wt/a", branch: "flightdeck/a", baseBranch: "main", needsSetup: true },
      { vendor: "agy", cwd: "/tmp/wt/b", worktreePath: "/tmp/wt/b", branch: "flightdeck/b", baseBranch: "main", needsSetup: false },
    ], "npm ci");
    const ws = useApp.getState().workspaces[0];
    expect(ws.setupCmd).toBe("npm ci");
    expect(ws.panes[0].needsSetup).toBe(true);
    expect(ws.panes[1].needsSetup).toBeUndefined(); // reused worktree — no setup
    useApp.getState().clearNeedsSetup(ws.panes[0].id);
    expect(useApp.getState().workspaces[0].panes[0].needsSetup).toBeUndefined();

    // No setup command -> fresh worktrees still skip setup.
    useApp.getState().createWorkspace("/tmp/other", [
      { vendor: "claude", cwd: "/tmp/wt/c", needsSetup: true },
    ]);
    const ws2 = useApp.getState().workspaces[1];
    expect(ws2.setupCmd).toBeUndefined();
    expect(ws2.panes[0].needsSetup).toBeUndefined();
  });

  it("addPane: appends to the target workspace and focuses the new pane", () => {
    useApp.getState().createWorkspace("/tmp/proj", [{ vendor: "claude", cwd: "/tmp/proj" }]);
    const wsId = useApp.getState().workspaces[0].id;
    useApp.getState().addPane(wsId, "agy", "/tmp/proj/sub");
    const ws = useApp.getState().workspaces[0];
    expect(ws.panes).toHaveLength(2);
    expect(ws.panes[1].vendor).toBe("agy");
    expect(ws.focused).toBe(ws.panes[1].id);
  });

  it("closePane: removes the pane and clears focus when the focused pane is closed", () => {
    useApp.getState().createWorkspace("/tmp/proj", [
      { vendor: "claude", cwd: "/tmp/proj" },
      { vendor: "agy", cwd: "/tmp/proj" },
    ]);
    const ws0 = useApp.getState().workspaces[0];
    const focusedId = ws0.focused!;
    useApp.getState().closePane(ws0.id, focusedId);
    const ws = useApp.getState().workspaces[0];
    expect(ws.panes.find((p) => p.id === focusedId)).toBeUndefined();
    expect(ws.panes).toHaveLength(1);
    expect(ws.focused).toBeNull();
  });

  it("focusPane: sets the focused pane", () => {
    useApp.getState().createWorkspace("/tmp/proj", [
      { vendor: "claude", cwd: "/tmp/proj" },
      { vendor: "agy", cwd: "/tmp/proj" },
    ]);
    const ws0 = useApp.getState().workspaces[0];
    const second = ws0.panes[1].id;
    useApp.getState().focusPane(ws0.id, second);
    expect(useApp.getState().workspaces[0].focused).toBe(second);
  });

  it("setPaneState: updates the matching pane and leaves other panes untouched", () => {
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }]);
    useApp.getState().createWorkspace("/b", [{ vendor: "agy", cwd: "/b" }]);
    const targetPane = useApp.getState().workspaces[1].panes[0].id;
    useApp.getState().setPaneState(targetPane, "waiting");
    expect(useApp.getState().workspaces[1].panes[0].state).toBe("waiting");
    expect(useApp.getState().workspaces[0].panes[0].state).toBe("starting");
  });

  it("switchWorkspace: changes the active workspace", () => {
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }]);
    const firstId = useApp.getState().workspaces[0].id;
    useApp.getState().createWorkspace("/b", [{ vendor: "agy", cwd: "/b" }]);
    useApp.getState().switchWorkspace(firstId);
    expect(useApp.getState().activeId).toBe(firstId);
  });

  it("closeWorkspace: removes it and reassigns active to the last remaining", () => {
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }]);
    useApp.getState().createWorkspace("/b", [{ vendor: "agy", cwd: "/b" }]);
    const [a, b] = useApp.getState().workspaces;
    useApp.getState().switchWorkspace(b.id);
    useApp.getState().closeWorkspace(b.id);
    const s = useApp.getState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].id).toBe(a.id);
    expect(s.activeId).toBe(a.id);
  });

  it("closeWorkspace: active becomes null when the last workspace is removed", () => {
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }]);
    const id = useApp.getState().workspaces[0].id;
    useApp.getState().closeWorkspace(id);
    expect(useApp.getState().workspaces).toHaveLength(0);
    expect(useApp.getState().activeId).toBeNull();
  });

  it("cancelCreate: guarded — stays open with zero workspaces, closes once one exists", () => {
    useApp.getState().startCreate();
    useApp.getState().cancelCreate();
    expect(useApp.getState().creating).toBe(true); // can't cancel into an empty cockpit
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }]);
    useApp.getState().startCreate();
    useApp.getState().cancelCreate();
    expect(useApp.getState().creating).toBe(false);
  });
});

describe("hydrate (session restore)", () => {
  beforeEach(reset);

  it("replaces state and bumps id counters past restored ids", () => {
    useApp.getState().hydrate(
      [
        {
          id: 900, name: "restored", root: "D:\\proj",
          panes: [
            { id: 9000, vendor: "claude", cwd: "D:\\wt\\a", state: "starting", epoch: 0, worktreePath: "D:\\wt\\a", branch: "flightdeck/a", baseBranch: "main" },
            { id: 9001, vendor: "pwsh", cwd: "D:\\proj", state: "starting", epoch: 0 },
          ],
          focused: 9000,
        },
      ],
      900
    );
    const s = useApp.getState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.activeId).toBe(900);
    expect(s.workspaces[0].panes[0].branch).toBe("flightdeck/a");
    // New panes must not collide with restored ids:
    useApp.getState().addPane(900, "claude", "D:\\proj");
    const ids = useApp.getState().workspaces[0].panes.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBeGreaterThan(9001);
  });

  it("falls back to the last workspace when the persisted activeId is gone", () => {
    useApp.getState().hydrate(
      [
        { id: 20, name: "a", root: "D:\\a", panes: [], focused: null },
        { id: 21, name: "b", root: "D:\\b", panes: [], focused: null },
      ],
      999
    );
    expect(useApp.getState().activeId).toBe(21);
  });
});
