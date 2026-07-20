import { useEffect, useRef, useState } from "react";
import { useApp, type PaneState } from "../store";
import { cachedInvoke, usePoll } from "../poll";

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

export interface PaneUsage { contextTokens: number; outputTokens: number; turns: number; }

// UI-160: same transcript-derived numbers PaneView's token chip reads, so a
// dispatched card shows usage without opening its pane. Goes through the
// shared cache (poll.ts) — a card and its pane's own chip never double the
// invoke count, and the poll stands down once the window is hidden.
export function usePaneUsage(paneId?: number): PaneUsage | null {
  const cwd = useApp((s) =>
    paneId == null ? undefined : s.workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId)?.cwd
  );
  const [usage, setUsage] = useState<PaneUsage | null>(null);

  usePoll(async () => {
    if (!cwd) { setUsage(null); return; }
    try {
      setUsage(await cachedInvoke<PaneUsage | null>("pane_usage", { cwd }, 7000));
    } catch {
      setUsage(null);
    }
  }, 15000, [cwd], !!cwd);

  return usage;
}
