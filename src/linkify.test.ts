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

  it("detects a UNC path", () => {
    const m = linkify("copy \\\\server\\share\\file.txt here");
    expect(m).toHaveLength(1);
    expect(m[0].raw).toBe("\\\\server\\share\\file.txt");
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
