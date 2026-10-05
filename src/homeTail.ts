// homeTail.ts: Home's view of a pane's recent output, from the Rust ring via
// `pane_tail` (ANSI already stripped). Fetched only for the cards that want it
// (a peek that is open) and refetched when that card's state key changes, never
// on a timer. Works for unmounted panes; the tail never leaves the app.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export const TAIL_BYTES = 16384;
/** Lines the peek shows. */
export const PEEK_LINES = 12;

export interface PaneTail { lines: string[]; seq: number }

/** `prev` keeps the last good tail on screen while a refetch is in flight or has failed. */
export type TailEntry =
  | { status: "loading"; prev?: PaneTail }
  | { status: "ok"; tail: PaneTail }
  | { status: "error"; prev?: PaneTail };

export const fetchTail = (modelId: number): Promise<PaneTail> =>
  invoke<PaneTail>("pane_tail", { modelId, maxBytes: TAIL_BYTES });

export const entryTail = (e: TailEntry | undefined): PaneTail | undefined =>
  !e ? undefined : e.status === "ok" ? e.tail : e.prev;

export interface TailWant { paneId: number; key: string }

export function useHomeTails(open: boolean, wants: TailWant[]) {
  const [entries, setEntries] = useState<Record<number, TailEntry>>({});
  const fetched = useRef(new Map<number, string>());
  const keys = useRef(new Map<number, string>());
  for (const w of wants) keys.current.set(w.paneId, w.key);

  const load = useCallback(async (paneId: number): Promise<PaneTail | null> => {
    const key = keys.current.get(paneId) ?? "";
    fetched.current.set(paneId, key);
    setEntries((m) => ({ ...m, [paneId]: { status: "loading", prev: entryTail(m[paneId]) } }));
    try {
      const tail = await fetchTail(paneId);
      setEntries((m) => ({ ...m, [paneId]: { status: "ok", tail } }));
      return tail;
    } catch {
      setEntries((m) => ({ ...m, [paneId]: { status: "error", prev: entryTail(m[paneId]) } }));
      return null;
    }
  }, []);

  const sig = wants.map((w) => w.paneId + ":" + w.key).join(",");
  useEffect(() => {
    if (!open) { fetched.current.clear(); setEntries((m) => (Object.keys(m).length ? {} : m)); return; }
    const want = new Set(wants.map((w) => w.paneId));
    for (const id of [...fetched.current.keys()]) if (!want.has(id)) fetched.current.delete(id);
    for (const w of wants) if (fetched.current.get(w.paneId) !== w.key) void load(w.paneId);
    // `sig` is the content of `wants`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sig, load]);

  return { entries, refresh: load };
}
