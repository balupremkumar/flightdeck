import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

const { isTooLargeError, openInEditor } = await import("./Preview");
const { openPath } = await import("@tauri-apps/plugin-opener");
const { useUI } = await import("./ui");

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

describe("openInEditor (QL-745/746)", () => {
  it("hands the path to the opener", async () => {
    vi.mocked(openPath).mockResolvedValueOnce(undefined);
    openInEditor("D:\\repo\\huge.log");
    expect(openPath).toHaveBeenCalledWith("D:\\repo\\huge.log");
  });

  it("surfaces a failure as a toast instead of an unhandled rejection", async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new Error("no handler"));
    openInEditor("D:\\repo\\huge.log");
    await Promise.resolve();
    await Promise.resolve();
    // .at() is ES2022; this project targets ES2020 (see tsconfig.json).
    const toasts = useUI.getState().toasts;
    const last = toasts[toasts.length - 1];
    expect(last?.kind).toBe("error");
    expect(last?.text).toContain("D:\\repo\\huge.log");
  });
});
