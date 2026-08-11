// quickopen.ts — pure, framework-free logic behind UX-526 (global quick-open,
// Ctrl+P), UX-527 (per-workspace recent files), UX-534 (tree type-to-jump)
// and UX-535 (Explorer subsequence filter). No React/Tauri imports here —
// quickopen.tsx and Explorer.tsx do the wiring and own the actual `invoke`
// calls; keeping this file plain data in/out is what makes the scoring and
// walking rules testable without mounting anything.

export interface DirEntry { name: string; dir: boolean; }

// Directories that are never descended into by the recursive walk below —
// same noise list Explorer.tsx already dims (IGNORED_NAMES there); moved
// here so both the plain tree and the walker agree on what counts as noise
// without keeping two copies in sync by hand.
export const IGNORED_DIR_NAMES = new Set([
  "node_modules", "target", "dist", "build", ".git", ".next", "out",
  ".cache", "__pycache__", ".venv", "venv", ".turbo", ".parcel-cache",
]);

/** Joins a child name onto a parent path, inferring the separator from the
 *  parent so a POSIX root stays POSIX and a Windows root stays Windows —
 *  mirrors Explorer.tsx's original joinPath exactly (moved here so the
 *  walker and the tree share one implementation). */
export function joinPath(parent: string, name: string): string {
  const sep = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  return parent.replace(/[\\/]+$/, "") + sep + name;
}

/** Rebuilds an absolute path from a root and a forward-slash-joined relative
 *  path (as produced by walkFiles/relPath below), using the root's own
 *  separator convention. */
export function relToAbs(root: string, relPath: string): string {
  const sep = root.includes("/") && !root.includes("\\") ? "/" : "\\";
  return root.replace(/[\\/]+$/, "") + sep + relPath.split("/").join(sep);
}

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** True when `targetPath` is `dirPath` itself or lives somewhere under it,
 *  using `dirPath`'s own separator convention (matches joinPath's rule).
 *  Shared by Explorer's reveal-active-file (ancestor-chain expansion) and
 *  its "is this preview even inside this root" containment check. */
export function isAncestor(dirPath: string, targetPath: string): boolean {
  const sep = dirPath.includes("/") && !dirPath.includes("\\") ? "/" : "\\";
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const d = norm(dirPath);
  const t = norm(targetPath);
  return t === d || t.startsWith(d + sep);
}

export interface WalkedFile { path: string; relPath: string; name: string; depth: number; }
export interface WalkResult { files: WalkedFile[]; truncated: boolean; }

// QL-741: the old ceilings (4000/4000/depth 14) were low enough that an
// ordinary monorepo fell off the end of the index — quick-open would simply
// deny that a file existed, with no note saying so. Raised to something a
// real repo fits inside. The extra ceiling is paid for below rather than in
// wall-clock: directories are read in parallel batches (one await per batch,
// not per directory) and partial results are handed back through onProgress
// as they are found, so the overlay paints while the walk is still running.
const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_DIRS = 20000;
const DEFAULT_MAX_DEPTH = 24;
/** Directories listed per await. Each listDir is an IPC round trip, so this
 *  walk is latency-bound, not CPU-bound: batching 12 turns a 2000-directory
 *  repo from 2000 sequential round trips into ~167, while still leaving the
 *  channel free for the cockpit's own polling between batches. */
const DEFAULT_CONCURRENCY = 12;
/** Floor between onProgress callbacks. One callback per batch would re-render
 *  a 20k-row list dozens of times for no visible gain; the first batch always
 *  reports so the list fills immediately. */
const PROGRESS_INTERVAL_MS = 120;

export interface WalkOptions {
  maxFiles?: number;
  maxDirs?: number;
  maxDepth?: number;
  concurrency?: number;
  /** Called with a snapshot (a copy, safe to hold) of everything found so
   *  far, after the first batch and then at most every PROGRESS_INTERVAL_MS.
   *  Lets a caller render an incomplete index instead of a spinner. */
  onProgress?: (files: WalkedFile[]) => void;
  /** Polled once per batch; returning true abandons the walk and returns what
   *  was found. Callers use it when nobody is waiting on the result any more
   *  (overlay closed, newer walk started) so a big repo stops costing IPC. */
  shouldCancel?: () => boolean;
}

/** Breadth-first recursive file listing built on the same one-level
 *  `listDir` the Explorer tree already calls (fs_list_dir) — there is no
 *  recursive Rust command yet (see the delivery report's HANDOFF EDITS for
 *  the follow-up worth adding). Hard-capped on files found and directories
 *  visited so a huge repo returns fast with an honest `truncated` flag
 *  instead of hanging; IGNORED_DIR_NAMES are never descended into. A
 *  directory read failure (permission denied, races with a delete) skips
 *  that one subtree and keeps going rather than aborting the whole walk. */
export async function walkFiles(
  listDir: (path: string) => Promise<DirEntry[]>,
  root: string,
  opts: WalkOptions = {}
): Promise<WalkResult> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDirs = opts.maxDirs ?? DEFAULT_MAX_DIRS;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

  const files: WalkedFile[] = [];
  const queue: Array<{ path: string; relPath: string; depth: number }> = [{ path: root, relPath: "", depth: 0 }];
  let dirsVisited = 0;
  let truncated = false;
  let reported = 0;
  let reportedAt = 0;

  while (queue.length > 0) {
    if (opts.shouldCancel?.()) break;
    if (files.length >= maxFiles || dirsVisited >= maxDirs) { truncated = true; break; }
    // One await per batch instead of per directory. Entries are still
    // consumed in queue order afterwards, so the BFS ordering (and therefore
    // the result order a caller sees) is exactly what it was before.
    const batch = queue.splice(0, Math.min(concurrency, maxDirs - dirsVisited));
    dirsVisited += batch.length;
    const listings = await Promise.all(batch.map((d) => listDir(d.path).catch(() => null)));
    let full = false;
    for (let i = 0; i < batch.length && !full; i++) {
      const dir = batch[i];
      const entries = listings[i];
      if (!entries) continue; // unreadable subtree — skip it, keep walking
      for (const e of entries) {
        const relPath = dir.relPath ? `${dir.relPath}/${e.name}` : e.name;
        if (e.dir) {
          if (IGNORED_DIR_NAMES.has(e.name)) continue; // deliberate exclusion, not a cap — doesn't count as truncated
          if (dir.depth + 1 > maxDepth) { truncated = true; continue; }
          queue.push({ path: joinPath(dir.path, e.name), relPath, depth: dir.depth + 1 });
        } else {
          files.push({ path: joinPath(dir.path, e.name), relPath, name: e.name, depth: dir.depth + 1 });
          if (files.length >= maxFiles) { truncated = true; full = true; break; }
        }
      }
    }
    if (opts.onProgress && files.length > reported) {
      const now = Date.now();
      if (reported === 0 || now - reportedAt >= PROGRESS_INTERVAL_MS) {
        reported = files.length;
        reportedAt = now;
        opts.onProgress(files.slice());
      }
    }
  }
  // Anything still queued means a cap (or a cancel) stopped us short of the
  // whole tree — the caller is expected to say so rather than pretend.
  if (queue.length > 0) truncated = true;
  return { files, truncated };
}

export interface MatchResult { score: number; positions: number[]; }

/** Ordered-subsequence match: every character of `query` must appear in
 *  `haystack` in order (not necessarily contiguous). Lower score is better;
 *  null means no match. Whitespace in the query is stripped before matching
 *  (typing "exp css" to reach "src/explorer.css" is a space-separated hint,
 *  not a literal space that must appear in the path). Mirrors
 *  CommandPalette's fuzzyScore rules (earlier and tighter runs score best)
 *  but also returns the matched character indices so a caller can highlight
 *  them — shared by quick-open's ranking and the Explorer filter box
 *  (UX-535), which fuzzyScore alone can't serve since it doesn't expose
 *  positions. */
export function subsequenceMatch(haystack: string, query: string): MatchResult | null {
  const q = query.trim();
  if (!q) return { score: 0, positions: [] };
  const s = haystack.toLowerCase();
  const ql = q.toLowerCase().replace(/\s+/g, "");
  if (!ql) return { score: 0, positions: [] };
  let si = 0, score = 0, streak = 0;
  const positions: number[] = [];
  for (let qi = 0; qi < ql.length; qi++) {
    const idx = s.indexOf(ql[qi], si);
    if (idx === -1) return null;
    score += (idx - si) + (streak > 0 ? 0 : 1);
    streak = idx === si ? streak + 1 : 0;
    positions.push(idx);
    si = idx + 1;
  }
  return { score, positions };
}

export interface FilterMatch { file: WalkedFile; score: number; positions: number[]; }

/** Subsequence-filters a flat file list against each file's relative path
 *  (so folder segments count too — "exp css" reaches src/explorer.css),
 *  best score first, capped so a huge match set can't blow up a render. */
export function filterFiles(files: WalkedFile[], query: string, limit = 300): FilterMatch[] {
  const q = query.trim();
  if (!q) return [];
  const out: FilterMatch[] = [];
  for (const f of files) {
    const m = subsequenceMatch(f.relPath, q);
    if (m) out.push({ file: f, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, limit);
}

/** UX-535: expands a set of filter matches into every relPath that must
 *  stay visible to show them — each match plus every one of its ancestor
 *  folders — so a filtered tree can show matched parents for context
 *  instead of a flat, disconnected list of hits. */
export function keepPathsForMatches(matches: FilterMatch[]): Set<string> {
  const keep = new Set<string>();
  for (const m of matches) {
    const segs = m.file.relPath.split("/");
    let acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      keep.add(acc);
    }
  }
  return keep;
}

export interface FilterRow { relPath: string; name: string; dir: boolean; depth: number; }

/** Turns the keep-set from keepPathsForMatches into an ordered, indented row
 *  list for rendering. Lexicographic sort on the full relPath naturally
 *  places a folder immediately before its own children (a strict prefix
 *  always sorts first), so no separate tree-building pass is needed. Depth
 *  is the number of path segments minus one (0 = top level). */
export function buildFilterRows(matches: FilterMatch[], keep: Set<string>): FilterRow[] {
  const matchPaths = new Set(matches.map((m) => m.file.relPath));
  const rows: FilterRow[] = [...keep].map((relPath) => {
    const segs = relPath.split("/");
    return { relPath, name: segs[segs.length - 1], dir: !matchPaths.has(relPath), depth: segs.length - 1 };
  });
  rows.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return rows;
}

/** UX-534: given the visible row names in tree order and the index of the
 *  currently focused row, finds the next row whose name starts with
 *  `buffer` (case-insensitive), searching forward from just after
 *  `fromIndex` and wrapping around — standard listbox typeahead. Returns
 *  null when nothing matches at all. `fromIndex` of -1 (nothing focused)
 *  searches the whole list from the top. */
export function typeaheadNext(names: string[], fromIndex: number, buffer: string): number | null {
  const b = buffer.toLowerCase();
  const n = names.length;
  if (!b || n === 0) return null;
  const start = fromIndex < 0 ? -1 : fromIndex;
  for (let step = 1; step <= n; step++) {
    const idx = (start + step) % n;
    if (names[idx].toLowerCase().startsWith(b)) return idx;
  }
  return null;
}

// ---------------------------------------------------------------------
// Recent files per workspace/pane root (UX-527). Persisted so the list
// survives a relaunch, same pattern as Explorer's own EXPAND_KEY.
// ---------------------------------------------------------------------
const RECENT_FILES_KEY = "flightdeck-quickopen-recent";
const RECENT_FILES_CAP = 15;

function loadRecentMap(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "{}") as Record<string, string[]>; } catch { return {}; }
}
function saveRecentMap(map: Record<string, string[]>) {
  try { localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(map)); } catch { /* non-persistent */ }
}

/** Recent files opened under `root` (a workspace or pane root path),
 *  newest first. */
export function loadRecentFiles(root: string): string[] {
  return loadRecentMap()[root] ?? [];
}

/** Records `path` as the most-recently-opened file under `root` — called
 *  from both quick-open's own selection and Explorer's open actions, so a
 *  file shows up as "recent" no matter which surface opened it. */
export function pushRecentFile(root: string, path: string) {
  const map = loadRecentMap();
  const list = [path, ...(map[root] ?? []).filter((p) => p !== path)].slice(0, RECENT_FILES_CAP);
  map[root] = list;
  saveRecentMap(map);
}
