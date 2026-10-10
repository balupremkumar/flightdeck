import { describe, expect, it } from "vitest";
import { capLines, editPairs, resultText, simpleDiff, toolInput } from "./raw";

describe("toolInput", () => {
  it("selects the requested tool's object input from mixed blocks", () => {
    const input = { file_path: "a.ts", old_string: "old", new_string: "new" };
    const raw = { message: { content: [null, "text", [],
      { type: "tool_use", id: "other", input: { command: "wrong" } },
      { type: "tool_use", id: "edit", input }] } };
    expect(toolInput(raw, "edit")).toBe(input);
    expect(toolInput(raw, "missing")).toBeNull();
  });
  it.each([null, [], {}, { message: null }, { message: { content: "text" } },
    { message: { content: [{ type: "tool_use", id: "edit", input: [] }] } }])(
    "returns null for malformed input: %j", (raw) => {
      expect(toolInput(raw, "edit")).toBeNull();
    },
  );
});

describe("editPairs", () => {
  it("extracts Edit replacements and Write content", () => {
    expect(editPairs("Edit", { file_path: "a.ts", old_string: "old", new_string: "new" })).toEqual([
      { path: "a.ts", oldText: "old", newText: "new" },
    ]);
    expect(editPairs("Write", { file_path: "b.ts", content: "contents" })).toEqual([
      { path: "b.ts", oldText: "", newText: "contents" },
    ]);
  });
  it("extracts MultiEdit objects in order and uses notebook paths as a fallback", () => {
    expect(editPairs("MultiEdit", { notebook_path: "notes.ipynb", edits: [
      { old_string: "a", new_string: "b" }, null, [], { old_string: "c", new_string: "d" },
    ] })).toEqual([
      { path: "notes.ipynb", oldText: "a", newText: "b" },
      { path: "notes.ipynb", oldText: "c", newText: "d" },
    ]);
  });
  it("handles missing or mistyped fields and unsupported tools defensively", () => {
    expect(editPairs("Edit", { file_path: 1, old_string: null, new_string: [] })).toEqual([
      { path: "", oldText: "", newText: "" },
    ]);
    expect(editPairs("Edit", null)).toEqual([]);
    expect(editPairs("Read", { file_path: "a" })).toEqual([]);
    expect(editPairs("MultiEdit", { edits: "bad" })).toEqual([]);
  });
});

describe("resultText", () => {
  it("selects string results by tool id", () => {
    expect(resultText({ message: { content: [
      { type: "tool_result", tool_use_id: "other", content: "wrong" },
      { type: "tool_result", tool_use_id: "id", content: "full output" },
    ] } }, "id")).toBe("full output");
  });
  it("joins text blocks and ignores malformed or non-text content", () => {
    expect(resultText({ message: { content: [{ type: "tool_result", tool_use_id: "id", content: [
      { type: "text", text: "first" }, null, [], { type: "image" }, { text: 42 },
      { type: "text", text: "" }, { type: "text", text: "last" },
    ] }] } }, "id")).toBe("first\nlast");
    expect(resultText(null, "id")).toBe("");
    expect(resultText({ message: { content: [{ type: "tool_result", tool_use_id: "id", content: null }] } }, "id")).toBe("");
    expect(resultText({ message: { content: [] } }, "missing")).toBe("");
  });
});

describe("simpleDiff", () => {
  it("trims shared prefix and suffix and emits removals before additions", () => {
    expect(simpleDiff("start\nold\nold2\nend", "start\nnew\nend")).toEqual([
      { t: "-", s: "old" }, { t: "-", s: "old2" }, { t: "+", s: "new" },
    ]);
  });
  it("handles identical text, insertions, deletions and trailing blank lines", () => {
    expect(simpleDiff("same", "same")).toEqual([]);
    expect(simpleDiff("", "")).toEqual([]);
    expect(simpleDiff("", "a\nb")).toEqual([{ t: "+", s: "a" }, { t: "+", s: "b" }]);
    expect(simpleDiff("a", "")).toEqual([{ t: "-", s: "a" }]);
    expect(simpleDiff("a", "a\n")).toEqual([{ t: "+", s: "" }]);
    expect(simpleDiff("a\nb", "a\nx\nb")).toEqual([{ t: "+", s: "x" }]);
  });
});

describe("capLines", () => {
  it("caps lines and reports hidden entries without changing the input", () => {
    const lines = [{ value: 1 }, { value: 2 }, { value: 3 }];
    expect(capLines(lines, 2, false)).toEqual({ shown: lines.slice(0, 2), hidden: 1 });
    expect(lines).toHaveLength(3);
    expect(capLines(lines, 0, false)).toEqual({ shown: [], hidden: 3 });
  });
  it("preserves the full list when expanded or at or below the cap", () => {
    const lines = [1, 2];
    for (const [cap, all] of [[1, true], [2, false], [3, false]] as const) {
      expect(capLines(lines, cap, all)).toEqual({ shown: lines, hidden: 0 });
      expect(capLines(lines, cap, all).shown).toBe(lines);
    }
    expect(capLines([], 0, false)).toEqual({ shown: [], hidden: 0 });
  });
});
