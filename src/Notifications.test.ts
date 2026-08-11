import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const setProgressBar = vi.fn(async () => {});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ requestUserAttention: vi.fn(), setProgressBar }),
  UserAttentionType: { Informational: 1, Critical: 2 },
  // Mirrors the real string enum (@tauri-apps/api/window.d.ts) — the values
  // are what actually reach the shell, so the tests assert on them.
  ProgressBarStatus: { None: "none", Normal: "normal", Indeterminate: "indeterminate", Paused: "paused", Error: "error" },
}));
// QL-742 pulled the memory-ceiling accessor in from Settings, which brings the
// dialog/opener plugins and localStorage with it (node has neither) — same
// stubs CommandPalette.test.ts uses for the identical import.
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const { setAttentionOverlay, summonTarget, SUMMON_EVENT, heavyPaneItems, aggregateProgress, setTaskbarProgress } =
  await import("./Notifications");
const { ProgressBarStatus } = await import("@tauri-apps/api/window");
import type { PaneProgress } from "./Terminal";
const { needsHumanQueue } = await import("./attention");
import type { AttentionItem } from "./attention";
import type { PaneState, Workspace } from "./store";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("setAttentionOverlay (QL-778)", () => {
  it("sends the count to the overlay-icon command, not the dead badge API", async () => {
    await setAttentionOverlay(3);
    expect(invoke).toHaveBeenCalledWith("set_attention_overlay", { count: 3 });
  });

  // The old setBadgeCount call passed `undefined` to clear, which is exactly
  // why "nothing needs you" has to keep reaching the backend: 0 is the clear.
  it("sends 0 rather than nothing when the queue empties, so the badge clears", async () => {
    await setAttentionOverlay(0);
    expect(invoke).toHaveBeenCalledWith("set_attention_overlay", { count: 0 });
  });

  it("never sends a negative or fractional count to a u32 command", async () => {
    await setAttentionOverlay(-2);
    await setAttentionOverlay(2.9);
    expect(invoke).toHaveBeenNthCalledWith(1, "set_attention_overlay", { count: 0 });
    expect(invoke).toHaveBeenNthCalledWith(2, "set_attention_overlay", { count: 2 });
  });

  it("swallows a backend failure — the browser preview has no taskbar", async () => {
    invoke.mockRejectedValue(new Error("no such command"));
    await expect(setAttentionOverlay(1)).resolves.toBeUndefined();
  });
});

// QL-782: several panes, one taskbar progress bar.
describe("aggregateProgress (QL-782)", () => {
  const p = (paneId: number, state: PaneProgress["state"], percent = 0): PaneProgress => ({ paneId, state, percent });

  it("clears the bar when nobody is reporting", () => {
    expect(aggregateProgress([])).toEqual({ status: ProgressBarStatus.None, percent: 0 });
  });

  it("shows the furthest-along pane, not an average that crawls backwards", () => {
    expect(aggregateProgress([p(1, "normal", 20), p(2, "normal", 80), p(3, "normal", 45)])).toEqual({
      status: ProgressBarStatus.Normal,
      percent: 80,
    });
  });

  it("lets an error win over healthy panes, carrying that pane's percentage", () => {
    expect(aggregateProgress([p(1, "normal", 90), p(2, "error", 30)])).toEqual({
      status: ProgressBarStatus.Error,
      percent: 30,
    });
  });

  it("stays on the first errored pane so two failures don't make the bar flicker", () => {
    expect(aggregateProgress([p(1, "error", 30), p(2, "error", 70)]).percent).toBe(30);
  });

  it("falls back to indeterminate only when nobody reports a real number", () => {
    expect(aggregateProgress([p(1, "indeterminate"), p(2, "indeterminate")])).toEqual({
      status: ProgressBarStatus.Indeterminate,
      percent: 0,
    });
  });

  it("prefers a real percentage over a spinner when both are reported", () => {
    expect(aggregateProgress([p(1, "indeterminate"), p(2, "normal", 12)])).toEqual({
      status: ProgressBarStatus.Normal,
      percent: 12,
    });
  });
});

describe("setTaskbarProgress (QL-782)", () => {
  beforeEach(() => setProgressBar.mockClear());

  it("omits the number for the states where it means nothing", async () => {
    await setTaskbarProgress({ status: ProgressBarStatus.None, percent: 0 });
    await setTaskbarProgress({ status: ProgressBarStatus.Indeterminate, percent: 0 });
    expect(setProgressBar.mock.calls).toEqual([
      [{ status: "none" }],
      [{ status: "indeterminate" }],
    ]);
  });

  it("sends the percentage for the states that render one", async () => {
    await setTaskbarProgress({ status: ProgressBarStatus.Normal, percent: 42 });
    await setTaskbarProgress({ status: ProgressBarStatus.Error, percent: 7 });
    expect(setProgressBar.mock.calls).toEqual([
      [{ status: "normal", progress: 42 }],
      [{ status: "error", progress: 7 }],
    ]);
  });

  it("swallows a missing capability rather than throwing into a render", async () => {
    setProgressBar.mockRejectedValueOnce(new Error("window.set_progress_bar not allowed"));
    await expect(setTaskbarProgress({ status: ProgressBarStatus.Normal, percent: 1 })).resolves.toBeUndefined();
  });
});

// Minimal pane/workspace shapes: only the fields the attention ranking reads.
function pane(id: number, state: PaneState, since: number) {
  return {
    id,
    vendor: "claude",
    title: `pane ${id}`,
    state,
    stateAt: since,
    cwd: "C:\\repo",
  } as unknown as Workspace["panes"][number];
}

function ws(id: number, panes: Workspace["panes"]): Workspace {
  return { id, name: `ws${id}`, panes, focused: panes[0]?.id, cwd: "C:\\repo" } as unknown as Workspace;
}

describe("summonTarget (QL-780)", () => {
  it("is the head of the ranked queue — approvals beat errors and questions", () => {
    const workspaces = [
      ws(1, [pane(10, "error", Date.now() - 60_000)]),
      ws(2, [pane(20, "permission", Date.now() - 1_000)]),
    ];
    const queue = needsHumanQueue(workspaces, {});
    const top = summonTarget(queue);
    expect(top?.p.id).toBe(20);
    expect(top?.w.id).toBe(2);
  });

  it("is null when nothing needs a human, so a summon doesn't move focus", () => {
    expect(summonTarget([])).toBeNull();
    expect(summonTarget(needsHumanQueue([ws(1, [pane(10, "running", Date.now())])], {}))).toBeNull();
  });

  it("never invents a target from a queue of quiet panes", () => {
    // "waiting" with no question is ambient, not needs-you (UX-601).
    const queue: AttentionItem[] = needsHumanQueue([ws(1, [pane(10, "idle", Date.now())])], {});
    expect(summonTarget(queue)).toBeNull();
  });
});

// QL-742: memory warnings are AMBIENT. These pin the resolution step; the
// "never rings" half is structural — heavyPaneItems feeds a list in the
// dropdown and nothing else, and the badge counts read needsHumanQueue only.
describe("heavyPaneItems (QL-742)", () => {
  const mem = (paneId: number, memoryMb: number) => ({ paneId, memoryMb, memoryWarnMb: 1024 });

  it("resolves a reading back to the workspace and pane it belongs to", () => {
    const workspaces = [ws(1, [pane(10, "running", Date.now())]), ws(2, [pane(20, "running", Date.now())])];
    const items = heavyPaneItems(workspaces, [mem(20, 2048)]);
    expect(items).toHaveLength(1);
    expect(items[0].w.id).toBe(2);
    expect(items[0].p.id).toBe(20);
    expect(items[0].mem.memoryMb).toBe(2048);
  });

  it("puts the biggest offender first — that's the one to look at", () => {
    const workspaces = [ws(1, [pane(10, "running", Date.now()), pane(11, "running", Date.now())])];
    const items = heavyPaneItems(workspaces, [mem(10, 1200), mem(11, 3000)]);
    expect(items.map((i) => i.p.id)).toEqual([11, 10]);
  });

  it("drops a pane that closed since the sample rather than rendering a ghost", () => {
    const workspaces = [ws(1, [pane(10, "running", Date.now())])];
    expect(heavyPaneItems(workspaces, [mem(99, 4096)])).toEqual([]);
  });

  it("is empty when nothing is over the ceiling, so the section never renders", () => {
    expect(heavyPaneItems([ws(1, [pane(10, "running", Date.now())])], [])).toEqual([]);
  });
});

describe("summon event name", () => {
  // The Rust side emits this exact string (src-tauri/src/summon.rs
  // SUMMON_EVENT). Drift here means the hotkey silently stops jumping.
  it("matches the backend constant", () => {
    expect(SUMMON_EVENT).toBe("app://summon");
  });
});
