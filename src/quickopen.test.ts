import { describe, expect, it, vi } from "vitest";

// The suite runs in node, which has no localStorage — same minimal stub
// trust.test.ts / CommandPalette.test.ts use.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const {
  joinPath, relToAbs, baseName, isAncestor,
  walkFiles, subsequenceMatch, filterFiles, keepPathsForMatches, buildFilterRows,
  typeaheadNext, loadRecentFiles, pushRecentFile,
} = await import("./quickopen");

describe("joinPath / relToAbs / baseName", () => {
  it("infers the separator from the parent (windows)", () => {
    expect(joinPath("D:\\repo", "src")).toBe("D:\\repo\\src");
  });
  it("infers the separator from the parent (posix)", () => {
    expect(joinPath("/repo", "src")).toBe("/repo/src");
  });
  it("rebuilds an absolute path from a forward-slash relPath", () => {
    expect(relToAbs("D:\\repo", "src/App.tsx")).toBe("D:\\repo\\src\\App.tsx");
    expect(relToAbs("/repo", "src/App.tsx")).toBe("/repo/src/App.tsx");
  });
  it("extracts the last path segment either separator style", () => {
    expect(baseName("D:\\repo\\src\\App.tsx")).toBe("App.tsx");
    expect(baseName("/repo/src/App.tsx")).toBe("App.tsx");
    expect(baseName("App.tsx")).toBe("App.tsx");
  });
});

describe("isAncestor", () => {
  it("is true for a direct child", () => {
    expect(isAncestor("D:\\repo", "D:\\repo\\src\\App.tsx")).toBe(true);
  });
  it("is true for the dir itself", () => {
    expect(isAncestor("D:\\repo", "D:\\repo")).toBe(true);
  });
  it("is false for a sibling that merely shares a prefix", () => {
    expect(isAncestor("D:\\repo", "D:\\repo-other\\App.tsx")).toBe(false);
  });
  it("is false for something outside the tree entirely", () => {
    expect(isAncestor("D:\\repo\\src", "D:\\other\\App.tsx")).toBe(false);
  });
});

// A tiny in-memory filesystem for walkFiles — keyed by absolute path,
// values are the DirEntry[] fs_list_dir would return for that directory.
function fakeListDir(fs: Record<string, { name: string; dir: boolean }[]>) {
  return async (path: string) => {
    const entries = fs[path];
    if (!entries) throw new Error("ENOENT");
    return entries;
  };
}

describe("walkFiles", () => {
  it("walks nested directories and reports relPath/depth", async () => {
    const fs = {
      "/root": [{ name: "a.ts", dir: false }, { name: "sub", dir: true }],
      "/root/sub": [{ name: "b.ts", dir: false }],
    };
    const { files, truncated } = await walkFiles(fakeListDir(fs), "/root");
    expect(truncated).toBe(false);
    const byRel = new Map(files.map((f) => [f.relPath, f]));
    expect(byRel.get("a.ts")).toMatchObject({ path: "/root/a.ts", depth: 1 });
    expect(byRel.get("sub/b.ts")).toMatchObject({ path: "/root/sub/b.ts", depth: 2 });
  });

  it("never descends into an ignored directory name", async () => {
    const fs = {
      "/root": [{ name: "node_modules", dir: true }, { name: "keep.ts", dir: false }],
      "/root/node_modules": [{ name: "should-not-appear.ts", dir: false }],
    };
    const { files } = await walkFiles(fakeListDir(fs), "/root");
    expect(files.map((f) => f.relPath)).toEqual(["keep.ts"]);
  });

  it("skips a directory that fails to read and keeps walking siblings", async () => {
    const fs = {
      "/root": [{ name: "denied", dir: true }, { name: "ok.ts", dir: false }],
      // "/root/denied" deliberately missing from the map -> fakeListDir throws
    };
    const { files } = await walkFiles(fakeListDir(fs), "/root");
    expect(files.map((f) => f.relPath)).toEqual(["ok.ts"]);
  });

  it("caps at maxFiles and reports truncated", async () => {
    const fs: Record<string, { name: string; dir: boolean }[]> = {
      "/root": Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.ts`, dir: false })),
    };
    const { files, truncated } = await walkFiles(fakeListDir(fs), "/root", { maxFiles: 3 });
    expect(files.length).toBe(3);
    expect(truncated).toBe(true);
  });

  it("caps at maxDepth and stops descending beyond it", async () => {
    const fs = {
      "/root": [{ name: "d1", dir: true }],
      "/root/d1": [{ name: "d2", dir: true }],
      "/root/d1/d2": [{ name: "too-deep.ts", dir: false }],
    };
    const { files, truncated } = await walkFiles(fakeListDir(fs), "/root", { maxDepth: 1 });
    expect(files).toEqual([]);
    expect(truncated).toBe(true);
  });
});

describe("subsequenceMatch", () => {
  it("matches an ordered subsequence and returns positions", () => {
    const m = subsequenceMatch("src/explorer.css", "exp css");
    expect(m).not.toBeNull();
  });
  it("rejects out-of-order or missing characters", () => {
    expect(subsequenceMatch("Open settings", "stpo")).toBeNull();
    expect(subsequenceMatch("Open settings", "zzz")).toBeNull();
  });
  it("is case-insensitive", () => {
    expect(subsequenceMatch("Open Settings", "OPEN")).not.toBeNull();
  });
  it("scores a tighter/earlier match lower (better) than a looser one", () => {
    const tight = subsequenceMatch("settings.ts", "set");
    const loose = subsequenceMatch("reset-all-settings.ts", "set");
    expect((tight as { score: number }).score).toBeLessThan((loose as { score: number }).score);
  });
  it("returns the matched character indices", () => {
    const m = subsequenceMatch("abcde", "ace");
    expect(m?.positions).toEqual([0, 2, 4]);
  });
  it("empty query matches everything with a zero score", () => {
    expect(subsequenceMatch("anything", "")).toEqual({ score: 0, positions: [] });
  });
});

describe("filterFiles / keepPathsForMatches / buildFilterRows (UX-535)", () => {
  const files = [
    { path: "/root/src/Explorer.tsx", relPath: "src/Explorer.tsx", name: "Explorer.tsx", depth: 2 },
    { path: "/root/src/explorer.css", relPath: "src/explorer.css", name: "explorer.css", depth: 2 },
    { path: "/root/README.md", relPath: "README.md", name: "README.md", depth: 1 },
  ];

  it("matches against the relative path so folder segments count", () => {
    const matches = filterFiles(files, "srcexp");
    expect(matches.map((m) => m.file.relPath).sort()).toEqual(["src/Explorer.tsx", "src/explorer.css"].sort());
  });

  it("an empty query matches nothing (recent files handle the empty case instead)", () => {
    expect(filterFiles(files, "")).toEqual([]);
  });

  it("keeps every ancestor folder of a match, not just the match itself", () => {
    const matches = filterFiles(files, "Explorer.tsx");
    const keep = keepPathsForMatches(matches);
    expect(keep.has("src")).toBe(true);
    expect(keep.has("src/Explorer.tsx")).toBe(true);
    expect(keep.has("README.md")).toBe(false);
  });

  it("builds indented rows with folders marked non-file and sorted so parents precede children", () => {
    const matches = filterFiles(files, "Explorer.tsx");
    const keep = keepPathsForMatches(matches);
    const rows = buildFilterRows(matches, keep);
    expect(rows.map((r) => r.relPath)).toEqual(["src", "src/Explorer.tsx"]);
    expect(rows[0]).toMatchObject({ dir: true, depth: 0, name: "src" });
    expect(rows[1]).toMatchObject({ dir: false, depth: 1, name: "Explorer.tsx" });
  });
});

describe("typeaheadNext (UX-534)", () => {
  const names = ["App.tsx", "Board.tsx", "Cockpit.tsx", "explorer.css", "Explorer.tsx"];

  it("finds the next name starting with the buffer, wrapping from the top", () => {
    expect(typeaheadNext(names, -1, "e")).toBe(3); // "explorer.css" — first case-insensitive match from the top
  });

  it("continues forward from just after the current row", () => {
    expect(typeaheadNext(names, 3, "e")).toBe(4); // wraps past explorer.css to Explorer.tsx
  });

  it("wraps around to the start when nothing matches after the current row", () => {
    expect(typeaheadNext(names, 4, "a")).toBe(0); // App.tsx, wrapping all the way around
  });

  it("returns null when nothing matches at all", () => {
    expect(typeaheadNext(names, 0, "zzz")).toBeNull();
  });

  it("returns null for an empty buffer or empty list", () => {
    expect(typeaheadNext(names, 0, "")).toBeNull();
    expect(typeaheadNext([], 0, "a")).toBeNull();
  });
});

describe("recent files per root (UX-527)", () => {
  it("is empty for a root that has never had a file opened", () => {
    expect(loadRecentFiles("/root/never-used")).toEqual([]);
  });

  it("records the most recent file first", () => {
    pushRecentFile("/root/a", "/root/a/one.ts");
    pushRecentFile("/root/a", "/root/a/two.ts");
    expect(loadRecentFiles("/root/a")).toEqual(["/root/a/two.ts", "/root/a/one.ts"]);
  });

  it("re-opening a file moves it back to the front instead of duplicating it", () => {
    pushRecentFile("/root/b", "/root/b/one.ts");
    pushRecentFile("/root/b", "/root/b/two.ts");
    pushRecentFile("/root/b", "/root/b/one.ts");
    expect(loadRecentFiles("/root/b")).toEqual(["/root/b/one.ts", "/root/b/two.ts"]);
  });

  it("keeps separate lists per root", () => {
    pushRecentFile("/root/c1", "/root/c1/x.ts");
    pushRecentFile("/root/c2", "/root/c2/y.ts");
    expect(loadRecentFiles("/root/c1")).toEqual(["/root/c1/x.ts"]);
    expect(loadRecentFiles("/root/c2")).toEqual(["/root/c2/y.ts"]);
  });

  it("caps the list so a long session can't grow it unbounded", () => {
    for (let i = 0; i < 20; i++) pushRecentFile("/root/d", `/root/d/f${i}.ts`);
    expect(loadRecentFiles("/root/d").length).toBeLessThanOrEqual(15);
  });
});
