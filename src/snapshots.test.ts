import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Workspace } from "./store";

// Runs in node, no localStorage — same minimal stub quickopen.test.ts uses.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const {
  serializeWorkspaceExport, parseWorkspaceDef,
  listSnapshots, saveSnapshot, deleteSnapshot, renameSnapshot, defPanesToNewPanes,
} = await import("./snapshots");

function ws(): Workspace {
  return {
    id: 1,
    name: "flightdeck",
    root: "D:\\repo",
    setupCmd: "npm ci",
    focused: 10,
    panes: [
      { id: 10, vendor: "claude", cwd: "D:\\repo\\wt\\a", state: "running", epoch: 0, worktreePath: "D:\\repo\\wt\\a", branch: "flightdeck/a", baseBranch: "main", title: "feature work" },
      { id: 11, vendor: "pwsh", cwd: "D:\\repo", state: "idle", epoch: 1 },
    ],
  };
}

describe("workspace export/import (UX-563)", () => {
  it("round-trips a workspace through serialize -> parse", () => {
    const json = serializeWorkspaceExport(ws());
    const parsed = parseWorkspaceDef(json);
    expect(parsed.root).toBe("D:\\repo");
    expect(parsed.setupCmd).toBe("npm ci");
    expect(parsed.panes).toHaveLength(2);
    expect(parsed.panes[0]).toMatchObject({ vendor: "claude", cwd: "D:\\repo\\wt\\a", title: "feature work" });
  });

  it("rejects invalid JSON with a human-readable message", () => {
    expect(() => parseWorkspaceDef("not json")).toThrow(/valid JSON/);
  });

  it("rejects a document missing a root folder", () => {
    expect(() => parseWorkspaceDef(JSON.stringify({ workspace: { panes: [] } }))).toThrow(/root folder/);
  });

  it("rejects a document with a malformed pane list", () => {
    expect(() => parseWorkspaceDef(JSON.stringify({ workspace: { root: "/a", panes: [{ vendor: "claude" }] } }))).toThrow(/pane list/);
  });

  it("accepts a bare workspace def (not wrapped in {workspace: ...})", () => {
    const parsed = parseWorkspaceDef(JSON.stringify({ root: "/a", panes: [{ vendor: "claude", cwd: "/a" }] }));
    expect(parsed.root).toBe("/a");
  });
});

describe("named snapshots (UX-562)", () => {
  beforeEach(() => store.clear());

  it("save then list, newest first", async () => {
    saveSnapshot("before refactor", [ws()], 1);
    await new Promise((r) => setTimeout(r, 2));
    saveSnapshot("after refactor", [ws()], 1);
    const all = listSnapshots();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("after refactor");
    expect(all[1].name).toBe("before refactor");
  });

  it("a snapshot captures full pane definitions, restorable as NewPane-shaped data", () => {
    const snap = saveSnapshot("mine", [ws()], 1);
    const newPanes = defPanesToNewPanes(snap.workspaces[0].panes);
    expect(newPanes).toEqual([
      { vendor: "claude", cwd: "D:\\repo\\wt\\a", worktreePath: "D:\\repo\\wt\\a", branch: "flightdeck/a", baseBranch: "main" },
      { vendor: "pwsh", cwd: "D:\\repo", worktreePath: undefined, branch: undefined, baseBranch: undefined },
    ]);
  });

  it("rename and delete", () => {
    const snap = saveSnapshot("first name", [ws()], 1);
    renameSnapshot(snap.id, "second name");
    expect(listSnapshots()[0].name).toBe("second name");
    deleteSnapshot(snap.id);
    expect(listSnapshots()).toHaveLength(0);
  });

  it("blank name falls back to a timestamped default rather than an empty string", () => {
    const snap = saveSnapshot("   ", [ws()], 1);
    expect(snap.name.trim()).not.toBe("");
  });
});
