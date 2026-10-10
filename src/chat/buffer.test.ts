import { describe, expect, it } from "vitest";
import type { ChatRecord } from "../chatlog";
import { appendBounded, MAX_RECORDS } from "./buffer";

const record = (index: number): ChatRecord => ({
  index, block: 0, uuid: null, parent_uuid: null, timestamp: null,
  kind: "other", sidechain: false, text: null, tool: null, result: null,
});

describe("bounded buffer", () => {
  it("MAX_RECORDS sets the default capacity to 5000", () => {
    expect(MAX_RECORDS).toBe(5000);
    const incoming = Array.from({ length: MAX_RECORDS + 1 }, (_, index) => record(index));
    const result = appendBounded([], incoming);
    expect(result.dropped).toBe(1);
    expect(result.list).toEqual(incoming.slice(1));
  });
  it("appendBounded preserves order and inputs when at or below capacity", () => {
    const list = [record(1)], incoming = [record(2)];
    expect(appendBounded(list, incoming, 2)).toEqual({ list: [record(1), record(2)], dropped: 0 });
    expect(appendBounded(list, incoming, 3).dropped).toBe(0);
    expect(list).toEqual([record(1)]);
    expect(incoming).toEqual([record(2)]);
  });
  it("appendBounded drops the oldest records even when an incoming batch exceeds capacity", () => {
    expect(appendBounded([record(1), record(2)], [record(3), record(4)], 3)).toEqual({
      list: [record(2), record(3), record(4)], dropped: 1,
    });
    expect(appendBounded([record(1)], [record(2), record(3), record(4)], 2)).toEqual({
      list: [record(3), record(4)], dropped: 2,
    });
    expect(appendBounded([], [record(1)], 0)).toEqual({ list: [], dropped: 1 });
  });
  it("appendBounded returns the existing list unchanged for empty incoming batches", () => {
    const list = [record(1)];
    const result = appendBounded(list, []);
    expect(result).toEqual({ list, dropped: 0 });
    expect(result.list).toBe(list);
  });
});
