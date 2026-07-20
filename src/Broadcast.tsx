import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel } from "./store";
import { useUI } from "./ui";
import { IconClose } from "./Icons";
import { relTime, timeTitle } from "./format";
import "./Broadcast.css";

type Scope = "workspace" | "all";
type Target = { w: { id: number; name: string }; p: PaneModel };

import { vendorShort } from "./vendors";

// UI-202: saved snippets — common prompts ("run the tests and fix what
// fails") the user deliberately wants to reuse. Separate storage and a
// separate affordance from the ArrowUp message history below: history is
// "what was sent recently", snippets are "what I chose to keep".
const SNIPPETS_KEY = "flightdeck-broadcast-snippets";
interface Snippet { id: string; text: string; }
function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* non-persistent */ }
  return [];
}
function persistSnippets(list: Snippet[]) {
  try { localStorage.setItem(SNIPPETS_KEY, JSON.stringify(list)); } catch { /* non-persistent */ }
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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
  // Distinct vendors present in the current scope — drives the presets.
  const vendorsInPool = useMemo(
    () => Array.from(new Set(pool.filter(({ p }) => !isDead(p)).map(({ p }) => p.vendor))),
    [pool]
  );
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

  // UI-201: newest-first message history for arrow-key recall.
  const history = useMemo(
    () => Array.from(new Set(broadcasts.map((r) => r.text).filter(Boolean))),
    [broadcasts]
  );
  const [histIdx, setHistIdx] = useState(-1);

  // UI-202: saved snippets — see the loadSnippets/persistSnippets note above.
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [snipOpen, setSnipOpen] = useState(false);
  const snipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!snipOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setSnipOpen(false); };
    const onMouseDown = (e: MouseEvent) => {
      if (snipRef.current && !snipRef.current.contains(e.target as Node)) setSnipOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [snipOpen]);

  const saveCurrentSnippet = () => {
    const msg = text.trim();
    if (!msg) return;
    if (snippets.some((s) => s.text === msg)) { pushToast("info", "Already saved."); return; }
    const next = [{ id: crypto.randomUUID(), text: msg }, ...snippets];
    setSnippets(next);
    persistSnippets(next);
    pushToast("success", "Snippet saved.");
  };
  const loadSnippet = (s: Snippet) => {
    setText(s.text);
    setHistIdx(-1); // a snippet load is a fresh edit, not a history step
    setSnipOpen(false);
  };
  const deleteSnippet = (id: string) => {
    const next = snippets.filter((s) => s.id !== id);
    setSnippets(next);
    persistSnippets(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setHistIdx(-1); void send(); return; }
    // UI-201: shell-style history. Only from an empty/unedited field or at the
    // very start, so it never eats a real cursor-up inside a draft.
    const el = e.currentTarget;
    if (e.key === "ArrowUp" && history.length > 0 && (el.selectionStart === 0 || histIdx >= 0)) {
      const next = Math.min(histIdx + 1, history.length - 1);
      if (next !== histIdx) { e.preventDefault(); setHistIdx(next); setText(history[next]); }
      return;
    }
    if (e.key === "ArrowDown" && histIdx >= 0) {
      e.preventDefault();
      const next = histIdx - 1;
      setHistIdx(next);
      setText(next < 0 ? "" : history[next]);
    }
  };

  if (!open) return null;

  return (
    <div className="bc-bar" role="region" aria-label="Broadcast message">
      <div className="bc-head">
        <span className="bc-title">Broadcast</span>
        <div className="bc-seg">
          <button className={scope === "workspace" ? "on" : ""} onClick={() => setScope("workspace")}>This workspace</button>
          <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>All workspaces</button>
          {/* UI-203: deselecting nine of eleven chips by hand is the common
              case this replaces. Presets are derived from the live pool, so
              they only offer vendors that are actually there. */}
          {vendorsInPool.length > 1 && vendorsInPool.map((v) => (
            <button
              key={v}
              className="bc-preset"
              title={`Target only the ${vendorShort(v)} panes in scope`}
              onClick={() => setExcluded(new Set(pool.filter(({ p }) => p.vendor !== v).map(({ p }) => p.id)))}
            >
              only {vendorShort(v)}
            </button>
          ))}
          {excluded.size > 0 && (
            <button className="bc-preset" onClick={() => setExcluded(new Set())} title="Re-include every pane in scope">
              select all
            </button>
          )}
        </div>
        <span className="sp" />
        {/* UI-202: saved snippets — a dropdown, not another segmented control,
            since the count is unbounded and each entry needs its own delete. */}
        <div className="bc-snip-wrap" ref={snipRef}>
          <button
            type="button"
            className="bc-snip-toggle"
            aria-haspopup="true"
            aria-expanded={snipOpen}
            onClick={() => setSnipOpen((v) => !v)}
            title="Saved snippets — common prompts you send often"
          >
            Snippets{snippets.length > 0 ? ` (${snippets.length})` : ""}
          </button>
          {snipOpen && (
            <div className="bc-snip-menu" role="menu" aria-label="Saved snippets">
              <button className="bc-snip-save" onClick={saveCurrentSnippet} disabled={!text.trim()}>
                Save current message
              </button>
              {snippets.length === 0 && <div className="bc-snip-empty">No snippets saved yet.</div>}
              {snippets.length > 0 && (
                <div className="bc-snip-list">
                  {snippets.map((s) => (
                    <div className="bc-snip-item" key={s.id}>
                      <button className="bc-snip-text" onClick={() => loadSnippet(s)} title={s.text}>{s.text}</button>
                      <button className="bc-snip-del" onClick={() => deleteSnippet(s.id)} title="Delete this snippet" aria-label="Delete this snippet">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
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
        <div className="bc-last" title={timeTitle(lastBroadcast.at)}>
          Last sent {relTime(lastBroadcast.at)} to {lastBroadcast.sentTo} pane{lastBroadcast.sentTo === 1 ? "" : "s"}
          {lastBroadcast.failed > 0 ? ` (${lastBroadcast.failed} failed)` : ""}
        </div>
      )}

      <div className="bc-row">
        <textarea
          className="bc-input"
          rows={1}
          placeholder={targets.length ? `Message ${targets.length} pane${targets.length === 1 ? "" : "s"}…  (Enter sends, Shift+Enter newline, ↑ recalls)` : "No panes selected"}
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
