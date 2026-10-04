import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../markdown";
import { extractToc } from "./toc";

describe("extractToc", () => {
  it("lists headings in order with levels and prefixed slug ids", () => {
    const t = extractToc(parseMarkdown("# Title\n\ntext\n\n## Setup\n\n### Deep dive\n"));
    expect(t.map((e) => [e.level, e.text, e.id])).toEqual([
      [1, "Title", "prv-h-title"],
      [2, "Setup", "prv-h-setup"],
      [3, "Deep dive", "prv-h-deep-dive"],
    ]);
  });
  it("dedupes repeated headings the way the renderer does", () => {
    const t = extractToc(parseMarkdown("## Notes\n\n## Notes\n\n## Notes\n"));
    expect(new Set(t.map((e) => e.id)).size).toBe(3);
  });
  it("reads inline formatting as plain text", () => {
    expect(extractToc(parseMarkdown("## The `fs_stat` **call**\n"))[0].text).toBe("The fs_stat call");
  });
  it("is empty without headings", () => {
    expect(extractToc(parseMarkdown("just a paragraph\n"))).toEqual([]);
  });
});
