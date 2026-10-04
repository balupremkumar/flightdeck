// termlinks.ts — Phase 1 L3: the pure half of terminal link handling. Terminal.tsx
// owns the xterm wiring; everything here is plain data in, plain data out so it
// can be tested without a terminal.
import { linkify, isRemotePath, type LinkMatch } from "./linkify";

/** The vault root, tried LAST as a base for relative paths (only if it exists).
 *  FUTURE SETTING: when Settings grows a "link base folder" field, read it here
 *  instead of this constant. */
export const VAULT_ROOT = "D:\\Dev\\ai";

/** Ordered, de-duplicated bases for resolving a relative path in a pane:
 *  worktree, last-known cwd, workspace root, vault root. Empty/missing entries
 *  are dropped; duplicates are compared case-insensitively ignoring a trailing
 *  separator (Windows). `vault` should already be checked for existence. */
export function candidateBases(o: { worktree?: string | null; cwd?: string | null; root?: string | null; vault?: string | null }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of [o.worktree, o.cwd, o.root, o.vault]) {
    if (!b) continue;
    const key = b.replace(/[\\/]+$/, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wrapped rows
// ---------------------------------------------------------------------------

export interface RowInfo { text: string; wrapped: boolean }
/** One buffer row's slice of a stitched logical line. `y` is the 1-based buffer
 *  line number xterm uses in link ranges. */
export interface Segment { y: number; offset: number; length: number }
export interface Logical { text: string; segments: Segment[] }
export interface Pos { x: number; y: number }
export interface Range { start: Pos; end: Pos }

/** Stitches the logical line containing buffer line `y` (1-based) across xterm
 *  soft-wrapped rows (`isWrapped` marks a row as the continuation of the one
 *  above). `getRow` must return UNTRIMMED row text (translateToString(false)) so
 *  column offsets stay exact; only the final row's trailing blanks are dropped. */
export function stitchLogical(getRow: (y: number) => RowInfo | undefined, y: number): Logical | null {
  if (!getRow(y)) return null;
  let s = y;
  while (getRow(s)?.wrapped && getRow(s - 1)) s--;
  let e = y;
  while (getRow(e + 1)?.wrapped) e++;
  let text = "";
  const segments: Segment[] = [];
  for (let r = s; r <= e; r++) {
    let t = getRow(r)!.text;
    if (r === e) t = t.replace(/\s+$/, "");
    segments.push({ y: r, offset: text.length, length: t.length });
    text += t;
  }
  return { text, segments };
}

/** Text offset -> 1-based cell position, or null when out of range. */
export function offsetToPos(l: Logical, offset: number): Pos | null {
  for (const seg of l.segments) {
    if (offset >= seg.offset && offset < seg.offset + seg.length) return { x: offset - seg.offset + 1, y: seg.y };
  }
  return null;
}

/** Maps a [start,end) text range to an inclusive xterm link range. A path broken
 *  by a soft wrap comes back as one range spanning two rows. */
export function matchRange(l: Logical, start: number, end: number): Range | null {
  const a = offsetToPos(l, start);
  const b = offsetToPos(l, end - 1);
  return a && b ? { start: a, end: b } : null;
}

const key = (p: Pos) => p.y * 100000 + p.x;
export function rangesOverlap(a: Range, b: Range): boolean {
  return key(a.start) <= key(b.end) && key(b.start) <= key(a.end);
}
export function rangeTouchesRow(r: Range, y: number): boolean {
  return r.start.y <= y && y <= r.end.y;
}

// ---------------------------------------------------------------------------
// Ink-style hard wraps (no isWrapped flag: the app itself broke the line)
// ---------------------------------------------------------------------------

const TOKEN_TAIL = /[^\s"'<>|()[\]{}]+$/;
const TOKEN_HEAD = /^( *)([^\s"'<>|()[\]{}]+)/;

export interface HardWrap {
  match: LinkMatch;
  /** Range covering the path on the upper row and its continuation below. */
  range: Range;
}

/** Conservative join for a path an app hard-wrapped: the upper row's last token
 *  must touch the last column (`cols`) and contain a path separator, and the
 *  lower row must start with a path-like token. Returns the path match that
 *  spans the break, or null. The caller must still prove it exists on disk
 *  before linking it. `upper` is right-trimmed, `upperY`/`lowerY` 1-based. */
export function hardWrapLink(upper: string, lower: string, cols: number, upperY: number, lowerY: number): HardWrap | null {
  if (upper.length < cols) return null;
  const t = TOKEN_TAIL.exec(upper);
  if (!t || !/[\\/]/.test(t[0])) return null;
  const c = TOKEN_HEAD.exec(lower);
  if (!c) return null;
  const tokenLen = t[0].length;
  const joined = t[0] + c[2];
  const match = linkify(joined).find((m) => m.kind === "path" && m.start < tokenLen && m.end > tokenLen);
  if (!match) return null;
  const pos = (off: number): Pos =>
    off < tokenLen ? { x: t.index + off + 1, y: upperY } : { x: c[1].length + (off - tokenLen) + 1, y: lowerY };
  return { match, range: { start: pos(match.start), end: pos(match.end - 1) } };
}

// ---------------------------------------------------------------------------
// OSC 8 file:// URIs
// ---------------------------------------------------------------------------

export interface FileTarget {
  /** Paths to test in order: the full decoded path, then (if it carried a
   *  :line[:col] suffix) the bare path. */
  candidates: string[];
  line?: number;
  col?: number;
}

/** Decodes a `file://` URI from an OSC 8 hyperlink. Returns null for anything
 *  that is not a local file (other schemes, UNC hosts, malformed escapes). */
export function parseFileUri(uri: string): FileTarget | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri.trim());
  if (!m) return null;
  const host = m[1];
  if (host && host.toLowerCase() !== "localhost") return null; // file://server/share is UNC: never linked
  let rest = (m[2] ?? "").replace(/\?.*$/, "");
  let frag: RegExpExecArray | null = null;
  const hi = rest.indexOf("#");
  if (hi >= 0) { frag = /^#L(\d+)(?:C(\d+))?/i.exec(rest.slice(hi)); rest = rest.slice(0, hi); }
  let path: string;
  try { path = decodeURIComponent(rest); } catch { return null; }
  if (!path || path.includes("\0")) return null;
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (/^[A-Za-z]:/.test(path)) path = path.replace(/\//g, "\\");
  if (isRemotePath(path)) return null; // UNC/device in any spelling (`/\srv`, `/%5Csrv`, `//srv`)
  const candidates = [path];
  let line: number | undefined;
  let col: number | undefined;
  const sfx = /:(\d+)(?::(\d+))?$/.exec(path);
  if (sfx && sfx.index > 1) {
    candidates.push(path.slice(0, sfx.index));
    line = Number(sfx[1]);
    col = sfx[2] !== undefined ? Number(sfx[2]) : undefined;
  } else if (frag) {
    line = Number(frag[1]);
    col = frag[2] !== undefined ? Number(frag[2]) : undefined;
  }
  return { candidates, line, col };
}

/** First existing candidate from `resolveCandidates(f.candidates, [])`. The line
 *  and column ride along unless the FULL path (suffix included) was the one that
 *  exists, in which case the suffix was part of the name. */
export function pickFileHit(
  f: FileTarget,
  hits: ({ path: string; isDir: boolean } | null)[]
): { path: string; isDir: boolean; line?: number; col?: number } | null {
  const i = hits.findIndex((h) => h !== null);
  if (i < 0) return null;
  const h = hits[i]!;
  const suffixWasName = f.candidates.length > 1 && i === 0;
  return { path: h.path, isDir: h.isDir, line: suffixWasName ? undefined : f.line, col: suffixWasName ? undefined : f.col };
}

// ---------------------------------------------------------------------------
// Double-activation guard
// ---------------------------------------------------------------------------

/** Claude Code's fullscreen mode can deliver the same OSC 8 activation twice.
 *  Returns a gate: `allow(key)` is false when `key` already fired within
 *  `windowMs`. */
export function createDedupe(windowMs = 700, now: () => number = Date.now): (key: string) => boolean {
  const last = new Map<string, number>();
  return (k) => {
    const t = now();
    const prev = last.get(k);
    if (prev !== undefined && t - prev < windowMs) return false;
    last.set(k, t);
    if (last.size > 50) for (const [kk, tt] of last) if (t - tt >= windowMs) last.delete(kk);
    return true;
  };
}

/** What a resolved terminal link points at; carried to the click handler and the
 *  right-click menu. */
export type LinkTarget =
  | { kind: "path"; path: string; isDir: boolean; line?: number; col?: number }
  | { kind: "url"; url: string };
