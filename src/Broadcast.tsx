import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel } from "./store";
import { useUI } from "./ui";
import { IconClose } from "./Icons";
import "./Broadcast.css";

type Scope = "workspace" | "all";
type Target = { w: { id: number; name: string }; p: PaneModel };

import { vendorShort } from "./vendors";

function relTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

// Self-contained broadcast composer: one message, sent to all (or a chosen
// subset of) panes via the existing `pty_write` command. Renders nothing when
// closed — the topbar owns the open/close toggle via useUI().broadcastOpen.
export function Broadcast() {
  const workspaces = useApp((s) => s.workspaces);
  const activeId = useApp((s) => s.activeId);
  const pushToast = useUI((s) => s.pushToast);
  const open = useUI((s) => s.broadcastOpen);
  const setOpen = useUI((s) => s.setBroadcastOpen);
  const broadcasts = useUI((s) => s.broadcasts);
  const pushBroadcastRecord = useUI((s) => s.pushBroadcastRecord);

  const [scope, setScope] = useState<Scope>("workspace");
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [text, setText] = useState("");
  const [pressEnter, setPressEnter] = useState(true);
  const [sending, setSending] = useState(false);

  // Esc closes the composer from anywhere (not just the textarea).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // Every pane in scope, live or not — dead panes are shown greyed-out and
  // unselectable rather than silently dropped, so the scope stays honest.
  const pool = useMemo<Target[]>(() => {
    const list: Target[] = [];
    for (const w of workspaces) {
      if (scope === "workspace" && w.id !== activeId) continue;
      for (const p of w.panes) list.push({ w: { id: w.id, name: w.name }, p });
    }
    return list;
  }, [workspaces, activeId, scope]);

  const isDead = (p: PaneModel) => p.state === "idle" || p.state === "error";
  const targets = pool.filter(({ p }) => !isDead(p) && !excluded.has(p.id));
  const lastBroadcast = broadcasts[0];

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
    pushBroadcastRecord({ text: msg, sentTo: targets.length, failed });
    if (failed === 0) {
      pushToast("success", `Sent to ${targets.length} pane${targets.length === 1 ? "" : "s"}`);
      setText("");
      setOpen(false);
    } else {
      // Keep the typed message on failure so the user can retry without retyping.
      pushToast("error", `Sent to ${targets.length - failed} of ${targets.length} — ${failed} failed`);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  if (!open) return null;

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
        {pool.length === 0 && <span className="bc-empty">No panes in scope — start a session first.</span>}
        {pool.map(({ w, p }) => {
          const dead = isDead(p);
          const ex = excluded.has(p.id);
          const title = dead
            ? p.state === "idle" ? "Idle — restart first" : "Crashed — restart first"
            : ex ? "Excluded — click to include" : "Included — click to exclude";
          return (
            <button
              key={p.id}
              className={"bc-chip" + (dead ? " dead" : ex ? " off" : "")}
              onClick={() => { if (!dead) toggle(p.id); }}
              disabled={dead}
              title={title}
            >
              <span className={"bc-dot " + p.state} />
              {scope === "all" && <span className="bc-chip-ws">{w.name}</span>}
              <span>{vendorShort(p.vendor)}</span>
            </button>
          );
        })}
      </div>

      {lastBroadcast && (
        <div className="bc-last">
          Last sent {relTime(lastBroadcast.at)} to {lastBroadcast.sentTo} pane{lastBroadcast.sentTo === 1 ? "" : "s"}
          {lastBroadcast.failed > 0 ? ` (${lastBroadcast.failed} failed)` : ""}
        </div>
      )}

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
