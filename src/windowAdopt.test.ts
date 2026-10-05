import { beforeEach, describe, expect, it, vi } from "vitest";

// Red team finding 6: a fold into main sent while main was mid-reload is lost (emit is
// fire and forget). Rust keeps it until main acks (`main_adopt_done`) and main replays
// what is left (`main_pending_adopts`) once its listener is up.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { invoke } = await import("@tauri-apps/api/core");
const { handleAdopt, replayPendingAdopts } = await import("./windowBoot");
const { useApp } = await import("./store");
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const ws = (id: number) => ({ id, name: `w${id}`, root: "D:\\p", panes: [] });
const fold = (id: number, transferId: number) => ({
  from: "fw-1", workspaceIds: [id], activeWs: id, transferId,
  slice: { version: 1, workspaces: [ws(id)], activeWorkspaceId: id, savedAt: 0 },
});
const calls = (cmd: string) => mockInvoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  useApp.setState({ workspaces: [], activeId: null, creating: false } as never);
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
});

describe("folds into main", () => {
  it("adopts the folded workspace and acks it to Rust", async () => {
    await handleAdopt(fold(3, 5) as never);
    expect(useApp.getState().workspaces.map((w) => w.id)).toEqual([3]);
    expect(calls("main_adopt_done")).toEqual([["main_adopt_done", { transferId: 5 }]]);
  });

  it("a replay of a fold main already holds adds nothing and still acks it", async () => {
    await handleAdopt(fold(3, 5) as never);
    await handleAdopt(fold(3, 5) as never);
    expect(useApp.getState().workspaces.map((w) => w.id)).toEqual([3]);
    expect(calls("main_adopt_done")).toHaveLength(2);
  });

  it("replays what Rust still holds after a reload, then acks each", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === "main_pending_adopts" ? [fold(3, 5), fold(4, 6)] : null));
    await replayPendingAdopts();
    expect(useApp.getState().workspaces.map((w) => w.id).sort()).toEqual([3, 4]);
    expect(calls("main_adopt_done").map((c) => (c[1] as { transferId: number }).transferId)).toEqual([5, 6]);
  });

  it("nothing pending, or a build without the command, is a no-op", async () => {
    await replayPendingAdopts();
    mockInvoke.mockRejectedValue(new Error("no such command"));
    await expect(replayPendingAdopts()).resolves.toBeUndefined();
    expect(useApp.getState().workspaces).toEqual([]);
  });
});
