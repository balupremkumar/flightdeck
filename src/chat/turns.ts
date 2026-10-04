// Pure record -> turn grouping for the chat view. DOM-free so it unit-tests in
// plain Node. A "turn" is everything under one user prompt.
import type { ChatRecord, ChatResult, ChatTool } from "../chatlog";

export const recKey = (r: Pick<ChatRecord, "index" | "block">): string => `${r.index}:${r.block}`;

export interface ToolCall {
  rec: ChatRecord;
  tool: ChatTool;
  result: ChatResult | null;
  resultRec: ChatRecord | null;
}

export type Item =
  | { kind: "text"; rec: ChatRecord }
  | { kind: "tools"; name: string; calls: ToolCall[] }
  | { kind: "subagent"; items: Item[] };

export interface Turn {
  key: string;
  prompt: ChatRecord | null;
  items: Item[];
  /** Unique paths touched by edit-class tools in this turn. */
  files: string[];
}

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Stable ids used for expansion state. */
export function itemKey(item: Item): string {
  if (item.kind === "text") return `t:${recKey(item.rec)}`;
  if (item.kind === "tools") return `g:${recKey(item.calls[0].rec)}`;
  return `s:${item.items.length ? itemKey(item.items[0]) : "empty"}`;
}
export const callKey = (c: ToolCall): string => `c:${recKey(c.rec)}`;

function pushItem(items: Item[], rec: ChatRecord, results: Map<string, ChatRecord>): void {
  if ((rec.kind === "assistant_text" || rec.kind === "user") && rec.text && rec.text.trim()) {
    items.push({ kind: "text", rec });
    return;
  }
  if (rec.kind === "tool_use" && rec.tool) {
    const rr = results.get(rec.tool.id) ?? null;
    const call: ToolCall = { rec, tool: rec.tool, result: rr?.result ?? null, resultRec: rr };
    const last = items[items.length - 1];
    if (last && last.kind === "tools" && last.name === rec.tool.name) last.calls.push(call);
    else items.push({ kind: "tools", name: rec.tool.name, calls: [call] });
  }
}

function collectFiles(items: Item[], into: Set<string>): void {
  for (const it of items) {
    if (it.kind === "tools" && EDIT_TOOLS.has(it.name)) for (const c of it.calls) for (const p of c.tool.paths) into.add(p);
    else if (it.kind === "subagent") collectFiles(it.items, into);
  }
}

export function buildTurns(records: ChatRecord[]): Turn[] {
  const results = new Map<string, ChatRecord>();
  for (const r of records) if (r.kind === "tool_result" && r.result) results.set(r.result.tool_use_id, r);

  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let side: Item[] | null = null;

  const ensureTurn = (rec: ChatRecord): Turn => {
    if (!cur) {
      cur = { key: `t${recKey(rec)}`, prompt: null, items: [], files: [] };
      turns.push(cur);
    }
    return cur;
  };
  const flushSide = () => {
    if (side && side.length && cur) cur.items.push({ kind: "subagent", items: side });
    side = null;
  };

  for (const rec of records) {
    if (rec.kind === "tool_result" || rec.kind === "system" || rec.kind === "other") continue;
    if (rec.sidechain) {
      ensureTurn(rec);
      if (!side) side = [];
      pushItem(side, rec, results);
      continue;
    }
    flushSide();
    if (rec.kind === "user") {
      if (!rec.text || !rec.text.trim()) continue;
      cur = { key: `t${recKey(rec)}`, prompt: rec, items: [], files: [] };
      turns.push(cur);
      continue;
    }
    pushItem(ensureTurn(rec).items, rec, results);
  }
  flushSide();

  for (const t of turns) {
    const s = new Set<string>();
    collectFiles(t.items, s);
    t.files = [...s];
  }
  return turns;
}
