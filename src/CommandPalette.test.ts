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

const { fuzzyScore, rankByRecent, buildShortcutMap } = await import("./CommandPalette");
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
