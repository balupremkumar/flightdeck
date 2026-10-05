import { describe, expect, it, vi } from "vitest";

// The suite runs in node, which has no localStorage — same minimal stub
// trust.test.ts uses.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { fuzzyScore, rankByRecent, buildShortcutMap, ACTION_SHORTCUT_ID, pickTaskVendor, taskLabel, waitForAgentReady, sendTaskWhenReady, buildWindowItems, buildMoveTargetItems } =await import("./CommandPalette");
const { getShortcuts, FIXED_SHORTCUTS } = await import("./Settings");

describe("fuzzyScore (command palette search matching)", () => {
  it("matches an ordered subsequence", () => {
    expect(fuzzyScore("Open settings", "opst")).not.toBeNull();
    expect(fuzzyScore("Open settings", "settings")).not.toBeNull();
  });

  it("rejects out-of-order or missing characters", () => {
    expect(fuzzyScore("Open settings", "stpo")).toBeNull();
    expect(fuzzyScore("Open settings", "zzz")).toBeNull();
  });

  it("scores a tighter/earlier match lower (better) than a looser one", () => {
    const tight = fuzzyScore("Settings", "set");
    const loose = fuzzyScore("Reset all settings", "set");
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight as number).toBeLessThan(loose as number);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("Open Settings", "OPEN")).not.toBeNull();
  });
});

describe("rankByRecent (UX-529 MRU ranking)", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("returns original order when nothing is recent", () => {
    expect(rankByRecent(items, [])).toEqual(items);
  });

  it("puts recent items first, newest-first, then the rest in original order", () => {
    const ranked = rankByRecent(items, ["c", "a"]);
    expect(ranked.map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores a recent id that no longer maps to an item", () => {
    const ranked = rankByRecent(items, ["ghost", "b"]);
    expect(ranked.map((i) => i.id)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("buildShortcutMap (UX-530, single source of truth)", () => {
  it("includes every rebindable and fixed shortcut, keyed by id", () => {
    const map = buildShortcutMap();
    for (const s of [...getShortcuts(), ...FIXED_SHORTCUTS]) {
      expect(map[s.id]).toBe(s.combo);
    }
  });

  it("reflects a rebind without needing a special cache-bust", () => {
    const before = buildShortcutMap();
    expect(before["settings"]).toBe("Ctrl+,");
    localStorage.setItem("flightdeck-shortcuts", JSON.stringify({ settings: "Ctrl+." }));
    const after = buildShortcutMap();
    expect(after["settings"]).toBe("Ctrl+.");
    localStorage.removeItem("flightdeck-shortcuts");
  });
});

describe("Open Home action (Phase 5)", () => {
  it("act:home maps to a registered shortcut and shows Ctrl+Shift+H as its hint", () => {
    expect(ACTION_SHORTCUT_ID["act:home"]).toBe("home");
    expect(buildShortcutMap()[ACTION_SHORTCUT_ID["act:home"]]).toBe("Ctrl+Shift+H");
  });

  it("no other shortcut claims Ctrl+Shift+H", () => {
    const clash = [...getShortcuts(), ...FIXED_SHORTCUTS].filter((s) => s.combo === "Ctrl+Shift+H");
    expect(clash.map((s) => s.id)).toEqual(["home"]);
  });
});

describe("Phase 4 window entries (flag flightdeck-multiwindow)", () => {
  const others = [
    { label: "fw-1", livePanes: 2, title: "Window 2", workspaces: [{ id: 5, name: "acme-web", root: "D:\\acme", paneId: 9, livePanes: 2 }] },
  ];
  const deps = (enabled: boolean, extra: Partial<Parameters<typeof buildWindowItems>[0]> = {}) =>
    ({ enabled, hasActiveWs: true, others, startMoveToWindow: () => {}, ...extra });

  it("lists nothing with the flag off, even with other windows known", () => {
    expect(buildWindowItems(deps(false))).toEqual([]);
  });

  it("lists move to new window, move to window, merge all, next window and every window's workspaces with the flag on", () => {
    const items = buildWindowItems(deps(true));
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([
      "act:move-workspace-window", "act:move-workspace-to-window", "act:merge-windows", "act:next-window", "rws:fw-1:5",
    ]));
    const go = items.find((i) => i.id === "rws:fw-1:5")!;
    expect(go).toMatchObject({ section: "Workspaces", label: "acme-web", hint: "Window 2" });
    expect(items.find((i) => i.id === "act:move-workspace-to-window")!.stay).toBe(true);
  });

  it("without an active workspace the move entries go but merge and next stay", () => {
    const ids = buildWindowItems(deps(true, { hasActiveWs: false })).map((i) => i.id);
    expect(ids).not.toContain("act:move-workspace-window");
    expect(ids).not.toContain("act:move-workspace-to-window");
    expect(ids).toContain("act:merge-windows");
  });

  it("Move workspace to window… lists the other windows by title", () => {
    const rows = buildMoveTargetItems(others);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "mv:fw-1", label: "Window 2", hint: "1 workspace" });
    expect(buildMoveTargetItems([])).toEqual([]);
  });
});

describe("New task helpers", () => {
  it("picks the first installed agent, else claude", () => {
    expect(pickTaskVendor([{ id: "codex", installed: false }, { id: "gemini", installed: true }])).toBe("gemini");
    expect(pickTaskVendor([])).toBe("claude");
  });

  it("collapses whitespace and caps the label at 60", () => {
    expect(taskLabel("  fix   the\nbug ")).toBe("fix the bug");
    expect(taskLabel("x".repeat(100))).toHaveLength(60);
    expect(taskLabel("   ")).toBe("");
  });
});

describe("New task send-when-ready", () => {
  const noSleep = () => Promise.resolve();
  type S = "starting" | "running" | "idle" | "waiting" | "permission" | "error";
  // State sequence consumed one entry per poll; the last entry repeats.
  const seq = (...states: (S | undefined)[]) => {
    let i = 0;
    return () => states[Math.min(i++, states.length - 1)];
  };

  it("waits through starting/running/permission, then reports ready on idle", async () => {
    const r = await waitForAgentReady(seq("starting", "running", "permission", "idle"), { sleep: noSleep });
    expect(r).toBe("ready");
  });
  it("treats waiting as ready", async () => {
    expect(await waitForAgentReady(seq("starting", "waiting"), { sleep: noSleep })).toBe("ready");
  });
  it("times out when the agent never settles", async () => {
    expect(await waitForAgentReady(seq("running"), { sleep: noSleep, timeoutMs: 1000, pollMs: 250 })).toBe("timeout");
  });
  it("gives up if the pane errors or disappears", async () => {
    expect(await waitForAgentReady(seq("starting", "error"), { sleep: noSleep })).toBe("gone");
    expect(await waitForAgentReady(seq(undefined), { sleep: noSleep })).toBe("gone");
  });

  it("writes the text plus Enter once ready", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const r = await sendTaskWhenReady({ text: "fix the bug", getState: seq("running", "idle"), write, copy, toast, sleep: noSleep });
    expect(r).toBe("sent");
    expect(write).toHaveBeenCalledWith("fix the bug\r");
    expect(copy).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
  it("on timeout leaves it unsent, copies it and toasts", async () => {
    const write = vi.fn();
    const copy = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const r = await sendTaskWhenReady({
      text: "fix the bug", getState: seq("running"), write, copy, toast, sleep: noSleep, timeoutMs: 500, pollMs: 250,
    });
    expect(r).toBe("copied");
    expect(write).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith("fix the bug");
    expect(toast).toHaveBeenCalledWith("info", "Task text copied, paste it into the pane");
  });
  it("falls back to the clipboard if the write rejects", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const r = await sendTaskWhenReady({
      text: "t", getState: seq("idle"), write: vi.fn().mockRejectedValue(new Error("x")), copy, toast, sleep: noSleep,
    });
    expect(r).toBe("copied");
    expect(copy).toHaveBeenCalledWith("t");
  });
  it("does nothing when the pane is gone", async () => {
    const write = vi.fn();
    const copy = vi.fn();
    const r = await sendTaskWhenReady({ text: "t", getState: seq(undefined), write, copy, toast: vi.fn(), sleep: noSleep });
    expect(r).toBe("gone");
    expect(write).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });
});
