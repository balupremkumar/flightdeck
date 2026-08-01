import { describe, expect, it } from "vitest";
import { nextUnreviewed } from "./reviewstate";

describe("next unreviewed file (UX-567)", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts"];

  it("picks the next file after current that isn't reviewed", () => {
    expect(nextUnreviewed(files, "a.ts", new Set())).toBe("b.ts");
  });

  it("skips already-reviewed files", () => {
    expect(nextUnreviewed(files, "a.ts", new Set(["b.ts", "c.ts"]))).toBe("d.ts");
  });

  it("wraps around to catch an earlier file reviewed out of order", () => {
    expect(nextUnreviewed(files, "c.ts", new Set(["d.ts"]))).toBe("a.ts");
  });

  it("returns null once every file is reviewed", () => {
    expect(nextUnreviewed(files, "a.ts", new Set(files))).toBeNull();
  });

  it("handles no current selection", () => {
    expect(nextUnreviewed(files, null, new Set())).toBe("a.ts");
  });

  it("handles an empty file list", () => {
    expect(nextUnreviewed([], null, new Set())).toBeNull();
  });
});
