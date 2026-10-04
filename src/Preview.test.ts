import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

// UX-517: openInEditor moved out of this file and into src/editor.ts, which is
// now the one canonical launcher — its own suite is editor.test.ts.
const { isTooLargeError, isBinaryPath, looksBinary, isDirReadError } = await import("./Preview");

describe("binary detection (Phase 1 L4)", () => {
  it("flags standalone binary extensions, case-insensitively", () => {
    for (const p of ["a.png", "D:\\x\\b.JPG", "c.pdf", "d.exe", "e.zip", "f.dll", "g.svg", "h.webp"]) {
      expect(isBinaryPath(p)).toBe(true);
    }
  });
  it("leaves text and code alone", () => {
    for (const p of ["a.md", "b.ts", "c.json", "README", "d.txt", "e.png.md"]) expect(isBinaryPath(p)).toBe(false);
  });
  it("detects NULs and replacement-char floods, not the odd one", () => {
    expect(looksBinary("abc\0def")).toBe(true);
    expect(looksBinary("\uFFFD".repeat(50) + "x".repeat(100))).toBe(true);
    expect(looksBinary("plain text with one bad \uFFFD char " + "x".repeat(500))).toBe(false);
    expect(looksBinary("")).toBe(false);
  });
});

describe("isDirReadError", () => {
  it("matches the Windows and POSIX folder-read failures", () => {
    expect(isDirReadError("Access is denied. (os error 5)")).toBe(true);
    expect(isDirReadError("Is a directory (os error 21)")).toBe(true);
  });
  it("ignores a missing file", () => {
    expect(isDirReadError("The system cannot find the file specified. (os error 2)")).toBe(false);
  });
});

describe("isTooLargeError (QL-745/746)", () => {
  it("matches the text reader's refusal verbatim", () => {
    // src-tauri/src/lib.rs — fs_read_text_file.
    expect(isTooLargeError("too large to preview (over 5MB)")).toBe(true);
  });

  it("matches the image reader's refusal verbatim", () => {
    // src-tauri/src/lib.rs — fs_read_file_base64.
    expect(isTooLargeError("too large to preview (over 10MB)")).toBe(true);
  });

  it("still matches once Tauri has wrapped it in an Error", () => {
    expect(isTooLargeError(new Error("too large to preview (over 5MB)"))).toBe(true);
  });

  it("leaves every other failure on the retryable error path", () => {
    for (const e of ["The system cannot find the file specified. (os error 2)", "Access is denied. (os error 5)", null, undefined]) {
      expect(isTooLargeError(e)).toBe(false);
    }
  });
});
