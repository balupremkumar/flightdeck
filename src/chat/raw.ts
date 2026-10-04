// Extraction from a full raw JSONL record (session_record) for on-demand
// expansion. Defensive: the shape is Claude Code's, not ours.
export interface EditPair { path: string; oldText: string; newText: string }
export interface DiffLine { t: "-" | "+"; s: string }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function blocks(raw: unknown): Obj[] {
  if (!isObj(raw)) return [];
  const m = raw.message;
  const c = isObj(m) ? m.content : undefined;
  return Array.isArray(c) ? c.filter(isObj) : [];
}

export function toolInput(raw: unknown, toolId: string): Obj | null {
  for (const b of blocks(raw)) if (b.type === "tool_use" && b.id === toolId && isObj(b.input)) return b.input;
  return null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function editPairs(name: string, input: Obj | null): EditPair[] {
  if (!input) return [];
  const path = str(input.file_path) || str(input.notebook_path);
  if (name === "Write") return [{ path, oldText: "", newText: str(input.content) }];
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.filter(isObj).map((e) => ({ path, oldText: str(e.old_string), newText: str(e.new_string) }));
  }
  if (name === "Edit") return [{ path, oldText: str(input.old_string), newText: str(input.new_string) }];
  return [];
}

/** Full text of a tool_result block, for expansion. */
export function resultText(raw: unknown, toolId: string): string {
  for (const b of blocks(raw)) {
    if (b.type !== "tool_result" || b.tool_use_id !== toolId) continue;
    const c = b.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.filter(isObj).map((x) => str(x.text)).filter(Boolean).join("\n");
  }
  return "";
}

/** Small removal-then-addition diff (no LCS) after trimming shared prefix/suffix. */
export function simpleDiff(oldText: string, newText: string): DiffLine[] {
  const o = oldText ? oldText.split("\n") : [];
  const n = newText ? newText.split("\n") : [];
  let a = 0;
  while (a < o.length && a < n.length && o[a] === n[a]) a++;
  let b = 0;
  while (b < o.length - a && b < n.length - a && o[o.length - 1 - b] === n[n.length - 1 - b]) b++;
  return [
    ...o.slice(a, o.length - b).map((s): DiffLine => ({ t: "-", s })),
    ...n.slice(a, n.length - b).map((s): DiffLine => ({ t: "+", s })),
  ];
}

export function capLines<T>(lines: T[], cap: number, all: boolean): { shown: T[]; hidden: number } {
  if (all || lines.length <= cap) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, cap), hidden: lines.length - cap };
}
