import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { IconClose, IconBranch, IconRefresh } from "./Icons";
import { relTime, timeTitle, tailEllipsis, bytes } from "./format";
import { vendorShort } from "./vendors";
import "./leftpanel.css";
import "./overlays.css";

// QL-764 — resume/fork launcher.
//
// Claude Code keeps every past session as a transcript under
// ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl, and `claude --resume <id>`
// (optionally with --fork-session) picks one back up. The backend
// (usage.rs::list_claude_sessions) indexes those files; this overlay lists them
// for the pane you're looking at and opens the chosen one as a NEW pane in the
// same folder, running the same vendor command plus the resume args.
//
// Open state lives here rather than in ui.ts, the same shape CommandPalette and
// Shortcuts already use for their own overlays: one component, its own key
// listener, mounted once in Cockpit.

/** The only vendor this applies to — resume is a Claude Code feature, and the
 *  transcripts the list is built from are Claude Code's own (same gate the ctx
 *  chip's data source implies: no transcript, nothing to show). */
export const RESUME_VENDOR = "claude";

const OPEN_EVENT = "flightdeck:session-launcher";

export interface ClaudeSession {
  id: string;
  modifiedMs: number;
  title: string;
  gitBranch: string | null;
  model: string | null;
  /** null when the transcript was too big to read whole — see usage.rs. */
  turns: number | null;
  sizeBytes: number;
}

/** The one-slot "how big is this session" reading: an exact turn count when the
 *  backend could read the transcript whole, the transcript's size when it
 *  couldn't. Never an invented number. */
export function sessionWeight(s: Pick<ClaudeSession, "turns" | "sizeBytes">): string {
  return s.turns != null ? `${s.turns} turn${s.turns === 1 ? "" : "s"}` : `${bytes(s.sizeBytes)} transcript`;
}

/** Open the launcher for a specific pane (defaults to the focused one).
 *  Exported so the pane menu and the command palette can reach it without a
 *  store field — same re-dispatch pattern the palette already uses for the
 *  side panel and cheat sheet. */
export function openSessionLauncher(paneId?: number) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { paneId } }));
}

/** The argv Claude Code needs to reopen `sessionId`. Fork leaves the original
 *  session untouched and branches a copy — the safe way to revisit a session
 *  you may still want to continue elsewhere. */
export function resumeArgs(sessionId: string, fork: boolean): string[] {
  return fork ? ["--resume", sessionId, "--fork-session"] : ["--resume", sessionId];
}

/** "claude-opus-4-1-20250805" -> "opus 4.1", "claude-3-5-haiku-20241022" ->
 *  "haiku 3.5". Unknown ids fall back to the id with the date stamp dropped,
 *  so a model this doesn't know still reads as something. */
export function modelShort(model: string | null | undefined): string {
  if (!model) return "";
  const parts = model.toLowerCase().replace(/[^a-z0-9-]/g, "-").split("-").filter(Boolean);
  const isDate = (t: string) => /^\d{8}$/.test(t);
  const isNum = (t: string) => /^\d+$/.test(t) && !isDate(t);
  const fam = parts.findIndex((p) => ["opus", "sonnet", "haiku", "fable"].includes(p));
  if (fam === -1) return parts.filter((p) => !isDate(p) && p !== "claude").join("-");
  // Generation sits either after the family (opus-4-1) or before it (3-5-haiku).
  const after = parts.slice(fam + 1).filter(isNum);
  const before = parts.slice(0, fam).filter(isNum);
  const gen = (after.length ? after : before).slice(0, 2).join(".");
  return gen ? `${parts[fam]} ${gen}` : parts[fam];
}

/** QL-765: context window used for the "% of window" reading.
 *  ASSUMPTION: every current Claude model is a 200k-token window; the 1M-token
 *  variants advertise themselves in the model id ("[1m]" / "-1m"). Nothing in
 *  the transcript states the window, so this is the one inferred number in the
 *  chip — every other figure in the tooltip is read straight off the file. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export function contextWindowFor(model: string | null | undefined): number {
  return model && /(\[1m\]|-1m\b)/i.test(model) ? 1_000_000 : DEFAULT_CONTEXT_WINDOW;
}

/** Substring filter over the fields a row actually shows. Order is preserved
 *  (the backend already sorted newest-first). */
export function filterSessions(list: ClaudeSession[], query: string): ClaudeSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) =>
    [s.title, s.id, s.gitBranch ?? "", modelShort(s.model), s.model ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
}

/** Stage the resume args for the next spawn in this folder, then create the
 *  pane that will consume them (usage.rs holds the staging; build_command in
 *  lib.rs applies it). Returns false when the backend refused the staging —
 *  in which case NO pane is created, since a pane spawned without the args
 *  would silently start a fresh session instead of resuming. */
export async function launchResume(
  wsId: number,
  pane: Pick<PaneModel, "vendor" | "cwd" | "worktreePath" | "branch" | "baseBranch">,
  sessionId: string,
  fork: boolean
): Promise<boolean> {
  try {
    await invoke("stage_launch_args", {
      vendor: pane.vendor,
      cwd: pane.cwd,
      args: resumeArgs(sessionId, fork),
    });
  } catch {
    return false;
  }
  const wt =
    pane.worktreePath && pane.branch && pane.baseBranch
      ? { worktreePath: pane.worktreePath, branch: pane.branch, baseBranch: pane.baseBranch }
      : undefined;
  useApp.getState().addPane(wsId, pane.vendor, pane.cwd, wt);
  return true;
}

export function SessionLauncher() {
  const workspaces = useApp((s) => s.workspaces);
  const pushToast = useUI((s) => s.pushToast);
  const [target, setTarget] = useState<{ wsId: number; paneId: number } | null>(null);
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const open = target !== null;
  const pane = useMemo(() => {
    if (!target) return null;
    const ws = workspaces.find((w) => w.id === target.wsId);
    return ws?.panes.find((p) => p.id === target.paneId) ?? null;
  }, [workspaces, target]);

  const close = useCallback(() => setTarget(null), []);
  useOverlayEsc(open, close);

  // Ctrl+Shift+R from anywhere, plus the programmatic open used by the pane
  // menu and the command palette. NOT guarded by the `.pbody` terminal check,
  // for the reason Ctrl+Shift+A documents in Cockpit.tsx: no agent TUI binds
  // this, and a shortcut that dies whenever a terminal has focus is useless —
  // a terminal having focus is the normal state of this app.
  useEffect(() => {
    const openFor = (paneId?: number) => {
      const st = useApp.getState();
      const ws = st.workspaces.find((w) => w.id === st.activeId);
      let found: { wsId: number; pane: PaneModel } | null = null;
      if (paneId != null) {
        for (const w of st.workspaces) {
          const p = w.panes.find((x) => x.id === paneId);
          if (p) { found = { wsId: w.id, pane: p }; break; }
        }
      } else {
        const p = ws?.panes.find((x) => x.id === ws.focused) ?? ws?.panes[0];
        if (ws && p) found = { wsId: ws.id, pane: p };
      }
      if (!found) {
        useUI.getState().pushToast("info", "Focus a pane first — the launcher lists that folder’s past sessions.");
        return;
      }
      if (found.pane.vendor !== RESUME_VENDOR) {
        useUI.getState().pushToast(
          "info",
          `Resuming past sessions is a ${vendorShort(RESUME_VENDOR)} feature — this pane is ${vendorShort(found.pane.vendor)}.`
        );
        return;
      }
      setTarget({ wsId: found.wsId, paneId: found.pane.id });
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "r" || e.key === "R"))) return;
      e.preventDefault();
      if (open) { close(); return; }
      openFor();
    };
    const onOpen = (e: Event) => openFor((e as CustomEvent<{ paneId?: number }>).detail?.paneId);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [open, close]);

  // Read the transcript index on open (and on a manual refresh). Not polled:
  // the list is a point-in-time picker, and scanning a folder of transcripts is
  // not something to do on a timer behind a closed overlay.
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    if (!open || !pane) return;
    let cancelled = false;
    setSessions(null);
    setError(null);
    setQuery("");
    setIndex(0);
    invoke<ClaudeSession[]>("list_claude_sessions", { cwd: pane.cwd })
      .then((list) => { if (!cancelled) setSessions(list); })
      .catch((e) => { if (!cancelled) { setSessions([]); setError(String(e)); } });
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => { cancelled = true; cancelAnimationFrame(id); };
  }, [open, pane?.cwd, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => filterSessions(sessions ?? [], query), [sessions, query]);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [index]);

  const run = useCallback(
    async (s: ClaudeSession, fork: boolean) => {
      if (!pane || !target) return;
      close();
      const ok = await launchResume(target.wsId, pane, s.id, fork);
      if (!ok) { pushToast("error", "Couldn’t stage the resume — no pane was opened."); return; }
      pushToast(
        "success",
        `${fork ? "Forking" : "Resuming"} session ${s.id.slice(0, 8)} in a new pane.`
      );
    },
    [pane, target, close, pushToast]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const s = results[index];
        if (s) void run(s, e.shiftKey);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, results, index, run]);

  if (!open || !pane) return null;

  return (
    <div className="cmdp-scrim" onMouseDown={close}>
      <div className="cmdp-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Resume a past session">
        <div className="cmdp-inputrow">
          <input
            ref={inputRef}
            className="cmdp-input"
            placeholder={`Resume a past ${vendorShort(pane.vendor)} session in ${pane.cwd}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <button className="ov-x" onClick={() => setReloadTick((t) => t + 1)} title="Re-read the transcripts">
            <IconRefresh size={15} />
          </button>
          <button className="ov-x" onClick={close} title="Close"><IconClose size={16} /></button>
        </div>
        <div className="cmdp-list">
          {sessions === null && <div className="cmdp-empty">Reading this folder’s transcripts…</div>}
          {sessions !== null && results.length === 0 && (
            <div className="cmdp-empty">
              {error
                ? "Couldn’t read the session transcripts for this folder."
                : query
                  ? `No past session matches "${query}".`
                  : "No past sessions recorded for this folder yet."}
              <span className="cmdp-empty-hint">
                {error
                  ? error
                  : `Sessions appear here once Claude Code has written a transcript for ${pane.cwd}.`}
              </span>
            </div>
          )}
          {results.map((s, i) => {
            const isActive = i === index;
            return (
              <div
                key={s.id}
                ref={isActive ? activeRef : undefined}
                className={"cmdp-item" + (isActive ? " active" : "")}
                onMouseEnter={() => setIndex(i)}
                onClick={(e) => void run(s, e.shiftKey)}
                title={`${s.title || s.id}\n${s.id}\n${sessionWeight(s)}${s.model ? ` · ${s.model}` : ""}\nClick to resume, Shift+click to fork`}
              >
                <span className="cmdp-label">{s.title || <em>(no prompt recorded)</em>}</span>
                {s.gitBranch && (
                  <span className="cmdp-hint" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <IconBranch size={10} />{tailEllipsis(s.gitBranch, 18)}
                  </span>
                )}
                {/* Model and turn count share one slot — a 560px row has room
                    for the prompt, the branch, one meta chip and the time. */}
                <span className="cmdp-hint">
                  {[modelShort(s.model), sessionWeight(s)].filter(Boolean).join(" · ")}
                </span>
                <span className="cmdp-hint" title={timeTitle(s.modifiedMs)}>{relTime(s.modifiedMs)}</span>
                <button
                  className="cmdp-shortcut"
                  style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", font: "inherit" }}
                  onClick={(e) => { e.stopPropagation(); void run(s, true); }}
                  title="Fork this session — resumes a copy, leaving the original untouched"
                >
                  <kbd>Fork</kbd>
                </button>
              </div>
            );
          })}
        </div>
        <div className="cmdp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> resume</span>
          <span><kbd>Shift</kbd>+<kbd>Enter</kbd> fork</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
