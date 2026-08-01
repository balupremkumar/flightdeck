import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, isExternalHref, isBlockedHref, isAbsoluteLocalPath, resolveMdLink } from "./markdown";
import type { BlockNode } from "./markdown";

describe("parseInline", () => {
  it("parses plain text", () => {
    expect(parseInline("hello world")).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("parses strong with ** and __", () => {
    expect(parseInline("**bold**")).toEqual([{ type: "strong", children: [{ type: "text", text: "bold" }] }]);
    expect(parseInline("__bold__")).toEqual([{ type: "strong", children: [{ type: "text", text: "bold" }] }]);
  });

  it("parses em with * and _", () => {
    expect(parseInline("*em*")).toEqual([{ type: "em", children: [{ type: "text", text: "em" }] }]);
    expect(parseInline("_em_")).toEqual([{ type: "em", children: [{ type: "text", text: "em" }] }]);
  });

  it("does not treat underscores inside an identifier as emphasis", () => {
    expect(parseInline("call my_var_name here")).toEqual([{ type: "text", text: "call my_var_name here" }]);
  });

  it("parses inline code", () => {
    expect(parseInline("run `npm test` now")).toEqual([
      { type: "text", text: "run " },
      { type: "code", text: "npm test" },
      { type: "text", text: " now" },
    ]);
  });

  it("parses a link", () => {
    expect(parseInline("see [docs](./README.md) here")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "./README.md", children: [{ type: "text", text: "docs" }] },
      { type: "text", text: " here" },
    ]);
  });

  it("parses an image", () => {
    expect(parseInline("![a screenshot](img/shot.png)")).toEqual([
      { type: "image", alt: "a screenshot", src: "img/shot.png" },
    ]);
  });

  it("does not fetch or emit anything for a bare word with brackets that isn't a link", () => {
    expect(parseInline("array[0] access")).toEqual([{ type: "text", text: "array[0] access" }]);
  });
});

describe("parseMarkdown — block structure", () => {
  it("parses headings 1-6", () => {
    const blocks = parseMarkdown("# H1\n## H2\n###### H6");
    expect(blocks).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "H1" }] },
      { type: "heading", level: 2, children: [{ type: "text", text: "H2" }] },
      { type: "heading", level: 6, children: [{ type: "text", text: "H6" }] },
    ]);
  });

  it("parses a paragraph", () => {
    const blocks = parseMarkdown("Just a line of text.");
    expect(blocks).toEqual([{ type: "paragraph", children: [{ type: "text", text: "Just a line of text." }] }]);
  });

  it("parses an unordered list", () => {
    const blocks = parseMarkdown("- one\n- two\n- three");
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as Extract<BlockNode, { type: "list" }>;
    expect(list.type).toBe("list");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
    expect(list.items[1].children).toEqual([{ type: "text", text: "two" }]);
  });

  it("parses an ordered list", () => {
    const blocks = parseMarkdown("1. first\n2. second");
    const list = blocks[0] as Extract<BlockNode, { type: "list" }>;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);
  });

  it("parses a task list with mixed checked state", () => {
    const blocks = parseMarkdown("- [ ] todo\n- [x] done\n- [X] also done");
    const list = blocks[0] as Extract<BlockNode, { type: "list" }>;
    expect(list.items.map((i) => i.checked)).toEqual([false, true, true]);
    expect(list.items[0].children).toEqual([{ type: "text", text: "todo" }]);
  });

  it("parses a code fence and preserves raw content (no inline parsing inside)", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\n// *not* emphasis\n```");
    expect(blocks).toEqual([{ type: "code", lang: "ts", code: "const x = 1;\n// *not* emphasis" }]);
  });

  it("parses a code fence with no language", () => {
    const blocks = parseMarkdown("```\nplain\n```");
    expect(blocks).toEqual([{ type: "code", lang: "", code: "plain" }]);
  });

  it("parses a blockquote", () => {
    const blocks = parseMarkdown("> quoted line\n> second line");
    expect(blocks).toEqual([
      {
        type: "blockquote",
        children: [{ type: "paragraph", children: [{ type: "text", text: "quoted line\nsecond line" }] }],
      },
    ]);
  });

  it("parses a horizontal rule", () => {
    expect(parseMarkdown("---")).toEqual([{ type: "hr" }]);
  });

  it("parses a GFM table with alignment", () => {
    const md = "| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |";
    const blocks = parseMarkdown(md);
    expect(blocks).toHaveLength(1);
    const table = blocks[0] as Extract<BlockNode, { type: "table" }>;
    expect(table.type).toBe("table");
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.header).toEqual([
      [{ type: "text", text: "A" }],
      [{ type: "text", text: "B" }],
      [{ type: "text", text: "C" }],
    ]);
    expect(table.rows).toEqual([[
      [{ type: "text", text: "1" }],
      [{ type: "text", text: "2" }],
      [{ type: "text", text: "3" }],
    ]]);
  });

  it("separates multiple blocks on blank lines", () => {
    const blocks = parseMarkdown("# Title\n\nParagraph one.\n\nParagraph two.");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph"]);
  });

  it("handles a demo README shape end to end", () => {
    const md = [
      "# Flightdeck",
      "",
      "A cockpit for **parallel** agents.",
      "",
      "## Features",
      "- [x] worktree isolation",
      "- [ ] WSL support",
      "",
      "```bash",
      "npm run tauri dev",
      "```",
      "",
      "See [the backlog](./BACKLOG.md) and ![hero](docs/hero.png).",
    ].join("\n");
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "heading", "list", "code", "paragraph"]);
  });
});

describe("isExternalHref", () => {
  it("treats http/https/mailto as external", () => {
    expect(isExternalHref("https://example.com")).toBe(true);
    expect(isExternalHref("http://example.com")).toBe(true);
    expect(isExternalHref("mailto:a@b.com")).toBe(true);
  });

  it("treats a relative path as not external", () => {
    expect(isExternalHref("./README.md")).toBe(false);
    expect(isExternalHref("../docs/x.md")).toBe(false);
    expect(isExternalHref("img/shot.png")).toBe(false);
  });
});

describe("resolveMdLink", () => {
  const md = "D:\\Dev\\ai\\projects\\active\\flightdeck\\docs\\guide.md";

  it("passes an external link through unchanged", () => {
    expect(resolveMdLink("https://example.com/x", md)).toBe("https://example.com/x");
  });

  it("passes a bare anchor through unchanged", () => {
    expect(resolveMdLink("#section", md)).toBe("#section");
  });

  it("resolves a same-directory relative link", () => {
    expect(resolveMdLink("./other.md", md)).toBe("D:\\Dev\\ai\\projects\\active\\flightdeck\\docs\\other.md");
  });

  it("resolves a parent-directory relative link", () => {
    expect(resolveMdLink("../README.md", md)).toBe("D:\\Dev\\ai\\projects\\active\\flightdeck\\README.md");
  });

  it("resolves an image path relative to the md file's directory", () => {
    expect(resolveMdLink("img/shot.png", md)).toBe("D:\\Dev\\ai\\projects\\active\\flightdeck\\docs\\img\\shot.png");
  });

  it("strips a trailing anchor before resolving", () => {
    expect(resolveMdLink("./other.md#heading", md)).toBe("D:\\Dev\\ai\\projects\\active\\flightdeck\\docs\\other.md");
  });
});

// Regression guard for the 2026-08-01 architectural review finding: previewed
// markdown is untrusted (any cloned repo's README), and the old "anything with
// a scheme is external" test sent javascript:, file:, custom protocol handlers
// and Windows drive-absolute paths straight to the OS shell opener.
describe("link scheme safety", () => {
  it("only treats http(s)/mailto/tel as openable external links", () => {
    expect(isExternalHref("https://example.com")).toBe(true);
    expect(isExternalHref("mailto:a@b.c")).toBe(true);
    expect(isExternalHref("javascript:alert(1)")).toBe(false);
    expect(isExternalHref("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isExternalHref("ms-msdt:/id")).toBe(false);
  });

  it("blocks untrusted schemes outright", () => {
    expect(isBlockedHref("javascript:alert(1)")).toBe(true);
    expect(isBlockedHref("ms-msdt:/id")).toBe(true);
    expect(isBlockedHref("data:text/html,x")).toBe(true);
    expect(isBlockedHref("https://example.com")).toBe(false);
    expect(isBlockedHref("./relative.md")).toBe(false);
  });

  it("treats a Windows drive path as a local file, never a scheme", () => {
    expect(isAbsoluteLocalPath("C:\\Windows\\System32\\calc.exe")).toBe(true);
    expect(isBlockedHref("C:\\Windows\\System32\\calc.exe")).toBe(false);
    expect(isExternalHref("C:\\Windows\\System32\\calc.exe")).toBe(false);
    expect(resolveMdLink("C:\\a\\b.md", "D:\\docs\\readme.md")).toBe("C:\\a\\b.md");
  });
});
