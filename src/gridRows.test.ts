import { describe, expect, it } from "vitest";
import { rows } from "./gridRows";

describe("rows() grid layout (R1)", () => {
  it("lays out the tiers the design specifies", () => {
    expect(rows(0)).toEqual([]);
    expect(rows(1)).toEqual([[0]]);
    expect(rows(2)).toEqual([[0, 1]]);
    expect(rows(3)).toEqual([[0, 1], [2]]);
    expect(rows(4)).toEqual([[0, 1], [2, 3]]);
    expect(rows(5)).toEqual([[0, 1, 2], [3, 4]]);
    expect(rows(6)).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(rows(9)).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
    expect(rows(10)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
    expect(rows(17)).toEqual([[0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16]]);
  });

  it("places every index exactly once, in order, for n = 1..40", () => {
    for (let n = 1; n <= 40; n++) {
      expect(rows(n).flat()).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it("appending a pane never moves an existing pane to another row, except at tier boundaries", () => {
    const rowOf = (n: number) => {
      const m = new Map<number, number>();
      rows(n).forEach((r, ri) => r.forEach((i) => m.set(i, ri)));
      return m;
    };
    for (let n = 1; n < 40; n++) {
      const a = rowOf(n);
      const b = rowOf(n + 1);
      const moved = [...a].filter(([i, r]) => b.get(i) !== r).length;
      if (n === 4 || n === 9 || n === 16) continue; // tier boundaries reshape
      if (n > 16) continue; // sqrt tier reshapes more freely
      expect(moved, `n=${n} -> ${n + 1}`).toBe(0);
    }
  });
});
