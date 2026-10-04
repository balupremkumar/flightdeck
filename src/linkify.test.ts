import { describe, expect, it } from "vitest";
import { linkify, resolvePath } from "./linkify";

describe("linkify — urls", () => {
  it("detects a bare https url", () => {
    const m = linkify("See https://example.com/docs for more.");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "url", raw: "https://example.com/docs" });
  });

  it("trims trailing sentence punctuation off a url", () => {
    const m = linkify("Docs: https://example.com/a/b.");
    expect(m[0].raw).toBe("https://example.com/a/b");
  });

  it("detects http (not just https)", () => {
    const m = linkify("http://localhost:1420/");
    expect(m[0].kind).toBe("url");
    expect(m[0].raw).toBe("http://localhost:1420/");
  });

  it("does not treat a url's own path segment as a separate path match", () => {
    const m = linkify("open https://example.com/docs/guide now");
    expect(m).toHaveLength(1);
  });
});

describe("linkify — windows absolute paths", () => {
  it("detects a drive-letter path", () => {
    const m = linkify("open D:\\Dev\\ai\\projects\\active\\flightdeck\\src\\App.tsx now");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "path", raw: "D:\\Dev\\ai\\projects\\active\\flightdeck\\src\\App.tsx" });
  });

  it("does not detect a UNC path", () => {
    const m = linkify("copy \\\\server\\share\\file.txt here");
    expect(m).toHaveLength(0);
  });

  it("strips trailing sentence punctuation", () => {
    const m = linkify("The file is at C:\\Users\\Balu\\notes.md.");
    expect(m[0].raw).toBe("C:\\Users\\Balu\\notes.md");
  });

  it("does not swallow a trailing parenthesis that isn't a tsc suffix", () => {
    const m = linkify("(see C:\\Users\\Balu\\notes.md)");
    expect(m[0].raw).toBe("C:\\Users\\Balu\\notes.md");
  });
});

describe("linkify — posix absolute paths", () => {
  it("detects a plain absolute path", () => {
    const m = linkify("cat /etc/hosts");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "path", raw: "/etc/hosts" });
  });

  it("detects an absolute path with a line suffix", () => {
    const m = linkify("at /home/user/project/src/index.ts:10");
    expect(m[0].raw).toBe("/home/user/project/src/index.ts");
    expect(m[0].line).toBe(10);
  });
});

describe("linkify — repo-relative paths", () => {
  it("detects a plain relative path with an extension", () => {
    const m = linkify("git status shows src/Terminal.tsx");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "path", raw: "src/Terminal.tsx" });
  });

  it("detects a dot-slash relative path", () => {
    const m = linkify("run ./build.sh next");
    expect(m[0].raw).toBe("./build.sh");
  });

  it("detects a dot-dot relative path", () => {
    const m = linkify("see ../shared/utils.ts for the helper");
    expect(m[0].raw).toBe("../shared/utils.ts");
  });

  it("handles the demo agent-output style line", () => {
    const m = linkify("Edit src/api/upload.ts (+4 -1)");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "path", raw: "src/api/upload.ts" });
  });

  it("handles git status porcelain lines", () => {
    const m1 = linkify(" M src/Terminal.tsx");
    expect(m1[0].raw).toBe("src/Terminal.tsx");
    const m2 = linkify("?? src/Preview.tsx");
    expect(m2[0].raw).toBe("src/Preview.tsx");
  });
});

describe("linkify — line/col suffixes", () => {
  it("parses tsc-style path(line,col)", () => {
    const m = linkify("src/App.tsx(12,5): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "path", raw: "src/App.tsx", line: 12, col: 5 });
  });

  it("parses vitest/eslint-style path:line:col", () => {
    const m = linkify("at src/foo.ts:42:10");
    expect(m[0]).toMatchObject({ raw: "src/foo.ts", line: 42, col: 10 });
  });

  it("parses a bare path:line with no column", () => {
    const m = linkify("thrown from src/bar.ts:7");
    expect(m[0]).toMatchObject({ raw: "src/bar.ts", line: 7, col: undefined });
  });

  it("FAIL src/x.test.ts with no suffix still matches", () => {
    const m = linkify("FAIL src/linkify.test.ts > linkify > detects urls");
    expect(m[0].raw).toBe("src/linkify.test.ts");
    expect(m[0].line).toBeUndefined();
  });
});

describe("linkify — quoted paths with spaces", () => {
  it("detects a double-quoted path containing a space", () => {
    const m = linkify('Reading "My Documents/notes.md" now');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "path", raw: "My Documents/notes.md" });
    expect(m[0].text).toBe('"My Documents/notes.md"');
  });

  it("detects a single-quoted windows path from an npm error", () => {
    const m = linkify("npm ERR! enoent ENOENT: no such file or directory, open 'C:\\Users\\Balu\\my project\\package.json'");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "path", raw: "C:\\Users\\Balu\\my project\\package.json" });
  });

  it("does not treat an ordinary quoted sentence as a path", () => {
    const m = linkify('He said "hello there" to everyone');
    expect(m).toHaveLength(0);
  });
});

describe("linkify — false positives it must avoid", () => {
  it("does not match prose slashes like and/or", () => {
    expect(linkify("Use pwsh and/or cmd for this")).toHaveLength(0);
  });

  it("does not match version numbers", () => {
    expect(linkify("Node.js v20.11.0 is required")).toHaveLength(0);
    expect(linkify("bumped to v1.2.3 today")).toHaveLength(0);
  });

  it("does not match plain times", () => {
    expect(linkify("Meeting at 12:30pm works")).toHaveLength(0);
    expect(linkify("started at 09:15:42")).toHaveLength(0);
  });

  it("does not match bare numbers", () => {
    expect(linkify("processed 12345 rows")).toHaveLength(0);
  });

  it("does not match a lone double slash", () => {
    expect(linkify("// just a comment")).toHaveLength(0);
  });

  it("does not match a fraction-like phrase", () => {
    expect(linkify("roughly 1/2 of the tests pass")).toHaveLength(0);
  });
});

describe("linkify — multiple matches on one line", () => {
  it("finds several links and reports correct offsets", () => {
    const line = "Edit src/App.tsx then check https://example.com/docs";
    const m = linkify(line);
    expect(m).toHaveLength(2);
    expect(m[0].kind).toBe("path");
    expect(line.slice(m[0].start, m[0].end)).toBe(m[0].text);
    expect(m[1].kind).toBe("url");
    expect(line.slice(m[1].start, m[1].end)).toBe(m[1].text);
  });
});

describe("resolvePath", () => {
  const winCwd = "D:\\Dev\\ai\\projects\\active\\flightdeck";

  it("leaves an absolute windows path unchanged", () => {
    const [m] = linkify("D:\\Dev\\other\\file.ts");
    expect(resolvePath(m, winCwd)).toBe("D:\\Dev\\other\\file.ts");
  });

  it("joins a bare relative path onto cwd", () => {
    const [m] = linkify("src/foo.ts");
    expect(resolvePath(m, winCwd)).toBe("D:\\Dev\\ai\\projects\\active\\flightdeck\\src\\foo.ts");
  });

  it("resolves a dot-slash relative path", () => {
    const [m] = linkify("./build.sh");
    expect(resolvePath(m, winCwd)).toBe("D:\\Dev\\ai\\projects\\active\\flightdeck\\build.sh");
  });

  it("resolves a dot-dot relative path up one level", () => {
    const [m] = linkify("../shared/utils.ts");
    expect(resolvePath(m, winCwd)).toBe("D:\\Dev\\ai\\projects\\active\\shared\\utils.ts");
  });

  it("leaves an absolute posix path unchanged under a posix cwd", () => {
    const [m] = linkify("/etc/hosts");
    expect(resolvePath(m, "/home/user/project")).toBe("/etc/hosts");
  });

  it("joins a relative path onto a posix cwd", () => {
    const [m] = linkify("src/foo.ts");
    expect(resolvePath(m, "/home/user/project")).toBe("/home/user/project/src/foo.ts");
  });

  it("resolves a quoted path with a space", () => {
    const [m] = linkify('"My Documents/notes.md"');
    expect(resolvePath(m, winCwd)).toBe("D:\\Dev\\ai\\projects\\active\\flightdeck\\My Documents\\notes.md");
  });
});

// ---- L1 matcher (phase 1) ----------------------------------------------

/** span helper: the exact substring each match underlines */
const spans = (s: string) => linkify(s).map((m) => s.slice(m.start, m.end));

describe("linkify L1 — delimiters and emphasis", () => {
  it("excludes backticks from the span, keeps line suffix", () => {
    const s = "open `D:\\Dev\\x\\App.tsx:42` now";
    const [m] = linkify(s);
    expect(m).toMatchObject({ kind: "path", raw: "D:\\Dev\\x\\App.tsx", line: 42 });
    expect(s.slice(m.start, m.end)).toBe("D:\\Dev\\x\\App.tsx:42");
    expect(spans("see `src-tauri/src/lib.rs`.")).toEqual(["src-tauri/src/lib.rs"]);
  });

  it("does not turn a backticked command into a path", () => {
    expect(spans("run `pwsh tools\\revert.ps1 -To 0.5.4` now")).toEqual(["tools\\revert.ps1"]);
  });

  it("excludes markdown emphasis markers", () => {
    expect(spans("**./x.ts**")).toEqual(["./x.ts"]);
    expect(spans("_src/a.ts_")).toEqual(["src/a.ts"]);
    expect(spans("**src/a.ts**")).toEqual(["src/a.ts"]);
  });

  it("accepts a markdown link target with spaces", () => {
    const s = "[x](D:\\a b\\c.md)";
    const [m] = linkify(s);
    expect(m.raw).toBe("D:\\a b\\c.md");
    expect(s.slice(m.start, m.end)).toBe("D:\\a b\\c.md");
  });

  it("accepts an angle-bracketed path with spaces", () => {
    expect(spans("open <C:\\My Files\\a.txt> ok")).toEqual(["C:\\My Files\\a.txt"]);
  });

  it("does not link an apostrophe pair in prose", () => {
    expect(linkify("it's a path/like thing, isn't it")).toHaveLength(0);
  });
});

describe("linkify L1 — urls", () => {
  it("drops an unbalanced trailing paren or bracket", () => {
    expect(spans("(see https://x.io/y)")).toEqual(["https://x.io/y"]);
    expect(spans("[t](https://x.io/y)")).toEqual(["https://x.io/y"]);
    expect(spans("https://x/y].")).toEqual(["https://x/y"]);
  });
  it("keeps a balanced paren pair", () => {
    expect(spans("https://en.wikipedia.org/wiki/Foo_(bar) ok")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });
  it("a quoted url is a url, not a path", () => {
    const [m] = linkify('go to "https://x.io/a/b" now');
    expect(m.kind).toBe("url");
    expect(m.raw).toBe("https://x.io/a/b");
  });
});

describe("linkify L1 — spaced absolute paths", () => {
  const p = "D:\\Dev\\ai\\projects\\active\\Kove Clients\\STATE.md";
  it("joins a drive path across spaces when it ends in a filename", () => {
    const s = `open ${p} please`;
    const m = linkify(s);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ raw: p, delimited: false });
    expect(s.slice(m[0].start, m[0].end)).toBe(p);
  });
  it("never emits the tail as a second relative link", () => {
    expect(linkify(p).map((m) => m.raw)).toEqual([p]);
  });
  it("supports Program Files (x86)", () => {
    expect(spans("C:\\Program Files (x86)\\Foo\\a.exe")).toEqual(["C:\\Program Files (x86)\\Foo\\a.exe"]);
  });
  it("does not join prose onto a finished path", () => {
    expect(spans("Saved D:\\a\\b.md then c\\d.ts")).toEqual(["D:\\a\\b.md", "c\\d.ts"]);
    expect(spans("Saved to D:\\a\\b.md, then")).toEqual(["D:\\a\\b.md"]);
    expect(spans("D:\\a\\b and c/d.md")).toEqual(["D:\\a\\b", "c/d.md"]);
  });
  it("normal drive paths are delimited true", () => {
    expect(linkify("D:\\a\\b.md")[0].delimited).toBe(true);
  });
});

describe("linkify L1 — tilde, env, git bash, wsl", () => {
  it("keeps the tilde in raw", () => {
    expect(linkify("~/.claude/agents/frontend.md")[0]).toMatchObject({ raw: "~/.claude/agents/frontend.md", kind: "path" });
    expect(linkify("see ~\\x\\y.md.")[0].raw).toBe("~\\x\\y.md");
  });
  it("expands %VAR% prefixes as paths", () => {
    expect(spans("`%APPDATA%\\ai.flightdeck.canary\\backups\\` ok")).toEqual(["%APPDATA%\\ai.flightdeck.canary\\backups\\"]);
  });
  it("matches git bash and wsl paths, raw kept", () => {
    expect(linkify("/c/Users/x/a.ts")[0]).toMatchObject({ kind: "path", raw: "/c/Users/x/a.ts" });
    expect(linkify("/mnt/d/Dev/a.ts")[0]).toMatchObject({ kind: "path", raw: "/mnt/d/Dev/a.ts" });
  });
  it("resolvePath maps git bash and wsl under a windows cwd", () => {
    const cwd = "D:\\Dev";
    expect(resolvePath(linkify("/c/Users/x/a.ts")[0], cwd)).toBe("C:\\Users\\x\\a.ts");
    expect(resolvePath(linkify("/mnt/d/Dev/a.ts")[0], cwd)).toBe("D:\\Dev\\a.ts");
    expect(resolvePath(linkify("/mnt/d/Dev/a.ts")[0], "/home/u")).toBe("/mnt/d/Dev/a.ts");
  });
  it("a lone slash command is an unverified candidate", () => {
    expect(linkify("type /clear now")[0]).toMatchObject({ raw: "/clear", delimited: false });
  });
});

describe("linkify L1 — suffixes", () => {
  const cases: [string, string, number, number | undefined, string][] = [
    ["a/x.ts:12", "a/x.ts", 12, undefined, "a/x.ts:12"],
    ["a/x.ts:12:5", "a/x.ts", 12, 5, "a/x.ts:12:5"],
    ["a/x.ts(12,5)", "a/x.ts", 12, 5, "a/x.ts(12,5)"],
    ["a/x.ts#L12", "a/x.ts", 12, undefined, "a/x.ts#L12"],
    ["a/x.ts#L12-L20", "a/x.ts", 12, undefined, "a/x.ts#L12-L20"],
    ["a/x.ts, line 12", "a/x.ts", 12, undefined, "a/x.ts, line 12"],
    ["a/x.ts:12:5-20", "a/x.ts", 12, 5, "a/x.ts:12:5-20"],
    ["x.ts:12", "x.ts", 12, undefined, "x.ts:12"],
  ];
  it.each(cases)("%s", (s, raw, line, col, span) => {
    const m = linkify(s);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ raw, line });
    expect(m[0].col).toBe(col);
    expect(s.slice(m[0].start, m[0].end)).toBe(span);
  });
  it("python traceback quoted path with trailing line", () => {
    const s = 'File "/app/x.py", line 7, in run';
    const [m] = linkify(s);
    expect(m).toMatchObject({ raw: "/app/x.py", line: 7 });
  });
});

describe("linkify L1 — unverified candidates", () => {
  it("bare filenames are delimited:false", () => {
    for (const f of ["README.md", "package.json", "STATE.md"]) {
      const s = `edit ${f} now`;
      const m = linkify(s);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ kind: "path", raw: f, delimited: false });
      expect(s.slice(m[0].start, m[0].end)).toBe(f);
    }
    expect(linkify("see package.json:3")[0]).toMatchObject({ raw: "package.json", line: 3 });
  });
  it("folders with a slash are delimited:false", () => {
    expect(linkify("look in src/components for it")[0]).toMatchObject({ raw: "src/components", delimited: false });
    expect(linkify("look in docs/ for it")[0]).toMatchObject({ raw: "docs/", delimited: false });
  });
  it("a path with a slash and extension is delimited:true", () => {
    expect(linkify("src/a.ts")[0].delimited).toBe(true);
  });
  it("prose false positives stay unmatched", () => {
    for (const s of [
      "e.g. this", "i.e. that", "v0.5.5 shipped", "version 3.5 is out", "Node.js is required",
      "Next.js and Vue.js apps", "a/b testing", "and/or", "TCP/IP stack", "on 10/05/2026", "1.2.3", "end.Then more",
      "visit example.com today", "mail me@x.md now", "http/1.1 only",
    ]) {
      expect(spans(s), s).toEqual([]);
    }
  });
});

describe("linkify L1 — wikilinks", () => {
  it("path with alias", () => {
    const s = "see [[projects/active/flightdeck/STATE|Flightdeck]] now";
    const [m] = linkify(s);
    expect(m).toMatchObject({ kind: "wikilink", raw: "projects/active/flightdeck/STATE", alias: "Flightdeck" });
    expect(s.slice(m.start, m.end)).toBe("[[projects/active/flightdeck/STATE|Flightdeck]]");
  });
  it("bare", () => {
    const [m] = linkify("[[HOME]]");
    expect(m).toMatchObject({ kind: "wikilink", raw: "HOME", text: "[[HOME]]" });
    expect(m.alias).toBeUndefined();
  });
});

describe("linkify L1 — misc", () => {
  it("file:/// url yields the drive path", () => {
    expect(linkify("file:///D:/Dev/ai/HOME.md")[0]).toMatchObject({ kind: "path", raw: "D:/Dev/ai/HOME.md" });
  });
  it("keeps UNC unlinked, also inside backticks", () => {
    expect(linkify("copy \\\\server\\share\\file.txt here")).toHaveLength(0);
    expect(linkify("(`\\\\server\\...`)")).toHaveLength(0);
  });
  it("folder with trailing slash keeps the slash", () => {
    expect(spans("in D:\\Dev\\ai\\research\\x-2026-10\\ now")).toEqual(["D:\\Dev\\ai\\research\\x-2026-10\\"]);
  });
  it("trims sentence punctuation", () => {
    expect(spans("Saved to D:\\a\\b.md, then")).toEqual(["D:\\a\\b.md"]);
    expect(spans("(see C:\\x\\out.json).")).toEqual(["C:\\x\\out.json"]);
  });
  it("is fast enough to run per terminal row", () => {
    const line = "error in src/components/Foo.tsx:42:7 see https://x.io/docs and `D:\\Dev\\x\\y.ts` plus lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore".slice(0, 200);
    const t = performance.now();
    for (let i = 0; i < 2000; i++) linkify(line);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
