import { describe, expect, it } from "vitest";
import { OutputPipe, attachFirst, attachPlan, isRestoredPane, markRestoredPane, type AttachInfo, type OutputEvt } from "./ptyAttach";

const b64 = (s: string) => btoa(s);
const evt = (pane_id: number, text: string, seq?: number): OutputEvt => ({ pane_id, b64: b64(text), seq });

/** A fake backend: a byte stream per pane, an event emitter, and a pty_attach
 *  whose answer is computed when it is CALLED but delivered after `lag` events
 *  have been emitted (the in-flight window the real IPC has). */
function harness() {
  const listeners: ((e: OutputEvt) => void)[] = [];
  let stream = "";
  const emitChunk = (pane: number, text: string) => {
    stream += text;
    const e = evt(pane, text, stream.length);
    listeners.forEach((l) => l(e));
  };
  const snapshotNow = (): AttachInfo => ({
    pty_id: 5,
    snapshot: { head: "", body: b64(stream), start_seq: 0, next_seq: stream.length },
    cols: 80,
    rows: 24,
  });
  return { listeners, emitChunk, snapshotNow };
}

describe("attach-then-subscribe", () => {
  it("shows every byte exactly once when output arrives around the attach", async () => {
    const h = harness();
    const pipe = new OutputPipe<OutputEvt>();
    const screen: string[] = [];
    // The listener is registered BEFORE attach, as in createSession.
    h.listeners.push((e) => {
      if (pipe.hold(e)) return;
      if (!pipe.accept(e)) return;
      screen.push(atob(e.b64));
    });

    h.emitChunk(5, "one|"); // before attach: in the snapshot
    h.emitChunk(5, "two|");

    let info!: AttachInfo;
    const inv = async <T,>(cmd: string): Promise<T> => {
      expect(cmd).toBe("pty_attach");
      info = h.snapshotNow(); // Rust snapshots here...
      h.emitChunk(5, "three|"); // ...an event whose seq is past next_seq lands while the reply is in flight
      return info as T;
    };

    const hit = await attachFirst(inv, pipe, 1, "0|claude|D:\\x");
    expect(hit).not.toBeNull();
    // Already-seen events (one, two) were held or delivered nowhere: the
    // snapshot is the only source for them.
    expect(screen).toEqual([]); // nothing delivered live yet: the in-flight one is held
    screen.push(atob(hit!.info.snapshot.body));
    for (const p of hit!.early) screen.push(atob(p.b64));

    h.emitChunk(5, "four|"); // live after bind
    h.emitChunk(9, "other pane|"); // someone else's pane: ignored

    expect(screen.join("")).toBe("one|two|three|four|");
  });

  it("drops an event whose seq equals next_seq (it is inside the snapshot)", async () => {
    const pipe = new OutputPipe<OutputEvt>();
    pipe.hold(evt(5, "aa", 2)); // arrived early, already part of the snapshot
    pipe.hold(evt(5, "bb", 4)); // after the snapshot
    const early = pipe.bind(5, 2);
    expect(early.map((e) => atob(e.b64))).toEqual(["bb"]);
    expect(pipe.accept(evt(5, "aa", 2))).toBe(false);
    expect(pipe.accept(evt(5, "cc", 3))).toBe(true);
    expect(pipe.accept(evt(6, "zz", 99))).toBe(false);
  });

  it("keeps held events in arrival order and only for its own pane", () => {
    const pipe = new OutputPipe<OutputEvt>();
    pipe.hold(evt(1, "a", 1));
    pipe.hold(evt(2, "x", 1));
    pipe.hold(evt(1, "b", 2));
    expect(pipe.bind(1).map((e) => atob(e.b64))).toEqual(["a", "b"]);
  });

  it("does not hold once bound, and events without seq are never dropped", () => {
    const pipe = new OutputPipe<OutputEvt>();
    pipe.bind(3, 100);
    expect(pipe.hold(evt(3, "x", 1))).toBe(false);
    expect(pipe.accept({ pane_id: 3, b64: b64("legacy") })).toBe(true);
  });

  it("spawn path: bind(id) with no base keeps everything", () => {
    const pipe = new OutputPipe<OutputEvt>();
    pipe.hold(evt(4, "first", 5));
    expect(pipe.bind(4).length).toBe(1);
    expect(pipe.accept(evt(4, "next", 9))).toBe(true);
  });

  it("returns null on a miss so the caller spawns", async () => {
    const pipe = new OutputPipe<OutputEvt>();
    const hit = await attachFirst(async <T,>() => null as T, pipe, 1, "0|claude|c");
    expect(hit).toBeNull();
    expect(pipe.hold(evt(1, "x", 1))).toBe(true); // still unbound
  });

  it("returns null when pty_attach throws, so the pane still spawns", async () => {
    const pipe = new OutputPipe<OutputEvt>();
    const hit = await attachFirst(async () => { throw new Error("boom"); }, pipe, 1, "0|claude|c");
    expect(hit).toBeNull();
  });

  it("passes modelId and gen straight through", async () => {
    const pipe = new OutputPipe<OutputEvt>();
    let seen: unknown;
    await attachFirst(async <T,>(_c: string, a?: Record<string, unknown>) => { seen = a; return null as T; }, pipe, 42, "7|codex|D:\\p");
    expect(seen).toEqual({ modelId: 42, gen: "7|codex|D:\\p" });
  });
});

describe("attachPlan", () => {
  it("keeps restored scrollback and nudges a redraw after a tiny snapshot", () => {
    expect(attachPlan(40, true, true)).toEqual({ reset: false, nudge: true });
  });
  it("resets a clean terminal for a real snapshot, or when nothing was restored", () => {
    expect(attachPlan(100_000, true, true)).toEqual({ reset: true, nudge: false });
    expect(attachPlan(40, false, false)).toEqual({ reset: true, nudge: false });
  });
});

describe("fresh panes never attach", () => {
  it("a fresh pane skips pty_attach entirely and spawns", async () => {
    let called = false;
    const inv = (async () => { called = true; return { pty_id: 9, snapshot: { head: "", body: "", start_seq: 0, next_seq: 0 } }; }) as Parameters<typeof attachFirst>[0];
    const pipe = new OutputPipe<OutputEvt>();
    expect(await attachFirst(inv, pipe, 1, "0|claude|D:\\a", true)).toBeNull();
    expect(called).toBe(false);
  });
  it("only panes rebuilt from a session doc count as restored", () => {
    expect(isRestoredPane(901)).toBe(false);
    markRestoredPane(901);
    expect(isRestoredPane(901)).toBe(true);
  });
});
