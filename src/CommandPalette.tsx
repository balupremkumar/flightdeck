import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type PaneState } from "./store";
import { useUI, setTheme } from "./ui";
import { closePaneGuarded } from "./worktrees";
import { IconWorkspace, IconAgent, IconSettings, IconClose } from "./Icons";
import "./leftpanel.css";

// Self-contained fuzzy command palette (Ctrl+K / Ctrl+P): jump to any
// workspace or pane, or run a handful of app actions. Mount once with
// `<CommandPalette />` — it owns its own open/closed state.

type Section = "Workspaces" | "Panes" | "Actions";
interface Item {
  id: string;
  section: Section;
  label: string;
  hint?: string;
  keywords?: string;
  /** UI-205: pane rows render a live status dot. */
  state?: PaneState;
  run: () => void;
}

const RECENT_KEY = "flightdeck-cmdp-recent";
function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}
function pushRecent(id: string) {
  try {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* non-persistent */ }
}

// Ordered-subsequence fuzzy match. Lower score = better match; null = no match.
function fuzzyScore(haystack: string, query: string): number | null {
  const s = haystack.toLowerCase();
  const q = query.toLowerCase();
  let si = 0, score = 0, streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = s.indexOf(q[qi], si);
    if (idx === -1) return null;
    score += (idx - si) + (streak > 0 ? 0 : 1);
    streak = idx === si ? streak + 1 : 0;
    si = idx + 1;
  }
  return score;
}

// No `setView`/panel-expand setter is reachable from outside Cockpit (local
// state there) — re-dispatch its own Ctrl+B handler instead of prop-drilling
// or duplicating state. See report for a cleaner follow-up wiring.
function toggleSidePanel() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
}

export function CommandPalette() {
  const workspaces = useApp((s) => s.workspaces);
  const switchWorkspace = useApp((s) => s.switchWorkspace);
  const focusPane = useApp((s) => s.focusPane);
  const startCreate = useApp((s) => s.startCreate);
  const restartPane = useApp((s) => s.restartPane);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);
  const explorerOpen = useUI((s) => s.explorerOpen);
  const setExplorerOpen = useUI((s) => s.setExplorerOpen);
  const setBroadcastOpen = useUI((s) => s.setBroadcastOpen);
  const setReviewPane = useUI((s) => s.setReviewPane);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Ctrl+K or Ctrl+P toggles. Guarded so it never steals keystrokes from a
  // focused terminal (same `.pbody` guard Cockpit uses for Ctrl+B).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K" || e.key === "p" || e.key === "P");
      if (!combo) return;
      if ((e.target as HTMLElement)?.closest?.(".pbody")) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const w of workspaces) {
      list.push({ id: `ws:${w.id}`, section: "Workspaces", label: w.name, hint: w.root, run: () => switchWorkspace(w.id) });
      for (const p of w.panes) {
        list.push({
          id: `pane:${p.id}`,
          section: "Panes",
          label: p.title || `${p.vendor} — ${w.name}`,
          hint: p.cwd,
          state: p.state, // UI-205: live status dot on the row
          keywords: `${p.vendor} ${w.name} ${p.state}`,
          run: () => { switchWorkspace(w.id); focusPane(w.id, p.id); },
        });
        if (p.state === "idle" || p.state === "error") {
          list.push({
            id: `restart:${p.id}`,
            section: "Actions",
            label: `Restart pane — ${p.title || p.vendor} (${w.name})`,
            run: () => {
              switchWorkspace(w.id);
              focusPane(w.id, p.id);
              restartPane(p.id);
              pushToast("info", "Restarting pane");
            },
          });
        }
        // Review drawer for isolated (worktree) panes — same surface as the
        // pane header's diff-stat badge.
        if (p.worktreePath) {
          list.push({
            id: `review:${p.id}`,
            section: "Actions",
            label: `Review changes — ${p.title || p.vendor} (${w.name})`,
            run: () => { switchWorkspace(w.id); setReviewPane(p.id); },
          });
        }
        // Same guard as the pane header's close button: a dead pane closes
        // directly, a live one confirms first (closing kills the PTY / ends
        // the agent session with no way back).
        list.push({
          id: `close:${p.id}`,
          section: "Actions",
          label: `Close pane — ${p.title || p.vendor} (${w.name})`,
          run: () => {
            switchWorkspace(w.id);
            focusPane(w.id, p.id);
            closePaneGuarded(w.id, p);
          },
        });
      }
    }
    list.push({ id: "act:new-workspace", section: "Actions", label: "New workspace", run: () => startCreate() });
    list.push({ id: "act:settings", section: "Actions", label: "Open settings", hint: "Ctrl+,", run: () => setSettingsOpen(true) });
    list.push({ id: "act:theme-dark", section: "Actions", label: "Switch to dark theme", run: () => setTheme("dark") });
    list.push({ id: "act:theme-light", section: "Actions", label: "Switch to light theme", run: () => setTheme("light") });
    list.push({ id: "act:toggle-panel", section: "Actions", label: "Toggle side panel", hint: "Ctrl+B", run: toggleSidePanel });
    list.push({ id: "act:attention-queue", section: "Actions", label: "Open attention queue", hint: "Ctrl+Shift+A", run: () => useUI.getState().setAttentionOpen(true) });
    list.push({
      id: "act:toggle-explorer",
      section: "Actions",
      label: explorerOpen ? "Toggle file explorer (currently open)" : "Toggle file explorer (currently closed)",
      run: () => setExplorerOpen(!explorerOpen),
    });
    list.push({ id: "act:open-broadcast", section: "Actions", label: "Open broadcast", run: () => setBroadcastOpen(true) });
    // UI-206: after a crash wave, restarting six panes one at a time is the
    // wrong amount of work.
    const errored = workspaces.flatMap((w) => w.panes.filter((p) => p.state === "error").map((p) => ({ w, p })));
    if (errored.length > 0) {
      list.push({
        id: "act:restart-errored",
        section: "Actions",
        label: `Restart all errored panes (${errored.length})`,
        run: () => {
          for (const { p } of errored) restartPane(p.id);
          pushToast("info", `Restarting ${errored.length} pane${errored.length === 1 ? "" : "s"}`);
        },
      });
    }
    // UI-207: act on what's focused without naming it.
    const activeWs = workspaces.find((w) => w.id === useApp.getState().activeId);
    const focusedPane = activeWs?.panes.find((p) => p.id === activeWs.focused);
    if (focusedPane) {
      list.push({
        id: "act:review-focused",
        section: "Actions",
        label: "Review changes — focused pane",
        run: () => setReviewPane(focusedPane.id),
      });
    }
    return list;
  }, [
    workspaces, switchWorkspace, focusPane, restartPane, startCreate,
    setSettingsOpen, pushToast, requestConfirm, explorerOpen, setExplorerOpen, setBroadcastOpen, setReviewPane,
  ]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      const recent = loadRecent();
      const byId = new Map(items.map((it) => [it.id, it]));
      const recentItems = recent.map((id) => byId.get(id)).filter((x): x is Item => !!x);
      const rest = items.filter((it) => !recent.includes(it.id));
      return [...recentItems, ...rest];
    }
    return items
      .map((it) => ({ it, score: fuzzyScore(`${it.label} ${it.keywords ?? ""}`, q) }))
      .filter((x): x is { it: Item; score: number } => x.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.it);
  }, [items, query]);

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [index]);

  const runItem = (it: Item) => {
    pushRecent(it.id);
    it.run();
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); const it = results[index]; if (it) runItem(it); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, results, index]);

  if (!open) return null;

  let lastSection: Section | null = null;
  return (
    <div className="cmdp-scrim" onMouseDown={() => setOpen(false)}>
      <div className="cmdp-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="cmdp-inputrow">
          <input
            ref={inputRef}
            className="cmdp-input"
            placeholder="Jump to a workspace, pane, or action…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <button className="ov-x" onClick={() => setOpen(false)} title="Close"><IconClose size={14} /></button>
        </div>
        <div className="cmdp-list">
          {results.length === 0 && <div className="cmdp-empty">No matches for "{query}"</div>}
          {results.map((it, i) => {
            const showHeader = it.section !== lastSection;
            lastSection = it.section;
            const isActive = i === index;
            return (
              <div key={it.id}>
                {showHeader && <div className="cmdp-section">{it.section}</div>}
                <div
                  ref={isActive ? activeRef : undefined}
                  className={"cmdp-item" + (isActive ? " active" : "")}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => runItem(it)}
                >
                  <span className="cmdp-ic">
                    {it.section === "Workspaces" ? <IconWorkspace size={14} /> : it.section === "Panes" ? <IconAgent size={14} /> : <IconSettings size={14} />}
                  </span>
                  {it.state && <span className={"pdot " + it.state} title={it.state} />}
                  <span className="cmdp-label">{it.label}</span>
                  {it.hint && <span className="cmdp-hint">{it.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cmdp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> select</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
