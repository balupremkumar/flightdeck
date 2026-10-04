import { describe, expect, it } from "vitest";
import { isMediaViewer, getFollow, setFollow, viewersFor, extOf, viewersForExt, resolveViewer, rememberViewer, getWrap, setWrap, VIEWER_CHOICE_KEY } from "./registry";

function fakeStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("registry", () => {
  it("maps extensions to ordered viewers, default first", () => {
    expect(viewersForExt("json", { csv: true })).toEqual(["json-tree", "code", "text"]);
    expect(viewersForExt("JSONL", { csv: true })).toEqual(["jsonl", "text"]);
    expect(viewersForExt("ndjson", { csv: true })).toEqual(["jsonl", "text"]);
    expect(viewersForExt("tsv", { csv: true })).toEqual(["csv", "text"]);
    expect(viewersForExt("md", { csv: true })).toEqual(["rendered", "raw"]);
    expect(viewersForExt("rs", { csv: true })).toEqual(["code", "text"]);
    expect(viewersForExt("", { csv: true })).toEqual(["text"]);
  });
  it("drops the table viewer while CsvTable does not exist", () => {
    expect(viewersForExt("csv", { csv: false })).toEqual(["text"]);
  });
  it("reads the extension from Windows and POSIX paths", () => {
    expect(extOf("D:\\a.b\\c\\Data.JSON")).toBe("json");
    expect(extOf("/x/y/.gitignore")).toBe("");
    expect(extOf("/x/README")).toBe("");
  });
  it("remembers the choice per extension", () => {
    const s = fakeStore();
    expect(resolveViewer("a.json", s, { csv: true })).toBe("json-tree");
    rememberViewer("a.json", "text", s);
    rememberViewer("b.md", "raw", s);
    expect(resolveViewer("other/dir/z.json", s, { csv: true })).toBe("text");
    expect(resolveViewer("c.md", s, { csv: true })).toBe("raw");
    expect(resolveViewer("c.jsonl", s, { csv: true })).toBe("jsonl");
  });
  it("ignores a remembered viewer the extension no longer offers, and corrupt storage", () => {
    expect(resolveViewer("a.csv", fakeStore({ [VIEWER_CHOICE_KEY]: JSON.stringify({ csv: "csv" }) }), { csv: false })).toBe("text");
    expect(resolveViewer("a.json", fakeStore({ [VIEWER_CHOICE_KEY]: "{not json" }), { csv: true })).toBe("json-tree");
    expect(resolveViewer("a.json", fakeStore({ [VIEWER_CHOICE_KEY]: "[1]" }), { csv: true })).toBe("json-tree");
    expect(resolveViewer("a.json", null, { csv: true })).toBe("json-tree");
  });
  it("wrap defaults on and persists", () => {
    const s = fakeStore();
    expect(getWrap(s)).toBe(true);
    setWrap(false, s);
    expect(getWrap(s)).toBe(false);
    setWrap(true, s);
    expect(getWrap(s)).toBe(true);
  });
  it("routes code and log files", () => {
    expect(viewersFor("/x/a.PS1")).toEqual(["code", "text"]);
    expect(viewersFor("/x/app.log")).toEqual(["log", "text"]);
    expect(viewersFor("/x/app.log.3")).toEqual(["log", "text"]);
    expect(viewersFor("/x/notes.txt")).toEqual(["text"]);
  });
  it("follow defaults on for logs only, remembered per extension", () => {
    const s = fakeStore();
    expect(getFollow("a.log", s)).toBe(true);
    expect(getFollow("a.log.2", s)).toBe(true);
    expect(getFollow("a.ts", s)).toBe(false);
    setFollow("a.ts", true, s);
    setFollow("b.log.1", false, s);
    expect(getFollow("z.ts", s)).toBe(true);
    expect(getFollow("a.log", s)).toBe(false);
  });
  it("routes images and pdf to media viewers, svg also offers source", () => {
    for (const e of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]) expect(viewersFor("/x/a." + e.toUpperCase())).toEqual(["image"]);
    expect(viewersFor("/x/a.svg")).toEqual(["image", "code"]);
    expect(viewersFor("/x/a.pdf")).toEqual(["pdf"]);
    expect(isMediaViewer("image") && isMediaViewer("pdf") && !isMediaViewer("code")).toBe(true);
  });
});
