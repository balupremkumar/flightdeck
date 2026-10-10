import { describe, expect, it } from "vitest";
import type { ChatRecord } from "../chatlog";
import {
  activityKey, buildTurns, callKey, changeSummary, EDIT_TOOLS, foldActivity,
  isNarration, isSystemPromptText, itemKey, placeUnlinked, recKey, runningCall,
} from "./turns";
import type { Activity, Item, ToolCall, Turn } from "./turns";

const record = (index: number, fields: Partial<ChatRecord> = {}): ChatRecord => ({
  index, block: 0, uuid: null, parent_uuid: null, timestamp: null,
  kind: "other", sidechain: false, text: null, tool: null, result: null, ...fields,
});
const text = (index: number, value: string): Extract<Item, { kind: "text" }> => ({
  kind: "text", rec: record(index, { kind: "assistant_text", text: value }),
});
const call = (index: number, name = "Read", fields: Partial<ToolCall["tool"]> = {}): ToolCall => {
  const tool = { id: `id${index}`, name, summary: "inspect", paths: [], added: 0, removed: 0, ...fields };
  return { rec: record(index, { kind: "tool_use", tool }), tool, result: null, resultRec: null };
};
const group = (...calls: ToolCall[]): Item => ({ kind: "tools", name: calls[0].tool.name, calls });
const turn = (items: Item[], fields: Partial<Turn> = {}): Turn => ({
  key: "turn", prompt: null, items, notes: [], files: [], ...fields,
});
const activity = (calls: ToolCall[], fields: Partial<Activity> = {}): Activity => ({
  kind: "activity", key: "activity", items: [group(...calls)], calls,
  sideSubagents: 0, narration: [], live: true, ...fields,
});

describe("stable keys", () => {
  it("recKey includes both the record offset and block", () => {
    expect(recKey({ index: 42, block: 3 })).toBe("42:3");
    expect(recKey({ index: 42, block: 4 })).toBe("42:4");
  });
  it("itemKey identifies text, first grouped call and nested or empty subagents", () => {
    expect(itemKey(text(1, "reply"))).toBe("t:1:0");
    expect(itemKey(group(call(2), call(3)))).toBe("g:2:0");
    expect(itemKey({ kind: "subagent", items: [text(4, "reply")] })).toBe("s:t:4:0");
    expect(itemKey({ kind: "subagent", items: [] })).toBe("s:empty");
  });
  it("callKey identifies a tool call independently of its tool id", () => {
    expect(callKey(call(5))).toBe("c:5:0");
  });
  it("activityKey prefixes the first item's stable key", () => {
    expect(activityKey(group(call(6)))).toBe("a:g:6:0");
  });
});

describe("classification", () => {
  it("EDIT_TOOLS contains the four edit-class tool names", () => {
    expect([...EDIT_TOOLS]).toEqual(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
    expect(EDIT_TOOLS.has("Read")).toBe(false);
  });
  it.each(["task-notification", "system-reminder", "command-name", "local-command-stdout", "command-message", "command-args"])(
    "isSystemPromptText recognises the %s wrapper at the start", (tag) => {
      expect(isSystemPromptText(`  <${tag}>metadata`)).toBe(true);
    },
  );
  it("isSystemPromptText leaves ordinary markup and later wrapper mentions alone", () => {
    expect(isSystemPromptText("<div> explain this")).toBe(false);
    expect(isSystemPromptText("Explain <system-reminder> tags")).toBe(false);
    expect(isSystemPromptText("")).toBe(false);
  });
  it("isNarration accepts a short paragraph including the 200-character boundary", () => {
    expect(isNarration("  I will inspect the code.  ")).toBe(true);
    expect(isNarration("x".repeat(200))).toBe(true);
    expect(isNarration("x".repeat(201))).toBe(false);
  });
  it.each(["", "   ", "Ready?", "Ready? )", "# Heading", "- item", "```ts\nx\n```", "first\n\nsecond"])(
    "isNarration rejects blank, questions or structured prose: %j", (value) => {
      expect(isNarration(value)).toBe(false);
    },
  );
});

describe("buildTurns", () => {
  it("starts a promptless turn then separates user prompts and attaches results by id", () => {
    const first = record(1, { kind: "assistant_text", text: "Earlier reply" });
    const prompt = record(2, { kind: "user", text: "Inspect" });
    const c = call(3);
    const result = record(4, { kind: "tool_result", result: { tool_use_id: c.tool.id, summary: "found", is_error: false } });
    const next = record(5, { kind: "user", text: "Continue" });
    expect(buildTurns([first, prompt, c.rec, result, next])).toEqual([
      turn([{ kind: "text", rec: first }], { key: "t1:0" }),
      turn([group({ ...c, result: result.result, resultRec: result })], { key: "t2:0", prompt }),
      turn([], { key: "t5:0", prompt: next }),
    ]);
  });
  it("groups consecutive same-name tools and preserves missing results", () => {
    const a = call(1), b = call(2), c = call(3, "Bash"), d = call(5);
    const prose = text(4, "A reply");
    expect(buildTurns([a.rec, b.rec, c.rec, prose.rec, d.rec])[0].items).toEqual([
      group(a, b), group(c), prose, group(d),
    ]);
  });
  it("keeps system notes on the current turn and ignores blank or non-display records", () => {
    const prompt = record(1, { kind: "user", text: "Hello" });
    const system = record(2, { kind: "system", text: "metadata" });
    const wrapper = record(3, { kind: "user", text: "<system-reminder>note" });
    expect(buildTurns([
      record(0, { kind: "system", text: "before" }), prompt, system, wrapper,
      record(4, { kind: "user", text: "  " }), record(5, { kind: "assistant_text", text: " " }),
      record(6), record(7, { kind: "system", text: "hidden", sidechain: true }),
    ])).toEqual([turn([], { key: "t1:0", prompt, notes: [system, wrapper] })]);
    expect(buildTurns([])).toEqual([]);
  });
  it("groups sidechains and collects unique edit paths including nested edits", () => {
    const prompt = record(1, { kind: "user", text: "Fix" });
    const edit = call(2, "Edit", { paths: ["a.ts"] });
    const nested = call(3, "Write", { paths: ["a.ts", "b.ts"] });
    nested.rec = { ...nested.rec, sidechain: true };
    const read = call(4, "Read", { paths: ["ignored.ts"] });
    const turns = buildTurns([prompt, edit.rec, nested.rec, read.rec]);
    expect(turns).toHaveLength(1);
    expect(turns[0].items).toEqual([group(edit), { kind: "subagent", items: [group(nested)] }, group(read)]);
    expect(turns[0].files).toEqual(["a.ts", "b.ts"]);
    expect(buildTurns([prompt, nested.rec])[0].items).toEqual([{ kind: "subagent", items: [group(nested)] }]);
  });
});

describe("foldActivity", () => {
  it("folds narration and steps without counting subagent calls as parent calls", () => {
    const a = call(2), b = call(4, "Bash"), nested = call(5);
    const items: Item[] = [text(1, "  Inspecting now.  "), group(a), text(3, "Checking next."),
      group(b), { kind: "subagent", items: [group(nested)] }];
    expect(foldActivity(items, true)).toEqual([{
      kind: "activity", key: "a:t:1:0", items, calls: [a, b], sideSubagents: 1,
      narration: ["Inspecting now.", "Checking next."], live: true,
    }]);
    expect(items).toHaveLength(5);
  });
  it("preserves final replies and single steps and marks only a trailing run live", () => {
    const a = group(call(1)), b = group(call(2, "Bash")), reply = text(3, "Done.");
    const c = group(call(4)), d = group(call(5, "Bash"));
    expect(foldActivity([a])).toEqual([a]);
    const sub: Item = { kind: "subagent", items: [] };
    expect(foldActivity([sub])).toEqual([sub]);
    expect(foldActivity([a, b, reply], true)).toMatchObject([
      { kind: "activity", live: false }, reply,
    ]);
    const heading = text(6, "# Results");
    expect(foldActivity([a, b, heading, c, d], true)).toMatchObject([
      { kind: "activity", live: false }, heading, { kind: "activity", live: true },
    ]);
    expect(foldActivity([a, b])).toMatchObject([{ kind: "activity", live: false }]);
  });
  it("keeps questions, structured prose and text-only runs visible", () => {
    const question = text(2, "Proceed?"), heading = text(4, "# Results");
    const a = group(call(1)), b = group(call(3)), c = group(call(5));
    expect(foldActivity([a, question, b, heading, c])).toEqual([a, question, b, heading, c]);
    const prose = [text(6, "First."), text(7, "Last.")];
    expect(foldActivity(prose)).toEqual(prose);
    expect(foldActivity([])).toEqual([]);
  });
});

describe("runningCall", () => {
  it("returns the last unresolved call only for a live run ending in tools", () => {
    const a = call(1), b = call(2);
    expect(runningCall(activity([a, b]))).toBe(b);
    expect(runningCall(activity([a], { live: false }))).toBeNull();
    expect(runningCall(activity([a], { items: [group(a), { kind: "subagent", items: [] }] }))).toBeNull();
    expect(runningCall(activity([a], { calls: [] }))).toBeNull();
    const complete = { ...a, result: { tool_use_id: a.tool.id, summary: "done", is_error: false } };
    expect(runningCall(activity([complete]))).toBeNull();
    expect(runningCall(activity([a], { items: [group(a), text(3, "Working.")] }))).toBe(a);
  });
});

describe("changeSummary", () => {
  it("sums edit changes recursively and ignores non-edit tools", () => {
    const files = ["a.ts", "b.ts"];
    const t = turn([
      group(call(1, "Edit", { added: 2, removed: 3 })),
      { kind: "subagent", items: [group(call(2, "Write", { added: 4, removed: 0 }))] },
      group(call(3, "Read", { added: 99, removed: 99 })),
    ], { files });
    expect(changeSummary(t)).toEqual({ files, added: 6, removed: 3 });
    expect(changeSummary(turn([]))).toEqual({ files: [], added: 0, removed: 0 });
  });
});

describe("placeUnlinked", () => {
  it("places links at the latest eligible prompt time and retains unknown or early links", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    const turns = [turn([]), turn([], { prompt: record(1, { timestamp: "2026-01-01T00:00:00Z" }) }),
      turn([], { prompt: record(2, { timestamp: "invalid" }) }),
      turn([], { prompt: record(3, { timestamp: "2026-01-01T00:00:01Z" }) })];
    const early = { id: "early", startedMs: start - 1 }, unknown = { id: "unknown" };
    const first = { id: "first", startedMs: start }, middle = { id: "middle", startedMs: start + 500 };
    const last = { id: "last", startedMs: start + 1000 };
    expect(placeUnlinked(turns, [early, first, middle, last, unknown])).toEqual({
      byTurn: new Map([[1, [first, middle]], [3, [last]]]), rest: [early, unknown],
    });
    expect(placeUnlinked([], [first])).toEqual({ byTurn: new Map(), rest: [first] });
  });
});
