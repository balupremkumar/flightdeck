import { describe, expect, it } from "vitest";
import {
  applyFolds, autoCollapseThreshold, collapseReason, foldRuns, hashPatch, parseViewed,
  reconcileViewed, shouldAutoCollapse, viewedStorageKey, whitespaceStorageKey,
} from "./reviewfold";

const ctx = (n: number) => Array<boolean>(n).fill(true);

describe("foldRuns (QL-715)", () => {
  it("leaves runs of 8 or fewer alone", () => {
    expect(foldRuns(ctx(8))).toEqual([]);
    expect(foldRuns(ctx(0))).toEqual([]);
    expect(foldRuns(ctx(1))).toEqual([]);
  });
  it("folds a 9-line run to 3 + 3 around 3 hidden", () => {
    expect(foldRuns(ctx(9))).toEqual([{ start: 3, end: 6 }]);
  });
  it("treats an all-unchanged file as one run", () => {
    expect(foldRuns(ctx(100))).toEqual([{ start: 3, end: 97 }]);
  });
  it("folds each long run separately and ignores changes between", () => {
    const f = [...ctx(10), false, false, ...ctx(5), false, ...ctx(12)];
    expect(foldRuns(f)).toEqual([{ start: 3, end: 7 }, { start: 21, end: 27 }]);
  });
  it("handles runs at the very start and end", () => {
    expect(foldRuns([...ctx(9), false])).toEqual([{ start: 3, end: 6 }]);
    expect(foldRuns([false, ...ctx(9)])).toEqual([{ start: 4, end: 7 }]);
  });
  it("a file with no context never folds", () => {
    expect(foldRuns([false, false, false])).toEqual([]);
  });
});

describe("applyFolds", () => {
  const ranges = foldRuns([...ctx(10), false]);
  it("replaces a hidden range with one fold segment", () => {
    const segs = applyFolds(11, ranges, new Set(), false);
    expect(segs.filter((s) => s.kind === "fold")).toEqual([{ kind: "fold", start: 3, end: 7 }]);
    expect(segs.length).toBe(11 - 4 + 1);
  });
  it("expanding one range shows every item", () => {
    const segs = applyFolds(11, ranges, new Set([3]), false);
    expect(segs.every((s) => s.kind === "item")).toBe(true);
    expect(segs.length).toBe(11);
  });
  it("showAll overrides folds", () => {
    expect(applyFolds(11, ranges, new Set(), true).length).toBe(11);
  });
});

describe("auto-collapse", () => {
  it("collapses over the threshold, not at it", () => {
    expect(shouldAutoCollapse({ added: 200, deleted: 100 }, false)).toBe(false);
    expect(shouldAutoCollapse({ added: 200, deleted: 101 }, false)).toBe(true);
  });
  it("collapses binary and truncated regardless of size", () => {
    expect(shouldAutoCollapse({ added: 0, deleted: 0, binary: true }, false)).toBe(true);
    expect(shouldAutoCollapse({ added: 1, deleted: 0 }, true)).toBe(true);
  });
  it("reads the threshold override defensively", () => {
    expect(autoCollapseThreshold(null)).toBe(300);
    expect(autoCollapseThreshold("")).toBe(300);
    expect(autoCollapseThreshold("abc")).toBe(300);
    expect(autoCollapseThreshold("-5")).toBe(300);
    expect(autoCollapseThreshold("50")).toBe(50);
    expect(shouldAutoCollapse({ added: 40, deleted: 20 }, false, 50)).toBe(true);
  });
  it("names the reason", () => {
    expect(collapseReason({ added: 1, deleted: 1 }, false, true)).toBe("Viewed");
    expect(collapseReason({ added: 0, deleted: 0, binary: true }, false, false)).toBe("Binary file");
    expect(collapseReason({ added: 400, deleted: 0 }, false, false)).toContain("400");
  });
});

describe("hashPatch and viewed invalidation (QL-719)", () => {
  it("is stable and sensitive to change", () => {
    expect(hashPatch("+a\n")).toBe(hashPatch("+a\n"));
    expect(hashPatch("+a\n")).not.toBe(hashPatch("+b\n"));
    expect(hashPatch("")).not.toBe(hashPatch(" "));
  });
  it("keeps marks whose hash is unchanged", () => {
    const r = reconcileViewed({ "a.ts": "h1" }, { "a.ts": "h1" }, new Set(["a.ts"]));
    expect(r).toEqual({ viewed: { "a.ts": "h1" }, invalidated: [] });
  });
  it("clears a mark when the patch hash differs and reports it", () => {
    const r = reconcileViewed({ "a.ts": "h1", "b.ts": "h2" }, { "a.ts": "hX", "b.ts": "h2" }, new Set(["a.ts", "b.ts"]));
    expect(r).toEqual({ viewed: { "b.ts": "h2" }, invalidated: ["a.ts"] });
  });
  it("drops marks for files no longer in the diff, without reporting them", () => {
    const r = reconcileViewed({ "gone.ts": "h" }, {}, new Set(["a.ts"]));
    expect(r).toEqual({ viewed: {}, invalidated: [] });
  });
  it("keeps a mark when the fresh hash could not be fetched", () => {
    const r = reconcileViewed({ "a.ts": "h1" }, { "a.ts": null }, new Set(["a.ts"]));
    expect(r.viewed).toEqual({ "a.ts": "h1" });
  });
});

describe("persistence", () => {
  it("keys viewed per repo+branch and whitespace per repo", () => {
    expect(viewedStorageKey("C:\\r", "feat")).not.toBe(viewedStorageKey("C:\\r", "other"));
    expect(viewedStorageKey("C:\\r", "feat")).not.toBe(viewedStorageKey("C:\\s", "feat"));
    expect(viewedStorageKey("C:\\r", null)).toBe(viewedStorageKey("C:\\r", undefined));
    expect(whitespaceStorageKey("C:\\r")).not.toBe(whitespaceStorageKey("C:\\s"));
  });
  it("parses stored marks defensively", () => {
    expect(parseViewed(null)).toEqual({});
    expect(parseViewed("not json")).toEqual({});
    expect(parseViewed("[1]")).toEqual({});
    expect(parseViewed('{"a":"h","b":3}')).toEqual({ a: "h" });
  });
});
