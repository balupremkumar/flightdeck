import { describe, expect, it } from "vitest";
import {
  candidateBases, stitchLogical, matchRange, offsetToPos, rangesOverlap, rangeTouchesRow, hardWrapLink,
  parseFileUri, pickFileHit, createDedupe, type RowInfo,
} from "./termlinks";
import { linkify } from "./linkify";

const rowsOf = (rows: RowInfo[]) => (y: number) => rows[y - 1];
const pad = (s: string, n: number) => s.padEnd(n, " ");

describe("candidateBases", () => {
  it("orders worktree, cwd, root, vault", () => {
    expect(candidateBases({ worktree: "C:\\wt", cwd: "C:\\wt\\sub", root: "C:\\repo", vault: "D:\\Dev\\ai" }))
      .toEqual(["C:\\wt", "C:\\wt\\sub", "C:\\repo", "D:\\Dev\\ai"]);
  });
  it("drops empties and case/trailing-slash duplicates", () => {
    expect(candidateBases({ worktree: undefined, cwd: "C:\\Repo\\", root: "c:\\repo", vault: null })).toEqual(["C:\\Repo\\"]);
  });
  it("omits the vault when it does not exist (null)", () => {
    expect(candidateBases({ cwd: "C:\\a", root: "C:\\b", vault: null })).toEqual(["C:\\a", "C:\\b"]);
  });
});

describe("stitchLogical + matchRange (soft wraps)", () => {
  // 20-col terminal: "see src/components/Verylong" wraps mid-path onto row 2.
  const cols = 20;
  const full = "see src/components/Terminal.tsx:12 ok";
  const r1 = full.slice(0, cols);
  const r2 = pad(full.slice(cols), cols);
  const rows: RowInfo[] = [{ text: r1, wrapped: false }, { text: r2, wrapped: true }];

  it("stitches from either row to the same logical line", () => {
    const a = stitchLogical(rowsOf(rows), 1)!;
    const b = stitchLogical(rowsOf(rows), 2)!;
    expect(a.text).toBe(full);
    expect(b.text).toBe(full);
    expect(a.segments.map((s) => s.y)).toEqual([1, 2]);
  });

  it("maps a path broken by the wrap to one two-row range", () => {
    const l = stitchLogical(rowsOf(rows), 1)!;
    const m = linkify(l.text).find((x) => x.kind === "path")!;
    const range = matchRange(l, m.start, m.end)!;
    expect(range.start).toEqual({ x: 5, y: 1 });
    expect(range.end.y).toBe(2);
    expect(range.end.x).toBe(m.end - cols); // inclusive, 1-based
    expect(rangeTouchesRow(range, 1)).toBe(true);
    expect(rangeTouchesRow(range, 2)).toBe(true);
    expect(rangeTouchesRow(range, 3)).toBe(false);
  });

  it("does not stitch rows that are not flagged wrapped", () => {
    const l = stitchLogical(rowsOf([{ text: r1, wrapped: false }, { text: r2, wrapped: false }]), 1)!;
    expect(l.text).toBe(r1);
  });

  it("stitches three rows and trims only the last row's blanks", () => {
    const l = stitchLogical(rowsOf([
      { text: "aaaaa", wrapped: false }, { text: "bbbbb", wrapped: true }, { text: "cc   ", wrapped: true },
    ]), 2)!;
    expect(l.text).toBe("aaaaabbbbbcc");
    expect(offsetToPos(l, 11)).toEqual({ x: 2, y: 3 });
    expect(offsetToPos(l, 12)).toBeNull();
  });

  it("returns null for a missing row", () => {
    expect(stitchLogical(rowsOf([]), 1)).toBeNull();
  });
});

describe("rangesOverlap", () => {
  const r = (a: [number, number], b: [number, number]) => ({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } });
  it("detects overlap across rows and rejects disjoint spans", () => {
    expect(rangesOverlap(r([5, 1], [3, 2]), r([18, 1], [20, 1]))).toBe(true);
    expect(rangesOverlap(r([1, 1], [4, 1]), r([5, 1], [9, 1]))).toBe(false);
  });
});

describe("hardWrapLink (Ink hard wraps)", () => {
  const cols = 24;
  it("joins a path touching the last column with a path-like continuation", () => {
    const upper = "open src/components/Term"; // 24 chars
    expect(upper.length).toBe(cols);
    const hw = hardWrapLink(upper, "inal.tsx:7 now", cols, 4, 5)!;
    expect(hw.match.raw).toBe("src/components/Terminal.tsx");
    expect(hw.match.line).toBe(7);
    expect(hw.range.start).toEqual({ x: 6, y: 4 });
    expect(hw.range.end).toEqual({ x: 10, y: 5 }); // "inal.tsx:7", suffix included
  });
  it("allows a leading indent on the continuation row", () => {
    const hw = hardWrapLink("open src/components/Term", "  inal.tsx", cols, 1, 2)!;
    expect(hw.match.raw).toBe("src/components/Terminal.tsx");
    expect(hw.range.end).toEqual({ x: 10, y: 2 });
  });
  it("requires the upper row to reach the last column", () => {
    expect(hardWrapLink("open src/components/Te", "rminal.tsx", cols, 1, 2)).toBeNull();
  });
  it("requires a path separator in the trailing token", () => {
    expect(hardWrapLink("aaaaaaaaaaaaaaaaaaaaaaaa", "bbb.tsx", cols, 1, 2)).toBeNull();
  });
  it("requires a continuation token", () => {
    expect(hardWrapLink("open src/components/Term", "   ", cols, 1, 2)).toBeNull();
    expect(hardWrapLink("open src/components/Term", "(x)", cols, 1, 2)).toBeNull();
  });
});

describe("parseFileUri", () => {
  it("decodes a Windows drive URI", () => {
    expect(parseFileUri("file:///C:/Users/Some%20One/a%23b.md")!.candidates).toEqual(["C:\\Users\\Some One\\a#b.md"]);
  });
  it("accepts file://localhost/", () => {
    expect(parseFileUri("file://localhost/C:/x/y.ts")!.candidates).toEqual(["C:\\x\\y.ts"]);
  });
  it("keeps a POSIX path as is", () => {
    expect(parseFileUri("file:///mnt/d/dev/a.ts")!.candidates).toEqual(["/mnt/d/dev/a.ts"]);
  });
  it("strips :line:col into a second, bare candidate", () => {
    const f = parseFileUri("file:///C:/repo/src/App.tsx:42:7")!;
    expect(f.candidates).toEqual(["C:\\repo\\src\\App.tsx:42:7", "C:\\repo\\src\\App.tsx"]);
    expect([f.line, f.col]).toEqual([42, 7]);
    expect(parseFileUri("file:///C:/a.ts:9")!.line).toBe(9);
  });
  it("reads a #L12 fragment as the line", () => {
    const f = parseFileUri("file:///C:/a.ts#L12")!;
    expect(f.candidates).toEqual(["C:\\a.ts"]);
    expect(f.line).toBe(12);
  });
  it("does not mistake a drive colon for a line suffix", () => {
    expect(parseFileUri("file:///C:/")!.candidates).toEqual(["C:\\"]);
  });
  it("rejects other schemes, UNC hosts and bad escapes", () => {
    for (const u of ["https://x.com/a", "javascript:alert(1)", "file://server/share/a.txt", "file:////server/share/a.txt", "file:///C:/%E0%A4%A", "mailto:a@b.c", ""]) {
      expect(parseFileUri(u), u).toBeNull();
    }
  });
});

describe("pickFileHit", () => {
  const f = parseFileUri("file:///C:/r/App.tsx:42:7")!;
  it("uses the bare path's hit with the line", () => {
    expect(pickFileHit(f, [null, { path: "C:\\r\\App.tsx", isDir: false }])).toEqual({ path: "C:\\r\\App.tsx", isDir: false, line: 42, col: 7 });
  });
  it("drops the line when the suffixed name itself exists", () => {
    expect(pickFileHit(f, [{ path: "C:\\r\\App.tsx:42:7", isDir: false }, null])!.line).toBeUndefined();
  });
  it("is null when nothing exists", () => {
    expect(pickFileHit(f, [null, null])).toBeNull();
  });
});

describe("createDedupe", () => {
  it("blocks the same key inside 700ms and allows it after", () => {
    let t = 1000;
    const allow = createDedupe(700, () => t);
    expect(allow("a")).toBe(true);
    t += 699;
    expect(allow("a")).toBe(false);
    t += 1; // 700 since the FIRST fire (the blocked call did not extend it)
    expect(allow("a")).toBe(true);
  });
  it("tracks keys independently", () => {
    const allow = createDedupe(700, () => 5);
    expect(allow("a")).toBe(true);
    expect(allow("b")).toBe(true);
    expect(allow("a")).toBe(false);
  });
});
