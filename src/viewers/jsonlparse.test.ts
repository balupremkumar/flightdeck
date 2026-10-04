import { describe, expect, it } from "vitest";
import { extractChips, parseJsonl } from "./jsonlparse";

describe("parseJsonl", () => {
  it("skips blank lines, keeps real line numbers, flags invalid lines with the error", () => {
    const { records, invalid } = parseJsonl('{"a":1}\n\n{bad\r\n  \n[1,2]\n');
    expect(records.map((r) => r.line)).toEqual([1, 3, 5]);
    expect(invalid).toBe(1);
    expect(records[0].value).toEqual({ a: 1 });
    expect(records[1].error).toBeTruthy();
    expect(records[1].value).toBeUndefined();
    expect(records[2].value).toEqual([1, 2]);
  });
  it("copes with an empty file and a BOM", () => {
    expect(parseJsonl("").records).toEqual([]);
    expect(parseJsonl("﻿{\"a\":1}").records[0].value).toEqual({ a: 1 });
  });
  it("handles 10k+ lines", () => {
    const text = Array.from({ length: 12_000 }, (_, i) => JSON.stringify({ i })).join("\n");
    expect(parseJsonl(text).records).toHaveLength(12_000);
  });
});

describe("extractChips (Claude session records)", () => {
  it("takes type, message.role and a text preview from string content", () => {
    expect(extractChips({ type: "user", message: { role: "user", content: "fix the\n  build please" } }))
      .toEqual({ type: "user", role: "user", preview: "fix the build please" });
  });
  it("takes the first text block of array content", () => {
    const c = extractChips({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Done." }] } });
    expect(c).toMatchObject({ type: "assistant", role: "assistant", preview: "Done." });
  });
  it("names the tool for tool_use and previews tool_result content", () => {
    expect(extractChips({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } }).preview).toBe("tool: Read");
    expect(extractChips({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok then" }] } }).preview).toBe("ok then");
  });
  it("truncates long previews", () => {
    const p = extractChips({ type: "user", message: { role: "user", content: "x".repeat(500) } }).preview;
    expect(p.length).toBeLessThanOrEqual(121);
    expect(p.endsWith("…")).toBe(true);
  });
  it("uses a summary record's summary, and leaves role absent when there is none", () => {
    const c = extractChips({ type: "summary", summary: "Refactored the parser" });
    expect(c).toEqual({ type: "summary", role: undefined, preview: "Refactored the parser" });
  });
  it("falls back to a key preview for non-Claude records and primitives", () => {
    expect(extractChips({ id: 1, ok: true, nested: { a: 1 }, list: [] }).preview).toBe("id: 1 ok: true nested: {…} list: […]");
    expect(extractChips(42).preview).toBe("42");
    expect(extractChips([1, 2]).preview).toBe("[1,2]");
  });
});
