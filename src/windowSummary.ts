import { useEffect, useState } from "react";
import { getMultiwindow } from "./settingsStore";
import { otherWindows, type WindowSummary } from "./windowBoot";

// Phase 4 S9: the other windows' titles and workspaces, for the palette's "Go to
// workspace" and Home. Polled from Rust's `window_summary` while a surface that shows
// it is open (a slice trails its window by the 800 ms save debounce, so a faster poll
// buys nothing). Nothing runs with the flag off or while the surface is closed.

export const SUMMARY_POLL_MS = 2500;

/** One bell footer row: another window with something waiting on you. */
export interface WindowFooterRow { label: string; text: string; wsId: number | null; paneId: number | null }

/** Phase 4 S10: the bell keeps its own rows for this window's panes; this adds one
 *  row per OTHER window that has anything needing you ("2 need you in Window 2").
 *  Windows with nothing pending produce no row. The jump goes to that window's top
 *  item, else its first workspace. */
export function windowFooterRows(rows: WindowSummary[]): WindowFooterRow[] {
  return rows
    .filter((r) => (r.needsYou ?? 0) > 0)
    .map((r) => {
      const n = r.needsYou ?? 0;
      const first = r.workspaces?.[0];
      return {
        label: r.label,
        text: `${n} ${n === 1 ? "needs" : "need"} you in ${r.title || r.label}`,
        wsId: r.top?.wsId ?? first?.id ?? null,
        paneId: r.top?.paneId ?? first?.paneId ?? null,
      };
    });
}

export function useWindowSummaries(active: boolean): WindowSummary[] {
  const [rows, setRows] = useState<WindowSummary[]>([]);
  useEffect(() => {
    if (!active || !getMultiwindow()) { setRows([]); return; }
    let cancelled = false;
    const load = () => { void otherWindows().then((r) => { if (!cancelled) setRows(r); }); };
    load();
    const id = setInterval(load, SUMMARY_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [active]);
  return rows;
}
