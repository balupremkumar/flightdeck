// Guards whether "?" is literal text or the shortcut cheat-sheet toggle.
import { describe, it, expect, vi } from "vitest";
import { isTypingTarget } from "./isTypingTarget";

describe("isTypingTarget", () => {
  it("returns false for a null target", () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it.each([
    "input",
    "textarea",
    "select",
    '[contenteditable="true"]',
    ".pbody",
  ])("returns true when closest matches %s", (selector) => {
    const match = {} as Element;
    const closest = vi.fn((selectors: string) =>
      selectors.split(",").map((part) => part.trim()).includes(selector) ? match : null,
    );
    const target = { closest } as unknown as Element;

    expect(isTypingTarget(target)).toBe(true);
    expect(closest).toHaveBeenCalledTimes(1);
    expect(closest).toHaveBeenCalledWith(expect.stringContaining(selector));
  });

  it("returns false when closest finds no match", () => {
    const closest = vi.fn(() => null);
    const target = { closest } as unknown as Element;

    expect(isTypingTarget(target)).toBe(false);
    expect(closest).toHaveBeenCalledTimes(1);
  });
});
