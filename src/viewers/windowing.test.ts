import { describe, expect, it } from "vitest";
import { ROW_H, windowRange } from "./windowing";

describe("list windowing", () => {
  it("uses 24 pixel rows by default", () => {
    expect(ROW_H).toBe(24);
  });

  it.each([
    { name: "start", scrollTop: 0, viewport: 240, total: 100, expected: { start: 0, end: 22 } },
    { name: "middle", scrollTop: 1200, viewport: 240, total: 100, expected: { start: 38, end: 72 } },
    { name: "end", scrollTop: 2160, viewport: 240, total: 100, expected: { start: 78, end: 100 } },
    { name: "short list", scrollTop: 0, viewport: 240, total: 4, expected: { start: 0, end: 4 } },
    { name: "empty list", scrollTop: 0, viewport: 240, total: 0, expected: { start: 0, end: 0 } },
    { name: "negative scroll", scrollTop: -24, viewport: 240, total: 100, expected: { start: 0, end: 22 } },
    { name: "zero viewport", scrollTop: 0, viewport: 0, total: 100, expected: { start: 0, end: 13 } },
    { name: "partial rows", scrollTop: 1201, viewport: 240, total: 100, expected: { start: 38, end: 73 } },
  ])("windowRange covers the $name with clamped overscan", ({ scrollTop, viewport, total, expected }) => {
    expect(windowRange(scrollTop, viewport, total)).toEqual(expected);
  });

  it("windowRange accepts custom row height and overscan", () => {
    expect(windowRange(105, 50, 100, 10, 2)).toEqual({ start: 8, end: 18 });
    expect(windowRange(105, 50, 100, 10, 0)).toEqual({ start: 10, end: 16 });
  });
});
