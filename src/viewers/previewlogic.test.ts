import { describe, expect, it } from "vitest";
import { atBottom, scopeRetryDelay, scrollAfterReload, shouldPoll, statChanged } from "./previewlogic";

describe("scopeRetryDelay", () => {
  it("retries once at 800 ms inside the boot window", () => {
    expect(scopeRetryDelay(0, false)).toBe(800);
    expect(scopeRetryDelay(2999, false)).toBe(800);
  });
  it("shows the panel after the window or after one retry", () => {
    expect(scopeRetryDelay(3000, false)).toBeNull();
    expect(scopeRetryDelay(500, true)).toBeNull();
  });
});

describe("statChanged", () => {
  const a = { mtime_ms: 100, size: 10 };
  it("treats the first stat as a baseline", () => expect(statChanged(null, a)).toBe(false));
  it("detects mtime or size changes", () => {
    expect(statChanged(a, { ...a })).toBe(false);
    expect(statChanged(a, { ...a, mtime_ms: 101 })).toBe(true);
    expect(statChanged(a, { ...a, size: 11 })).toBe(true);
  });
});

describe("shouldPoll", () => {
  const on = { follow: true, drawerOpen: true, windowVisible: true, loaded: true };
  it("needs every condition", () => {
    expect(shouldPoll(on)).toBe(true);
    for (const k of Object.keys(on) as (keyof typeof on)[]) expect(shouldPoll({ ...on, [k]: false })).toBe(false);
  });
});

describe("scroll preservation", () => {
  it("detects the bottom within slack", () => {
    expect(atBottom({ scrollTop: 592, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(atBottom({ scrollTop: 100, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });
  it("sticks to the bottom only if it was there", () => {
    expect(scrollAfterReload(true, 600, 2000, 400)).toBe(1600);
    expect(scrollAfterReload(false, 300, 2000, 400)).toBe(300);
  });
});
