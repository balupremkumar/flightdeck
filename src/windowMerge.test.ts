import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 4 S9: session-wide operations run Merge all windows first, then act in main on
// the merged document.

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

let windowLabel = "main";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: windowLabel }) }));

const { invoke } = await import("@tauri-apps/api/core");
const { useApp } = await import("./store");
const { mergeFirst, registerSliceFlush, waitForWorkspaces } = await import("./windowMerge");
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const ws = (id: number) => ({ id, name: `w${id}`, root: "D:\\p", panes: [] });
const log: string[] = [];

beforeEach(() => {
  store.clear();
  store.set("flightdeck-multiwindow", "1");
  windowLabel = "main";
  log.length = 0;
  useApp.setState({ workspaces: [ws(1)], activeId: 1 } as never);
  registerSliceFlush(async () => { log.push(`flush:${useApp.getState().workspaces.map((w) => w.id).join(",")}`); });
  mockInvoke.mockReset();
});

describe("mergeFirst", () => {
  it("merges, waits for main to hold the adopted workspaces, flushes the merged slice, and only then returns", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      log.push(`invoke:${cmd}`);
      // win://adopt lands a little after the command answers.
      setTimeout(() => useApp.setState({ workspaces: [ws(1), ws(10), ws(11)] } as never), 120);
      return [10, 11];
    });
    await mergeFirst();
    log.push("operation");
    expect(log).toEqual(["invoke:merge_all_windows", "flush:1,10,11", "operation"]);
  });

  it("with nothing to merge it neither waits nor flushes", async () => {
    mockInvoke.mockResolvedValue([]);
    await mergeFirst();
    expect(log).toEqual([]);
  });

  it("is a no-op with the flag off: Rust is never asked", async () => {
    store.set("flightdeck-multiwindow", "0");
    await mergeFirst();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("refuses in a secondary, before it merges anything", async () => {
    windowLabel = "fw-1";
    await expect(mergeFirst()).rejects.toThrow(/main window/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("a Rust build without the command behaves like one window", async () => {
    mockInvoke.mockRejectedValue(new Error("no such command"));
    await expect(mergeFirst()).resolves.toBeUndefined();
  });

  it("fails loudly, not silently, if the adopted workspaces never arrive", async () => {
    mockInvoke.mockResolvedValue([99]);
    expect(await waitForWorkspaces([99], 120, 20)).toBe(false);
    expect(log).toEqual([]);
  });
});
