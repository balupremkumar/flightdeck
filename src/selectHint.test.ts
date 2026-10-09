import { beforeEach, describe, expect, it } from "vitest";
import { resetSelectHints, takeSelectHint } from "./selectHint";

const qualifying = { button: 0, shift: false, mouseTracking: true, agentVendor: true };

beforeEach(() => resetSelectHints());

describe("takeSelectHint", () => {
  it("shows once per pane and gives each pane its own hint", () => {
    expect(takeSelectHint(1, qualifying)).toBe(true);
    expect(takeSelectHint(1, qualifying)).toBe(false);
    expect(takeSelectHint(2, qualifying)).toBe(true);
  });

  it.each([
    { ...qualifying, shift: true },
    { ...qualifying, button: 1 },
    { ...qualifying, button: 2 },
    { ...qualifying, mouseTracking: false },
    { ...qualifying, agentVendor: false },
  ])("does not consume the hint for a non-qualifying press: %j", (ctx) => {
    expect(takeSelectHint(1, ctx)).toBe(false);
    expect(takeSelectHint(1, qualifying)).toBe(true);
  });

  it("allows the first hint again after reset", () => {
    expect(takeSelectHint(1, qualifying)).toBe(true);
    resetSelectHints();
    expect(takeSelectHint(1, qualifying)).toBe(true);
  });
});
