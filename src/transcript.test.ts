import { describe, expect, it } from "vitest";
import { extractLastCommand, redactText, scrollbackFilename, searchTranscript, toLines } from "./transcript";

describe("toLines", () => {
  it("normalises CRLF and preserves blank lines", () => {
    expect(toLines("a\r\nb\r\n\r\nc")).toEqual(["a", "b", "", "c"]);
  });
});

describe("searchTranscript", () => {
  const lines = ["Building project", "Error: missing dependency", "  running tests", "ERROR again"];

  it("finds case-insensitive matches in document order", () => {
    const m = searchTranscript(lines, "error");
    expect(m.map((x) => x.index)).toEqual([1, 3]);
  });

  it("empty query returns no matches", () => {
    expect(searchTranscript(lines, "   ")).toEqual([]);
  });

  it("no matches returns an empty array, not undefined", () => {
    expect(searchTranscript(lines, "nope-not-here")).toEqual([]);
  });
});

describe("redactText (UX-547, mirrors support.rs::redact)", () => {
  it("redacts known key prefixes", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const out = redactText(`using key ${secret} for this session`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("leaves paths and ordinary prose alone", () => {
    const input = "cwd D:\\Dev\\ai\\projects\\active\\flightdeck is a normal sentence";
    expect(redactText(input)).toBe(input);
  });

  it("redacts generic long opaque alnum tokens", () => {
    const out = redactText("token abc123DEF456ghi789JKL012mno345");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("abc123DEF456ghi789JKL012mno345");
  });

  it("redacts across multiple lines independently", () => {
    const out = redactText("line one sk-ant-abcdefghijklmnopqrstuvwxyz0123\nline two is clean");
    const outLines = out.split("\n");
    expect(outLines[0]).toContain("[REDACTED]");
    expect(outLines[1]).toBe("line two is clean");
  });
});

describe("extractLastCommand (UX-549)", () => {
  it("picks up a Claude Code Bash(...) tool call, most recent one wins", () => {
    const lines = ["⏺ Bash(npm ci)", "installing…", "⏺ Bash(npm run build)", "build output here"];
    expect(extractLastCommand(lines)).toBe("npm run build");
  });

  it("falls back to a plain shell prompt echo", () => {
    expect(extractLastCommand(["$ git status", "nothing to commit"])).toBe("git status");
  });

  it("returns null when nothing looks like a command", () => {
    expect(extractLastCommand(["just some narration", "no commands here"])).toBeNull();
  });

  it("ignores an empty transcript", () => {
    expect(extractLastCommand([])).toBeNull();
  });
});

describe("scrollbackFilename", () => {
  it("is safe and marks redacted exports distinctly", () => {
    expect(scrollbackFilename("claude", false)).toMatch(/^claude-scrollback-\d{4}-\d{2}-\d{2}\.log$/);
    expect(scrollbackFilename("claude", true)).toMatch(/-redacted\.log$/);
  });

  it("sanitises an odd vendor id", () => {
    expect(scrollbackFilename("my vendor!", false)).toMatch(/^my-vendor--scrollback-/);
  });
});
