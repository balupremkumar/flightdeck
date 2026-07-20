import { describe, expect, it } from "vitest";
import { groupByDir } from "./diffgroups";
import type { DiffFile } from "./worktrees";

const f = (path: string, added = 1, deleted = 0): DiffFile => ({ path, added, deleted, binary: false });

describe("directory grouping (UI-167)", () => {
  it("groups files under their containing directory", () => {
    const groups = groupByDir([f("src/a.ts"), f("src/b.ts"), f("src/nested/c.ts")]);
    expect(groups.map((g) => g.dir)).toEqual(["src", "src/nested"]);
    expect(groups[0].files).toHaveLength(2);
  });

  it("treats root files as their own group", () => {
    const groups = groupByDir([f("README.md"), f("src/a.ts")]);
    expect(groups[0]).toMatchObject({ dir: "", added: 1, deleted: 0 });
  });

  it("sums added/deleted per directory", () => {
    const groups = groupByDir([f("src/a.ts", 3, 1), f("src/b.ts", 2, 4)]);
    expect(groups[0]).toMatchObject({ added: 5, deleted: 5 });
  });

  it("survives an empty list", () => {
    expect(groupByDir([])).toEqual([]);
  });
});
