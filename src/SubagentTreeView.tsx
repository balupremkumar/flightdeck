// SubagentTreeView.tsx — QL-769: what this pane's agent has FANNED OUT to.
//
// A Claude Code session that dispatches subagents writes each one its own
// transcript (~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl).
// Until now the cockpit showed one busy pane and no way to tell whether that
// meant one agent thinking or six agents working — this is that missing view.
//
// Two backend calls on purpose (see usage.rs):
//   pane_subagent_count — directory metadata only, cheap enough to sit on the
//     ctx-chip's 15s cadence just to decide whether the header chip appears;
//   pane_subagents      — the rows, polled only while the popover is open.
//
// Named *TreeView* (not SubagentTree.tsx) per the repo's file-naming rule in
// CLAUDE.md: a component whose name differs from a logic module only by case
// resolves to the same specifier on this filesystem.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useOverlayEsc } from "./ui";
import { cachedInvoke, usePoll } from "./poll";
import { compact, duration, relTime, absTime, tailEllipsis } from "./format";
import "./subagents.css";

export interface SubagentRow {
  id: string;
  agentType: string | null;
  description: string | null;
  tool: string | null;
  startedMs: number;
  lastActivityMs: number;
  contextTokens: number;
  outputTokens: number;
  turns: number;
  finished: boolean;
}

export interface SubagentCount {
  total: number;
  recent: number;
}

/** How long an unfinished agent may go without writing a line before the row
 *  says so. Two minutes: a WebSearch or a long Bash step routinely takes one,
 *  so anything shorter would cry wolf on healthy work. */
export const SUBAGENT_STALE_MS = 120_000;

/** True when a row is worth flagging: still running by its own transcript, but
 *  nothing has been appended for a while. Deliberately "possibly" — a subagent
 *  transcript has no heartbeat, so this is a silence, not a death certificate. */
export function isPossiblyStuck(row: SubagentRow, now: number = Date.now()): boolean {
  return !row.finished && now - row.lastActivityMs > SUBAGENT_STALE_MS;
}

/** Header-chip text. `recent` (written to in the last couple of minutes) is the
 *  live number when there is one; otherwise the session's total, which is a
 *  history readout rather than a live one — the tooltip says which. */
export function subagentChipLabel(c: SubagentCount): string {
  const n = c.recent > 0 ? c.recent : c.total;
  return `${n} agent${n === 1 ? "" : "s"}`;
}

/** Row label: the agent's type when the sidecar meta recorded one, else its id.
 *  Never "agent" — a row that can't say what it is says its id instead. */
export function subagentLabel(row: SubagentRow): string {
  return row.agentType || row.id;
}

interface SubagentTreeProps {
  open: boolean;
  onClose: () => void;
  /** Anchor, measured from the chip that opened this (same portal trick the
   *  pane overflow menu uses — .pane clips overflow). */
  pos: { top: number; left: number } | null;
  cwd: string;
  /** Pane epoch: a restart is a new session, so the rows must not carry over. */
  epoch: number;
}

const ROW_POLL_MS = 4000;

export function SubagentTree({ open, onClose, pos, cwd, epoch }: SubagentTreeProps) {
  useOverlayEsc(open, onClose);
  const [rows, setRows] = useState<SubagentRow[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Only while open — a closed popover costs nothing but the count probe.
  usePoll(
    async () => {
      try {
        setRows(await cachedInvoke<SubagentRow[]>("pane_subagents", { cwd }, ROW_POLL_MS / 2));
      } catch {
        setRows([]); // command not available (older backend) → honest empty state
      }
      setTick((t) => t + 1); // re-render the elapsed/idle columns as they age
    },
    ROW_POLL_MS,
    [cwd, epoch],
    open
  );

  // A click anywhere else dismisses it, like the pane's other portalled menus
  // (Escape is the shared overlay stack's job, above — never a second global
  // key listener, see CLAUDE.md).
  useEffect(() => {
    if (!open) return;
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, onClose]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [tick]);
  if (!open || !pos) return null;

  return createPortal(
    <div
      className="subpop"
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      aria-label="Subagents"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="subpop-head">
        <span>Subagents</span>
        {rows && <span className="subpop-count">{rows.length}</span>}
      </div>
      {rows == null ? (
        <div className="subpop-empty">Reading…</div>
      ) : rows.length === 0 ? (
        <div className="subpop-empty">This session hasn’t dispatched any subagents.</div>
      ) : (
        <div className="subpop-body">
          {rows.map((r) => {
            const stuck = isPossiblyStuck(r, now);
            const isOpen = expanded === r.id;
            return (
              <div key={r.id} className={"subrow" + (r.finished ? " done" : "") + (stuck ? " stuck" : "")}>
                <button
                  className="subrow-main"
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                  title={r.description ?? undefined}
                >
                  <span className={"subrow-dot" + (r.finished ? " done" : stuck ? " stuck" : " live")} aria-hidden />
                  <span className="subrow-type">{subagentLabel(r)}</span>
                  <span className="subrow-tool">{r.finished ? "reported back" : r.tool ?? "starting…"}</span>
                  <span className="subrow-el" title={`Started ${absTime(r.startedMs)}`}>
                    {duration(r.startedMs, now)}
                  </span>
                  <span className="subrow-tok" title={`${r.turns} turns · ${compact(r.contextTokens)} context now`}>
                    {compact(r.outputTokens)}
                  </span>
                </button>
                {stuck && (
                  <span className="subrow-stuck" title={`Nothing written to its transcript since ${absTime(r.lastActivityMs)} — it may still be inside one long tool call.`}>
                    possibly stuck · quiet {relTime(r.lastActivityMs, now)}
                  </span>
                )}
                {isOpen && (
                  <div className="subrow-detail">
                    {r.description && <div className="subrow-desc">{tailEllipsis(r.description, 220)}</div>}
                    <div className="subrow-facts">
                      <span>id {r.id}</span>
                      <span>{r.turns} turns</span>
                      <span>{compact(r.contextTokens)} ctx</span>
                      <span>{compact(r.outputTokens)} out</span>
                      <span title={absTime(r.lastActivityMs)}>last line {relTime(r.lastActivityMs, now)}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="subpop-foot">
        Read from each subagent’s own transcript. “Reported back” means its last message was its final answer.
      </div>
    </div>,
    document.body
  );
}
