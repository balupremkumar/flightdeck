// difflines.ts — UX-519/UI-617: map each line of a unified patch to its real
// file line numbers (old side, new side), so a click can jump the in-app
// preview to the exact line, and the unified view can show aligned gutters
// the same way `git diff`/GitHub do. Shares its hunk-header parser with
// splitdiff.ts rather than re-deriving it.
import { parseHunkStarts } from "./splitdiff";

export interface PatchLineNo {
  /** 1-based line in the OLD (pre-change) file; null on pure additions, hunk headers and meta lines. */
  oldLine: number | null;
  /** 1-based line in the NEW (current, on-disk) file; null on pure deletions, hunk headers and meta lines. */
  newLine: number | null;
}

const isDel = (s: string) => s.startsWith("-") && !s.startsWith("---");
const isAdd = (s: string) => s.startsWith("+") && !s.startsWith("+++");
const isMeta = (s: string) =>
  s.startsWith("diff ") || s.startsWith("index ") || s.startsWith("+++") || s.startsWith("---") ||
  s.startsWith("new file") || s.startsWith("deleted file") || s.startsWith("similarity ") ||
  s.startsWith("rename ") || s.startsWith("old mode") || s.startsWith("new mode");

/** Walks a unified patch's lines once, tracking both file's line counters
 *  across hunk boundaries. A deleted line only exists on the old side (no
 *  jump target — the current file doesn't have that line); an added or
 *  context line exists on the new side, which is what the preview opens. */
export function mapPatchLines(lines: string[]): PatchLineNo[] {
  const out: PatchLineNo[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    const starts = parseHunkStarts(line);
    if (starts) {
      [oldNo, newNo] = starts;
      out.push({ oldLine: null, newLine: null });
      continue;
    }
    if (isMeta(line)) { out.push({ oldLine: null, newLine: null }); continue; }
    if (isDel(line)) { out.push({ oldLine: oldNo++, newLine: null }); continue; }
    if (isAdd(line)) { out.push({ oldLine: null, newLine: newNo++ }); continue; }
    // Context line (leading space) or a trailing blank — present on both sides.
    out.push({ oldLine: oldNo++, newLine: newNo++ });
  }
  return out;
}
