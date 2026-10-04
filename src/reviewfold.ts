// reviewfold.ts — Phase 3 (C1) pure helpers behind the Review drawer's
// de-cluttering: unchanged-region folding (QL-715), auto-collapse, and the
// "Viewed" mark with patch-hash invalidation (QL-719). Kept out of Review.tsx
// so the rules are testable without mounting the drawer.

/** Files with more changed lines than this open collapsed. Override with the
 *  localStorage key below until Settings grows a field for it. */
export const AUTO_COLLAPSE_LINES = 300;
export const AUTO_COLLAPSE_KEY = "flightdeck-review-autocollapse";

/** Runs of unchanged context longer than this fold, keeping FOLD_KEEP lines
 *  at each end. */
export const FOLD_MIN_RUN = 8;
export const FOLD_KEEP = 3;

/** Threshold from a raw localStorage value; anything unusable falls back. */
export function autoCollapseThreshold(raw: string | null | undefined, fallback = AUTO_COLLAPSE_LINES): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Binary files, truncated diffs and diffs over the threshold start collapsed. */
export function shouldAutoCollapse(
  file: { added: number; deleted: number; binary?: boolean },
  truncated: boolean,
  threshold = AUTO_COLLAPSE_LINES
): boolean {
  return !!file.binary || truncated || file.added + file.deleted > threshold;
}

/** Why a file is collapsed, for the one-line reason on its header. */
export function collapseReason(
  file: { added: number; deleted: number; binary?: boolean },
  truncated: boolean,
  viewed: boolean,
  threshold = AUTO_COLLAPSE_LINES
): string {
  if (viewed) return "Viewed";
  if (file.binary) return "Binary file";
  if (truncated) return "Diff too large to render fully";
  if (file.added + file.deleted > threshold) return `Large diff (${file.added + file.deleted} changed lines)`;
  return "Collapsed";
}

export interface HiddenRange {
  /** First hidden index. */
  start: number;
  /** One past the last hidden index. */
  end: number;
}

/** Given one flag per displayed line/row (true = unchanged context), returns
 *  the ranges to hide: every run longer than `minRun` keeps `keep` lines at
 *  each end and hides the middle. Runs of `minRun` or fewer are left alone. */
export function foldRuns(isContext: readonly boolean[], minRun = FOLD_MIN_RUN, keep = FOLD_KEEP): HiddenRange[] {
  const out: HiddenRange[] = [];
  let i = 0;
  while (i < isContext.length) {
    if (!isContext[i]) { i++; continue; }
    let j = i;
    while (j < isContext.length && isContext[j]) j++;
    if (j - i > minRun) out.push({ start: i + keep, end: j - keep });
    i = j;
  }
  return out;
}

export type FoldSegment =
  | { kind: "item"; i: number }
  | { kind: "fold"; start: number; end: number };

/** Walks `count` items, replacing each hidden range with a single fold
 *  segment unless that range's `start` is in `expanded` (or `showAll`). */
export function applyFolds(
  count: number,
  ranges: readonly HiddenRange[],
  expanded: ReadonlySet<number>,
  showAll: boolean
): FoldSegment[] {
  const byStart = new Map(ranges.map((r) => [r.start, r]));
  const out: FoldSegment[] = [];
  for (let i = 0; i < count; ) {
    const r = !showAll && !expanded.has(i) ? byStart.get(i) : undefined;
    if (r) { out.push({ kind: "fold", start: r.start, end: r.end }); i = r.end; }
    else { out.push({ kind: "item", i }); i++; }
  }
  return out;
}

/** Deterministic, cheap content hash (FNV-1a 32-bit + length). Not
 *  cryptographic; it only has to notice that a patch changed. */
export function hashPatch(patch: string, counts?: { added: number; deleted: number }): string {
  // The patch is capped, so an edit past the cap would not change it; the
  // file's full added:deleted counts are hashed in so that still invalidates.
  if (counts) patch = `${counts.added}:${counts.deleted}\n${patch}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < patch.length; i++) {
    h ^= patch.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + patch.length.toString(16);
}

/** Viewed marks: path -> hash of the patch when it was ticked. */
export type ViewedMap = Record<string, string>;

/** Reconciles stored marks against the hashes a refresh just computed.
 *  `current[path]` is the fresh hash, or null when it couldn't be fetched
 *  (the mark is kept, nothing is learned). Files absent from `present` are
 *  dropped; a differing hash clears the mark and is reported in `invalidated`. */
export function reconcileViewed(
  viewed: ViewedMap,
  current: Record<string, string | null>,
  present: ReadonlySet<string>
): { viewed: ViewedMap; invalidated: string[] } {
  const next: ViewedMap = {};
  const invalidated: string[] = [];
  for (const [path, hash] of Object.entries(viewed)) {
    if (!present.has(path)) continue;
    const now = current[path];
    if (now != null && now !== hash) { invalidated.push(path); continue; }
    next[path] = hash;
  }
  return { viewed: next, invalidated };
}

// Persistence keys: viewed marks per repo+branch, whitespace toggle per repo.
export const viewedStorageKey = (cwd: string, branch: string | null | undefined) =>
  `flightdeck-review-viewed:${cwd}:${branch ?? ""}`;
export const whitespaceStorageKey = (cwd: string) => `flightdeck-review-nows:${cwd}`;

export function parseViewed(raw: string | null | undefined): ViewedMap {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: ViewedMap = {};
    for (const [k, h] of Object.entries(v as Record<string, unknown>)) if (typeof h === "string") out[k] = h;
    return out;
  } catch {
    return {};
  }
}
