import { afterEach, describe, expect, it, vi } from "vitest";
import { getMultiwindow, getWindowDrag } from "./settingsStore";

// 0.6.1: both flags are on unless Settings wrote an explicit "0".
function stub(values: Record<string, string>) {
  vi.stubGlobal("localStorage", { getItem: (k: string) => values[k] ?? null });
}

afterEach(() => vi.unstubAllGlobals());

describe("multiple windows and window drag default on", () => {
  it("an absent key means on", () => {
    stub({});
    expect(getMultiwindow()).toBe(true);
    expect(getWindowDrag()).toBe(true);
  });

  it("an explicit 0 is the kill switch", () => {
    stub({ "flightdeck-multiwindow": "0", "flightdeck-window-drag": "0" });
    expect(getMultiwindow()).toBe(false);
    expect(getWindowDrag()).toBe(false);
  });

  it("an explicit 1 stays on", () => {
    stub({ "flightdeck-multiwindow": "1", "flightdeck-window-drag": "1" });
    expect(getMultiwindow()).toBe(true);
    expect(getWindowDrag()).toBe(true);
  });

  it("unreadable storage falls back to on", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); } });
    expect(getMultiwindow()).toBe(true);
    expect(getWindowDrag()).toBe(true);
  });
});
