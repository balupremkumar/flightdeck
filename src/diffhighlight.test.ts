import { describe, expect, it } from "vitest";
import { highlightLine, highlight, langFor } from "./diffhighlight";

const kinds = (line: string, lang: Parameters<typeof highlightLine>[1]) =>
  highlightLine(line, lang).map((t) => t.kind);
const textOf = (line: string, lang: Parameters<typeof highlightLine>[1]) =>
  highlightLine(line, lang).map((t) => t.text).join("");

describe("langFor (UI-171)", () => {
  it("maps the extensions this repo actually has", () => {
    expect(langFor("src/Review.tsx")).toBe("js");
    expect(langFor("src-tauri/src/main.rs")).toBe("rust");
    expect(langFor("src/review.css")).toBe("css");
    expect(langFor("package.json")).toBe("json");
    expect(langFor("STATE.md")).toBe("md");
  });

  it("falls back to no highlighting for anything else", () => {
    expect(langFor("assets/logo.svg")).toBeNull();
    expect(langFor("Makefile")).toBeNull();
    expect(highlight("whatever", "Makefile")).toBeNull();
  });
});

describe("highlightLine (UI-171)", () => {
  it("reassembles the full line from its tokens, always", () => {
    const line = 'const x = "hi there"; // trailing note';
    expect(textOf(line, "js")).toBe(line);
  });

  it("marks js keywords, strings, comments and numbers", () => {
    const line = 'const timeout = 30; // ms';
    const toks = highlightLine(line, "js");
    expect(toks.find((t) => t.text === "const")?.kind).toBe("kw");
    expect(toks.find((t) => t.text === "30")?.kind).toBe("num");
    expect(toks.find((t) => t.text === "// ms")?.kind).toBe("com");
  });

  it("does not flag ordinary identifiers as keywords", () => {
    expect(kinds("myVariableName", "js")).toEqual(["plain"]);
  });

  it("handles single, double and template-literal strings in js", () => {
    expect(highlightLine(`'a'`, "js")[0]).toEqual({ text: "'a'", kind: "str" });
    expect(highlightLine(`"a"`, "js")[0]).toEqual({ text: '"a"', kind: "str" });
    expect(highlightLine("`a`", "js")[0]).toEqual({ text: "`a`", kind: "str" });
  });

  it("respects escaped quotes inside a string", () => {
    const line = String.raw`"a \" b"`;
    expect(highlightLine(line, "js")).toEqual([{ text: line, kind: "str" }]);
  });

  it("tokenises rust keywords and comments", () => {
    const toks = highlightLine("fn main() { // entry", "rust");
    expect(toks.find((t) => t.text === "fn")?.kind).toBe("kw");
    expect(toks.find((t) => t.text === "// entry")?.kind).toBe("com");
  });

  it("treats css at-rules as keywords without a generic identifier list", () => {
    const toks = highlightLine("@media (min-width: 40px) {", "css");
    expect(toks.find((t) => t.text === "@media")?.kind).toBe("kw");
    expect(toks.find((t) => t.text === "40")?.kind).toBe("num");
  });

  it("tokenises json keys/values and true/false/null", () => {
    const toks = highlightLine('"ok": true,', "json");
    expect(toks.find((t) => t.text === '"ok"')?.kind).toBe("str");
    expect(toks.find((t) => t.text === "true")?.kind).toBe("kw");
  });

  it("lifts inline code spans out of markdown, nothing else", () => {
    const toks = highlightLine("run `npm test` first", "md");
    expect(toks.find((t) => t.text === "`npm test`")?.kind).toBe("str");
    expect(toks.some((t) => t.kind === "kw")).toBe(false);
  });

  it("doesn't close a block comment that never closes on this line", () => {
    const toks = highlightLine("/* start of a longer comment", "js");
    expect(toks).toEqual([{ text: "/* start of a longer comment", kind: "com" }]);
  });

  it("survives an empty line", () => {
    expect(highlightLine("", "js")).toEqual([]);
  });
});
