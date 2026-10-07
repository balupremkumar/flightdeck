import { describe, it, expect } from "vitest";
import { quietWheelReports, rightClickAction, shouldConfirmPaste, shouldCopyOnSelect, type WheelAcc } from "./terminalMouse";

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

describe("right-click paste confirm (SF2)", () => {
  it("routes paste through the confirm when flagged", () => expect(rightClickAction({ ...base, confirmPaste: true })).toBe("paste-confirm"));
  it("a selection still copies", () => expect(rightClickAction({ ...base, confirmPaste: true, hasSelection: true })).toBe("copy"));
  it("the menu setting is unaffected", () => expect(rightClickAction({ ...base, confirmPaste: true, setting: "menu" })).toBe("menu"));
  it("permission, open question and unfocused panes confirm", () => {
    expect(shouldConfirmPaste({ attention: "permission", focused: true })).toBe(true);
    expect(shouldConfirmPaste({ attention: "question", focused: true })).toBe(true);
    expect(shouldConfirmPaste({ attention: null, focused: false })).toBe(true);
  });
  it("a focused pane that is not blocked pastes straight in", () => {
    expect(shouldConfirmPaste({ attention: null, focused: true })).toBe(false);
    expect(shouldConfirmPaste({ attention: "error", focused: true })).toBe(false);
  });
});

describe("agent vendors ignore mouse tracking (SF3)", () => {
  it("an agent pane with tracking on still pastes", () => expect(rightClickAction({ ...base, mouseTracking: true, agentVendor: true })).toBe("paste"));
  it("...and copies a selection", () => expect(rightClickAction({ ...base, mouseTracking: true, agentVendor: true, hasSelection: true })).toBe("copy"));
  it("a shell pane with tracking keeps app", () => expect(rightClickAction({ ...base, mouseTracking: true, agentVendor: false })).toBe("app"));
  it("the menu setting still wins for agents", () => expect(rightClickAction({ ...base, mouseTracking: true, agentVendor: true, setting: "menu" })).toBe("menu"));
});

describe("shouldCopyOnSelect", () => {
  const ok = { enabled: true, userGesture: true, changed: true, text: "x" };
  it("copies a user selection", () => expect(shouldCopyOnSelect(ok)).toBe(true));
  it("not when disabled", () => expect(shouldCopyOnSelect({ ...ok, enabled: false })).toBe(false));
  it("not programmatic", () => expect(shouldCopyOnSelect({ ...ok, userGesture: false })).toBe(false));
  it("not unchanged (plain click)", () => expect(shouldCopyOnSelect({ ...ok, changed: false })).toBe(false));
  it("not empty", () => expect(shouldCopyOnSelect({ ...ok, text: "" })).toBe(false));
});

describe("quietWheelReports (K11)", () => {
  const UP = "\x1b[<64;5;7M", DOWN = "\x1b[<65;5;7M";
  const px = (deltaY: number) => ({ deltaY, deltaMode: 0 });

  it("sends three SGR wheel-up reports per 120 px mouse notch, at the pointer cell", () => {
    const acc: WheelAcc = { px: 0 };
    expect(quietWheelReports(acc, px(-120), 5, 7, 40)).toBe(UP.repeat(3));
    expect(quietWheelReports(acc, px(120), 5, 7, 40)).toBe(DOWN.repeat(3));
  });

  it("never sends arrow keys", () => {
    expect(quietWheelReports({ px: 0 }, px(-120), 5, 7, 40)).not.toMatch(/\x1b\[A|\x1bOA/);
  });

  it("accumulates small trackpad deltas until a whole line", () => {
    const acc: WheelAcc = { px: 0 };
    expect(quietWheelReports(acc, px(-15), 5, 7, 40)).toBe("");
    expect(quietWheelReports(acc, px(-15), 5, 7, 40)).toBe("");
    expect(quietWheelReports(acc, px(-15), 5, 7, 40)).toBe(UP);
    expect(acc.px).toBe(-5);
  });

  it("drops the leftover when the direction reverses", () => {
    const acc: WheelAcc = { px: -30 };
    expect(quietWheelReports(acc, px(40), 5, 7, 40)).toBe(DOWN);
    expect(acc.px).toBe(0);
  });

  it("handles line and page delta modes, capped at one screen", () => {
    expect(quietWheelReports({ px: 0 }, { deltaY: -2, deltaMode: 1 }, 5, 7, 40)).toBe(UP.repeat(2));
    expect(quietWheelReports({ px: 0 }, { deltaY: 1, deltaMode: 2 }, 5, 7, 40)).toBe(DOWN.repeat(40));
    expect(quietWheelReports({ px: 0 }, px(-100000), 5, 7, 40)).toBe(UP.repeat(40));
  });
});
