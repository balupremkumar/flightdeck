import { describe, expect, it } from "vitest";
import {
  parseInline, parseMarkdown, isExternalHref, isBlockedHref, isAbsoluteLocalPath, resolveMdLink,
  safeDecode, slugify, makeSlugger, inlineText, parseWikilink, parseLinkTarget, autolinkInline, VAULT_ROOT,
} from "./markdown";
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

describe("percent-decoding (Phase 1 L4)", () => {
  const md = "D:\\Dev\\ai\\notes\\readme.md";
  it("decodes %20 in a relative target", () => {
    expect(resolveMdLink("my%20notes/a%2Bb.md", md)).toBe("D:\\Dev\\ai\\notes\\my notes\\a+b.md");
  });
  it("leaves a lone % alone instead of throwing", () => {
    expect(safeDecode("100%.md")).toBe("100%.md");
    expect(resolveMdLink("100%.md", md)).toBe("D:\\Dev\\ai\\notes\\100%.md");
  });
});

describe("heading slugs", () => {
  it("slugs the GitHub way", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  API & Usage (v2) ")).toBe("api--usage-v2");
    expect(slugify("snake_case Heading-1")).toBe("snake_case-heading-1");
  });
  it("de-duplicates repeats in order", () => {
    const s = makeSlugger();
    expect([s("Intro"), s("Intro"), s("Intro"), s("Other")]).toEqual(["intro", "intro-1", "intro-2", "other"]);
  });
  it("flattens inline nodes to text", () => {
    const h = parseMarkdown("## The `code` **bold** title")[0] as Extract<BlockNode, { type: "heading" }>;
    expect(slugify(inlineText(h.children))).toBe("the-code-bold-title");
  });
});

describe("wikilinks", () => {
  it("[[path|alias]] shows the alias and resolves under the vault", () => {
    const w = parseWikilink("projects/active/flightdeck/STATE", "Flightdeck");
    expect(w.label).toBe("Flightdeck");
    expect(w.href).toBe(VAULT_ROOT + "\\projects\\active\\flightdeck\\STATE.md");
  });
  it("[[path]] shows the last segment; keeps an existing extension", () => {
    expect(parseWikilink("brain/rulings").label).toBe("rulings");
    expect(parseWikilink("docs/x.txt").href).toBe(VAULT_ROOT + "\\docs\\x.txt");
  });
  it("keeps a #suffix off the extension check", () => {
    expect(parseWikilink("notes/a#L12").href).toBe(VAULT_ROOT + "\\notes\\a.md#L12");
  });
  it("parses inline into a link node", () => {
    const n = parseInline("see [[brain/rulings|Rulings]] now");
    expect(n[1]).toEqual({
      type: "link",
      href: VAULT_ROOT + "\\brain\\rulings.md",
      children: [{ type: "text", text: "Rulings" }],
    });
  });
});

describe("parseLinkTarget", () => {
  const md = "D:\\Dev\\ai\\notes\\readme.md";
  it("bare #anchor targets the current file", () => {
    expect(parseLinkTarget("#My%20Heading", md)).toEqual({ kind: "file", path: md, anchor: "My Heading" });
  });
  it("file.md#L12 and ranges give a line", () => {
    expect(parseLinkTarget("other.md#L12", md)).toEqual({ kind: "file", path: "D:\\Dev\\ai\\notes\\other.md", line: 12 });
    expect(parseLinkTarget("../a.ts#L5-L9", md)).toEqual({ kind: "file", path: "D:\\Dev\\ai\\a.ts", line: 5 });
  });
  it("path:12 and path:12:5 give a line", () => {
    expect(parseLinkTarget("src/x.ts:12", md)).toEqual({ kind: "file", path: "D:\\Dev\\ai\\notes\\src\\x.ts", line: 12 });
    expect(parseLinkTarget("C:\\a\\b.ts:7:3", md)).toEqual({ kind: "file", path: "C:\\a\\b.ts", line: 7 });
  });
  it("other.md#heading carries an anchor, relative to the md folder", () => {
    expect(parseLinkTarget("sub/other.md#Setup", md)).toEqual({ kind: "file", path: "D:\\Dev\\ai\\notes\\sub\\other.md", anchor: "Setup" });
  });
  it("external urls pass through", () => {
    expect(parseLinkTarget("https://a.dev/x#y", md)).toEqual({ kind: "external", url: "https://a.dev/x#y" });
  });
});

describe("autolinkInline", () => {
  const text = (s: string) => autolinkInline([{ type: "text", text: s }]);
  it("links a bare URL and keeps surrounding text", () => {
    const out = text("go to https://example.com/a now");
    expect(out.map((n) => n.type)).toEqual(["text", "link", "text"]);
    expect((out[1] as { href: string }).href).toBe("https://example.com/a");
  });
  it("links an absolute path with a line suffix", () => {
    const out = text("see D:\\Dev\\x\\y.ts:12 here");
    const link = out.find((n) => n.type === "link") as { href: string } | undefined;
    expect(link?.href).toBe("D:\\Dev\\x\\y.ts#L12");
  });
  it("leaves plain prose alone", () => {
    expect(text("nothing to see here")).toEqual([{ type: "text", text: "nothing to see here" }]);
  });
  it("paragraph parsing autolinks but explicit links and code are untouched", () => {
    const p = parseMarkdown("[a](https://x.dev) `https://y.dev` https://z.dev")[0] as Extract<BlockNode, { type: "paragraph" }>;
    expect(p.children.filter((n) => n.type === "link")).toHaveLength(2);
    expect(p.children.some((n) => n.type === "code")).toBe(true);
  });
});

describe("remote / device paths (any slash spelling)", () => {
  const forms = [
    "\\\\srv\\share\\x.md", "//srv/share/x.md", "/\\srv\\share\\x.md", "\\/srv/share/x.md",
    "%5C%5Csrv%5Cshare%5Cx.md", "/%5Csrv/share/x.md", "\\\\?\\UNC\\srv\\share\\x.md", "\\\\.\\pipe\\x",
  ];
  for (const f of forms) {
    it(`isAbsoluteLocalPath rejects, blocks and leaves unresolved: ${f}`, () => {
      expect(isAbsoluteLocalPath(f)).toBe(false);
      expect(isBlockedHref(f)).toBe(true);
      expect(resolveMdLink(f, "D:\\v\\a.md")).toBe(f);
      expect(parseLinkTarget(f, "D:\\v\\a.md")).toMatchObject({ kind: "file", path: f });
    });
  }
  it("parseWikilink never turns a remote target into a UNC href", () => {
    for (const t of ["/\\srv/share/x", "\\/srv/share/x", "//srv/share/x", "%5C%5Csrv/share/x"]) {
      const w = parseWikilink(t);
      expect(w.href).toBe("blocked:remote-path");
      expect(w.href).not.toMatch(/srv/);
    }
  });
  it("autolinkInline leaves UNC text alone", () => {
    const out = autolinkInline([{ type: "text", text: "see \\\\srv\\share\\x.txt and /\\srv/share/y.txt" }]);
    expect(out.every((n) => n.type === "text")).toBe(true);
  });
  it("local paths and wikilinks still work", () => {
    expect(isAbsoluteLocalPath("C:\\a\\b.md")).toBe(true);
    expect(isAbsoluteLocalPath("/home/a.md")).toBe(true);
    expect(parseWikilink("projects/x/STATE").href).toBe(`${VAULT_ROOT}\\projects\\x\\STATE.md`);
  });
  it("parseLinkTarget clamps .. at the drive root", () => {
    expect(parseLinkTarget("..\\..\\..\\Windows\\win.ini", "D:\\v\\a.md")).toMatchObject({ kind: "file", path: "D:\\Windows\\win.ini" });
    expect(parseLinkTarget("../../../Windows/win.ini", "D:\\v\\a.md")).toMatchObject({ path: "D:\\Windows\\win.ini" });
  });
});
