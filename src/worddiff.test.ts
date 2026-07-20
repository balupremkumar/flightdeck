import { describe, expect, it } from "vitest";
import { wordDiffMap, commonTokens, tokenize } from "./worddiff";

const changed = (segs: { text: string; changed: boolean }[]) =>
  segs.filter((s) => s.changed).map((s) => s.text);

describe("word-level diff (UI-166)", () => {
  it("marks only the tokens that actually differ", () => {
    const m = wordDiffMap(["-const timeout = 30;", "+const timeout = 60;"]);
    expect(changed(m.get(0)!)).toEqual(["30"]);
    expect(changed(m.get(1)!)).toEqual(["60"]);
  });

  it("reassembles the full line from its segments", () => {
    const lines = ["-hello brave world", "+hello cruel world"];
    const m = wordDiffMap(lines);
    for (const [i, segs] of m) {
      expect(segs.map((s) => s.text).join("")).toBe(lines[i].slice(1));
    }
  });

  it("pairs multi-line runs of equal length", () => {
    const m = wordDiffMap(["-a 1", "-b 2", "+a 9", "+b 8"]);
    expect(m.size).toBe(4);
    expect(changed(m.get(0)!)).toEqual(["1"]);
    expect(changed(m.get(3)!)).toEqual(["8"]);
  });

  it("leaves unequal runs alone (a real block change, not an edit)", () => {
    expect(wordDiffMap(["-only line", "+one", "+two"]).size).toBe(0);
  });

  it("ignores +++/--- file headers", () => {
    expect(wordDiffMap(["--- a/f.ts", "+++ b/f.ts"]).size).toBe(0);
  });

  it("leaves wholly unrelated lines unmarked", () => {
    expect(wordDiffMap(["-aaa", "+zzz"]).size).toBe(0);
  });

  it("bails out on pathologically long lines instead of stalling", () => {
    const a = tokenize("x ".repeat(400));
    const b = tokenize("y ".repeat(400));
    const { aKeep } = commonTokens(a, b);
    expect(aKeep.every((k) => k === false)).toBe(true);
  });

  it("handles empty sides without throwing", () => {
    expect(() => wordDiffMap(["-", "+something"])).not.toThrow();
  });
});
