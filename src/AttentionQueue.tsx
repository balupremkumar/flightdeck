// AttentionQueue.tsx — the standalone "needs you now" surface (UI-1 v2).
// The bell dropdown is a glance; this is the work surface: every blocked pane
// across every workspace, approval-first, keyboard-driven (arrows/1-9 select,
// Enter jumps, Esc closes). Open via Ctrl+Shift+A, the palette, or the bell's
// "See all".
import { useEffect, useMemo, useState } from "react";
import { useApp } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { ambientQueue, forMins, KIND_HEADING, KIND_LABEL, lastLine, needsHumanQueue, type AttentionKind } from "./attention";
import { vendorShort } from "./vendors";
import { IconBell, IconClose } from "./Icons";
import "./Notifications.css";

const KIND_ORDER: AttentionKind[] = ["permission", "error", "question"];

export function AttentionQueue() {
  const open = useUI((s) => s.attentionOpen);
  const setOpen = useUI((s) => s.setAttentionOpen);
  const workspaces = useApp((s) => s.workspaces);
  const switchWorkspace = useApp((s) => s.switchWorkspace);
  const focusPane = useApp((s) => s.focusPane);
  const [sel, setSel] = useState(0);
  const [, setTick] = useState(0);

  const snoozed = useUI((s) => s.snoozed);
  const snoozePane = useUI((s) => s.snoozePane);
  // UX-601: the queue is the NARROW list — approvals, errors, real questions.
  // Panes that have merely gone quiet are ambient and roll up to a single
  // count in the footer instead of filling this list with non-work.
  const queue = useMemo(() => needsHumanQueue(workspaces, snoozed), [workspaces, snoozed]);
  const ambient = useMemo(() => ambientQueue(workspaces, snoozed), [workspaces, snoozed]);

  // Keep durations honest while open.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(id);
  }, [open]);

  // Clamp the selection when the queue shrinks under it.
  useEffect(() => {
    if (sel >= queue.length) setSel(Math.max(0, queue.length - 1));
  }, [queue.length, sel]);

  const jump = (wsId: number, paneId: number) => {
    switchWorkspace(wsId);
    focusPane(wsId, paneId);
    setOpen(false);
  };

  // UX-542/543: Escape moved onto the shared overlay stack (see ui.ts) so it
  // only closes this when it's the top-most overlay; arrow/Enter/1-9
  // navigation stays in its own local listener below.
  useOverlayEsc(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(queue.length - 1, i + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); return; }
      if (e.key === "Enter" && queue[sel]) { e.preventDefault(); jump(queue[sel].w.id, queue[sel].p.id); return; }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= Math.min(9, queue.length)) { e.preventDefault(); jump(queue[n - 1].w.id, queue[n - 1].p.id); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, queue, sel]);

  if (!open) return null;

  return (
    <div className="aq-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="aq-panel" role="dialog" aria-label="Attention queue">
        <div className="aq-head">
          <IconBell size={16} />
          <span className="aq-title">Attention queue</span>
          <span className="aq-count">{queue.length === 0 ? "all calm" : `${queue.length} waiting on you`}</span>
          <span className="sp" />
          <button className="rv-ic" onClick={() => setOpen(false)} title="Close (Esc)"><IconClose size={16} /></button>
        </div>

        {queue.length === 0 ? (
          <div className="aq-empty">
            <strong>Nothing needs you right now</strong>
            <span className="aq-empty-sub">
              {ambient.length > 0
                ? `${ambient.length} pane${ambient.length === 1 ? " is" : "s are"} quiet between turns — that's normal, and never lands here.`
                : "Every agent is working."}
            </span>
            <span className="aq-empty-sub">
              Panes land here when they need approval, error out, or ask you a question.
              Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> any time to check.
            </span>
          </div>
        ) : (
          <div className="aq-list">
            {/* UX-601: grouped by urgency — approvals, then errors, then
                questions. The 1-9 index stays global so a heading never
                renumbers the shortcuts underneath it. */}
            {KIND_ORDER.map((kind) => {
              const rows = queue.filter((x) => x.kind === kind);
              if (rows.length === 0) return null;
              return (
                <div className="aq-group" key={kind}>
                  <div className={"nq-group-head " + kind}>
                    {KIND_HEADING[kind]} <span className="nq-group-n">{rows.length}</span>
                  </div>
                  {rows.map(({ w, p, since }) => {
                    const i = queue.findIndex((x) => x.p.id === p.id);
                    const ask = lastLine.get(p.id);
                    return (
                      <button
                        className={"aq-row " + kind + (i === sel ? " sel" : "")}
                        key={p.id}
                        onClick={() => jump(w.id, p.id)}
                        onMouseEnter={() => setSel(i)}
                      >
                        {/* UI-630 + UX-601: the row leads with its shortcut
                            number and severity dot, then says WHAT is being
                            asked (the agent's own last line), then WHERE, then
                            HOW LONG — the four facts needed to triage without
                            opening the pane. */}
                        {i < 9 && <span className="aq-n">{i + 1}</span>}
                        <span className={"ntf-dot " + kind} />
                        <span className="aq-main">
                          <span className={"aq-ask" + (ask ? "" : " none")}>
                            {ask || "No output captured yet — open the pane to see."}
                          </span>
                          <span className="aq-ws">
                            {KIND_LABEL[kind]} · {w.name} › {p.title || vendorShort(p.vendor)}
                          </span>
                        </span>
                        <span className="aq-since">{forMins(since)}</span>
                        {/* UI-143: park a pane you've decided to deal with later. */}
                        <span
                          className="aq-snooze"
                          role="button"
                          tabIndex={-1}
                          title="Snooze for 10 minutes"
                          onClick={(e) => { e.stopPropagation(); snoozePane(p.id, 10 * 60_000); }}
                        >
                          snooze
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        <div className="aq-foot">
          <span>↑↓ select · Enter jump · 1-9 direct · Esc close</span>
          {ambient.length > 0 && queue.length > 0 && (
            <span className="aq-ambient">{ambient.length} quiet · no action needed</span>
          )}
        </div>
      </div>
    </div>
  );
}
