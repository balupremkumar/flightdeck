import { beforeEach, describe, expect, it } from "vitest";
import { paneHasUnsentInput, registerPaneSend, sendToPane, unregisterPaneSend, useApp } from "./store";

// The store is a singleton; reset the observable slice before each test.
// (wseq/pseq/gseq id counters are module-level and keep incrementing — tests
// only assert on relative behaviour, never on specific id values.)
const reset = () =>
  useApp.setState({ workspaces: [], activeId: null, creating: false, selectedPaneIds: [], groups: [] });

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

  it("movePaneToWorkspace: moves the pane whole, keeping its identity", () => {
    useApp.getState().createWorkspace("/a", [
      { vendor: "claude", cwd: "/wt/a", worktreePath: "/wt/a", branch: "flightdeck/a", baseBranch: "main" },
      { vendor: "agy", cwd: "/a" },
    ]);
    useApp.getState().createWorkspace("/b", [{ vendor: "claude", cwd: "/b" }]);
    const [wsA, wsB] = useApp.getState().workspaces;
    const moving = wsA.panes[0];

    useApp.getState().movePaneToWorkspace(wsA.id, moving.id, wsB.id);
    const [a, b] = useApp.getState().workspaces;

    expect(a.panes.map((p) => p.id)).not.toContain(moving.id);
    expect(b.panes.map((p) => p.id)).toContain(moving.id);
    // The pane must arrive intact — same id, same worktree. A move that
    // recreated it would strand the worktree and kill the running PTY.
    const arrived = b.panes.find((p) => p.id === moving.id)!;
    expect(arrived.worktreePath).toBe("/wt/a");
    expect(arrived.branch).toBe("flightdeck/a");
    expect(b.focused).toBe(moving.id);
  });

  it("movePaneToWorkspace: hands focus on when the moved pane held it", () => {
    useApp.getState().createWorkspace("/a", [
      { vendor: "claude", cwd: "/a" },
      { vendor: "agy", cwd: "/a" },
    ]);
    useApp.getState().createWorkspace("/b", [{ vendor: "claude", cwd: "/b" }]);
    const [wsA, wsB] = useApp.getState().workspaces;
    const focused = wsA.focused!;
    useApp.getState().movePaneToWorkspace(wsA.id, focused, wsB.id);
    const a = useApp.getState().workspaces[0];
    expect(a.focused).not.toBe(focused);
    expect(a.panes.some((p) => p.id === a.focused)).toBe(true);
  });

  it("movePaneToWorkspace: ignores a move to the same workspace or an unknown pane", () => {
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }]);
    const ws = useApp.getState().workspaces[0];
    const before = JSON.stringify(useApp.getState().workspaces);
    useApp.getState().movePaneToWorkspace(ws.id, ws.panes[0].id, ws.id);
    useApp.getState().movePaneToWorkspace(ws.id, 99999, ws.id);
    expect(JSON.stringify(useApp.getState().workspaces)).toBe(before);
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

  it("setPaneDraft: records an unsent line, and blank clears it (UX-581/582)", () => {
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }]);
    const pane = useApp.getState().workspaces[0].panes[0];
    expect(paneHasUnsentInput(pane)).toBe(false);

    useApp.getState().setPaneDraft(pane.id, "still typing this out");
    const withDraft = useApp.getState().workspaces[0].panes[0];
    expect(withDraft.draft).toBe("still typing this out");
    expect(paneHasUnsentInput(withDraft)).toBe(true);

    useApp.getState().setPaneDraft(pane.id, "");
    const cleared = useApp.getState().workspaces[0].panes[0];
    expect(cleared.draft).toBeUndefined();
    expect(paneHasUnsentInput(cleared)).toBe(false);
  });

  it("paneHasUnsentInput: whitespace-only draft doesn't count as unsent input", () => {
    expect(paneHasUnsentInput({ draft: "   " })).toBe(false);
    expect(paneHasUnsentInput({ draft: undefined })).toBe(false);
    expect(paneHasUnsentInput({ draft: "x" })).toBe(true);
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

describe("UX-553 pane selection", () => {
  beforeEach(reset);

  it("togglePaneSelection: adds then removes on repeat toggles", () => {
    useApp.getState().togglePaneSelection(1);
    useApp.getState().togglePaneSelection(2);
    expect(useApp.getState().selectedPaneIds).toEqual([1, 2]);
    useApp.getState().togglePaneSelection(1);
    expect(useApp.getState().selectedPaneIds).toEqual([2]);
  });

  it("clearSelection empties it; setSelection replaces it wholesale", () => {
    useApp.getState().setSelection([3, 4, 5]);
    expect(useApp.getState().selectedPaneIds).toEqual([3, 4, 5]);
    useApp.getState().clearSelection();
    expect(useApp.getState().selectedPaneIds).toEqual([]);
  });

  it("switchWorkspace clears a stale cross-workspace selection", () => {
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }]);
    useApp.getState().setSelection([1, 2]);
    useApp.getState().switchWorkspace(useApp.getState().workspaces[0].id);
    expect(useApp.getState().selectedPaneIds).toEqual([]);
  });

  it("closePane and closeWorkspace prune the closed pane out of selection and groups", () => {
    useApp.getState().createWorkspace("/a", [{ vendor: "claude", cwd: "/a" }, { vendor: "pwsh", cwd: "/a" }]);
    const ws = useApp.getState().workspaces[0];
    const [p1, p2] = ws.panes;
    useApp.getState().setSelection([p1.id, p2.id]);
    useApp.getState().createGroup("g", [p1.id, p2.id]);
    useApp.getState().closePane(ws.id, p1.id);
    expect(useApp.getState().selectedPaneIds).toEqual([p2.id]);
    expect(useApp.getState().groups[0].paneIds).toEqual([p2.id]);
    useApp.getState().closeWorkspace(ws.id);
    expect(useApp.getState().selectedPaneIds).toEqual([]);
    expect(useApp.getState().groups[0].paneIds).toEqual([]);
  });
});

describe("UX-554 pane groups", () => {
  beforeEach(reset);

  it("createGroup/renameGroup/deleteGroup", () => {
    const id = useApp.getState().createGroup("  Reviewers  ", [1, 2]);
    expect(useApp.getState().groups).toEqual([{ id, name: "Reviewers", paneIds: [1, 2] }]);
    useApp.getState().renameGroup(id, "Backend");
    expect(useApp.getState().groups[0].name).toBe("Backend");
    useApp.getState().deleteGroup(id);
    expect(useApp.getState().groups).toEqual([]);
  });

  it("hydrateGroups bumps the id counter past restored groups", () => {
    useApp.getState().hydrateGroups([{ id: 500, name: "old", paneIds: [1] }]);
    const id = useApp.getState().createGroup("new", []);
    expect(id).toBeGreaterThan(500);
  });
});

describe("UX-564 duplicatePane", () => {
  beforeEach(reset);

  it("adds a new pane with the same cwd/vendor/worktree identity, focuses it", () => {
    useApp.getState().createWorkspace("/repo", [
      { vendor: "claude", cwd: "/repo/wt/a", worktreePath: "/repo/wt/a", branch: "flightdeck/a", baseBranch: "main" },
    ]);
    const ws = useApp.getState().workspaces[0];
    const src = ws.panes[0];
    useApp.getState().duplicatePane(ws.id, src.id);
    const panes = useApp.getState().workspaces[0].panes;
    expect(panes).toHaveLength(2);
    const dup = panes[1];
    expect(dup.id).not.toBe(src.id);
    expect(dup.vendor).toBe(src.vendor);
    expect(dup.cwd).toBe(src.cwd);
    expect(dup.worktreePath).toBe(src.worktreePath);
    expect(dup.branch).toBe(src.branch);
    expect(dup.state).toBe("starting");
    expect(useApp.getState().workspaces[0].focused).toBe(dup.id);
  });

  it("is a no-op if the source pane is gone", () => {
    useApp.getState().createWorkspace("/repo", [{ vendor: "claude", cwd: "/repo" }]);
    const ws = useApp.getState().workspaces[0];
    useApp.getState().duplicatePane(ws.id, 999999);
    expect(useApp.getState().workspaces[0].panes).toHaveLength(1);
  });
});

describe("UX-553/554 pane send registry", () => {
  it("sendToPane calls the registered callback and reports reachability", () => {
    const calls: string[] = [];
    registerPaneSend(1, (t) => calls.push(t));
    expect(sendToPane(1, "hello")).toBe(true);
    expect(calls).toEqual(["hello"]);
    unregisterPaneSend(1);
    expect(sendToPane(1, "again")).toBe(false);
  });
});
