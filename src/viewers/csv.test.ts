import { describe, expect, it } from "vitest";
import { clampWidth, compareCells, delimiterForPath, detectDelimiter, detectHeader, nextSort, parseCsv, sortedOrder, visibleRange } from "./csv";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes and embedded newlines", () => {
    const r = parseCsv('a,b\n"x, y","he said ""hi"""\n"line1\nline2",z\n', "f.csv");
    expect(r.rows).toEqual([["a", "b"], ["x, y", 'he said "hi"'], ["line1\nline2", "z"]]);
  });
  it("handles CRLF and embedded CRLF in quotes", () => {
    const r = parseCsv('a,b\r\n"p\r\nq",2\r\n', "f.csv");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1][0]).toBe("p\r\nq");
  });
  it("strips a BOM", () => {
    expect(parseCsv("﻿name,age\nA,1", "f.csv").rows[0][0]).toBe("name");
  });
  it("flags ragged rows and reports widest column count", () => {
    const r = parseCsv("a,b,c\n1,2\n1,2,3,4\n", "f.csv");
    expect(r.ragged).toBe(true);
    expect(r.columns).toBe(4);
    expect(parseCsv("a,b\n1,2\n", "f.csv").ragged).toBe(false);
  });
  it("uses tab for .tsv", () => {
    const r = parseCsv("a\tb,c\n1\t2\n", "x.TSV");
    expect(r.delimiter).toBe("\t");
    expect(r.rows[0]).toEqual(["a", "b,c"]);
  });
  it("auto-detects for unknown extensions", () => {
    expect(parseCsv("a;b;c\n1;2;3", "x.txt").delimiter).toBe(";");
    expect(detectDelimiter("a|b\n1|2")).toBe("|");
    expect(detectDelimiter("just text")).toBe(",");
  });
  it("skips blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n\n", "f.csv").rows).toHaveLength(2);
  });
  it("delimiterForPath", () => {
    expect(delimiterForPath("a.csv")).toBe(",");
    expect(delimiterForPath("a.log")).toBeNull();
  });
});

describe("detectHeader", () => {
  it("true for unique non-numeric first row", () => expect(detectHeader([["a", "b"], ["1", "2"]])).toBe(true));
  it("false when a cell is numeric", () => expect(detectHeader([["a", "2"], ["1", "2"]])).toBe(false));
  it("false for duplicates, empties, single row", () => {
    expect(detectHeader([["a", "a"], ["1", "2"]])).toBe(false);
    expect(detectHeader([["a", ""], ["1", "2"]])).toBe(false);
    expect(detectHeader([["a", "b"]])).toBe(false);
  });
});

describe("compareCells / sortedOrder", () => {
  it("sorts numerically, not lexically", () => {
    expect(compareCells("9", "10", "asc")).toBeLessThan(0);
    expect(compareCells("9", "10", "desc")).toBeGreaterThan(0);
    expect(compareCells("1,200", "300", "asc")).toBeGreaterThan(0);
  });
  it("sorts strings case-insensitively", () => {
    expect(compareCells("apple", "Banana", "asc")).toBeLessThan(0);
  });
  it("puts empty cells last in both directions", () => {
    expect(compareCells("", "a", "asc")).toBeGreaterThan(0);
    expect(compareCells("", "a", "desc")).toBeGreaterThan(0);
    expect(compareCells("", " ", "asc")).toBe(0);
  });
  it("numbers before text", () => expect(compareCells("5", "x", "asc")).toBeLessThan(0));
  it("sortedOrder is stable, skips header, null for no sort", () => {
    const rows = [["h"], ["b"], [""], ["a"], ["b"]];
    expect(sortedOrder(rows, 0, "asc", 1)).toEqual([3, 1, 4, 2]);
    expect(sortedOrder(rows, 0, "desc", 1)).toEqual([1, 4, 3, 2]);
    expect(sortedOrder(rows, 0, null, 1)).toBeNull();
  });
  it("nextSort cycles", () => {
    expect(nextSort(null)).toBe("asc");
    expect(nextSort("asc")).toBe("desc");
    expect(nextSort("desc")).toBeNull();
  });
});

describe("visibleRange", () => {
  it("windows from scrollTop with overscan", () => {
    expect(visibleRange(1000, 20, 400, 50000, 5)).toEqual({ start: 45, end: 75 });
  });
  it("clamps at the top and bottom", () => {
    expect(visibleRange(0, 20, 400, 1000, 8)).toEqual({ start: 0, end: 28 });
    expect(visibleRange(19900, 20, 400, 1000, 8)).toEqual({ start: 987, end: 1000 });
  });
  it("handles empty and bad input", () => {
    expect(visibleRange(0, 20, 400, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(-50, 0, 400, 10)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(1e9, 20, 400, 10)).toEqual({ start: 10, end: 10 });
  });
  it("clampWidth", () => {
    expect(clampWidth(10)).toBe(48);
    expect(clampWidth(5000)).toBe(800);
    expect(clampWidth(100.4)).toBe(100);
  });
});
