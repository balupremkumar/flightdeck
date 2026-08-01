import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { IconClose } from "./Icons";
import { relTime, timeTitle, tailEllipsis } from "./format";
import { lastLine } from "./attention";
import { LinkifiedText } from "./LinkifiedText";
import {
  loadSnippets, saveSnippets, addSnippet, removeSnippet, type Snippet,
  extractPlaceholders, fillPlaceholders,
  loadPromptHistory, savePromptHistory, recordPrompt, historyFor,
} from "./prompthistory";
import "./Broadcast.css";

type Scope = "workspace" | "all";
type Target = { w: { id: number; name: string }; p: PaneModel };

import { vendorShort } from "./vendors";

// UI-202/UX-552: saved snippets — common prompts ("run the tests and fix
// what fails") the user deliberately wants to reuse, now living in
// prompthistory.ts (shared with the command palette's snippet-insert
// actions — see HANDOFF EDITS) so both surfaces read the same list. History
// is "what was sent recently" (below); snippets are "what I chose to keep".


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

  // Esc closes the composer from anywhere (not just the textarea). UX-542/543:
  // registered into the shared overlay stack (ui.ts) instead of its own
  // window listener — Esc closes this ONLY when it's the top-most overlay,
  // and closing it (by any means) returns focus to whatever had it before
  // the composer opened.
  useOverlayEsc(open, () => setOpen(false));

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
  // UX-521: what each live target last said, linkified — a glance at
  // context before you send it more, same last-line source the attention
  // queue reads from (attention.ts, written by each pane's tail tracker).
  const targetsWithOutput = useMemo(
    () => targets
      .map(({ w, p }) => ({ w, p, line: lastLine.get(p.id) }))
      .filter((t): t is { w: Target["w"]; p: PaneModel; line: string } => !!t.line),
    [targets]
  );

  const toggle = (paneId: number) => {
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(paneId)) next.delete(paneId);
      else next.add(paneId);
      return next;
    });
  };

  // UX-551: per-vendor sent-prompt history, persisted across restarts.
  const [promptHistory, setPromptHistory] = useState(loadPromptHistory);
  // The vendor(s) actually being sent to right now — when it's exactly one,
  // ArrowUp recall (below) prefers that vendor's own history over the mixed
  // "sent to anyone" list, since an agy-flavoured prompt has no business
  // surfacing when you're about to type at a shell pane.
  const targetVendors = useMemo(() => Array.from(new Set(targets.map(({ p }) => p.vendor))), [targets]);
  const singleVendor = targetVendors.length === 1 ? targetVendors[0] : null;

  const sendText = async (msg: string) => {
    const trimmed = msg.trim();
    if (!trimmed || targets.length === 0 || sending) return;
    setSending(true);
    const payload = pressEnter ? trimmed + "\r" : trimmed;
    const results = await Promise.allSettled(targets.map(({ p }) => invoke("pty_write", { paneId: p.id, data: payload })));
    setSending(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    pushBroadcastRecord({ text: trimmed, sentTo: targets.length, failed });
    // UX-551: record under every vendor this send actually reached.
    setPromptHistory((prev) => {
      let next = prev;
      for (const v of targetVendors) next = recordPrompt(next, v, trimmed);
      savePromptHistory(next);
      return next;
    });
    if (failed === 0) {
      pushToast("success", `Sent to ${targets.length} pane${targets.length === 1 ? "" : "s"}`);
      setText("");
      setOpen(false);
    } else {
      // Keep the typed message on failure so the user can retry without retyping.
      pushToast("error", `Sent to ${targets.length - failed} of ${targets.length} — ${failed} failed`);
    }
  };
  const send = () => sendText(text);
  // UX-550: resend the last broadcast text to the CURRENT target selection —
  // one pane if scope has been narrowed to one, N panes if it's still
  // broadcast-wide. No retyping, no re-picking targets.
  const resendLast = () => { if (lastBroadcast) void sendText(lastBroadcast.text); };

  // UI-201/UX-551: newest-first recall for ArrowUp — this vendor's own
  // history when the send is scoped to exactly one vendor, otherwise the
  // combined "sent to anyone" list (unchanged behaviour for a mixed send).
  const vendorHistory = historyFor(promptHistory, singleVendor);
  const combinedHistory = useMemo(
    () => Array.from(new Set(broadcasts.map((r) => r.text).filter(Boolean))),
    [broadcasts]
  );
  const history = vendorHistory.length > 0 ? vendorHistory : combinedHistory;
  const [histIdx, setHistIdx] = useState(-1);

  // UI-202/UX-552: saved snippets, shared storage (prompthistory.ts) so the
  // command palette's snippet-insert actions read the same list (HANDOFF).
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [snipOpen, setSnipOpen] = useState(false);
  const snipRef = useRef<HTMLDivElement>(null);
  // UX-552: a snippet carrying {{placeholder}} tokens opens this small
  // fill-in step instead of inserting straight away.
  const [fillingSnippet, setFillingSnippet] = useState<{ snippet: Snippet; tokens: string[]; values: Record<string, string> } | null>(null);

  // UX-542/543: same shared-stack treatment as the composer itself above.
  useOverlayEsc(snipOpen, () => setSnipOpen(false));
  useEffect(() => {
    if (!snipOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (snipRef.current && !snipRef.current.contains(e.target as Node)) setSnipOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [snipOpen]);

  const saveCurrentSnippet = () => {
    const { list, changed } = addSnippet(snippets, text);
    if (!changed) { pushToast("info", text.trim() ? "Already saved." : "Type a message first."); return; }
    setSnippets(list);
    saveSnippets(list);
    pushToast("success", "Snippet saved.");
  };
  const insertSnippet = (s: Snippet) => {
    const tokens = extractPlaceholders(s.text);
    if (tokens.length > 0) {
      setFillingSnippet({ snippet: s, tokens, values: Object.fromEntries(tokens.map((t) => [t, ""])) });
      setSnipOpen(false);
      return;
    }
    setText(s.text);
    setHistIdx(-1); // a snippet load is a fresh edit, not a history step
    setSnipOpen(false);
  };
  const commitFilledSnippet = () => {
    if (!fillingSnippet) return;
    setText(fillPlaceholders(fillingSnippet.snippet.text, fillingSnippet.values));
    setHistIdx(-1);
    setFillingSnippet(null);
  };
  const deleteSnippet = (id: string) => {
    const next = removeSnippet(snippets, id);
    setSnippets(next);
    saveSnippets(next);
  };

  // UX-552: a snippet chosen from the command palette (ui.ts's
  // pendingSnippetId) is picked up the moment the composer is open for it.
  const pendingSnippetId = useUI((s) => s.pendingSnippetId);
  const setPendingSnippet = useUI((s) => s.setPendingSnippet);
  useEffect(() => {
    if (!open || !pendingSnippetId) return;
    const found = snippets.find((s) => s.id === pendingSnippetId);
    setPendingSnippet(null);
    if (found) insertSnippet(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pendingSnippetId]);

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
                      <button className="bc-snip-text" onClick={() => insertSnippet(s)} title={s.text}>{s.text}</button>
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

      {/* UX-552: placeholder fill-in step for a {{token}}-carrying snippet. */}
      {fillingSnippet && (
        <div className="bc-fill" role="form" aria-label={`Fill in ${fillingSnippet.snippet.text}`}>
          <div className="bc-fill-head">Fill in “{fillingSnippet.snippet.text}”</div>
          <div className="bc-fill-fields">
            {fillingSnippet.tokens.map((t) => (
              <label className="bc-fill-field" key={t}>
                <span>{t}</span>
                <input
                  autoFocus={t === fillingSnippet.tokens[0]}
                  value={fillingSnippet.values[t] ?? ""}
                  onChange={(e) => setFillingSnippet((f) => f && { ...f, values: { ...f.values, [t]: e.target.value } })}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitFilledSnippet(); } }}
                />
              </label>
            ))}
          </div>
          <div className="bc-fill-actions">
            <button className="btn-ghost" type="button" onClick={() => setFillingSnippet(null)}>Cancel</button>
            <button className="bc-send" type="button" onClick={commitFilledSnippet}>Insert</button>
          </div>
        </div>
      )}

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

      {/* UX-521: what each live target last said — linkified, so a path or
          url an agent just printed is clickable straight from here. */}
      {targetsWithOutput.length > 0 && (
        <div className="bc-outputs" aria-label="Last output from targeted panes">
          {targetsWithOutput.map(({ w, p, line }) => (
            <div className="bc-output-row" key={p.id}>
              <span className="bc-output-who">{scope === "all" ? `${w.name} · ` : ""}{vendorShort(p.vendor)}</span>
              <LinkifiedText className="bc-output-line" text={tailEllipsis(line, 140)} cwd={p.cwd} />
            </div>
          ))}
        </div>
      )}

      {lastBroadcast && (
        <div className="bc-last" title={timeTitle(lastBroadcast.at)}>
          <span>
            Last sent {relTime(lastBroadcast.at)} to {lastBroadcast.sentTo} pane{lastBroadcast.sentTo === 1 ? "" : "s"}
            {lastBroadcast.failed > 0 ? ` (${lastBroadcast.failed} failed)` : ""}
          </span>
          {/* UX-550: resend without retyping — goes to the current target
              selection (one pane if narrowed, N if still broadcast-wide). */}
          <button className="bc-resend" onClick={resendLast} disabled={targets.length === 0 || sending} title="Resend this exact message to the current target selection">
            Resend
          </button>
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
