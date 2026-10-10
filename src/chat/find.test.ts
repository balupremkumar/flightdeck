import { describe, expect, it } from "vitest";
import type { ChatRecord } from "../chatlog";
import { callMatches, planFind } from "./find";
import type { Item, ToolCall, Turn } from "./turns";

const record = (index: number, text: string | null = null): ChatRecord => ({
  index, block: 0, uuid: null, parent_uuid: null, timestamp: null,
  kind: "assistant_text", sidechain: false, text, tool: null, result: null,
});
const call = (index: number): ToolCall => ({
  rec: record(index), tool: { id: `id${index}`, name: "Read", summary: "inspect source", paths: ["src/Widget.ts"], added: 0, removed: 0 },
  result: { tool_use_id: `id${index}`, summary: "FOUND match", is_error: false }, resultRec: null,
});
const turn = (items: Item[], prompt: ChatRecord | null = null): Turn => ({
  key: "turn", items, prompt, notes: [], files: [],
});

describe("callMatches", () => {
  it.each(["READ", "SOURCE", "widget.TS", "found"])("searches tool metadata and result text case-insensitively: %s", (q) => {
    expect(callMatches(call(1), q)).toBe(true);
  });
  it("rejects empty and absent matches and handles a pending result", () => {
    expect(callMatches(call(1), "")).toBe(false);
    expect(callMatches(call(1), "absent")).toBe(false);
    expect(callMatches({ ...call(1), result: null }, "found")).toBe(false);
    expect(callMatches({ ...call(1), result: null }, "read")).toBe(true);
  });
});

describe("planFind", () => {
  it("orders prompt, prose and matching calls and expands only matching calls in a group", () => {
    const a = call(3), b = { ...call(4), result: null };
    const turns = [turn([{ kind: "text", rec: record(2, "Found it.") },
      { kind: "tools", name: "Read", calls: [a, b] }], record(1, "Find FOUND")),
      turn([{ kind: "text", rec: record(5, "Found again.") }])];
    expect(planFind(turns, "found")).toEqual({
      keys: ["p:1:0", "t:2:0", "c:3:0", "t:5:0"], expand: new Set(["g:3:0", "c:3:0", "a:t:2:0"]),
    });
  });
  it("expands enclosing activities and subagents for nested matches", () => {
    const a = call(1), nested = call(2);
    const turns = [turn([{ kind: "tools", name: "Read", calls: [a] },
      { kind: "subagent", items: [{ kind: "tools", name: "Read", calls: [nested] }] }])];
    expect(planFind(turns, "found")).toEqual({
      keys: ["c:1:0", "c:2:0"], expand: new Set(["c:1:0", "c:2:0", "s:g:2:0", "a:g:1:0"]),
    });
  });
  it("returns empty plans for blank or absent queries without expanding a singleton group", () => {
    const turns = [turn([{ kind: "tools", name: "Read", calls: [call(1)] }])];
    for (const q of ["", " \t\n", "absent"]) {
      expect(planFind(turns, q)).toEqual({ keys: [], expand: new Set() });
    }
    expect(planFind(turns, "read")).toEqual({ keys: ["c:1:0"], expand: new Set(["c:1:0"]) });
    expect(planFind([], "read")).toEqual({ keys: [], expand: new Set() });
  });
});
