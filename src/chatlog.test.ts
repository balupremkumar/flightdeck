import { describe, expect, it } from "vitest";
import { SessionTailer, type ChatRecord, type TailResult } from "./chatlog";

const rec = (index: number): ChatRecord => ({
  index, block: 0, uuid: null, parent_uuid: null, timestamp: null, kind: "user",
  sidechain: false, text: "x", tool: null, result: null,
});

describe("SessionTailer", () => {
  it("advances the offset across polls and never re-reads", async () => {
    const calls: number[] = [];
    const tail = async (_p: string, from: number): Promise<TailResult> => {
      calls.push(from);
      return from === 0
        ? { records: [rec(0)], next_offset: 10, truncated: false }
        : { records: [], next_offset: from, truncated: false };
    };
    const t = new SessionTailer("p.jsonl", tail);
    expect((await t.poll()).length).toBe(1);
    expect(t.offset).toBe(10);
    expect((await t.poll()).length).toBe(0);
    expect(calls).toEqual([0, 10]);
  });

  it("drains truncated batches in one poll", async () => {
    const pages: TailResult[] = [
      { records: [rec(0), rec(5)], next_offset: 10, truncated: true },
      { records: [rec(10)], next_offset: 15, truncated: false },
    ];
    const froms: number[] = [];
    let i = 0;
    const t = new SessionTailer("p.jsonl", async (_p, from) => { froms.push(from); return pages[i++]; });
    const got = await t.poll();
    expect(got.map((r) => r.index)).toEqual([0, 5, 10]);
    expect(froms).toEqual([0, 10]);
    expect(t.offset).toBe(15);
  });

  it("caps batches per poll so a huge file cannot spin forever", async () => {
    let n = 0;
    const t = new SessionTailer("p.jsonl", async (_p, from) => { n++; return { records: [], next_offset: from + 1, truncated: true }; }, 3);
    await t.poll();
    expect(n).toBe(3);
    expect(t.offset).toBe(3);
  });
});
