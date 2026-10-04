import { describe, expect, it } from "vitest";
import { computeFoldRanges, foldAll, foldSummary, foldsContaining, pruneFolded, toggleFold, type FoldMark } from "./foldmarks";

const m = (id: number, promptLine: number, outStart?: number, outEnd?: number, exit?: number): FoldMark => ({ id, promptLine, outStart, outEnd, exit });

describe("computeFoldRanges", () => {
  it("covers output from C to the line before the end marker", () => {
    expect(computeFoldRanges([m(1, 0, 1, 6, 0)])).toEqual([{ id: 1, promptLine: 0, start: 1, lines: 5, exit: 0 }]);
  });
  it("skips a running command (no exit / no end)", () => {
    expect(computeFoldRanges([m(1, 0, 1, undefined, undefined), m(2, 5, 6)])).toEqual([]);
  });
  it("skips a command with no output", () => {
    expect(computeFoldRanges([m(1, 0, 1, 1, 0)])).toEqual([]);
    expect(computeFoldRanges([m(1, 0, undefined, 1, 0)])).toEqual([]);
  });
  it("trims trailing blank rows", () => {
    const blank = new Set([4, 5]);
    expect(computeFoldRanges([m(1, 0, 1, 6, 1)], (l) => blank.has(l))[0]).toMatchObject({ start: 1, lines: 3, exit: 1 });
    expect(computeFoldRanges([m(1, 0, 1, 3, 0)], () => true)).toEqual([]);
  });
  it("clips to the next prompt and ignores a C at or above its own prompt", () => {
    const r = computeFoldRanges([m(1, 0, 1, 20, 0), m(2, 4, 5, 8, 0)]);
    expect(r.map((x) => [x.id, x.start, x.lines])).toEqual([[1, 1, 3], [2, 5, 3]]);
    expect(computeFoldRanges([m(1, 5, 2, 8, 0)])[0]).toMatchObject({ start: 6, lines: 2 });
  });
  it("keeps independent ranges for finished commands around a running one", () => {
    const r = computeFoldRanges([m(1, 0, 1, 3, 0), m(2, 3, 4), m(3, 9, 10, 12, 2)]);
    expect(r.map((x) => x.id)).toEqual([1, 3]);
  });
});

describe("foldSummary", () => {
  it("formats command, lines and exit", () => {
    expect(foldSummary("  ls   -la ", 12, 0)).toBe("▸ ls -la (12 lines, exit 0)");
    expect(foldSummary("x", 1, 2)).toBe("▸ x (1 line, exit 2)");
    expect(foldSummary("", 3, 0)).toBe("▸ (3 lines, exit 0)");
  });
  it("caps a long command", () => {
    const s = foldSummary("a".repeat(200), 2, 0, 10);
    expect(s).toBe(`▸ ${"a".repeat(9)}… (2 lines, exit 0)`);
  });
});

describe("fold state", () => {
  it("toggles without mutating", () => {
    const a = new Set<number>();
    const b = toggleFold(a, 1);
    expect([...a]).toEqual([]);
    expect([...b]).toEqual([1]);
    expect([...toggleFold(b, 1)]).toEqual([]);
  });
  const ranges = computeFoldRanges([m(1, 0, 1, 4, 0), m(2, 4, 5, 9, 0)]);
  it("folds all and finds the block containing a line", () => {
    const all = foldAll(ranges);
    expect([...all]).toEqual([1, 2]);
    expect(foldsContaining(ranges, all, 6)).toEqual([2]);
    expect(foldsContaining(ranges, all, 4)).toEqual([]);
    expect(foldsContaining(ranges, new Set([1]), 6)).toEqual([]);
  });
  it("prunes ids with no range", () => {
    expect([...pruneFolded(new Set([1, 7]), ranges)]).toEqual([1]);
  });
});
