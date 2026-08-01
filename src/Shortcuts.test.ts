import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { isTypingTarget } = await import("./Shortcuts");
const { getShortcuts, FIXED_SHORTCUTS, CONTEXTUAL_SHORTCUTS } = await import("./Settings");

describe("isTypingTarget (UX-545 cheat-sheet key guard)", () => {
  function fakeEl(matches: boolean): Element {
    return { closest: () => (matches ? ({} as Element) : null) } as unknown as Element;
  }
  it("is false for null (no target)", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
  it("is true when the target is inside an input/textarea/terminal", () => {
    expect(isTypingTarget(fakeEl(true))).toBe(true);
  });
  it("is false for a plain element", () => {
    expect(isTypingTarget(fakeEl(false))).toBe(false);
  });
});

describe("shortcut registries (single source of truth, UX-545/530)", () => {
  it("has no id collisions between rebindable and fixed shortcuts", () => {
    const rebindable = getShortcuts().map((s) => s.id);
    const fixed = FIXED_SHORTCUTS.map((s) => s.id);
    const overlap = rebindable.filter((id) => fixed.includes(id));
    expect(overlap).toEqual([]);
  });

  it("has no two DIFFERENT global shortcuts bound to the same combo", () => {
    const all = [...getShortcuts(), ...FIXED_SHORTCUTS];
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const s of all) {
      const key = s.combo.toLowerCase();
      if (seen.has(key) && seen.get(key) !== s.id) collisions.push(`${key}: ${seen.get(key)} vs ${s.id}`);
      seen.set(key, s.id);
    }
    expect(collisions).toEqual([]);
  });

  it("contextual shortcuts don't collide with each other within the same context", () => {
    const byContext = new Map<string, string[]>();
    for (const s of CONTEXTUAL_SHORTCUTS) {
      const list = byContext.get(s.context) ?? [];
      expect(list).not.toContain(s.combo);
      list.push(s.combo);
      byContext.set(s.context, list);
    }
  });

  it("every shortcut has a non-empty label and combo", () => {
    for (const s of [...getShortcuts(), ...FIXED_SHORTCUTS, ...CONTEXTUAL_SHORTCUTS]) {
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(s.combo.trim().length).toBeGreaterThan(0);
    }
  });
});
