import { useEffect, useRef, useState } from "react";
import { useApp, type PaneState } from "../store";

export interface PaneStatus {
  state: PaneState;
  rel: string; // "just now" / "12s ago" / "4m ago" — time since the state last changed
}

import { relTime as fmtRel } from "../format";

function relTime(ms: number): string {
  return fmtRel(Date.now() - ms);
}

// Live agent progress for a card dispatched to a pane (BACKLOG D12): a state
// dot + "last activity" relative time, driven by the pane's own state
// transitions (store.ts sets `starting -> running -> waiting/idle/error`).
export function usePaneStatus(paneId?: number): PaneStatus | null {
  const pane = useApp((s) => (paneId == null ? undefined : s.workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId)));
  const last = useRef<{ state?: PaneState; at: number }>({ state: undefined, at: Date.now() });
  const [, force] = useState(0);

  useEffect(() => {
    if (pane && pane.state !== last.current.state) last.current = { state: pane.state, at: Date.now() };
  }, [pane?.state]);

  useEffect(() => {
    if (!pane) return;
    const id = window.setInterval(() => force((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, [!!pane]);

  if (!pane) return null;
  return { state: pane.state, rel: relTime(Date.now() - last.current.at) };
}
