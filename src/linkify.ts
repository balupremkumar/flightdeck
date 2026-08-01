// linkify.ts — UX-501..503/523: pure detection of clickable URLs and file
// paths inside a single line of terminal (or other plain-text) output.
//
// Deliberately conservative: every pattern below is anchored on a strong
// structural signal (a URL scheme, a drive letter, a leading slash, an
// explicit ./ or ../, or a slash-separated path ending in a real extension)
// so ordinary prose — "and/or", "v1.2.3", "12:30", "12345" — never lights up.
// See linkify.test.ts for the false-positive suite this was built against.

export interface LinkMatch {
  kind: "url" | "path";
  /** Exactly the substring `line.slice(start, end)` — what should be
   *  underlined/clickable, including surrounding quotes if any. */
  text: string;
  start: number;
  end: number;
  /** The resolvable url/path with quotes stripped and any :line[:col] or
   *  (line,col) suffix removed. Feed this to resolvePath(). */
  raw: string;
  /** 1-based line number, if the match carried a :line / (line,col) suffix. */
  line?: number;
  /** 1-based column number, if the suffix included one. */
  col?: number;
}

// Characters that never appear inside an unquoted path/url token we detect —
// whitespace, quotes, angle brackets, the shell pipe, the drive/suffix colon,
// and bracket/paren/brace punctuation (so trailing "(...)"/")"/"]" in prose or
// a tsc-style "(12,5)" suffix never gets absorbed into the path body itself).
const BODY = `[^\\s"'<>|:()\\[\\]{}]`;
const URL_BODY = `[^\\s"'<>]`;

const URL_RE = new RegExp(`\\bhttps?:\\/\\/${URL_BODY}+`, "g");
const WIN_ABS_RE = new RegExp(`(?<![A-Za-z0-9_])[A-Za-z]:[\\\\/]${BODY}*`, "g");
const UNC_RE = new RegExp(`\\\\\\\\${BODY}+(?:\\\\${BODY}+)+`, "g");
const POSIX_ABS_RE = new RegExp(`(?<![\\w./])\\/(?:[A-Za-z0-9_.-]+\\/)*[A-Za-z0-9_.-]+`, "g");
const DOTREL_RE = new RegExp(`(?<![\\w./])\\.{1,2}[\\\\/]${BODY}+`, "g");
const BARE_REL_RE = new RegExp(
  `(?<![\\w./])(?:[A-Za-z0-9_.-]+[\\\\/])+[A-Za-z0-9_.-]+\\.[A-Za-z0-9]{1,10}`,
  "g"
);
const QUOTED_RE = /"([^"]{1,400})"|'([^']{1,400})'/g;

const SUFFIX_PAREN_RE = /^\((\d+),(\d+)\)/;
const SUFFIX_COLON_RE = /^:(\d+)(?::(\d+))?/;
const TRIM_TRAILING_RE = /[.,;!?]+$/;

interface RawCandidate {
  kind: "url" | "path";
  start: number;
  end: number;
  raw: string;
  line?: number;
  col?: number;
  text?: string; // pre-computed display text (quoted variant); otherwise derived from the line
}

function collectUrls(lineText: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const m of lineText.matchAll(URL_RE)) {
    let end = m.index! + m[0].length;
    let raw = m[0];
    const trimmed = raw.replace(TRIM_TRAILING_RE, "");
    end -= raw.length - trimmed.length;
    raw = trimmed;
    if (!raw) continue;
    out.push({ kind: "url", start: m.index!, end, raw });
  }
  return out;
}

function withSuffix(lineText: string, start: number, end: number, raw: string): RawCandidate {
  const rest = lineText.slice(end);
  const paren = SUFFIX_PAREN_RE.exec(rest);
  if (paren) {
    return { kind: "path", start, end: end + paren[0].length, raw, line: Number(paren[1]), col: Number(paren[2]) };
  }
  const colon = SUFFIX_COLON_RE.exec(rest);
  if (colon) {
    return {
      kind: "path",
      start,
      end: end + colon[0].length,
      raw,
      line: Number(colon[1]),
      col: colon[2] !== undefined ? Number(colon[2]) : undefined,
    };
  }
  // No suffix — trim any sentence punctuation the greedy body pattern
  // swallowed (e.g. "notes.md." at the end of a sentence).
  const trimmed = raw.replace(TRIM_TRAILING_RE, "");
  return { kind: "path", start, end: end - (raw.length - trimmed.length), raw: trimmed };
}

function collectPlainPaths(lineText: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const re of [WIN_ABS_RE, UNC_RE, POSIX_ABS_RE, DOTREL_RE, BARE_REL_RE]) {
    re.lastIndex = 0;
    for (const m of lineText.matchAll(re)) {
      if (m[0].length < 3) continue; // skip degenerate "/" / ".\" style noise
      out.push(withSuffix(lineText, m.index!, m.index! + m[0].length, m[0]));
    }
  }
  return out;
}

function collectQuotedPaths(lineText: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const m of lineText.matchAll(QUOTED_RE)) {
    const inner = m[1] ?? m[2] ?? "";
    if (!/[\\/]/.test(inner)) continue; // only a path if it actually looks like one
    const start = m.index!;
    const end = start + m[0].length;
    out.push({ kind: "path", start, end, raw: inner, text: m[0] });
  }
  return out;
}

/** Detects URLs and file paths in a single line of plain text. Returns
 *  matches left-to-right with no overlaps — where two candidate patterns
 *  would cover the same span, the earliest-starting (then longest) wins. */
export function linkify(lineText: string): LinkMatch[] {
  const candidates = [...collectUrls(lineText), ...collectQuotedPaths(lineText), ...collectPlainPaths(lineText)]
    .filter((c) => c.end > c.start)
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - b.start - (a.end - a.start)));

  const out: LinkMatch[] = [];
  let lastEnd = -1;
  for (const c of candidates) {
    if (c.start < lastEnd) continue; // overlaps an already-accepted match
    out.push({
      kind: c.kind,
      text: c.text ?? lineText.slice(c.start, c.end),
      start: c.start,
      end: c.end,
      raw: c.raw,
      line: c.line,
      col: c.col,
    });
    lastEnd = c.end;
  }
  return out;
}

function isAbsolute(raw: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw) || /^\//.test(raw);
}

// Exported so markdown.ts can resolve relative links/images against a .md
// file's own directory with the identical ../. collapsing rule.
export function normalizeSegments(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(part);
  }
  return out;
}

/** Resolves a match's raw path to an absolute path against `cwd`. URLs and
 *  already-absolute paths (Windows drive, UNC, POSIX) pass through unchanged. */
export function resolvePath(match: LinkMatch, cwd: string): string {
  if (match.kind === "url") return match.raw;
  if (isAbsolute(match.raw)) return match.raw;

  const isWin = /^[A-Za-z]:/.test(cwd) || cwd.includes("\\");
  const cwdSegs = cwd.split(/[\\/]+/).filter(Boolean);
  const relSegs = match.raw.split(/[\\/]+/);
  const merged = normalizeSegments([...cwdSegs, ...relSegs]);
  const sep = isWin ? "\\" : "/";
  return isWin ? merged.join(sep) : "/" + merged.join(sep);
}
