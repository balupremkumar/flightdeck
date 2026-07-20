// AttentionQueue.tsx — the standalone "needs you now" surface (UI-1 v2).
// The bell dropdown is a glance; this is the work surface: every blocked pane
// across every workspace, approval-first, keyboard-driven (arrows/1-9 select,
// Enter jumps, Esc closes). Open via Ctrl+Shift+A, the palette, or the bell's
// "See all".
import { useEffect, useMemo, useState } from "react";
import { useApp } from "./store";
import { useUI } from "./ui";
import { attentionQueue, forMins, STATE_LABEL } from "./attention";
import { vendorShort } from "./vendors";
import { IconBell, IconClose } from "./Icons";
import "./Notifications.css";

export function AttentionQueue() {
  const open = useUI((s) => s.attentionOpen);
  const setOpen = useUI((s) => s.setAttentionOpen);
  const workspaces = useApp((s) => s.workspaces);
  const switchWorkspace = useApp((s) => s.switchWorkspace);
  const focusPane = useApp((s) => s.focusPane);
  const [sel, setSel] = useState(0);
  const [, setTick] = useState(0);

  const queue = useMemo(() => attentionQueue(workspaces), [workspaces]);

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(queue.length - 1, i + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); return; }
      if (e.key === "Enter" && queue[sel]) { e.preventDefault(); jump(queue[sel].w.id, queue[sel].p.id); return; }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= Math.min(9, queue.length)) { e.preventDefault(); jump(queue[n - 1].w.id, queue[n - 1].p.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, queue, sel]);

  if (!open) return null;

  return (
    <div className="aq-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="aq-panel" role="dialog" aria-label="Attention queue">
        <div className="aq-head">
          <IconBell size={15} />
          <span className="aq-title">Attention queue</span>
          <span className="aq-count">{queue.length === 0 ? "clear" : `${queue.length} waiting on you`}</span>
          <span className="sp" />
          <button className="rv-ic" onClick={() => setOpen(false)} title="Close (Esc)"><IconClose size={13} /></button>
        </div>

        {queue.length === 0 ? (
          <div className="aq-empty">
            Nothing needs you — every agent is working or idle.
            <span className="aq-empty-sub">Panes land here when they hit an approval prompt, error out, or go quiet.</span>
          </div>
        ) : (
          <div className="aq-list">
            {queue.map(({ w, p, since }, i) => (
              <button
                className={"aq-row " + p.state + (i === sel ? " sel" : "")}
                key={p.id}
                onClick={() => jump(w.id, p.id)}
                onMouseEnter={() => setSel(i)}
              >
                {i < 9 && <span className="aq-n">{i + 1}</span>}
                <span className={"ntf-dot " + p.state} />
                <span className="aq-main">
                  <span className="aq-pane">{p.title || vendorShort(p.vendor)}</span>
                  <span className="aq-ws">{w.name}</span>
                </span>
                <span className="aq-state">{STATE_LABEL[p.state]}</span>
                <span className="aq-since">{forMins(since)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="aq-foot">↑↓ select · Enter jump · 1-9 direct · Esc close</div>
      </div>
    </div>
  );
}
