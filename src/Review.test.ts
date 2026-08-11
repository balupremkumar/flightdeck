import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

const { splitTruncationMarker, DIFF_TRUNCATED_MARKER } = await import("./Review");

// QL-739: the marker the Rust side appends to an oversized file diff
// (src-tauri/src/worktree.rs:506) must never render as diff content.
describe("splitTruncationMarker (QL-739)", () => {
  it("leaves a complete patch untouched", () => {
    const patch = "@@ -1,2 +1,2 @@\n-old\n+new\n";
    expect(splitTruncationMarker(patch)).toEqual({ body: patch, truncated: false });
  });

  it("flags the marker and strips it off the body", () => {
    const patch = "@@ -1,2 +1,2 @@\n-old\n+new\n" + DIFF_TRUNCATED_MARKER;
    expect(splitTruncationMarker(patch)).toEqual({ body: "@@ -1,2 +1,2 @@\n-old\n+new", truncated: true });
  });

  it("matches the exact marker the backend appends", () => {
    expect(DIFF_TRUNCATED_MARKER).toBe("… [diff truncated]");
    expect(splitTruncationMarker("+x\n" + DIFF_TRUNCATED_MARKER).truncated).toBe(true);
  });

  it("tolerates trailing blank lines after the marker", () => {
    expect(splitTruncationMarker(`+x\n${DIFF_TRUNCATED_MARKER}\n\n`)).toEqual({ body: "+x", truncated: true });
  });

  it("ignores the marker anywhere but the end — that's real file content", () => {
    const patch = `+${DIFF_TRUNCATED_MARKER}\n context\n`;
    expect(splitTruncationMarker(patch)).toEqual({ body: patch, truncated: false });
  });

  it("handles an empty patch", () => {
    expect(splitTruncationMarker("")).toEqual({ body: "", truncated: false });
  });

  it("handles a patch that is nothing but the marker", () => {
    expect(splitTruncationMarker(DIFF_TRUNCATED_MARKER)).toEqual({ body: "", truncated: true });
  });
});
