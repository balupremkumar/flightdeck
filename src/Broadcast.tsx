import { useMemo, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel } from "./store";
import { useUI } from "./ui";
import { IconAgent, IconClose } from "./Icons";
import "./Broadcast.css";

type Scope = "workspace" | "all";
type Target = { w: { id: number; name: string }; p: PaneModel };

import { vendorShort } from "./vendors";

// Self-contained broadcast composer: one message, sent to all (or a chosen
// subset of) panes via the existing `pty_write` command. Docks as a floating
// pill; expands into the full bar. Mount once: <Broadcast />.
export function Broadcast() {
  const workspaces = useApp((s) => s.workspaces);
  const activeId = useApp((s) => s.activeId);
  const pushToast = useUI((s) => s.pushToast);

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("workspace");
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [text, setText] = useState("");
  const [pressEnter, setPressEnter] = useState(true);
  const [sending, setSending] = useState(false);

  // Panes eligible to receive a broadcast — must have a live PTY (idle/error panes don't).
  const pool = useMemo<Target[]>(() => {
    const list: Target[] = [];
    for (const w of workspaces) {
      if (scope === "workspace" && w.id !== activeId) continue;
      for (const p of w.panes) {
        if (p.state === "idle" || p.state === "error") continue;
        list.push({ w: { id: w.id, name: w.name }, p });
      }
    }
    return list;
  }, [workspaces, activeId, scope]);

  const targets = pool.filter(({ p }) => !excluded.has(p.id));

  const toggle = (paneId: number) => {
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(paneId)) next.delete(paneId);
      else next.add(paneId);
      return next;
    });
  };

  const send = async () => {
    const msg = text.trim();
    if (!msg || targets.length === 0 || sending) return;
    setSending(true);
    const payload = pressEnter ? msg + "\r" : msg;
    const results = await Promise.allSettled(targets.map(({ p }) => invoke("pty_write", { paneId: p.id, data: payload })));
    setSending(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      pushToast("success", `Sent to ${targets.length} pane${targets.length === 1 ? "" : "s"}`);
      setText("");
    } else {
      // Keep the typed message on failure so the user can retry without retyping.
      pushToast("error", `Sent to ${targets.length - failed} of ${targets.length} — ${failed} failed`);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
    if (e.key === "Escape") setOpen(false);
  };

  if (!open) {
    return (
      <button className="bc-fab" onClick={() => setOpen(true)} title="Broadcast a message to multiple panes">
        <IconAgent size={15} />
        <span>Broadcast</span>
      </button>
    );
  }

  return (
    <div className="bc-bar" role="region" aria-label="Broadcast message">
      <div className="bc-head">
        <span className="bc-title">Broadcast</span>
        <div className="bc-seg">
          <button className={scope === "workspace" ? "on" : ""} onClick={() => setScope("workspace")}>This workspace</button>
          <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>All workspaces</button>
        </div>
        <span className="sp" />
        <button className="bc-x" onClick={() => setOpen(false)} title="Collapse"><IconClose size={13} /></button>
      </div>

      <div className="bc-chips">
        {pool.length === 0 && <span className="bc-empty">No live panes in scope — start or resume a session first.</span>}
        {pool.map(({ w, p }) => {
          const ex = excluded.has(p.id);
          return (
            <button
              key={p.id}
              className={"bc-chip" + (ex ? " off" : "")}
              onClick={() => toggle(p.id)}
              title={ex ? "Excluded — click to include" : "Included — click to exclude"}
            >
              <span className={"bc-dot " + p.state} />
              {scope === "all" && <span className="bc-chip-ws">{w.name}</span>}
              <span>{vendorShort(p.vendor)}</span>
            </button>
          );
        })}
      </div>

      <div className="bc-row">
        <textarea
          className="bc-input"
          rows={1}
          placeholder={targets.length ? `Message ${targets.length} pane${targets.length === 1 ? "" : "s"}…` : "No panes selected"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <label className="bc-enter">
          <input type="checkbox" checked={pressEnter} onChange={(e) => setPressEnter(e.target.checked)} />
          Enter
        </label>
        <button className="bc-send" disabled={!text.trim() || targets.length === 0 || sending} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
