import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePoll } from "./poll";
import { compact } from "./format";
import { hasQuotaData, quotaFill, quotaLevel, quotaTooltip, resetLabel, type PlanUsage, type QuotaWindow } from "./quota";
import "./quotagauge.css";

const POLL_MS = 60_000;

function Bar({ label, w, now }: { label: string; w: QuotaWindow; now: number }) {
  const level = quotaLevel(w.pct);
  const reset = resetLabel(w.resetsAt, now);
  return (
    <span className={"qg-row " + level}>
      <span className="qg-label">{label}</span>
      <span className="qg-track">
        <span className="qg-fill" style={{ width: `${w.pct == null ? 0 : quotaFill(w.pct)}%` }} />
      </span>
      <span className="qg-val">{w.pct != null ? `${Math.round(w.pct * 100)}%` : compact(w.usedTokens)}</span>
      {reset && <span className="qg-reset">{reset.replace("resets in ", "")}</span>}
    </span>
  );
}

/** Claude plan quota: 5-hour and weekly windows. Hidden when there is no data. */
export default function QuotaGauge() {
  const [plan, setPlan] = useState<PlanUsage | null>(null);
  usePoll(async () => {
    try { setPlan(await invoke<PlanUsage | null>("plan_usage")); } catch { setPlan(null); }
  }, POLL_MS, []);
  if (!hasQuotaData(plan)) return null;
  const now = Date.now();
  return (
    <div className="quota-gauge" title={quotaTooltip(plan, now)} aria-label="Claude plan usage">
      <Bar label="5h" w={plan.fiveHour} now={now} />
      <Bar label="wk" w={plan.weekly} now={now} />
    </div>
  );
}
