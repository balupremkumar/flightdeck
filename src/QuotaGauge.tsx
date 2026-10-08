import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePoll } from "./poll";
import { compact } from "./format";
import { useOverlayEsc } from "./ui";
import { hasQuotaData, quotaFill, quotaLevel, quotaTooltip, resetLabel, type PlanUsage, type QuotaWindow } from "./quota";
import "./quotagauge.css";

const POLL_MS = 60_000;

function Bar({ label, w, now, detail = false }: { label: string; w: QuotaWindow; now: number; detail?: boolean }) {
  const reset = resetLabel(w.resetsAt, now);
  return (
    <span className={"qg-row " + quotaLevel(w.pct)}>
      <span className="qg-label">{label}</span>
      <span className="qg-val">{w.pct != null ? `${Math.round(w.pct * 100)}%` : compact(w.usedTokens)}</span>
      <span className="qg-track" aria-hidden="true">
        <span className="qg-fill" style={{ width: `${quotaFill(w.pct)}%` }} />
      </span>
      {(reset || detail) && <span className="qg-reset">{detail ? reset || "Reset time unknown" : reset.replace("resets in ", "")}</span>}
    </span>
  );
}

/** Claude plan quota: 5-hour and weekly windows. Hidden when there is no data. */
export default function QuotaGauge() {
  const [plan, setPlan] = useState<PlanUsage | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const visible = hasQuotaData(plan);
  useOverlayEsc(open && visible, () => setOpen(false));
  useEffect(() => {
    if (!open || !visible) return;
    const outside = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, visible]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  usePoll(async () => {
    try { setPlan(await invoke<PlanUsage | null>("plan_usage")); } catch { setPlan(null); }
  }, POLL_MS, []);
  if (!hasQuotaData(plan)) return null;
  const now = Date.now();
  const source = quotaTooltip(plan, now).split("\n\n")[1];
  return (
    <div className="quota-gauge" ref={root}>
      <button type="button" className="qg-pill" aria-label="Claude plan usage" aria-expanded={open}
        aria-controls={open ? detailId : undefined} onClick={() => setOpen(!open)}>
        <Bar label="5h" w={plan.fiveHour} now={now} />
        <span className="qg-week"><Bar label="Week" w={plan.weekly} now={now} /></span>
      </button>
      {open && <div className="qg-popover" id={detailId} role="region" aria-label="Claude plan usage details">
        <strong>Claude plan usage</strong>
        <Bar label="5-hour" w={plan.fiveHour} now={now} detail />
        <Bar label="Week" w={plan.weekly} now={now} detail />
        <p className="qg-source">{source}</p>
      </div>}
    </div>
  );
}
