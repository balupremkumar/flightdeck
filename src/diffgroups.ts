// diffgroups.ts — UI-167: group a changed-file list by directory once it's too
// long to scan flat. Below the threshold the caller keeps the plain list —
// grouping ten files just adds chrome for no gain.
import type { DiffFile } from "./worktrees";

export interface FileGroup {
  /** Directory the files live in, relative to repo root. "" is the root itself. */
  dir: string;
  files: DiffFile[];
  added: number;
  deleted: number;
}

/** Files keep their incoming order within a group; groups appear in the order
 * their first file was seen. Git already returns paths sorted, so that keeps
 * directories in a stable, predictable order across reloads. */
export function groupByDir(files: DiffFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    const slash = f.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : f.path.slice(0, slash);
    let g = groups.get(dir);
    if (!g) { g = { dir, files: [], added: 0, deleted: 0 }; groups.set(dir, g); }
    g.files.push(f);
    g.added += f.added;
    g.deleted += f.deleted;
  }
  return [...groups.values()];
}
