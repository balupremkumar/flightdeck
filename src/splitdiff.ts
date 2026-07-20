// splitdiff.ts — UI-165: turn a unified patch into aligned side-by-side rows.
//
// Unified diffs are compact but make you reconstruct "what did this line become"
// in your head. A split view answers that spatially. The alignment rule: within
// a hunk, a run of deletions pairs positionally with the run of additions that
// follows it; leftovers on either side become half-rows.

export type RowKind = "context" | "change" | "add" | "del" | "hunk" | "meta";

export interface SplitRow {
  kind: RowKind;
  /** Original-side text (no +/- marker). Absent for a pure addition. */
  left?: string;
  /** New-side text. Absent for a pure deletion. */
  right?: string;
  /** 1-based line numbers, when the hunk header gave us a starting point. */
  leftNo?: number;
  rightNo?: number;
  /** Index into the original patch lines, so hunk jumping still works. */
  index: number;
}

const isDel = (s: string) => s.startsWith("-") && !s.startsWith("---");
const isAdd = (s: string) => s.startsWith("+") && !s.startsWith("+++");
const isMeta = (s: string) =>
  s.startsWith("diff ") || s.startsWith("index ") || s.startsWith("+++") || s.startsWith("---") ||
  s.startsWith("new file") || s.startsWith("deleted file") || s.startsWith("similarity ") ||
  s.startsWith("rename ") || s.startsWith("old mode") || s.startsWith("new mode");

/** "@@ -12,7 +12,9 @@" -> [12, 12]; null when it isn't a hunk header. */
export function parseHunkStarts(line: string): [number, number] | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

export function toSplitRows(lines: string[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const starts = parseHunkStarts(line);
    if (starts) {
      [leftNo, rightNo] = starts;
      rows.push({ kind: "hunk", left: line, index: i });
      i++;
      continue;
    }

    if (isMeta(line)) {
      rows.push({ kind: "meta", left: line, index: i });
      i++;
      continue;
    }

    if (isDel(line) || isAdd(line)) {
      const dels: number[] = [];
      while (i < lines.length && isDel(lines[i])) dels.push(i++);
      const adds: number[] = [];
      while (i < lines.length && isAdd(lines[i])) adds.push(i++);

      const pairs = Math.max(dels.length, adds.length);
      for (let k = 0; k < pairs; k++) {
        const d = dels[k];
        const a = adds[k];
        rows.push({
          kind: d !== undefined && a !== undefined ? "change" : d !== undefined ? "del" : "add",
          left: d !== undefined ? lines[d].slice(1) : undefined,
          right: a !== undefined ? lines[a].slice(1) : undefined,
          leftNo: d !== undefined ? leftNo++ : undefined,
          rightNo: a !== undefined ? rightNo++ : undefined,
          // Anchor on whichever side exists, so hunk navigation still resolves.
          index: d ?? a,
        });
      }
      continue;
    }

    // Context (leading space) or a blank trailing line.
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      kind: "context",
      left: text,
      right: text,
      leftNo: leftNo++,
      rightNo: rightNo++,
      index: i,
    });
    i++;
  }

  return rows;
}
