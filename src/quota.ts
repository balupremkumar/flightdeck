// quota.ts — pure state for the plan quota gauge (QuotaGauge.tsx).
// Shape mirrors usage.rs `PlanUsage` (camelCase over IPC).

import { compact } from "./format";

export interface QuotaWindow {
  usedTokens: number;
  windowStart: number;
  resetsAt: number | null;
  /** 0..1+, null when no cap is known. */
  pct: number | null;
}
export interface PlanUsage {
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
  source: "claude-reported" | "estimated";
}

export const QUOTA_WARN = 0.75;
export const QUOTA_CRIT = 0.9;

export type QuotaLevel = "" | "warn" | "crit";

/** Colour step for a fill fraction; no cap known (null) never alarms. */
export function quotaLevel(pct: number | null): QuotaLevel {
  if (pct == null) return "";
  return pct >= QUOTA_CRIT ? "crit" : pct >= QUOTA_WARN ? "warn" : "";
}

/** Bar width 0..100, clamped. */
export function quotaFill(pct: number | null): number {
  return pct == null ? 0 : Math.max(0, Math.min(100, Math.round(pct * 100)));
}

/** "resets in 2h 05m" / "resets in 12m" / "" when unknown or already past. */
export function resetLabel(resetsAt: number | null, now: number): string {
  if (resetsAt == null || resetsAt <= now) return "";
  const mins = Math.max(1, Math.round((resetsAt - now) / 60_000));
  if (mins >= 48 * 60) return `resets in ${Math.round(mins / 60 / 24)}d`;
  const h = Math.floor(mins / 60);
  return h > 0 ? `resets in ${h}h ${String(mins % 60).padStart(2, "0")}m` : `resets in ${mins}m`;
}

/** The gauge shows only when there is Claude data at all. */
export function hasQuotaData(p: PlanUsage | null | undefined): p is PlanUsage {
  return !!p && (p.weekly.usedTokens > 0 || p.fiveHour.usedTokens > 0 || p.fiveHour.resetsAt != null);
}

export function quotaTooltip(p: PlanUsage, now: number): string {
  const line = (label: string, w: QuotaWindow) =>
    `${label}: ${compact(w.usedTokens)} tokens` +
    (w.pct != null ? ` (${Math.round(w.pct * 100)}%)` : "") +
    (resetLabel(w.resetsAt, now) ? `, ${resetLabel(w.resetsAt, now)}` : "");
  const method =
    p.source === "claude-reported"
      ? "Reset time reported by Claude Code in a session transcript (a limit was hit)."
      : "Estimated from local sessions. Input + output + cache-write tokens from every " +
        "~/.claude transcript (subagents included). The 5h window starts at the hour of the first " +
        "message after the last window ended; the week is the last 7 days. Anthropic publishes no " +
        "token caps, so the % appears only after a past limit hit shows what this account reached.";
  return `${line("5-hour", p.fiveHour)}\n${line("Week", p.weekly)}\n\n${method}`;
}
