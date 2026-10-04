import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { collectReadRoots, isOutsideScopeError, syncReadRoots } = await import("./readscope");
const { useApp } = await import("./store");

const ws = (id: number, root: string, cwds: Array<[string, string?]> = []) => ({
  id, name: "w", root, focused: null,
  panes: cwds.map(([cwd, worktreePath], i) => ({ id: id * 10 + i, vendor: "claude", cwd, state: "idle", epoch: 0, worktreePath })),
}) as never;

describe("collectReadRoots", () => {
  it("dedupes roots, cwds and worktrees ignoring case, slashes and trailing separators", () => {
    const out = collectReadRoots([
      ws(1, "D:\\Dev\\app", [["d:/dev/app/"], ["D:\\Dev\\app\\.wt\\a", "D:\\Dev\\app\\.wt\\a"]]),
      ws(2, "D:\\Dev\\APP"),
    ]);
    expect(out).toEqual(["D:\\Dev\\app", "D:\\Dev\\app\\.wt\\a"]);
  });
  it("skips empty values", () => {
    expect(collectReadRoots([ws(1, "", [[""]])])).toEqual([]);
  });
});

describe("isOutsideScopeError", () => {
  it("matches the string and Error forms only", () => {
    expect(isOutsideScopeError("outside-read-scope")).toBe(true);
    expect(isOutsideScopeError(new Error("outside-read-scope"))).toBe(true);
    expect(isOutsideScopeError("too large to preview (over 5MB)")).toBe(false);
    expect(isOutsideScopeError("not outside-read-scope really")).toBe(false);
    expect(isOutsideScopeError(null)).toBe(false);
  });
});

describe("syncReadRoots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useApp.setState({ workspaces: [] });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("debounces bursts into one call with the latest roots, and skips unchanged sets", async () => {
    const stop = syncReadRoots();
    useApp.setState({ workspaces: [ws(1, "D:\\a")] });
    useApp.setState({ workspaces: [ws(1, "D:\\a"), ws(2, "D:\\b")] });
    await vi.advanceTimersByTimeAsync(199);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_read_roots", { roots: ["D:\\a", "D:\\b"] });
    useApp.setState({ workspaces: [ws(1, "D:\\a"), ws(2, "d:\\B\\")] });
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
  });
});
