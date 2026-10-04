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
  /** System-classified records (meta, compact summaries, wrapper tags); shown only in Verbose. */
  notes: ChatRecord[];
  /** Unique paths touched by edit-class tools in this turn. */
  files: string[];
}

const SYSTEM_TAG = /^\s*<(task-notification|system-reminder|command-name|local-command-stdout|command-message|command-args)\b/;
/** Defensive: user text that is really a harness wrapper, in case the backend missed it. */
export const isSystemPromptText = (text: string): boolean => SYSTEM_TAG.test(text);

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

/**
 * TN2 Normal density: a run of consecutive non-text items (tool groups and
 * subagents) between two pieces of prose, shown as ONE line. Verbose renders
 * Turn.items as built; this is a view over them, never a replacement.
 */
export interface Activity {
  kind: "activity";
  key: string;
  items: Item[];
  /** Top-level calls in the run, in order (a subagent's own calls are not the parent's). */
  calls: ToolCall[];
  /** Sidechain subagent items in the run (older transcripts). */
  sideSubagents: number;
  /** The run ends the conversation so far, so a call without a result is still running. */
  live: boolean;
}
export type NormalItem = Item | Activity;

export const activityKey = (first: Item): string => `a:${itemKey(first)}`;

/** The call of a live run that is still running, if any. */
export function runningCall(a: Activity): ToolCall | null {
  const last = a.calls[a.calls.length - 1];
  return a.live && last && !last.result && a.items[a.items.length - 1].kind === "tools" ? last : null;
}

/**
 * Folds every run of non-text items into one Activity. A run that is already a
 * single line (one tool group, or one sidechain subagent) stays as it is. `live`:
 * this is the newest turn, so its trailing run may still be in progress.
 */
export function foldActivity(items: Item[], live = false): NormalItem[] {
  const out: NormalItem[] = [];
  let run: Item[] = [];
  const flush = (atEnd: boolean) => {
    if (!run.length) return;
    const only = run.length === 1 ? run[0] : null;
    if (only && (only.kind === "subagent" || only.kind === "tools")) out.push(only);
    else {
      out.push({
        kind: "activity",
        key: activityKey(run[0]),
        items: run,
        calls: run.flatMap((it) => (it.kind === "tools" ? it.calls : [])),
        sideSubagents: run.filter((it) => it.kind === "subagent").length,
        live: live && atEnd,
      });
    }
    run = [];
  };
  for (const it of items) {
    if (it.kind === "text") { flush(false); out.push(it); }
    else run.push(it);
  }
  flush(true);
  return out;
}

export function buildTurns(records: ChatRecord[]): Turn[] {
  const results = new Map<string, ChatRecord>();
  for (const r of records) if (r.kind === "tool_result" && r.result) results.set(r.result.tool_use_id, r);

  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let side: Item[] | null = null;

  const ensureTurn = (rec: ChatRecord): Turn => {
    if (!cur) {
      cur = { key: `t${recKey(rec)}`, prompt: null, items: [], notes: [], files: [] };
      turns.push(cur);
    }
    return cur;
  };
  // NOTE: Claude 2.1.289 writes subagent transcripts to <session>/subagents/*.jsonl,
  // not into the main file, so this sidechain grouping rarely fires any more.
  // Left in place for older transcripts.
  const flushSide =() => {
    if (side && side.length && cur) cur.items.push({ kind: "subagent", items: side });
    side = null;
  };

  for (const rec of records) {
    if (rec.kind === "system" || (rec.kind === "user" && rec.text && isSystemPromptText(rec.text))) {
      // Never a prompt or sticky header; kept as a note on the current turn (Verbose only).
      if (cur && !rec.sidechain && rec.text && rec.text.trim()) (cur as Turn).notes.push(rec);
      continue;
    }
    if (rec.kind === "tool_result" || rec.kind === "other") continue;
    if (rec.sidechain) {
      ensureTurn(rec);
      if (!side) side = [];
      pushItem(side, rec, results);
      continue;
    }
    flushSide();
    if (rec.kind === "user") {
      if (!rec.text || !rec.text.trim()) continue;
      cur = { key: `t${recKey(rec)}`, prompt: rec, items: [], notes: [], files: [] };
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
