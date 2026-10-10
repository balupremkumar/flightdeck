import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { entryTail, fetchTail, PEEK_LINES, TAIL_BYTES, type PaneTail } from "./homeTail";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => { vi.mocked(invoke).mockReset(); });

describe("pane tails", () => {
  const tail: PaneTail = { lines: ["first", "last"], seq: 42 };

  it("limits fetches to 16 KiB and peeks to twelve lines", () => {
    expect(TAIL_BYTES).toBe(16384);
    expect(PEEK_LINES).toBe(12);
  });

  it("fetchTail requests the model tail and returns its lines and sequence", async () => {
    vi.mocked(invoke).mockResolvedValue(tail);
    await expect(fetchTail(7)).resolves.toBe(tail);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("pane_tail", { modelId: 7, maxBytes: 16384 });
  });

  it("fetchTail propagates a backend rejection", async () => {
    const error = new Error("pane gone");
    vi.mocked(invoke).mockRejectedValue(error);
    await expect(fetchTail(7)).rejects.toBe(error);
  });

  it("entryTail returns the successful tail or the last good tail while loading or failed", () => {
    expect(entryTail({ status: "ok", tail })).toBe(tail);
    expect(entryTail({ status: "loading", prev: tail })).toBe(tail);
    expect(entryTail({ status: "error", prev: tail })).toBe(tail);
  });

  it("entryTail returns undefined when no tail has been fetched", () => {
    expect(entryTail(undefined)).toBeUndefined();
    expect(entryTail({ status: "loading" })).toBeUndefined();
    expect(entryTail({ status: "error" })).toBeUndefined();
  });
});
