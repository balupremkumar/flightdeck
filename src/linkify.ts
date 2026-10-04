// linkify.ts — UX-501..503/523 + Phase 1 L1: pure detection of clickable URLs,
// file paths and wikilinks inside a single line of terminal (or other
// plain-text) output.
//
// Conservative by design. Strong structural signals (URL scheme, drive letter,
// leading slash, ./ ../ ~/ %VAR%, a slash path ending in a real extension)
// produce confident matches (`delimited: true`). Weaker shapes (a bare
// filename, a folder like src/components, a drive path joined across spaces,
// a lone /word) are emitted as UNVERIFIED candidates (`delimited: false`):
// callers must check them against the disk before underlining.
//
// Passes claim spans in priority order; later passes never overlap earlier
// ones: wikilink, markdown-link target, url, quoted/backticked/<angle>,
// plain paths, then bare filename/folder candidates.
// See linkify.test.ts for the false-positive suite this was built against.

export interface LinkMatch {
  kind: "url" | "path" | "wikilink";
  /** Exactly the substring `line.slice(start, end)` — what should be
   *  underlined/clickable. Quotes are included for "..." and '...' paths;
   *  backticks, <>, markdown emphasis and sentence punctuation never are. */
  text: string;
  start: number;
  end: number;
  /** The resolvable url/path (or wikilink target) with quotes stripped and any
   *  :line[:col], (line,col), #L12, ", line 12" suffix removed. Feed this to
   *  resolvePath(). A leading ~ or %VAR% is kept. */
  raw: string;
  /** 1-based line number, if the match carried a line suffix. */
  line?: number;
  /** 1-based column number, if the suffix included one. */
  col?: number;
  /** Wikilinks only: the text after `|`, if any. */
  alias?: string;
  /** false = unverified candidate: caller must confirm it exists on disk
   *  before underlining. true/undefined = confident (shape or delimiter makes
   *  it unambiguous). Always set by linkify(). */
  delimited?: boolean;
}

// Characters that never appear inside an unquoted path token: whitespace,
// quotes, angle brackets, pipe, the drive/suffix colon, bracket/paren/brace
// punctuation, backtick and * (markdown), # (anchor / #L12 suffix).
const BODY = `[^\\s"'<>|:()\\[\\]{}\`*#]`;
const URL_BODY = `[^\\s"'<>\\[\\]\`]`;

const URL_RE = new RegExp(`\\bhttps?:\\/\\/${URL_BODY}+`, "g");
const WIN_ABS_RE = new RegExp(`(?<![A-Za-z0-9_])[A-Za-z]:[\\\\/]${BODY}*`, "g");
const ENV_RE = new RegExp(`(?<![\\w%])%[A-Za-z_][A-Za-z0-9_]*%[\\\\/]${BODY}*`, "g");
const TILDE_RE = new RegExp(`(?<![\\w.~/\\\\])~[\\\\/]${BODY}+`, "g");
const POSIX_ABS_RE = /(?<![\w./<\\$%])\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\/?/g;
const DOTREL_RE = new RegExp(`(?<![\\w./])\\.{1,2}[\\\\/]${BODY}+`, "g");
const BARE_REL_RE =
  /(?<![\w./\\@])@?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])/g;
const BARE_FILE_RE = /(?<![\w./\\@%~$-])[A-Za-z0-9_][\w.-]*\.([A-Za-z0-9]{1,10})(?![\w-]|\.\w|[\\/@])/g;
const FOLDER_RE = /(?<![\w./\\@:%~$<-])(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]*/g;

const WIKI_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g;
const MDLINK_RE = /\]\((<?)([^)<>\n]+?)>?\)/g;
const DQ_RE = /(?<!\w)"([^"\n]{1,400})"(?!\w)/g;
const SQ_RE = /(?<!\w)'([^'\n]{1,400})'(?!\w)/g;
const BT_RE = /`([^`\n]{1,400})`/g;
const ANG_RE = /<([^<>\n]{1,400})>/g;

// Spaced-continuation of a drive path: 1-4 space-joined words, then a separator.
const WORD = `(?:[A-Za-z0-9_][A-Za-z0-9_&.+@~-]*|\\([A-Za-z0-9 _.-]{1,20}\\))`;
const SPACED_RE = new RegExp(`((?: ${WORD}){1,4})([\\\\/]${BODY}*)`, "y");
const STOPWORDS = new Set(
  "and or then to in is the with from for on at as but it if of a an by into see are was be not no so that this".split(" ")
);

// Suffix right after a path (anchored at the start of the remaining text).
const SUFFIXES: RegExp[] = [
  /^\((\d+),\s*(\d+)\)/,
  /^:(\d+)(?::(\d+))?(?:-\d+)?/,
  /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?/i,
  /^,\s*line\s+(\d+)(?:,?\s*col(?:umn)?\s+(\d+))?/i,
];
// Same shapes anchored at the END of a delimited inner string.
const INNER_SUFFIX_RE =
  /(?::(\d+)(?::(\d+))?(?:-\d+)?|\((\d+),\s*(\d+)\)|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|,\s*line\s+(\d+)(?:,?\s*col(?:umn)?\s+(\d+))?)$/i;

/** True for a UNC / device / verbatim path in ANY spelling: after a safe
 *  percent-decode and `/` -> backslash it starts with two backslashes (`\\srv`,
 *  `//srv`, `/\srv`, `\/srv`, `%5C%5Csrv`, `/%5Csrv`, `\\?\UNC\`, `\\.\pipe\`).
 *  Remote and device paths are never linked, previewed or read. */
export function isRemotePath(s: string): boolean {
  let d = s.trimStart();
  try { d = decodeURIComponent(d); } catch { d = d.replace(/%5C/gi, "\\").replace(/%2F/gi, "/"); }
  const b = d.replace(/\//g, "\\");
  return b.startsWith("\\\\") || b.startsWith("\\??\\"); // UNC, device, NT namespace
}

const PUNCT_END_RE =/[.,;!?]+$/;
const PREFIX_RE = /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|%[A-Za-z_]\w*%[\\/]|\/[^\s/])/;
const STRONG_RE = /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|%[A-Za-z_]\w*%[\\/])/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

// Extensions accepted for a BARE filename (no slash). Deliberately an
// allowlist: "end.Then", "example.com", "v0.5.5", "e.g" must not light up.
const BARE_EXTS = new Set(
  (
    "md mdx txt json jsonc json5 yaml yml toml ini cfg conf env lock log csv tsv xml html htm css scss less " +
    "ts tsx js jsx mjs cjs vue svelte py rs go java kt kts swift c h cc cpp hpp cs sh bash zsh ps1 psm1 bat cmd " +
    "sql rb php lua pl r dart ex exs erl hs ml scala gradle png jpg jpeg gif svg webp ico bmp pdf doc docx xls " +
    "xlsx ppt pptx zip tar gz tgz rar 7z exe dll msi bin so dylib jar wasm map rst tex ipynb proto graphql gql " +
    "prisma tf pem key patch diff"
  ).split(" ")
);
// Folder names that make an extensionless `a/b` look like a real path.
const KNOWN_DIRS = new Set(
  (
    "src lib libs docs doc test tests spec specs components app apps dist build out public static assets " +
    "node_modules packages pkg tools scripts script bin config configs internal cmd src-tauri target vendor " +
    "examples example e2e demo styles hooks utils plugins release releases archive research projects brain " +
    "templates crates .claude .github .vscode"
  ).split(" ")
);

interface Cand {
  kind: "url" | "path" | "wikilink";
  start: number;
  end: number;
  raw: string;
  delimited: boolean;
  line?: number;
  col?: number;
  alias?: string;
  /** a drive-absolute path whose last segment has no extension */
  absNoExt?: boolean;
  /** relative candidate that must not be the tail of a split abs path */
  rel?: boolean;
}

function suffixAt(rest: string): { len: number; line: number; col?: number } | null {
  const c = rest.charCodeAt(0);
  // fast reject: suffixes start with ( : # ,
  if (c !== 40 && c !== 58 && c !== 35 && c !== 44) return null;
  for (const re of SUFFIXES) {
    const m = re.exec(rest);
    if (m) return { len: m[0].length, line: Number(m[1]), col: m[2] !== undefined ? Number(m[2]) : undefined };
  }
  return null;
}

function lastSeg(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return p.slice(i + 1);
}

function extOf(p: string): string | null {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(lastSeg(p));
  return m && /[A-Za-z]/.test(m[1]) ? m[1] : null;
}

/** Build a path candidate from line[start,end): drops markdown `_` emphasis,
 *  trailing sentence punctuation, then absorbs a line/col suffix. */
function mk(
  lineText: string,
  start: number,
  end: number,
  delimited: boolean,
  extra: Partial<Cand> = {}
): Cand | null {
  let raw = lineText.slice(start, end);
  if (raw[0] === "_" && lineText[end] === "_") {
    start++;
    raw = raw.slice(1);
  }
  const t = raw.replace(PUNCT_END_RE, "");
  end -= raw.length - t.length;
  raw = t;
  if (!raw) return null;
  const s = suffixAt(lineText.slice(end));
  const c: Cand = { kind: "path", start, end, raw, delimited, ...extra };
  if (s) {
    c.end = end + s.len;
    c.line = s.line;
    c.col = s.col;
  }
  return c;
}

function trimUrl(raw: string, emphasisBefore: boolean): string {
  for (;;) {
    const last = raw[raw.length - 1];
    if (last === undefined) return raw;
    if (/[.,;:!?*'"]/.test(last) || (last === "_" && emphasisBefore)) {
      raw = raw.slice(0, -1);
    } else if (last === ")" && count(raw, "(") < count(raw, ")")) {
      raw = raw.slice(0, -1);
    } else return raw;
  }
}

function count(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

function collectUrls(lineText: string, out: Cand[]): void {
  if (lineText.indexOf("http") < 0) return;
  for (const m of lineText.matchAll(URL_RE)) {
    const start = m.index!;
    const raw = trimUrl(m[0], lineText[start - 1] === "_");
    if (raw.length <= (raw.startsWith("https") ? 8 : 7)) continue;
    out.push({ kind: "url", start, end: start + raw.length, raw, delimited: true });
  }
}

interface Whole {
  raw: string;
  line?: number;
  col?: number;
  delimited: boolean;
}

/** Interpret a delimited inner string (quotes/backticks/<>/md target) as ONE path. */
function parseWhole(inner: string, mode: "quote" | "tick" | "angle" | "md"): Whole | null {
  if (isRemotePath(inner) || URL_SCHEME_RE.test(inner)) return null;
  let raw = inner;
  let line: number | undefined;
  let col: number | undefined;
  const sm = INNER_SUFFIX_RE.exec(inner);
  if (sm && sm.index > 0) {
    raw = inner.slice(0, sm.index);
    line = Number(sm[1] ?? sm[3] ?? sm[5] ?? sm[7]);
    const c = sm[2] ?? sm[4] ?? sm[6] ?? sm[8];
    col = c !== undefined ? Number(c) : undefined;
  }
  if (!raw || /^\s|\s$/.test(raw) || /[|*?"<>]/.test(raw) || !/[A-Za-z]/.test(raw)) return null;
  if (/^\.+$/.test(lastSeg(raw)) && !/[\\/]$/.test(raw)) return null;
  if (/^\\[^\\]*$/.test(raw)) return null; // `\r`, `\n`: escapes, not paths
  if (!/[\\/]/.test(raw) && raw[0] === ".") return null; // `.json`: a bare extension, not a file
  const hasSep = /[\\/]/.test(raw);
  const strong = STRONG_RE.test(raw);
  const prefix = PREFIX_RE.test(raw);
  const ext = extOf(raw);
  const trailingSep = /[\\/]$/.test(raw);
  if (mode === "angle" && !strong) return null;
  if (/\s/.test(raw)) {
    if (!hasSep) return null;
    if ((mode === "tick" || mode === "angle") && !prefix) return null;
    if (/\s-{1,2}[A-Za-z]/.test(raw)) return null; // a command with flags
  } else if (!hasSep && !(ext && BARE_EXTS.has(ext.toLowerCase()))) {
    return null;
  }
  let delimited: boolean;
  if (prefix) {
    const singlePosix = /^\/[^/\s]+\/?$/.test(raw) && !ext;
    delimited = !singlePosix;
  } else delimited = hasSep && (ext !== null || trailingSep);
  return { raw, line, col, delimited };
}

function collectDelimited(lineText: string, add: (c: Cand) => void): void {
  // markdown link targets: [x](path with spaces)
  if (lineText.indexOf("](") >= 0) {
    for (const m of lineText.matchAll(MDLINK_RE)) {
      const w = parseWhole(m[2], "md");
      if (!w) continue;
      const start = m.index! + 2 + m[1].length;
      add({ kind: "path", start, end: start + m[2].length, raw: w.raw, line: w.line, col: w.col, delimited: w.delimited });
    }
  }
  for (const [re, mode] of [[DQ_RE, "quote"], [SQ_RE, "quote"]] as const) {
    if (lineText.indexOf(re === DQ_RE ? '"' : "'") < 0) continue;
    for (const m of lineText.matchAll(re)) {
      const w = parseWhole(m[1], mode);
      if (!w) continue;
      const start = m.index!;
      let end = start + m[0].length;
      let { line, col } = w;
      if (line === undefined) {
        const s = suffixAt(lineText.slice(end));
        if (s) {
          end += s.len;
          line = s.line;
          col = s.col;
        }
      }
      add({ kind: "path", start, end, raw: w.raw, line, col, delimited: w.delimited });
    }
  }
  for (const [re, mode] of [[BT_RE, "tick"], [ANG_RE, "angle"]] as const) {
    if (lineText.indexOf(re === BT_RE ? "`" : "<") < 0) continue;
    for (const m of lineText.matchAll(re)) {
      const w = parseWhole(m[1], mode);
      if (!w) continue;
      const start = m.index! + 1;
      add({ kind: "path", start, end: start + m[1].length, raw: w.raw, line: w.line, col: w.col, delimited: w.delimited });
    }
  }
}

/** Extends a drive path across spaces: "D:\a\Kove Clients\STATE.md". Returns the
 *  new end of the (untrimmed) span, or `end` when no safe continuation exists. */
function extendSpaced(lineText: string, start: number, end: number): number {
  const base = lineText.slice(start, end);
  if (PUNCT_END_RE.test(base) || extOf(base)) return end;
  let e = end;
  let best = end;
  for (let i = 0; i < 4; i++) {
    SPACED_RE.lastIndex = e;
    const m = SPACED_RE.exec(lineText);
    if (!m) break;
    const words = m[1].trim().split(" ");
    if (STOPWORDS.has(words[0].toLowerCase()) || words.some((w) => PUNCT_END_RE.test(w))) break;
    e = m.index + m[0].length;
    const t = lineText.slice(start, e);
    if (PUNCT_END_RE.test(t)) {
      if (extOf(t.replace(PUNCT_END_RE, ""))) best = e;
      break;
    }
    if (extOf(t)) {
      best = e;
      break;
    }
    if (/[\\/]$/.test(t)) best = e;
  }
  return best;
}

function collectPlain(lineText: string, out: Cand[]): void {
  const push = (c: Cand | null) => c && out.push(c);
  for (const m of lineText.matchAll(WIN_ABS_RE)) {
    if (m[0].length < 3) continue;
    const start = m.index!;
    const end = m.index! + m[0].length;
    const e2 = extendSpaced(lineText, start, end);
    const c = mk(lineText, start, e2, e2 === end);
    if (!c) continue;
    if (e2 === end && !extOf(c.raw)) c.absNoExt = true;
    // a spaced join must be verified on disk (delimited:false)
    out.push(c);
  }
  for (const m of lineText.matchAll(ENV_RE)) push(mk(lineText, m.index!, m.index! + m[0].length, true));
  for (const m of lineText.matchAll(TILDE_RE)) push(mk(lineText, m.index!, m.index! + m[0].length, true));
  for (const m of lineText.matchAll(POSIX_ABS_RE)) {
    if (m[0].length < 3) continue;
    const c = mk(lineText, m.index!, m.index! + m[0].length, true);
    if (c && /^\/[^/]+\/?$/.test(c.raw) && !extOf(c.raw)) c.delimited = false;
    push(c);
  }
  for (const m of lineText.matchAll(DOTREL_RE)) {
    if (m[0].length < 3) continue;
    push(mk(lineText, m.index!, m.index! + m[0].length, true));
  }
  for (const m of lineText.matchAll(BARE_REL_RE)) {
    const ext = m[0].slice(m[0].lastIndexOf(".") + 1);
    if (!/[A-Za-z]/.test(ext)) continue; // 1.5, http/1.1
    push(mk(lineText, m.index!, m.index! + m[0].length, true, { rel: true }));
  }
}

function collectBare(lineText: string, out: Cand[]): void {
  for (const m of lineText.matchAll(BARE_FILE_RE)) {
    const ext = m[1].toLowerCase();
    if (!BARE_EXTS.has(ext)) continue;
    // "Node.js", "Next.js", "Vue.js": product names, not files
    if (ext === "js" && /^[A-Z][a-z]+$/.test(m[0].slice(0, m[0].length - m[1].length - 1))) continue;
    const c = mk(lineText, m.index!, m.index! + m[0].length, false, { rel: true });
    if (c) out.push(c);
  }
  if (lineText.indexOf("/") < 0 && lineText.indexOf("\\") < 0) return;
  for (const m of lineText.matchAll(FOLDER_RE)) {
    const c = mk(lineText, m.index!, m.index! + m[0].length, false, { rel: true });
    if (!c || c.line !== undefined) continue;
    const trailing = /[\\/]$/.test(c.raw);
    const segs = c.raw.split(/[\\/]/).filter(Boolean);
    if (!segs.length || !/[A-Za-z]/.test(c.raw) || segs.some((s) => s.length < 2 || /^\.+$/.test(s))) continue;
    const known = segs.some((s) => KNOWN_DIRS.has(s.toLowerCase()));
    if (!known) continue;
    if (!trailing && segs.length < 2) continue;
    out.push(c);
  }
}

/** Detects URLs, file paths and wikilinks in a single line of plain text.
 *  Returns matches left-to-right with no overlaps; earlier passes (wikilink,
 *  delimited, url) win over plain paths, which win over bare candidates. */
export function linkify(lineText: string): LinkMatch[] {
  if (!/[./\\~%[]/.test(lineText)) return [];
  const cands: Cand[] = [];
  const overlaps = (s: number, e: number) => cands.some((c) => s < c.end && e > c.start);
  const add = (c: Cand) => {
    if (c.end > c.start && !overlaps(c.start, c.end)) cands.push(c);
  };

  if (lineText.indexOf("[[") >= 0) {
    for (const m of lineText.matchAll(WIKI_RE)) {
      const raw = m[1].trim();
      if (!raw) continue;
      add({ kind: "wikilink", start: m.index!, end: m.index! + m[0].length, raw, alias: m[2]?.trim() || undefined, delimited: true });
    }
  }
  collectDelimited(lineText, add);
  const urls: Cand[] = [];
  collectUrls(lineText, urls);
  urls.forEach(add);

  const settle = (group: Cand[]) => {
    group.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - b.start - (a.end - a.start)));
    for (const c of group) {
      // never link the tail of a split absolute path ("Clients\STATE.md")
      if (c.rel && lineText[c.start - 1] === " " && cands.some((p) => p.absNoExt && p.end === c.start - 1)) continue;
      add(c);
    }
  };
  const plain: Cand[] = [];
  collectPlain(lineText, plain);
  settle(plain);
  const bare: Cand[] = [];
  collectBare(lineText, bare);
  settle(bare);

  cands.sort((a, b) => a.start - b.start);
  return cands.filter((c) => !isRemotePath(c.raw)).map((c) => ({
    kind: c.kind,
    text: lineText.slice(c.start, c.end),
    start: c.start,
    end: c.end,
    raw: c.raw,
    line: c.line,
    col: c.col,
    alias: c.alias,
    delimited: c.delimited,
  }));
}

function isAbsolute(raw: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(raw) || /^\//.test(raw) || /^~[\\/]/.test(raw) || /^%[A-Za-z_]\w*%[\\/]/.test(raw);
}

// Exported so markdown.ts can resolve relative links/images against a .md
// file's own directory with the identical ../. collapsing rule.
export function normalizeSegments(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 1 && /^[A-Za-z]:$/.test(out[0])) continue; // clamp at the drive, never pop it
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(part);
  }
  return out;
}

/** Git Bash `/c/Users/x` and WSL `/mnt/d/Dev` to a drive path (Windows cwd only). */
function mapForeignDrive(raw: string): string | null {
  const m = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(raw) ?? /^\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
  if (!m) return null;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? "").replace(/\//g, "\\")}`;
}

/** Resolves a match's raw path to an absolute path against `cwd`. URLs and
 *  already-absolute paths (Windows drive, POSIX, ~, %VAR%) pass through
 *  unchanged, except Git Bash/WSL drive paths which map to `X:\...` under a
 *  Windows cwd. Do not join a relative path to a UNC cwd — return the raw path. */
export function resolvePath(match: LinkMatch, cwd: string): string {
  if (match.kind === "url") return match.raw;
  const isWin = /^[A-Za-z]:/.test(cwd) || cwd.includes("\\");
  if (isWin) {
    const mapped = mapForeignDrive(match.raw);
    if (mapped) return mapped;
  }
  if (isAbsolute(match.raw)) return match.raw;
  // Avoid producing a UNC result from a relative path joined to a UNC cwd.
  if (/^\\\\/.test(cwd)) return match.raw;

  const cwdSegs = cwd.split(/[\\/]+/).filter(Boolean);
  const relSegs = match.raw.split(/[\\/]+/);
  const merged = normalizeSegments([...cwdSegs, ...relSegs]);
  const sep = isWin ? "\\" : "/";
  return isWin ? merged.join(sep) : "/" + merged.join(sep);
}

/** Toast for any attempt to hand a UNC / device path to the OS opener. */
export const REMOTE_PATH_MSG = "Network paths are not opened from Flightdeck.";
