// Pure helpers for the CSV/TSV viewer (V2b). No DOM, no React.
import Papa from "papaparse";

export type Delimiter = "," | "\t" | ";" | "|";

export interface ParsedCsv {
  rows: string[][];
  delimiter: Delimiter;
  columns: number; // widest row
  ragged: boolean; // rows disagree on column count
}

const CANDIDATES: Delimiter[] = [",", "\t", ";", "|"];

export function delimiterForPath(path: string): Delimiter | null {
  const p = path.toLowerCase();
  if (p.endsWith(".tsv") || p.endsWith(".tab")) return "\t";
  if (p.endsWith(".csv")) return ",";
  return null;
}

/** Pick the candidate with the most consistent non-zero per-line count over the first lines. */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 20000).split(/\r\n|\n|\r/).filter((l) => l.length).slice(0, 20);
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = sample.map((l) => l.split(d).length - 1);
    if (!counts.length) continue;
    const min = Math.min(...counts);
    if (min === 0) continue;
    const score = min * counts.length;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCsv(text: string, path: string): ParsedCsv {
  const clean = stripBom(text);
  const delimiter = delimiterForPath(path) ?? detectDelimiter(clean);
  const res = Papa.parse<string[]>(clean, { delimiter, skipEmptyLines: true, header: false });
  const rows = res.data.map((r) => r.map((c) => (c == null ? "" : String(c))));
  let columns = 0;
  let ragged = false;
  for (const r of rows) {
    if (columns && r.length !== columns) ragged = true;
    if (r.length > columns) columns = r.length;
  }
  return { rows, delimiter, columns, ragged };
}

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/,(?=\d{3}(\D|$))/g, "");
  if (!t || !NUM_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** First row is a header when every cell is non-numeric, non-empty and unique (and data follows). */
export function detectHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (!first.length) return false;
  const seen = new Set<string>();
  for (const c of first) {
    const t = c.trim();
    if (!t || parseNumber(t) !== null || seen.has(t)) return false;
    seen.add(t);
  }
  return true;
}

export type SortDir = "asc" | "desc";

/** Numeric when both parse, else natural string compare; numbers before text; empty cells always last. */
export function compareCells(a: string, b: string, dir: SortDir): number {
  const ea = a.trim() === "";
  const eb = b.trim() === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const na = parseNumber(a);
  const nb = parseNumber(b);
  let c: number;
  if (na !== null && nb !== null) c = na - nb;
  else if (na !== null) c = -1;
  else if (nb !== null) c = 1;
  else c = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

/** Row indices (from `from`) ordered by a column; stable. null means "no sort". */
export function sortedOrder(rows: string[][], col: number, dir: SortDir | null, from = 0): number[] | null {
  if (dir === null) return null;
  const idx: { i: number; n: number }[] = [];
  for (let i = from; i < rows.length; i++) idx.push({ i, n: idx.length });
  idx.sort((x, y) => compareCells(rows[x.i][col] ?? "", rows[y.i][col] ?? "", dir) || x.n - y.n);
  return idx.map((x) => x.i);
}

/** Cycle none, asc, desc, none. */
export function nextSort(cur: SortDir | null): SortDir | null {
  return cur === null ? "asc" : cur === "asc" ? "desc" : null;
}

export interface Range { start: number; end: number } // end exclusive

/** Visible row window with overscan, clamped to [0, total]. */
export function visibleRange(scrollTop: number, rowHeight: number, viewport: number, total: number, overscan = 8): Range {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + Math.max(0, viewport)) / rowHeight);
  return { start: Math.max(0, Math.min(total, first - overscan)), end: Math.min(total, last + overscan) };
}

export function clampWidth(w: number, min = 48, max = 800): number {
  return Math.min(max, Math.max(min, Math.round(w)));
}
