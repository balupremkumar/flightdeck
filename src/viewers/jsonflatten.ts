// jsonflatten.ts — the pure core of the JSON tree viewer.
//
// parseJson turns a V8 parse failure into {message, line, column}. flattenJson
// walks only the nodes that are open, so the cost tracks what is visible rather
// than the file: a 5 MB document opened at depth 2 yields a few hundred rows.

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonRow {
  /** JSONPath-style location, e.g. `$.items[3].name`. Also the row's identity. */
  path: string;
  depth: number;
  /** Object key or array index; null for the root. */
  key: string | number | null;
  kind: JsonKind;
  node: unknown;
  /** Child count for containers, 0 otherwise. */
  size: number;
  open: boolean;
}

export interface JsonParseError { message: string; line: number; column: number }
export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: JsonParseError };

export function lineCol(text: string, pos: number): { line: number; column: number } {
  const p = Math.min(Math.max(0, pos), text.length);
  let line = 1, last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < p; i = text.indexOf("\n", i + 1)) { line++; last = i; }
  return { line, column: p - last };
}

export function parseJson(text: string): JsonParseResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { ok: true, value: JSON.parse(src) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lc = /line (\d+) column (\d+)/i.exec(msg);
    if (lc) return { ok: false, error: { message: msg, line: +lc[1], column: +lc[2] } };
    const pos = /position (\d+)/i.exec(msg);
    // Newer V8 messages ("Unexpected token ',', ... is not valid JSON") carry no
    // position, so find it ourselves rather than report line 1.
    const at = pos ? +pos[1] : /end of json/i.test(msg) ? src.length : locateJsonError(src);
    return { ok: false, error: { message: msg, ...lineCol(src, at) } };
  }
}

/** Offset of the first character that breaks the JSON grammar (text length if
 *  it ends early). Only called after JSON.parse has already failed. */
export function locateJsonError(s: string): number {
  let i = 0;
  const ws = () => { while (i < s.length && " \t\n\r".includes(s[i])) i++; };
  const bad = (): never => { throw i; };
  const lit = (w: string) => { if (!s.startsWith(w, i)) bad(); i += w.length; };
  function str() {
    i++; // opening quote
    for (;;) {
      if (i >= s.length) bad();
      const c = s[i];
      if (c === '"') { i++; return; }
      if (c < " ") bad();
      if (c === "\\") {
        const e = s[i + 1];
        if (e === "u") { if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { i += 2; bad(); } i += 6; }
        else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else { i++; bad(); }
      } else i++;
    }
  }
  function value(depth: number) {
    if (depth > 2000) bad();
    ws();
    const c = s[i];
    if (c === "{") {
      i++; ws();
      if (s[i] === "}") { i++; return; }
      for (;;) {
        ws(); if (s[i] !== '"') bad();
        str(); ws(); if (s[i] !== ":") bad();
        i++; value(depth + 1); ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return; }
        bad();
      }
    } else if (c === "[") {
      i++; ws();
      if (s[i] === "]") { i++; return; }
      for (;;) {
        value(depth + 1); ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return; }
        bad();
      }
    } else if (c === '"') str();
    else if (c === "t") lit("true");
    else if (c === "f") lit("false");
    else if (c === "n") lit("null");
    else {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
      if (!m) bad();
      i += (m as RegExpExecArray)[0].length;
    }
  }
  try {
    value(0); ws();
    return i < s.length ? i : 0; // trailing garbage
  } catch (at) {
    return typeof at === "number" ? at : 0;
  }
}

export function kindOf(v: unknown): JsonKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  return t === "object" ? "object" : t === "string" || t === "number" || t === "boolean" ? t : "string";
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
export function pathAppend(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

export interface FlattenOpts {
  /** Is the container at `path` / `depth` (relative to the root) open? */
  isOpen: (path: string, depth: number) => boolean;
  /** Hard stop so a pathological expand-all cannot allocate without bound. */
  maxRows?: number;
}

export interface FlattenResult { rows: JsonRow[]; truncated: boolean }

export function flattenJson(root: unknown, opts: FlattenOpts, rootPath = "$", baseDepth = 0): FlattenResult {
  const max = opts.maxRows ?? 1_000_000;
  const rows: JsonRow[] = [];
  interface Item { node: unknown; key: string | number | null; path: string; depth: number }
  const stack: Item[] = [{ node: root, key: null, path: rootPath, depth: baseDepth }];
  while (stack.length) {
    if (rows.length >= max) return { rows, truncated: true };
    const it = stack.pop() as Item;
    const kind = kindOf(it.node);
    if (kind !== "object" && kind !== "array") {
      rows.push({ path: it.path, depth: it.depth, key: it.key, kind, node: it.node, size: 0, open: false });
      continue;
    }
    const keys = kind === "array" ? null : Object.keys(it.node as object);
    const size = keys ? keys.length : (it.node as unknown[]).length;
    const open = size > 0 && opts.isOpen(it.path, it.depth - baseDepth);
    rows.push({ path: it.path, depth: it.depth, key: it.key, kind, node: it.node, size, open });
    if (!open) continue;
    for (let i = size - 1; i >= 0; i--) {
      const k: string | number = keys ? keys[i] : i;
      const child = keys ? (it.node as Record<string, unknown>)[keys[i]] : (it.node as unknown[])[i];
      stack.push({ node: child, key: k, path: pathAppend(it.path, k), depth: it.depth + 1 });
    }
  }
  return { rows, truncated: false };
}

/** Longest string shown in a row; the full value is still what Copy takes. */
export const MAX_SHOWN = 300;

/** The text of a row as displayed, for find-in-viewer. */
export function rowText(r: JsonRow): string {
  const key = r.key === null ? "" : `${r.key}: `;
  switch (r.kind) {
    case "object": return `${key}{${r.size}}`;
    case "array": return `${key}[${r.size}]`;
    case "string": {
      const s = r.node as string;
      return `${key}"${s.length > MAX_SHOWN ? s.slice(0, MAX_SHOWN) + "…" : s}"`;
    }
    default: return `${key}${String(r.node)}`;
  }
}
