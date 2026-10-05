import { useEffect, useState } from "react";
import { getMultiwindow } from "./settingsStore";
import { otherWindows, type WindowSummary } from "./windowBoot";

// Phase 4 S9: the other windows' titles and workspaces, for the palette's "Go to
// workspace" and Home. Polled from Rust's `window_summary` while a surface that shows
// it is open (a slice trails its window by the 800 ms save debounce, so a faster poll
// buys nothing). Nothing runs with the flag off or while the surface is closed.

export const SUMMARY_POLL_MS = 2500;

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
