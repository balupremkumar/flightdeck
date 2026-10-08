import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { IconClose, IconBranch, IconRefresh } from "./Icons";
import { relTime, timeTitle, tailEllipsis } from "./format";
import { vendorShort } from "./vendors";
import "./leftpanel.css";
import "./overlays.css";
import { chooseSearchPane, type SessionLauncherOptions, hitCwd, canResume, supportsFork, listCommandFor, supportsDeepSearch, OPEN_EVENT, ClaudeSession, sessionWeight, modelShort, filterSessions, SessionSearchResults, MIN_SEARCH_CHARS, SEARCH_DEBOUNCE_MS, groupHits, highlightParts, launchResume } from "./sessionLauncherLogic";
export * from "./sessionLauncherLogic";

export function SessionLauncher() {
  const workspaces = useApp((s) => s.workspaces);
  const pushToast = useUI((s) => s.pushToast);
  const [target, setTarget] = useState<{ wsId: number; paneId: number; search?: boolean } | null>(null);
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // QL-771: deep (full-text) mode and its own request state. Kept separate from
  // the list's, so flipping back to titles never re-reads the folder.
  const [deep, setDeep] = useState(false);
  // Scope ("This folder" / "All projects") and regex are part of the query.
  const [allProjects, setAllProjects] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [search, setSearch] = useState<SessionSearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
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
    const openFor = (paneId?: number, opts?: SessionLauncherOptions) => {
      const st = useApp.getState();
      const ws = st.workspaces.find((w) => w.id === st.activeId);
      let found: { wsId: number; pane: PaneModel } | null = null;
      if (opts?.search) {
        const p = ws && chooseSearchPane(ws.panes, paneId ?? ws.focused);
        if (ws && p) found = { wsId: ws.id, pane: p };
        if (!found) {
          useUI.getState().pushToast("info", "Search past sessions needs a Claude pane in the active workspace.");
          return;
        }
      } else if (paneId != null) {
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
      if (!canResume(found.pane.vendor)) {
        useUI.getState().pushToast(
          "info",
          `Resuming past sessions works for ${vendorShort("claude")} and ${vendorShort("codex")} panes — this pane is ${vendorShort(found.pane.vendor)}.`
        );
        return;
      }
      setTarget({ wsId: found.wsId, paneId: found.pane.id, search: opts?.search });
    };
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!(e.ctrlKey && e.shiftKey && !e.altKey && (key === "r" || key === "f"))) return;
      e.preventDefault();
      if (open) { close(); return; }
      openFor(undefined, { search: key === "f" });
    };
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<SessionLauncherOptions & { paneId?: number }>).detail;
      openFor(detail?.paneId, detail);
    };
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
    setDeep(!!target?.search);
    if (target?.search) setAllProjects(true);
    setSearch(null);
    setSearchError(null);
    invoke<ClaudeSession[]>(listCommandFor(pane.vendor), { cwd: pane.cwd })
      .then((list) => { if (!cancelled) setSessions(list); })
      .catch((e) => { if (!cancelled) { setSessions([]); setError(String(e)); } });
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => { cancelled = true; cancelAnimationFrame(id); };
  }, [open, target, pane?.cwd, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => filterSessions(sessions ?? [], query), [sessions, query]);
  useEffect(() => { setIndex(0); }, [query, deep]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [index]);

  // QL-771: the deep search itself. Debounced, cancelled on every keystroke, and
  // it degrades silently: if the backend command isn't there, the overlay says
  // content search is unavailable and the title filter carries on working.
  const trimmed = query.trim();
  useEffect(() => {
    if (!open || !pane || !deep) return;
    if (trimmed.length < MIN_SEARCH_CHARS) {
      setSearch(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      invoke<SessionSearchResults>("search_claude_sessions", { cwd: pane.cwd, query: trimmed, allProjects, regex: useRegex })
        .then((r) => {
          if (cancelled) return;
          setSearch(r);
          setSearchError(null);
          setSearching(false);
        })
        .catch((e) => {
          if (cancelled) return;
          setSearch({ hits: [], truncated: false, sessionsSearched: 0, partial: false });
          setSearchError(String(e));
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, pane?.cwd, deep, trimmed, allProjects, useRegex, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const forkable = !!pane && supportsFork(pane.vendor);
  const deepOk = !!pane && supportsDeepSearch(pane.vendor);
  const hits = deep ? search?.hits ?? [] : [];
  const groups = useMemo(() => groupHits(hits), [hits]);
  /** Flat row index of each group's first hit — keyboard nav runs over the flat
   *  hit list, the rows are drawn grouped. */
  const groupStart = useMemo(() => {
    let n = 0;
    return groups.map((g) => { const s = n; n += g.hits.length; return s; });
  }, [groups]);
  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);
  const rowCount = deep ? hits.length : results.length;

  const run = useCallback(
    async (sessionId: string, fork: boolean, cwd?: string) => {
      if (!pane || !target) return;
      fork = fork && supportsFork(pane.vendor);
      close();
      const res = await launchResume(target.wsId, pane, sessionId, fork, cwd);
      if (res === "cwd-missing") { pushToast("error", `That session’s folder no longer exists (${cwd}). No pane was opened.`); return; }
      if (res !== "ok") { pushToast("error", "Couldn’t stage the resume — no pane was opened."); return; }
      pushToast(
        "success",
        `${fork ? "Forking" : "Resuming"} session ${sessionId.slice(0, 8)} in a new pane.`
      );
    },
    [pane, target, close, pushToast]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, rowCount - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        // Plain Tab flips title filter <-> content search. Shift+Tab is left
        // alone so the row of buttons is still reachable by keyboard.
        e.preventDefault();
        if (deepOk) setDeep((d) => !d);
      }
      else if (e.key === "Enter") {
        e.preventDefault();
        const id = deep ? hits[index]?.sessionId : results[index]?.id;
        if (id) void run(id, e.shiftKey, deep ? hitCwd(hits[index], pane?.cwd ?? "") : undefined);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, deepOk, results, hits, deep, index, rowCount, run, pane?.cwd]);

  if (!open || !pane) return null;

  return (
    <div className="cmdp-scrim" onMouseDown={close}>
      <div className="cmdp-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Resume a past session">
        <div className="cmdp-inputrow">
          <input
            ref={inputRef}
            className="cmdp-input"
            placeholder={
              deep
                ? `Search what was said in ${allProjects ? "all projects" : pane.cwd}${useRegex ? " (regex)" : ""}…`
                : `Resume a past ${vendorShort(pane.vendor)} session in ${pane.cwd}…`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {deepOk && (
          <button
            className={"agent-chip" + (deep ? " ok" : "")}
            aria-pressed={deep}
            onClick={() => setDeep((d) => !d)}
            title={
              deep
                ? "Searching message text across every transcript in this folder (Tab for titles)"
                : "Search inside the transcripts, not just the session titles (Tab)"
            }
          >
            Search content
          </button>
          )}
          {deepOk && deep && (
            <>
              <button
                className={"agent-chip" + (allProjects ? " ok" : "")}
                aria-pressed={allProjects}
                onClick={() => setAllProjects((a) => !a)}
                title={allProjects ? "Searching every project (click for this folder only)" : "Searching this folder only (click for every project)"}
              >
                {allProjects ? "All projects" : "This folder"}
              </button>
              <button
                className={"agent-chip" + (useRegex ? " ok" : "")}
                aria-pressed={useRegex}
                aria-label="Regular expression"
                onClick={() => setUseRegex((r) => !r)}
                title={useRegex ? "Query is a regular expression (case-insensitive)" : "Treat the query as a regular expression"}
                style={{ fontFamily: "var(--mono, monospace)" }}
              >
                .*
              </button>
            </>
          )}
          <button className="ov-x" onClick={() => setReloadTick((t) => t + 1)} title="Re-read the transcripts">
            <IconRefresh size={15} />
          </button>
          <button className="ov-x" onClick={close} title="Close"><IconClose size={16} /></button>
        </div>
        <div className="cmdp-list">
          {/* QL-771 — content search. Its own states: too short to search,
              searching, unavailable (backend command missing — the title
              filter is untouched), nothing said matches. */}
          {deep && trimmed.length < MIN_SEARCH_CHARS && (
            <div className="cmdp-empty">
              Search what was said in {allProjects ? "every project’s" : "this folder’s"} sessions.
              <span className="cmdp-empty-hint">
                Type at least {MIN_SEARCH_CHARS} characters. Prompts and replies are searched; tool
                output and sub-agent turns are not.
              </span>
            </div>
          )}
          {deep && trimmed.length >= MIN_SEARCH_CHARS && searching && hits.length === 0 && (
            <div className="cmdp-empty">Reading {allProjects ? "transcripts across all projects" : "this folder’s transcripts"}…</div>
          )}
          {deep && trimmed.length >= MIN_SEARCH_CHARS && !searching && !searchError && search?.error && (
            <div className="cmdp-empty">
              That isn’t a valid regular expression.
              <span className="cmdp-empty-hint">{search.error}</span>
            </div>
          )}
          {deep && trimmed.length >= MIN_SEARCH_CHARS && !searching && searchError && (
            <div className="cmdp-empty">
              Content search is unavailable.
              <span className="cmdp-empty-hint">
                {searchError}
                <br />
                Press <kbd>Tab</kbd> to go back to filtering session titles.
              </span>
            </div>
          )}
          {deep && trimmed.length >= MIN_SEARCH_CHARS && !searching && !searchError && !search?.error && hits.length === 0 && search !== null && (
            <div className="cmdp-empty">
              Nothing said {allProjects ? "in any project" : "in this folder"} matches "{trimmed}".
              <span className="cmdp-empty-hint">
                {search.sessionsSearched} transcript{search.sessionsSearched === 1 ? "" : "s"} searched{search.partial ? " (partial: stopped early, narrow the search)" : ""}.
                Tool output, file contents and sub-agent turns are deliberately left out.
              </span>
            </div>
          )}
          {deep &&
            groups.map((g, gi) => {
              const s = byId.get(g.sessionId);
              return (
                <div key={g.sessionId}>
                  <div className="cmdp-section" style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s?.title || g.sessionId.slice(0, 8)}
                    </span>
                    {allProjects && g.cwd && (
                      <span
                        style={{ flex: "none", maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "none", letterSpacing: 0 }}
                        title={g.cwd}
                      >
                        {tailEllipsis(g.cwd, 32)}
                      </span>
                    )}
                    <span style={{ flex: "none", textTransform: "none", letterSpacing: 0 }}>
                      {g.count} hit{g.count === 1 ? "" : "s"}
                      {s ? ` · ${relTime(s.modifiedMs)}` : ""}
                    </span>
                  </div>
                  {g.hits.map((h, hi) => {
                    const i = groupStart[gi] + hi;
                    const isActive = i === index;
                    return (
                      <div
                        key={`${h.sessionId}:${i}`}
                        ref={isActive ? activeRef : undefined}
                        className={"cmdp-item" + (isActive ? " active" : "")}
                        style={{ alignItems: "flex-start" }}
                        onMouseEnter={() => setIndex(i)}
                        onClick={(e) => void run(h.sessionId, e.shiftKey, hitCwd(h, pane.cwd))}
                        title={`${s?.title || h.sessionId}\n${h.cwd ? h.cwd + "\n" : ""}${h.sessionId}\nClick to resume, Shift+click to fork`}
                      >
                        <span
                          className="cmdp-hint"
                          style={{ width: 46, textAlign: "left", paddingTop: 1 }}
                          title={h.timestampMs ? timeTitle(h.timestampMs) : undefined}
                        >
                          {h.role === "user" ? "you" : "agent"}
                        </span>
                        <span
                          className="cmdp-label"
                          style={{
                            whiteSpace: "normal",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            lineHeight: 1.45,
                          }}
                        >
                          {highlightParts(h.snippet, trimmed, useRegex).map((p, pi) =>
                            p.hit ? (
                              <mark
                                key={pi}
                                style={{
                                  background: "color-mix(in srgb, var(--accent) 34%, transparent)",
                                  color: "inherit",
                                  borderRadius: 3,
                                  padding: "0 1px",
                                }}
                              >
                                {p.text}
                              </mark>
                            ) : (
                              <span key={pi}>{p.text}</span>
                            )
                          )}
                        </span>
                        {h.timestampMs > 0 && (
                          <span className="cmdp-hint" title={timeTitle(h.timestampMs)}>{relTime(h.timestampMs)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          {deep && (search?.truncated || search?.partial) && hits.length > 0 && (
            <div className="cmdp-empty" style={{ padding: "10px" }}>
              {search?.partial ? "Partial results: the search stopped early. " : ""}
              {search?.truncated ? `Showing the first ${hits.length} hits. ` : ""}
              Narrow the search to see the rest.
            </div>
          )}

          {!deep && sessions === null && <div className="cmdp-empty">Reading this folder’s transcripts…</div>}
          {!deep && sessions !== null && results.length === 0 && (
            <div className="cmdp-empty">
              {error
                ? "Couldn’t read the session transcripts for this folder."
                : query
                  ? `No past session matches "${query}".`
                  : "No past sessions recorded for this folder yet."}
              <span className="cmdp-empty-hint">
                {error
                  ? error
                  : `Sessions appear here once ${pane.vendor === "codex" ? "Codex has recorded a session (only the last week or so is listed; older ones are compressed)" : "Claude Code has written a transcript"} for ${pane.cwd}.`}
              </span>
            </div>
          )}
          {!deep && results.map((s, i) => {
            const isActive = i === index;
            return (
              <div
                key={s.id}
                ref={isActive ? activeRef : undefined}
                className={"cmdp-item" + (isActive ? " active" : "")}
                onMouseEnter={() => setIndex(i)}
                onClick={(e) => void run(s.id, e.shiftKey)}
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
                {forkable && (
                <button
                  className="cmdp-shortcut"
                  style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", font: "inherit" }}
                  onClick={(e) => { e.stopPropagation(); void run(s.id, true); }}
                  title="Fork this session — resumes a copy, leaving the original untouched"
                >
                  <kbd>Fork</kbd>
                </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="cmdp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> resume</span>
          {forkable && <span><kbd>Shift</kbd>+<kbd>Enter</kbd> fork</span>}
          {deepOk
            ? <span><kbd>Tab</kbd> {deep ? "session titles" : "search content"}</span>
            : <span>content search: Claude panes only</span>}
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
