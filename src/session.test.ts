import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { hydrateFrom, lastRestoreReport, parseUiPrefs, lastSessionSummary } = await import("./session");
const { useApp } = await import("./store");
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const reset = () => useApp.setState({ workspaces: [], activeId: null, creating: false });

describe("session restore (UX-581 draft round-trip / UX-583 restore report)", () => {
  beforeEach(() => {
    reset();
    mockInvoke.mockReset();
  });

  it("restores a pane's unsent draft line", async () => {
    mockInvoke.mockResolvedValue(null); // repoToplevel: not a repo, "plain" pane
    await hydrateFrom(
      [
        {
          id: 1,
          name: "ws",
          root: "D:\\proj",
          panes: [{ id: 10, vendor: "claude", cwd: "D:\\proj", draft: "still typing this" } as never],
        },
      ],
      1
    );
    const pane = useApp.getState().workspaces[0].panes[0];
    expect(pane.draft).toBe("still typing this");
  });

  it("reports a plain (non-isolated) pane as status 'plain'", async () => {
    mockInvoke.mockResolvedValue(null);
    await hydrateFrom(
      [{ id: 1, name: "ws", root: "D:\\proj", panes: [{ id: 10, vendor: "claude", cwd: "D:\\proj" }] }],
      1
    );
    const report = lastRestoreReport();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ paneId: 10, workspaceId: 1, workspaceName: "ws", status: "plain" });
  });

  it("reports an isolated pane whose worktree is still intact as status 'intact'", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "git_repo_toplevel") return Promise.resolve("D:\\proj"); // still resolves — intact
      return Promise.resolve(null);
    });
    await hydrateFrom(
      [
        {
          id: 1,
          name: "ws",
          root: "D:\\proj",
          panes: [
            { id: 10, vendor: "claude", cwd: "D:\\wt\\a", worktreePath: "D:\\wt\\a", branch: "flightdeck/a", baseBranch: "main" },
          ],
        },
      ],
      1
    );
    expect(lastRestoreReport()[0].status).toBe("intact");
  });

  it("reports a reattached worktree distinctly from a fallen-back one", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_repo_toplevel") return Promise.resolve(null); // dir is gone
      if (cmd === "git_worktree_add") {
        return Promise.resolve({ path: `D:\\wt\\${args?.slug}`, branch: `flightdeck/${args?.slug}`, baseBranch: "main", created: false });
      }
      return Promise.resolve(null);
    });
    await hydrateFrom(
      [
        {
          id: 1,
          name: "ws",
          root: "D:\\proj",
          panes: [
            // Branch survives (flightdeck/ prefix) -> reattach succeeds.
            { id: 10, vendor: "claude", cwd: "D:\\wt\\a", worktreePath: "D:\\wt\\a", branch: "flightdeck/a", baseBranch: "main" },
            // No recognisable branch -> falls back to the workspace root.
            { id: 11, vendor: "agy", cwd: "D:\\wt\\b", worktreePath: "D:\\wt\\b", branch: "some-other-branch", baseBranch: "main" },
          ],
        },
      ],
      1
    );
    const report = lastRestoreReport();
    expect(report.find((r) => r.paneId === 10)?.status).toBe("reattached");
    expect(report.find((r) => r.paneId === 11)?.status).toBe("fell-back");
  });
});

// UX-554/561: uiPrefs grew two new fields (groups, summary) without touching
// persist.rs/persist.ts (SessionDoc.uiPrefs is an untyped blob there) — this
// is the backward-compat contract: an OLD doc, saved before either shipped,
// must still load with sane defaults rather than throwing.
describe("parseUiPrefs backward compatibility (UX-554/561)", () => {
  it("a pre-UX-554/561 doc (uiPrefs has only board, or is entirely absent) still parses", () => {
    expect(parseUiPrefs({ board: { columns: [] } })).toEqual({ board: { columns: [] }, groups: [], summary: [] });
    expect(parseUiPrefs(undefined)).toEqual({ board: undefined, groups: [], summary: [] });
    expect(parseUiPrefs(null)).toEqual({ board: undefined, groups: [], summary: [] });
    expect(parseUiPrefs("not even an object")).toEqual({ board: undefined, groups: [], summary: [] });
  });

  it("a current doc round-trips board, groups and summary", () => {
    const uiPrefs = {
      board: { columns: [] },
      groups: [{ id: 1, name: "backend", paneIds: [10, 11] }],
      summary: [{ workspaceName: "ws", vendor: "claude", cwd: "D:\\proj", state: "waiting", lastLine: "done" }],
    };
    expect(parseUiPrefs(uiPrefs)).toEqual(uiPrefs);
  });

  it("tolerates groups/summary being present but the wrong shape (not an array)", () => {
    expect(parseUiPrefs({ groups: "oops", summary: 42 })).toEqual({ board: undefined, groups: [], summary: [] });
  });
});

describe("lastSessionSummary (UX-561)", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("returns [] when there's no session doc yet", async () => {
    mockInvoke.mockResolvedValue(null);
    expect(await lastSessionSummary()).toEqual([]);
  });

  it("returns [] for an old doc with no summary in uiPrefs, instead of throwing", async () => {
    mockInvoke.mockResolvedValue({ version: 1, savedAt: 0, activeWorkspaceId: null, workspaces: [], uiPrefs: { board: {} } });
    expect(await lastSessionSummary()).toEqual([]);
  });

  it("returns the persisted summary when present", async () => {
    const summary = [{ workspaceName: "ws", vendor: "claude", cwd: "D:\\proj", state: "running" }];
    mockInvoke.mockResolvedValue({ version: 1, savedAt: 0, activeWorkspaceId: null, workspaces: [], uiPrefs: { summary } });
    expect(await lastSessionSummary()).toEqual(summary);
  });
});
