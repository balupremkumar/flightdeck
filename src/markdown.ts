// markdown.ts — UX-506/507/508: a small, dependency-free markdown -> AST
// parser for the read-only file preview. Deliberately NOT a general-purpose
// CommonMark implementation — it covers the constructs a README/notes file
// actually uses (headings, bold/italic, lists incl. task lists, tables, code
// fences, blockquotes, links, images) and nothing else.
//
// Renders to React elements only (see Preview.tsx) — never to an HTML
// string — so there is no dangerouslySetInnerHTML anywhere in this feature
// and file content can never inject raw HTML/scripts (UX-509's "no raw HTML
// passthrough" requirement falls out of that, rather than needing a
// sanitiser dependency).

import { linkify, normalizeSegments, isRemotePath } from "./linkify";

/** Root that `[[wikilinks]]` resolve against. A constant for now; a future
 *  setting (phase1-links.md, vault root) replaces this. */
export const VAULT_ROOT = "D:\\Dev\\ai";

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "image"; src: string; alt: string };

export interface ListItem {
  children: InlineNode[];
  /** undefined = not a task item; otherwise the checkbox state. */
  checked?: boolean;
}

export type Align = "left" | "center" | "right" | null;

export type BlockNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "code"; lang: string; code: string }
  | { type: "blockquote"; children: BlockNode[] }
  | { type: "table"; align: Align[]; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "hr" };

// ---------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------

const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const LINK_RE = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const CODE_RE = /^`([^`]+)`/;
const WIKI_RE = /^\[\[([^[\]|]+?)(?:\|([^[\]]*))?\]\]/;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) { nodes.push({ type: "text", text: buf }); buf = ""; }
  };

  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (ch === "!" && text[i + 1] === "[") {
      const m = IMAGE_RE.exec(rest);
      if (m) { flush(); nodes.push({ type: "image", alt: m[1], src: m[2] }); i += m[0].length; continue; }
    }
    if (ch === "[" && text[i + 1] === "[") {
      const m = WIKI_RE.exec(rest);
      if (m) {
        flush();
        const w = parseWikilink(m[1], m[2]);
        nodes.push({ type: "link", href: w.href, children: [{ type: "text", text: w.label }] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = LINK_RE.exec(rest);
      if (m) { flush(); nodes.push({ type: "link", href: m[2], children: parseInline(m[1]) }); i += m[0].length; continue; }
    }
    if (ch === "`") {
      const m = CODE_RE.exec(rest);
      if (m) { flush(); nodes.push({ type: "code", text: m[1] }); i += m[0].length; continue; }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const marker = ch + ch;
      const closeIdx = text.indexOf(marker, i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flush();
        nodes.push({ type: "strong", children: parseInline(text.slice(i + 2, closeIdx)) });
        i = closeIdx + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const closeIdx = text.indexOf(ch, i + 1);
      // Word-boundary guard for underscores only — otherwise every
      // snake_case_identifier in a code-ish sentence turns into italics.
      const boundaryOk =
        ch === "*" || (!isWordChar(text[i - 1]) && !isWordChar(text[closeIdx + 1]));
      if (closeIdx !== -1 && closeIdx > i + 1 && boundaryOk) {
        flush();
        nodes.push({ type: "em", children: parseInline(text.slice(i + 1, closeIdx)) });
        i = closeIdx + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return nodes;
}

// ---------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^(```|~~~)\s*(\S*)\s*$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSepRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function alignFor(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

export function parseMarkdown(src: string): BlockNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== marker) { code.push(lines[i]); i++; }
      i++; // consume the closing fence (or EOF)
      blocks.push({ type: "code", lang, code: code.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const qlines: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) { qlines.push(QUOTE_RE.exec(lines[i])![1]); i++; }
      blocks.push({ type: "blockquote", children: parseMarkdown(qlines.join("\n")) });
      continue;
    }

    // Table: a row containing '|' immediately followed by a separator row.
    if (line.includes("|") && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const header = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(alignFor);
      i += 2;
      const rows: InlineNode[][][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m || /\d/.test(m[2]) !== ordered) break;
        const task = TASK_RE.exec(m[3]);
        if (task) items.push({ children: autolinkInline(parseInline(task[2])), checked: task[1].toLowerCase() === "x" });
        else items.push({ children: autolinkInline(parseInline(m[3])) });
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isSepRow(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) blocks.push({ type: "paragraph", children: autolinkInline(parseInline(para.join("\n"))) });
  }

  return blocks;
}

// ---------------------------------------------------------------------
// Link/image resolution (UX-507/508) — pure, so it's unit-testable without
// touching the DOM or Tauri. mdFilePath is the currently-open .md file's own
// absolute path; relative hrefs/srcs resolve against ITS directory, not cwd.
// ---------------------------------------------------------------------

/** Schemes we will hand to the OS opener. Deliberately an ALLOWLIST.
 *
 *  Previewed markdown is untrusted input — a README from any cloned repo. The
 *  earlier "anything with a scheme is external" test also matched `javascript:`,
 *  `file:`, custom protocol handlers, and (because `c:` is a valid scheme shape)
 *  Windows drive-absolute paths like `C:\Windows\System32\calc.exe`. All of
 *  those were being passed to openUrl, i.e. the shell — so a link in someone
 *  else's README could launch a program on click. */
const SAFE_LINK_SCHEMES = /^(https?|mailto|tel):/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isExternalHref(href: string): boolean {
  return SAFE_LINK_SCHEMES.test(href);
}

/** A drive-absolute Windows path (`C:\x`, `C:/x`) or a POSIX absolute path.
 *  Not "external" — it is a local file, and must be treated as one. */
export function isAbsoluteLocalPath(href: string): boolean {
  if (isRemotePath(href)) return false; // UNC/device in any spelling is not local
  return /^[A-Za-z]:[\\/]/.test(href) || href.startsWith("/");
}

/** Anything with a scheme we do not trust: `javascript:`, `file:`, `data:`,
 *  `ms-msdt:` and friends. Rendered inert rather than opened. */
export function isBlockedHref(href: string): boolean {
  if (isRemotePath(href)) return true;
  return HAS_SCHEME.test(href) && !SAFE_LINK_SCHEMES.test(href) && !isAbsoluteLocalPath(href);
}

export function resolveMdLink(href: string, mdFilePath: string): string {
  if (isExternalHref(href) || href.startsWith("#")) return href;
  if (isRemotePath(href)) return href; // stays remote so every reader rejects it
  // An absolute local path is already resolved; joining it onto the md file's
  // directory would produce nonsense.
  if (isAbsoluteLocalPath(href)) return safeDecode(href.split("#")[0].split("?")[0]);
  const clean = safeDecode(href.split("#")[0].split("?")[0]);
  if (!clean) return href; // pure "#anchor"/"?query" already handled above; empty guard
  const isWin = /^[A-Za-z]:/.test(mdFilePath) || mdFilePath.includes("\\");
  const sep = isWin ? "\\" : "/";
  const dirSegs = mdFilePath.split(/[\\/]+/);
  dirSegs.pop(); // drop the filename, keep the containing directory
  const relSegs = clean.split(/[\\/]/);
  const merged = normalizeSegments([...dirSegs, ...relSegs]);
  return isWin ? merged.join(sep) : "/" + merged.join(sep);
}

/** decodeURIComponent that never throws: a lone `%` (a literal filename like
 *  `100%.md`) just stays as typed. */
export function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ---------------------------------------------------------------------
// Heading slugs (GitHub style) for `#anchor` links
// ---------------------------------------------------------------------

/** Flattens inline nodes to their visible text (for heading slugs). */
export function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text": case "code": return n.text;
        case "image": return n.alt;
        default: return inlineText(n.children);
      }
    })
    .join("");
}

/** GitHub's heading slug: lowercase, drop everything but letters, digits,
 *  spaces, `-` and `_`, then spaces become `-`. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");
}

/** Returns a function that slugs headings in document order, de-duplicating
 *  repeats the way GitHub does (`intro`, `intro-1`, `intro-2`). */
export function makeSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

// ---------------------------------------------------------------------
// Wikilinks `[[path|alias]]` / `[[path]]`
// ---------------------------------------------------------------------

/** Resolves a wikilink target against VAULT_ROOT. `.md` is appended when the
 *  last segment has no extension; a `#suffix` (anchor or L12) is preserved.
 *  The result is an absolute local path, so it goes through the same
 *  open-in-preview route as any other local link. */
export function parseWikilink(target: string, alias?: string): { href: string; label: string } {
  const t = target.trim();
  if (isRemotePath(t)) return { href: "blocked:remote-path", label: alias?.trim() || "remote path" };
  const hashAt = t.indexOf("#");
  const pathPart = hashAt === -1 ? t : t.slice(0, hashAt);
  const suffix = hashAt === -1 ? "" : t.slice(hashAt);
  const segs = pathPart.split(/[\\/]/).filter(Boolean);
  const last = segs[segs.length - 1] ?? pathPart;
  const label = alias?.trim() || last;
  let file = pathPart;
  if (!/\.[A-Za-z0-9]+$/.test(last)) file += ".md";
  const abs = isAbsoluteLocalPath(file) ? file : `${VAULT_ROOT}\\${file}`;
  const norm = abs.replace(/\//g, "\\");
  // Encode `%` so resolveMdLink's percent-decoding leaves a literal one alone.
  return { href: norm.replace(/%/g, "%25") + suffix, label };
}

// ---------------------------------------------------------------------
// Bare paths / URLs in prose
// ---------------------------------------------------------------------

/** Turns bare URLs and paths in plain text nodes into link nodes. Reuses
 *  linkify() unchanged. Links/code are left alone; strong/em are recursed. */
export function autolinkInline(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const n of nodes) {
    if (n.type === "strong" || n.type === "em") {
      out.push({ ...n, children: autolinkInline(n.children) });
      continue;
    }
    if (n.type !== "text") { out.push(n); continue; }
    let last = 0;
    for (const m of linkify(n.text)) {
      let href: string;
      if (m.kind === "url") {
        if (!isExternalHref(m.raw)) continue;
        href = m.raw;
      } else if (m.kind === "path") {
        if (isRemotePath(m.raw)) continue; // UNC/device is never linked
        if (!/[\\/]/.test(m.raw)) continue; // a lone word is not obviously a path
        href = m.raw.replace(/%/g, "%25") + (m.line ? `#L${m.line}` : "");
      } else continue;
      if (m.start > last) out.push({ type: "text", text: n.text.slice(last, m.start) });
      out.push({ type: "link", href, children: [{ type: "text", text: m.text }] });
      last = m.end;
    }
    if (last === 0) out.push(n);
    else if (last < n.text.length) out.push({ type: "text", text: n.text.slice(last) });
  }
  return out;
}

// ---------------------------------------------------------------------
// Link target parsing (anchors, line targets, relative resolution)
// ---------------------------------------------------------------------

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; line?: number; anchor?: string };

const LINE_FRAG_RE = /^L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i;
const PATH_LINE_RE = /^(.*\.[A-Za-z0-9]+):(\d+)(?::\d+)?$/;

/** Classifies a markdown link target. `path` is always absolute (a bare
 *  `#anchor` resolves to mdPath itself). `file.md#L12` and `file.ts:12[:5]`
 *  yield `line`; any other `#fragment` yields `anchor` (percent-decoded). */
export function parseLinkTarget(href: string, mdPath: string): LinkTarget {
  if (isExternalHref(href)) return { kind: "external", url: href };
  if (isRemotePath(href)) return { kind: "file", path: href }; // stays remote; every reader rejects it
  const noQuery = href.split("?")[0];
  const hashAt = noQuery.indexOf("#");
  let pathPart = hashAt === -1 ? noQuery : noQuery.slice(0, hashAt);
  const frag = hashAt === -1 ? "" : safeDecode(noQuery.slice(hashAt + 1));
  let line: number | undefined;
  let anchor: string | undefined;
  const lm = LINE_FRAG_RE.exec(frag);
  if (lm) line = Number(lm[1]);
  else if (frag) anchor = frag;
  if (line === undefined) {
    const pl = PATH_LINE_RE.exec(pathPart);
    if (pl) { pathPart = pl[1]; line = Number(pl[2]); }
  }
  const path = pathPart === "" ? mdPath : resolveMdLink(pathPart, mdPath);
  return { kind: "file", path, ...(line !== undefined ? { line } : {}), ...(anchor ? { anchor } : {}) };
}
