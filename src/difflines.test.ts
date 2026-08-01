import { describe, expect, it } from "vitest";
import { mapPatchLines } from "./difflines";

const patch = (s: string) => s.trimStart().split("\n");

describe("patch line mapping (UX-519/UI-617)", () => {
  it("carries a running new-file line number across context and additions", () => {
    const nos = mapPatchLines(patch(`
@@ -10,3 +10,4 @@
 keep
+added one
+added two
 tail`));
    expect(nos.map((n) => n.newLine)).toEqual([null, 10, 11, 12, 13]);
  });

  it("gives deleted lines an old-side number and no new-side target", () => {
    const nos = mapPatchLines(patch(`
@@ -5,2 +5,1 @@
-gone
 kept`));
    expect(nos[1]).toEqual({ oldLine: 5, newLine: null });
    expect(nos[2]).toEqual({ oldLine: 6, newLine: 5 });
  });

  it("resets both counters at each hunk header", () => {
    const nos = mapPatchLines(patch(`
@@ -1,1 +1,1 @@
-a
+b
@@ -50,1 +51,1 @@
-c
+d`));
    expect(nos[2].newLine).toBe(1);
    expect(nos[5].newLine).toBe(51);
  });

  it("gives meta/file-header lines no line numbers at all", () => {
    const nos = mapPatchLines(patch(`
diff --git a/f.ts b/f.ts
index 111..222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,1 +1,1 @@
-x
+y`));
    expect(nos.slice(0, 5)).toEqual(new Array(5).fill({ oldLine: null, newLine: null }));
  });

  it("survives an empty patch", () => {
    expect(mapPatchLines([])).toEqual([]);
  });
});
