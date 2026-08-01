import { describe, expect, it } from "vitest";
import { buildExplainPrompt, buildLineCommentPrompt, fileLineRange, truncatePatchForPrompt } from "./reviewprompt";
import { mapPatchLines } from "./difflines";

const patch = (s: string) => s.trimStart().split("\n");

describe("fileLineRange", () => {
  it("spans the min/max real file line across a range, preferring the new side", () => {
    const lines = patch(`
@@ -10,3 +10,4 @@
 keep
+added one
+added two
 tail`);
    const nos = mapPatchLines(lines);
    expect(fileLineRange(nos, 1, 3)).toEqual({ start: 10, end: 12 });
  });

  it("falls back to the old side for a pure deletion", () => {
    const lines = patch(`
@@ -5,2 +5,1 @@
-gone
 kept`);
    const nos = mapPatchLines(lines);
    expect(fileLineRange(nos, 1, 1)).toEqual({ start: 5, end: 5 });
  });

  it("is null when the range is only hunk/meta lines", () => {
    const lines = patch(`
diff --git a/f.ts b/f.ts
@@ -1,1 +1,1 @@`);
    const nos = mapPatchLines(lines);
    expect(fileLineRange(nos, 0, 1)).toBeNull();
  });
});

describe("buildLineCommentPrompt (UX-568)", () => {
  const lines = patch(`
@@ -10,3 +10,4 @@
 keep
+added one
+added two
 tail`);
  const nos = mapPatchLines(lines);

  it("prefixes the file and real line range, then the raw selected lines", () => {
    const p = buildLineCommentPrompt("src/foo.ts", lines, nos, 1, 2);
    expect(p).toBe("src/foo.ts:10-11\n```\n keep\n+added one\n```\n");
  });

  it("collapses a single-line selection to one line number, no range", () => {
    const p = buildLineCommentPrompt("src/foo.ts", lines, nos, 1, 1);
    expect(p).toBe("src/foo.ts:10\n```\n keep\n```\n");
  });

  it("normalises a reversed (bottom-to-top) selection", () => {
    const forward = buildLineCommentPrompt("f.ts", lines, nos, 1, 3);
    const reversed = buildLineCommentPrompt("f.ts", lines, nos, 3, 1);
    expect(reversed).toBe(forward);
  });

  it("falls back to just the file name when no line resolves", () => {
    const p = buildLineCommentPrompt("f.ts", lines, nos, 0, 0);
    expect(p.startsWith("f.ts\n")).toBe(true);
  });
});

describe("truncatePatchForPrompt (UX-569)", () => {
  it("returns short patches unchanged", () => {
    expect(truncatePatchForPrompt("a\nb\nc", 100)).toBe("a\nb\nc");
  });

  it("cuts at a line boundary and appends a clear truncation marker", () => {
    const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = truncatePatchForPrompt(big, 40);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("truncated");
    expect(out.startsWith(big.slice(0, out.indexOf("\n…")))).toBe(true);
    // Never mid-line: the kept portion up to the marker must end where a
    // real line in the source ended.
    const kept = out.slice(0, out.indexOf("\n…"));
    expect(big.startsWith(kept)).toBe(true);
  });

  it("never exceeds maxChars for the kept portion even without a newline in range", () => {
    const noNewlines = "x".repeat(100);
    const out = truncatePatchForPrompt(noNewlines, 10);
    expect(out).toContain("truncated");
  });
});

describe("buildExplainPrompt (UX-569)", () => {
  it("frames the (capped) patch as a question naming the file", () => {
    const p = buildExplainPrompt("src/foo.ts", "@@ -1,1 +1,1 @@\n-a\n+b", 1000);
    expect(p).toBe("Explain this diff for src/foo.ts:\n```diff\n@@ -1,1 +1,1 @@\n-a\n+b\n```\n");
  });

  it("truncates a huge patch instead of pasting it wholesale", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    const p = buildExplainPrompt("big.ts", huge, 500);
    expect(p.length).toBeLessThan(huge.length);
    expect(p).toContain("truncated");
  });
});
