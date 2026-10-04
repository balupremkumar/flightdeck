// Attach-first for pane terminals (Phase 4 S3): a webview reload must find the
// agents still running in Rust and reconnect to them instead of spawning again.
//
// This file is the pure part (no xterm, no DOM) so the ordering that makes the
// handoff gapless can be unit tested with a mocked invoke/listen.
//
// How the handoff stays gapless and duplicate-free: every `pty://output` event
// carries `seq`, the ring offset AFTER its chunk. `pty_attach` snapshots the ring
// under the same lock that emits, and returns `next_seq` (the ring offset at the
// snapshot). So an event with seq <= next_seq is already inside the snapshot and
// is dropped; an event with seq > next_seq happened after it and is delivered.
// The listener is registered BEFORE the attach call, and events arriving while it
// is in flight are held, so nothing falls into the gap.

export interface OutputEvt {
  pane_id: number;
  b64: string;
  /** Ring seq after this chunk. Absent from older backends. */
  seq?: number;
}

export interface AttachSnapshot {
  /** Base64: mode-restoring escapes to write first. */
  head: string;
  /** Base64: buffered output, starting at a safe cut. */
  body: string;
  start_seq: number;
  next_seq: number;
}

export interface AttachInfo {
  pty_id: number;
  snapshot: AttachSnapshot;
  /** The pty's size when the snapshot was taken (the bytes were written at it). */
  cols?: number;
  rows?: number;
  proc_name?: string;
}

/** Gate between the `pty://output` listener and the terminal. */
export class OutputPipe<E extends { pane_id: number; seq?: number }> {
  private early: E[] = [];
  private paneId = 0;
  private minSeq = 0;

  /** Before a pty id is known: hold the event. Returns true if held. */
  hold(e: E): boolean {
    if (this.paneId !== 0) return false;
    this.early.push(e);
    return true;
  }

  /** Live path: is this event for our pane and not already in the snapshot? */
  accept(e: E): boolean {
    if (e.pane_id !== this.paneId) return false;
    return !this.seen(e);
  }

  /** The pty id is known (spawned or attached). Returns the held events that
   *  belong to it, in arrival order, minus any already covered by `afterSeq`. */
  bind(paneId: number, afterSeq = 0): E[] {
    this.paneId = paneId;
    this.minSeq = afterSeq;
    const held = this.early.filter((e) => e.pane_id === paneId && !this.seen(e));
    this.early = [];
    return held;
  }

  private seen(e: E): boolean {
    return e.seq !== undefined && e.seq <= this.minSeq;
  }
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Ask Rust for a live pty for this pane model. null means spawn instead; an
 *  error also means spawn (a stuck attach must never leave a pane dead). On a hit
 *  the pipe is bound to the pty, and the returned `early` events are the held
 *  ones that are NOT in the snapshot. */
export async function attachFirst<E extends { pane_id: number; seq?: number }>(
  inv: Invoke,
  pipe: OutputPipe<E>,
  modelId: number,
  gen: string,
): Promise<{ info: AttachInfo; early: E[] } | null> {
  let info: AttachInfo | null;
  try {
    info = await inv<AttachInfo | null>("pty_attach", { modelId, gen });
  } catch {
    return null;
  }
  if (!info) return null;
  return { info, early: pipe.bind(info.pty_id, info.snapshot.next_seq) };
}
