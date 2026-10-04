import { describe, expect, it } from "vitest";
import { flattenJson, lineCol, parseJson, pathAppend, rowText } from "./jsonflatten";

const depth2 = { isOpen: (_p: string, d: number) => d < 2 };

describe("parseJson", () => {
  it("parses valid JSON, tolerating a BOM", () => {
    expect(parseJson("﻿{\"a\":1}")).toEqual({ ok: true, value: { a: 1 } });
  });
  it("reports line and column for invalid JSON", () => {
    const r = parseJson('{\n  "a": 1,\n  "b": ,\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message.length).toBeGreaterThan(0);
      expect(r.error.line).toBe(3);
      expect(r.error.column).toBeGreaterThan(0);
    }
  });
  it("puts a truncated document at its end", () => {
    const text = '{"a": [1, 2';
    const r = parseJson(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.line).toBe(1);
  });
  it("lineCol is 1-based", () => {
    expect(lineCol("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
    expect(lineCol("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });
});

describe("pathAppend", () => {
  it("builds JSONPath-style paths", () => {
    expect(pathAppend("$", "a")).toBe("$.a");
    expect(pathAppend("$.a", 3)).toBe("$.a[3]");
    expect(pathAppend("$", "has space")).toBe('$["has space"]');
    expect(pathAppend("$", "1x")).toBe('$["1x"]');
  });
});

describe("flattenJson", () => {
  const doc = { a: { b: { c: { d: 1 } } }, list: [1, { x: "y" }], n: null, e: {} };
  it("caps expansion at the initial depth", () => {
    const { rows } = flattenJson(doc, depth2);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get("$")?.open).toBe(true);
    expect(byPath.get("$.a")?.open).toBe(true);
    expect(byPath.get("$.a.b")?.open).toBe(false); // depth 2: shown, not opened
    expect(byPath.has("$.a.b.c")).toBe(false);
    expect(byPath.get("$.list[1]")?.open).toBe(false);
    expect(byPath.get("$.e")?.open).toBe(false); // empty container never opens
    expect(rows.map((r) => r.path)).toEqual(["$", "$.a", "$.a.b", "$.list", "$.list[0]", "$.list[1]", "$.n", "$.e"]);
  });
  it("expand all reaches every node, collapse leaves only the root", () => {
    expect(flattenJson(doc, { isOpen: () => true }).rows.map((r) => r.path)).toContain("$.a.b.c.d");
    expect(flattenJson(doc, { isOpen: () => false }).rows).toHaveLength(1);
  });
  it("honours maxRows", () => {
    const big = Array.from({ length: 100 }, (_, i) => i);
    const r = flattenJson(big, { isOpen: () => true, maxRows: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });
  it("is not recursive: very deep nesting does not overflow the stack", () => {
    let v: unknown = 1;
    for (let i = 0; i < 50_000; i++) v = [v];
    expect(flattenJson(v, { isOpen: () => true }).rows).toHaveLength(50_001);
  });
  it("rowText truncates long strings", () => {
    const rows = flattenJson({ s: "x".repeat(1000) }, { isOpen: () => true }).rows;
    expect(rowText(rows[1]).length).toBeLessThan(320);
  });
});

describe("5 MB benchmark (flattening step)", () => {
  it("parses and flattens a ~5 MB document quickly at depth 2 and fully expanded", () => {
    const items = Array.from({ length: 38_000 }, (_, i) => ({
      id: i, name: `item-${i}`, tags: ["alpha", "beta", "gamma"], nested: { a: i, b: "lorem ipsum dolor sit amet", c: [i, i + 1] },
    }));
    const text = JSON.stringify(items);
    expect(text.length).toBeGreaterThan(4_800_000);
    const t0 = performance.now();
    const parsed = parseJson(text);
    const t1 = performance.now();
    expect(parsed.ok).toBe(true);
    const shallow = flattenJson((parsed as { value: unknown }).value, depth2);
    const t2 = performance.now();
    const full = flattenJson((parsed as { value: unknown }).value, { isOpen: () => true });
    const t3 = performance.now();
    console.log(`bench ${(text.length / 1e6).toFixed(1)}MB: parse ${(t1 - t0).toFixed(0)}ms, depth-2 flatten ${(t2 - t1).toFixed(0)}ms (${shallow.rows.length} rows), expand-all flatten ${(t3 - t2).toFixed(0)}ms (${full.rows.length} rows)`);
    expect(shallow.rows.length).toBeLessThan(400_000);
    expect(t2 - t1).toBeLessThan(1500);
    expect(t3 - t2).toBeLessThan(5000);
  });
});
