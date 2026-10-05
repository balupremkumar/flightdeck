import { invoke } from "@tauri-apps/api/core";
import { KIND_RANK, type AttentionItem } from "./attention";
import type { Workspace } from "./store";

// Phase 4 S10: every window tells Rust what needs the human in it. Rust adds the
// counts up and puts the total on every window's taskbar overlay, and picks the
// global top item for the summon chord. The ranking stays here (attention.ts); Rust
// only compares the tuple `(kindRank, since, wsId, paneId)`, smallest wins.

export interface AttentionTopReport { kindRank: number; since: number; wsId: number; paneId: number }
export interface AttentionReport { count: number; top: AttentionTopReport | null }

/** `needsHumanQueue` is already ranked, so its head is this window's top item. */
export function buildAttentionReport(queue: AttentionItem[]): AttentionReport {
  const head = queue[0];
  return {
    count: queue.length,
    top: head && head.kind
      ? { kindRank: KIND_RANK[head.kind], since: Math.max(0, Math.trunc(head.since)), wsId: head.w.id, paneId: head.p.id }
      : null,
  };
}

export function reportKey(r: AttentionReport): string {
  const t = r.top;
  return t ? `${r.count}:${t.kindRank}:${t.since}:${t.wsId}:${t.paneId}` : `${r.count}:-`;
}

let lastSent: string | null = null;

/** Send the report unless it is identical to the last one that reached Rust. When
 *  the command is unavailable (browser preview, a window Rust has not registered yet)
 *  `fallback(count)` keeps this window's own taskbar count honest, and the next
 *  change retries. */
export async function sendAttentionReport(queue: AttentionItem[], fallback: (count: number) => Promise<void>): Promise<void> {
  const report = buildAttentionReport(queue);
  const key = reportKey(report);
  if (key === lastSent) return;
  lastSent = key;
  try {
    await invoke("attention_report", { count: report.count, top: report.top });
  } catch {
    if (lastSent === key) lastSent = null;
    await fallback(report.count);
  }
}

export function _resetReportForTests(): void {
  lastSent = null;
}

/** Where a summon lands, from Rust's `app://summon` payload (`{wsId, paneId}`, nulls
 *  when no window has anything pending). Only a pane this window still holds counts:
 *  a stale payload must not switch to a workspace that has gone. */
export interface SummonPayload { wsId: number | null; paneId: number | null }
export function summonPane(payload: SummonPayload | null | undefined, workspaces: Workspace[]): { wsId: number; paneId: number | null } | null {
  if (!payload || payload.wsId == null) return null;
  const ws = workspaces.find((w) => w.id === payload.wsId);
  if (!ws) return null;
  const paneId = payload.paneId != null && ws.panes.some((p) => p.id === payload.paneId) ? payload.paneId : null;
  return { wsId: ws.id, paneId };
}
