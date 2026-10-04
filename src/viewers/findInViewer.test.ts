import { describe, expect, it } from "vitest";
import { countMatches, findInChunks, findOffsets, nextIndex } from "./findInViewer";
import { windowRange } from "./windowing";

describe("find helpers", () => {
  it("counts case-insensitive, non-overlapping matches", () => {
    expect(findOffsets("Foo foo FOO", "foo")).toEqual([0, 4, 8]);
    expect(countMatches("aaaa", "aa")).toBe(2);
    expect(countMatches("abc", "")).toBe(0);
    expect(countMatches("abc", "z")).toBe(0);
  });
  it("next/prev wrap around", () => {
    expect(nextIndex(0, 12, 1)).toBe(1);
    expect(nextIndex(11, 12, 1)).toBe(0);
    expect(nextIndex(0, 12, -1)).toBe(11);
    expect(nextIndex(5, 0, 1)).toBe(0);
  });
  it("matches across syntax-highlight spans but not across lines", () => {
    const chunks = [
      { text: "const ", block: 0 },
      { text: "foo", block: 0 },
      { text: "bar", block: 1 },
    ];
    const m = findInChunks(chunks, "t foo");
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual([{ chunk: 0, start: 4, end: 6 }, { chunk: 1, start: 0, end: 3 }]);
    expect(findInChunks(chunks, "foobar")).toEqual([]);
    expect(findInChunks(chunks, "o")).toHaveLength(3);
  });
});

describe("windowRange", () => {
  it("mounts a small slice of a large list", () => {
    const r = windowRange(24 * 5000, 600, 10_000);
    expect(r.end - r.start).toBeLessThan(60);
    expect(r.start).toBeLessThanOrEqual(5000);
    expect(r.end).toBeGreaterThan(5000);
  });
  it("clamps at both ends and handles empty", () => {
    expect(windowRange(0, 600, 10).start).toBe(0);
    expect(windowRange(1e9, 600, 10).end).toBe(10);
    expect(windowRange(0, 600, 0)).toEqual({ start: 0, end: 0 });
  });
});
