import { describe, expect, it } from "vitest";
import { toSplitRows, parseHunkStarts } from "./splitdiff";

const patch = (s: string) => s.trimStart().split("\n");

describe("split diff (UI-165)", () => {
  it("reads line numbers out of the hunk header", () => {
    expect(parseHunkStarts("@@ -12,7 +30,9 @@ fn main()")).toEqual([12, 30]);
    expect(parseHunkStarts("@@ -1 +1 @@")).toEqual([1, 1]);
    expect(parseHunkStarts("not a hunk")).toBeNull();
  });

  it("pairs a deletion with the addition that replaced it", () => {
    const rows = toSplitRows(patch(`
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;`));
    const change = rows.find((r) => r.kind === "change")!;
    expect(change.left).toBe("const b = 2;");
    expect(change.right).toBe("const b = 3;");
  });

  it("numbers both sides independently across an uneven change", () => {
    const rows = toSplitRows(patch(`
@@ -10,4 +20,5 @@
 keep
-gone
+new one
+new two
 tail`));
    const tail = rows[rows.length - 1];
    // left: 10 keep, 11 gone -> tail is 12. right: 20 keep, 21+22 new -> tail 23.
    expect(tail.leftNo).toBe(12);
    expect(tail.rightNo).toBe(23);
  });

  it("leaves half-rows when a run has no counterpart", () => {
    const rows = toSplitRows(patch(`
@@ -1,2 +1,1 @@
-only removed
-also removed
+one added`));
    const kinds = rows.filter((r) => r.kind !== "hunk").map((r) => r.kind);
    expect(kinds).toEqual(["change", "del"]);
    const half = rows.find((r) => r.kind === "del")!;
    expect(half.right).toBeUndefined();
    expect(half.left).toBe("also removed");
  });

  it("classifies file headers as meta, not content", () => {
    const rows = toSplitRows(patch(`
diff --git a/f.ts b/f.ts
index 111..222 100644
--- a/f.ts
+++ b/f.ts
@@ -1 +1 @@
-x
+y`));
    expect(rows.filter((r) => r.kind === "meta")).toHaveLength(4);
    expect(rows.filter((r) => r.kind === "change")).toHaveLength(1);
  });

  it("keeps an index that points back into the original patch", () => {
    const lines = patch(`
@@ -1,2 +1,2 @@
 ctx
-old
+new`);
    for (const r of toSplitRows(lines)) {
      expect(lines[r.index]).toBeDefined();
    }
  });

  it("handles a pure addition (new file) without a left side", () => {
    const rows = toSplitRows(patch(`
@@ -0,0 +1,2 @@
+line one
+line two`));
    const adds = rows.filter((r) => r.kind === "add");
    expect(adds).toHaveLength(2);
    expect(adds.every((r) => r.left === undefined)).toBe(true);
    expect(adds.map((r) => r.rightNo)).toEqual([1, 2]);
  });

  it("survives an empty patch", () => {
    expect(toSplitRows([])).toEqual([]);
  });
});
