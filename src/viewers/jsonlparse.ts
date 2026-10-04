// jsonlparse.ts — one record per non-empty line, plus the summary chips shown
// for Claude session records (`type`, `message.role`, a short text preview).
import { parseJson } from "./jsonflatten";

export interface JsonlRecord {
  /** 1-based line number in the file (blank lines are skipped but still counted). */
  line: number;
  raw: string;
  value?: unknown;
  error?: string;
}

export interface JsonlParsed { records: JsonlRecord[]; invalid: number }

export function parseJsonl(text: string): JsonlParsed {
  const records: JsonlRecord[] = [];
  let invalid = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = i === 0 && lines[i].charCodeAt(0) === 0xfeff ? lines[i].slice(1) : lines[i];
    if (raw.trim() === "") continue;
    const res = parseJson(raw);
    if (res.ok) records.push({ line: i + 1, raw, value: res.value });
    else { invalid++; records.push({ line: i + 1, raw, error: res.error.message }); }
  }
  return { records, invalid };
}

export interface JsonlChips { type?: string; role?: string; preview: string }

const PREVIEW_MAX = 120;
function tidy(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX) + "…" : t;
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function blockPreview(b: unknown): string | undefined {
  if (typeof b === "string") return str(b);
  if (!b || typeof b !== "object") return undefined;
  const o = b as Record<string, unknown>;
  if (str(o.text)) return o.text as string;
  if (o.type === "tool_use" && str(o.name)) return `tool: ${o.name as string}`;
  if (o.type === "tool_result") return contentPreview(o.content) ?? "tool result";
  if (str(o.thinking)) return o.thinking as string;
  return undefined;
}
function contentPreview(c: unknown): string | undefined {
  if (typeof c === "string") return str(c);
  if (Array.isArray(c)) for (const b of c) { const p = blockPreview(b); if (p) return p; }
  return undefined;
}

/** `type`, `message.role` and a short text preview for a record. Non-objects and
 *  records without recognisable text get a compact key/value preview instead. */
export function extractChips(v: unknown): JsonlChips {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { preview: tidy(JSON.stringify(v) ?? "") };
  const o = v as Record<string, unknown>;
  const msg = o.message && typeof o.message === "object" ? (o.message as Record<string, unknown>) : undefined;
  const type = str(o.type);
  const role = msg ? str(msg.role) : str(o.role);
  const text =
    (msg ? contentPreview(msg.content) : undefined) ??
    str(o.summary) ??
    contentPreview(o.content) ??
    str(o.text) ??
    str(o.message);
  if (text) return { type, role, preview: tidy(text) };
  const rest = Object.entries(o)
    .filter(([k]) => k !== "type")
    .slice(0, 4)
    .map(([k, val]) => `${k}: ${typeof val === "object" && val !== null ? (Array.isArray(val) ? "[…]" : "{…}") : String(val)}`);
  return { type, role, preview: tidy(rest.join("  ")) };
}
