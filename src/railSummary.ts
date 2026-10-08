import { attentionKind, type AttentionKind } from "./attention";
import type { PaneModel } from "./store";

export interface RailSummary {
  needs: number;
  working: number;
  idle: number;
  total: number;
  worst: AttentionKind | null;
}

// The rail ranks errors first, independently of the attention queue's order.
const severity: Record<AttentionKind, number> = { error: 3, permission: 2, question: 1 };

export function railSummary(panes: readonly PaneModel[]): RailSummary {
  const summary: RailSummary = { needs: 0, working: 0, idle: 0, total: panes.length, worst: null };
  for (const pane of panes) {
    const kind = attentionKind(pane);
    if (kind) {
      summary.needs++;
      if (!summary.worst || severity[kind] > severity[summary.worst]) summary.worst = kind;
    } else if (pane.state === "starting" || pane.state === "running") {
      summary.working++;
    } else {
      summary.idle++;
    }
  }
  return summary;
}

export function railSentence(summary: RailSummary): string {
  if (summary.total === 0) return "No panes";
  if (summary.idle === summary.total) return "All idle";
  return [
    summary.needs > 0 ? `${summary.needs} needs you` : null,
    summary.working > 0 ? `${summary.working} working` : null,
    summary.idle > 0 ? `${summary.idle} idle` : null,
  ].filter(Boolean).join(" \u00b7 ");
}
