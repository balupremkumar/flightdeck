import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

// UX-517: openInEditor moved out of this file and into src/editor.ts, which is
// now the one canonical launcher — its own suite is editor.test.ts.
const { isTooLargeError } = await import("./Preview");

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
