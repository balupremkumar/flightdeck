import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const {
  hydrateFrom, lastRestoreReport, parseUiPrefs, lastSessionSummary,
  setRestoredScrollback, restoredScrollbackFor,
  registerScrollbackSource, unregisterScrollbackSource, refreshScrollbackCache, paneScrollbackCache,
} = await import("./session");
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

  it("round-trips titleManual; old docs load as unset", async () => {
    mockInvoke.mockResolvedValue(null);
    await hydrateFrom(
      [{ id: 1, name: "ws", root: "D:\\proj", panes: [
        { id: 10, vendor: "claude", cwd: "D:\\proj", title: "claude", titleManual: true },
        { id: 11, vendor: "claude", cwd: "D:\\proj", title: "node" },
      ] }],
      1
    );
    const [a, b] = useApp.getState().workspaces[0].panes;
    expect(a.titleManual).toBe(true);
    expect(b.titleManual).toBeUndefined();
    const { toDraft } = await import("./session");
    const draft = toDraft(useApp.getState().workspaces, 1);
    expect(draft.workspaces[0].panes.map((p) => p.titleManual)).toEqual([true, undefined]);
  });

  it("redacts draft, title and summary lastLine before they reach the doc (RT-060 M3)", async () => {
    mockInvoke.mockResolvedValue(null);
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
    await hydrateFrom(
      [{ id: 1, name: "ws", root: "D:\proj", panes: [
        { id: 10, vendor: "claude", cwd: "D:\proj", title: `title ${key}`, draft: key },
      ] }],
      1
    );
    const { lastLine } = await import("./attention");
    lastLine.set(10, `\x1b[32m${key}\x1b[0m`);
    const { toDraft } = await import("./session");
    const doc = toDraft(useApp.getState().workspaces, 1);
    lastLine.delete(10);
    expect(JSON.stringify(doc)).not.toContain("sk-ant-");
    expect(doc.workspaces[0].panes[0].draft).toBe("[REDACTED]");
    expect(doc.workspaces[0].panes[0].title).toBe("title [REDACTED]");
    expect((doc.uiPrefs as { summary: { lastLine: string }[] }).summary[0].lastLine).toContain("[REDACTED]");
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
  const empty = { groups: [], summary: [], scrollback: {}, paneChat: {}, paneColor: {} };

  it("a pre-UX-554/561 doc (uiPrefs has only a legacy board, or is entirely absent) still parses", () => {
    expect(parseUiPrefs({ board: { columns: [] } })).toEqual(empty);
    expect(parseUiPrefs(undefined)).toEqual(empty);
    expect(parseUiPrefs(null)).toEqual(empty);
    expect(parseUiPrefs("not even an object")).toEqual(empty);
  });

  it("silently ignores a legacy uiPrefs.board and a saved board view (Board removed)", () => {
    const parsed = parseUiPrefs({ board: { todo: [{ id: "c1", title: "x" }] }, view: "board", activeView: "board", groups: [] });
    expect(parsed).toEqual(empty);
    expect(parsed).not.toHaveProperty("board");
  });

  it("a current doc round-trips groups and summary", () => {
    const uiPrefs = {
      groups: [{ id: 1, name: "backend", paneIds: [10, 11] }],
      summary: [{ workspaceName: "ws", vendor: "claude", cwd: "D:\\proj", state: "waiting", lastLine: "done" }],
    };
    expect(parseUiPrefs(uiPrefs)).toEqual({ ...uiPrefs, scrollback: {}, paneChat: {}, paneColor: {} });
  });

  it("parses per-pane chat prefs and drops junk", () => {
    expect(parseUiPrefs({ paneChat: { 3: { view: "chat", focusMode: true }, 4: { view: "x" }, bad: { view: "chat" }, 5: 7 } }).paneChat)
      .toEqual({ 3: { view: "chat", focusMode: true } });
  });

  it("tolerates groups/summary being present but the wrong shape (not an array)", () => {
    expect(parseUiPrefs({ groups: "oops", summary: 42 })).toEqual(empty);
  });

  // QL-762: a doc written before scrollback persistence existed has no
  // `scrollback` key at all — the case every launch hits after an upgrade.
  it("reads persisted scrollback keyed by pane id, and defaults to none", () => {
    expect(parseUiPrefs({ scrollback: { 10: "hello\r\n", 11: "world" } }).scrollback)
      .toEqual({ 10: "hello\r\n", 11: "world" });
    expect(parseUiPrefs({}).scrollback).toEqual({});
  });

  it("drops scrollback entries that aren't a pane id mapped to a string", () => {
    expect(parseUiPrefs({ scrollback: { abc: "x", 10: 42, 11: "", 12: "keep" } }).scrollback)
      .toEqual({ 12: "keep" });
    expect(parseUiPrefs({ scrollback: "oops" }).scrollback).toEqual({});
  });

  // A doc that grew past the cap (hand-edited, or written by a build with a
  // bigger one) must not be able to make a restore paint 50MB into a pane.
  it("re-applies the per-pane cap on the way in, keeping the newest end", () => {
    const huge = `${"x".repeat(1_000_000)}TAIL`;
    const out = parseUiPrefs({ scrollback: { 10: huge } }).scrollback;
    expect(out[10]).toHaveLength(1_000_000);
    expect(out[10].endsWith("TAIL")).toBe(true);
  });
});

// QL-762: what a restored pane is handed at mount. Non-destructive on purpose —
// a PaneView that remounts (workspace switch, focus mode) must still paint it.
describe("restored scrollback staging (QL-762)", () => {
  it("hands each pane its own, and nothing to a pane that had none", () => {
    setRestoredScrollback({ 10: "pane ten output" });
    expect(restoredScrollbackFor(10)).toBe("pane ten output");
    expect(restoredScrollbackFor(11)).toBeUndefined();
    expect(restoredScrollbackFor(10)).toBe("pane ten output"); // read twice, still there
    setRestoredScrollback({});
    expect(restoredScrollbackFor(10)).toBeUndefined();
  });
});

// QL-762: the serialise-on-idle cache the save path reads.
describe("scrollback sources (QL-762)", () => {
  beforeEach(() => {
    for (const id of [1, 2, 3]) unregisterScrollbackSource(id);
  });

  it("caches what each registered pane serialises", () => {
    registerScrollbackSource(1, () => "pane one");
    registerScrollbackSource(2, () => "pane two");
    refreshScrollbackCache();
    expect(paneScrollbackCache()).toEqual({ 1: "pane one", 2: "pane two" });
  });

  it("redacts key-shaped tokens before they reach the doc on disk", () => {
    registerScrollbackSource(1, () => "using key sk-ant-abcdefghijklmnopqrstuvwxyz0123 for this run");
    refreshScrollbackCache();
    expect(paneScrollbackCache()[1]).toContain("[REDACTED]");
    expect(paneScrollbackCache()[1]).not.toContain("sk-ant-");
  });

  it("redacts a key glued to an assignment prefix", () => {
    registerScrollbackSource(1, () => "export KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123\r\n");
    refreshScrollbackCache();
    expect(paneScrollbackCache()[1]).not.toContain("sk-ant-");
    expect(paneScrollbackCache()[1]).toContain("KEY=");
  });

  it("skips a pane whose serialiser throws rather than losing the whole save", () => {
    registerScrollbackSource(1, () => { throw new Error("mid-teardown"); });
    registerScrollbackSource(2, () => "still fine");
    refreshScrollbackCache();
    expect(paneScrollbackCache()).toEqual({ 2: "still fine" });
  });

  it("forgets a pane the moment it closes — a closed pane must not come back", () => {
    registerScrollbackSource(1, () => "gone soon");
    refreshScrollbackCache();
    unregisterScrollbackSource(1);
    expect(paneScrollbackCache()).toEqual({});
    refreshScrollbackCache();
    expect(paneScrollbackCache()).toEqual({});
  });

  it("stops at the document budget instead of writing an unbounded session file", () => {
    registerScrollbackSource(1, () => "a".repeat(2_500_000));
    registerScrollbackSource(2, () => "b".repeat(2_500_000));
    refreshScrollbackCache();
    const cached = paneScrollbackCache();
    expect(Object.keys(cached)).toEqual(["1"]);
    expect(Object.values(cached).join("").length).toBeLessThanOrEqual(3_000_000);
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
