import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ requestUserAttention: vi.fn() }),
  UserAttentionType: { Informational: 1, Critical: 2 },
}));

const { setAttentionOverlay, summonTarget, SUMMON_EVENT } = await import("./Notifications");
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

describe("summon event name", () => {
  // The Rust side emits this exact string (src-tauri/src/summon.rs
  // SUMMON_EVENT). Drift here means the hotkey silently stops jumping.
  it("matches the backend constant", () => {
    expect(SUMMON_EVENT).toBe("app://summon");
  });
});
