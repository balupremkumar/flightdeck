import { describe, it, expect } from "vitest";
import { rightClickAction, shouldCopyOnSelect } from "./terminalMouse";

const base = { hasSelection: false, overLink: false, mouseTracking: false, shift: false, setting: "paste" as const };

describe("rightClickAction", () => {
  it("pastes with no selection", () => expect(rightClickAction(base)).toBe("paste"));
  it("copies with a selection", () => expect(rightClickAction({ ...base, hasSelection: true })).toBe("copy"));
  it("link wins over copy/paste", () => expect(rightClickAction({ ...base, overLink: true, hasSelection: true })).toBe("link"));
  it("mouse tracking goes to the app", () => expect(rightClickAction({ ...base, mouseTracking: true })).toBe("app"));
  it("shift opens the menu even with tracking or a link", () => {
    expect(rightClickAction({ ...base, shift: true, mouseTracking: true })).toBe("menu");
    expect(rightClickAction({ ...base, shift: true, overLink: true })).toBe("menu");
  });
  it("menu setting is always today's menu", () => {
    expect(rightClickAction({ ...base, setting: "menu", hasSelection: true })).toBe("menu");
    expect(rightClickAction({ ...base, setting: "menu", mouseTracking: true })).toBe("menu");
  });
});

describe("shouldCopyOnSelect", () => {
  const ok = { enabled: true, userGesture: true, changed: true, text: "x" };
  it("copies a user selection", () => expect(shouldCopyOnSelect(ok)).toBe(true));
  it("not when disabled", () => expect(shouldCopyOnSelect({ ...ok, enabled: false })).toBe(false));
  it("not programmatic", () => expect(shouldCopyOnSelect({ ...ok, userGesture: false })).toBe(false));
  it("not unchanged (plain click)", () => expect(shouldCopyOnSelect({ ...ok, changed: false })).toBe(false));
  it("not empty", () => expect(shouldCopyOnSelect({ ...ok, text: "" })).toBe(false));
});
