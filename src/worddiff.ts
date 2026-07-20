// worddiff.ts — UI-166: intra-line (word-level) diff for the review drawer.
//
// A changed line usually differs by a token or two. Showing a solid red line
// above a solid green one makes the reader compare two near-identical strings
// by eye; marking only the tokens that actually differ makes the edit obvious.

export interface Seg {
  text: string;
  /** True when this token differs between the paired -/+ lines. */
  changed: boolean;
}

/** Split into words, runs of whitespace, and single punctuation chars. */
export function tokenize(str: string): string[] {
  return str.match(/\s+|\w+|[^\s\w]/g) ?? [];
}

/** LCS over tokens: which positions on each side are UNCHANGED. */
export function commonTokens(a: string[], b: string[]): { aKeep: boolean[]; bKeep: boolean[] } {
  const n = a.length;
  const m = b.length;
  const aKeep = new Array<boolean>(n).fill(false);
  const bKeep = new Array<boolean>(m).fill(false);
  // LCS is O(n*m). A minified/very long line falls back to "wholly changed"
  // rather than stalling the drawer.
  if (n === 0 || m === 0 || n * m > 40_000) return { aKeep, bKeep };

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aKeep[i] = true;
      bKeep[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { aKeep, bKeep };
}

function segsFor(line: string, keep: boolean[]): Seg[] {
  const toks = tokenize(line);
  const out: Seg[] = [];
  for (let k = 0; k < toks.length; k++) {
    const changed = !keep[k];
    const last = out[out.length - 1];
    // Merge neighbours of the same kind so we render as few spans as possible.
    if (last && last.changed === changed) last.text += toks[k];
    else out.push({ text: toks[k], changed });
  }
  return out;
}

/**
 * Map of patch-line index -> segments, for lines whose counterpart could be
 * identified. Only equal-length -/+ runs are paired; an unequal run is a
 * genuine block insert/delete where word-diffing would be noise.
 */
export function wordDiffMap(lines: string[]): Map<number, Seg[]> {
  const marks = new Map<number, Seg[]>();
  let i = 0;
  while (i < lines.length) {
    const isDel = (s: string) => s.startsWith("-") && !s.startsWith("---");
    const isAdd = (s: string) => s.startsWith("+") && !s.startsWith("+++");
    if (!isDel(lines[i])) {
      i++;
      continue;
    }
    const dels: number[] = [];
    while (i < lines.length && isDel(lines[i])) dels.push(i++);
    const adds: number[] = [];
    while (i < lines.length && isAdd(lines[i])) adds.push(i++);
    if (dels.length !== adds.length) continue;

    for (let k = 0; k < dels.length; k++) {
      const aLine = lines[dels[k]].slice(1);
      const bLine = lines[adds[k]].slice(1);
      const aTok = tokenize(aLine);
      const bTok = tokenize(bLine);
      const { aKeep, bKeep } = commonTokens(aTok, bTok);
      // If nothing matched, the lines are unrelated — leave them plain.
      if (!aKeep.some(Boolean) && !bKeep.some(Boolean)) continue;
      marks.set(dels[k], segsFor(aLine, aKeep));
      marks.set(adds[k], segsFor(bLine, bKeep));
    }
  }
  return marks;
}
