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

import { normalizeSegments } from "./linkify";

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
        if (task) items.push({ children: parseInline(task[2]), checked: task[1].toLowerCase() === "x" });
        else items.push({ children: parseInline(m[3]) });
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
    if (para.length) blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
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
  return /^[A-Za-z]:[\\/]/.test(href) || href.startsWith("/") || href.startsWith("\\\\");
}

/** Anything with a scheme we do not trust: `javascript:`, `file:`, `data:`,
 *  `ms-msdt:` and friends. Rendered inert rather than opened. */
export function isBlockedHref(href: string): boolean {
  return HAS_SCHEME.test(href) && !SAFE_LINK_SCHEMES.test(href) && !isAbsoluteLocalPath(href);
}

export function resolveMdLink(href: string, mdFilePath: string): string {
  if (isExternalHref(href) || href.startsWith("#")) return href;
  // An absolute local path is already resolved; joining it onto the md file's
  // directory would produce nonsense.
  if (isAbsoluteLocalPath(href)) return href.split("#")[0].split("?")[0];
  const clean = href.split("#")[0].split("?")[0];
  if (!clean) return href; // pure "#anchor"/"?query" already handled above; empty guard
  const isWin = /^[A-Za-z]:/.test(mdFilePath) || mdFilePath.includes("\\");
  const sep = isWin ? "\\" : "/";
  const dirSegs = mdFilePath.split(/[\\/]+/);
  dirSegs.pop(); // drop the filename, keep the containing directory
  const relSegs = clean.split("/");
  const merged = normalizeSegments([...dirSegs, ...relSegs]);
  return isWin ? merged.join(sep) : "/" + merged.join(sep);
}
