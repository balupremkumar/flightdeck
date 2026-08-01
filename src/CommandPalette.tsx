import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type PaneState } from "./store";
import { useUI, setTheme } from "./ui";
import { closePaneGuarded } from "./worktrees";
import { checkForUpdate } from "./updater";
import { getShortcuts, FIXED_SHORTCUTS } from "./Settings";
import { IconWorkspace, IconAgent, IconSettings, IconClose } from "./Icons";
import { VendorGlyph } from "./VendorGlyph";
import "./leftpanel.css";
// UX-530: .cmdp-shortcut + the global <kbd> look live in overlays.css.
import "./overlays.css";

// Self-contained fuzzy command palette (Ctrl+K / Ctrl+P): jump to any
// workspace or pane, or run a handful of app actions. Mount once with
// `<CommandPalette />` — it owns its own open/closed state.

type Section = "Workspaces" | "Panes" | "Actions";
interface Item {
  id: string;
  section: Section;
  label: string;
  hint?: string;
  /** UX-530: the bound key combo, shown as a distinct kbd row from `hint`
   *  (which is a free-text path/context string, not a shortcut). */
  shortcut?: string;
  keywords?: string;
  /** UI-205: pane rows render a live status dot. */
  state?: PaneState;
  /** UI-236: pane rows render their vendor glyph. */
  vendor?: string;
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

// UX-529: puts the most-recently-run commands first when the query is empty.
// Pure so it's testable without mounting the palette. `recent` is newest-first
// (as loadRecent/pushRecent already store it); anything not in it keeps its
// original relative order.
export function rankByRecent<T extends { id: string }>(items: T[], recent: string[]): T[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  const recentItems = recent.map((id) => byId.get(id)).filter((x): x is T => !!x);
  const rest = items.filter((it) => !recent.includes(it.id));
  return [...recentItems, ...rest];
}

// UX-530: id->combo lookup built from Settings.tsx's two shortcut registries
// (the single source of truth — see FIXED_SHORTCUTS there) so the palette
// never carries its own hand-typed copy to drift out of sync. Recomputed by
// the palette on every open rather than cached, so a rebind in Settings shows
// up immediately.
export function buildShortcutMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const s of [...getShortcuts(), ...FIXED_SHORTCUTS]) map[s.id] = s.combo;
  return map;
}

// Ordered-subsequence fuzzy match. Lower score = better match; null = no match.
export function fuzzyScore(haystack: string, query: string): number | null {
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
// Same re-dispatch pattern for the keyboard cheat sheet (Shortcuts.tsx owns
// its own open state via a "?" listener, mirroring how CommandPalette owns
// its own Ctrl+K/P state).
function openCheatSheet() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
}

// UX-530: maps a palette action's id to the shortcut-registry id it
// represents (Settings.tsx's DEFAULT_SHORTCUTS/FIXED_SHORTCUTS) — kept as one
// small table here rather than hand-typing each combo a second time.
const ACTION_SHORTCUT_ID: Record<string, string> = {
  "act:settings": "settings",
  "act:toggle-panel": "toggle-panel",
  "act:attention-queue": "attention-queue",
  "act:zoom-in": "zoom-in",
  "act:zoom-out": "zoom-out",
  "act:zoom-reset": "zoom-reset",
  "act:cheat-sheet": "cheat-sheet",
};

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
      // UX-526: Ctrl+P now belongs to quick-open (go to file), the editor
      // convention. Leaving it here as well opened BOTH overlays at once.
      const combo = e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K");
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
          vendor: p.vendor, // UI-236: vendor glyph
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
    list.push({ id: "act:settings", section: "Actions", label: "Open settings", run: () => setSettingsOpen(true) });
    list.push({ id: "act:cheat-sheet", section: "Actions", label: "Keyboard shortcuts cheat sheet", run: openCheatSheet });
    // UI-181/UX-598: every Settings section, so the palette is a complete
    // index of the app's preferences, not just the ones that existed when
    // this list was first written.
    for (const sec of ["Appearance", "Terminal", "Editor", "Shortcuts", "Agents", "Startup", "Session", "Diagnostics", "Reset", "About"]) {
      list.push({
        id: `act:settings:${sec}`,
        section: "Actions",
        label: `Settings: ${sec}`,
        keywords: `settings ${sec} preferences`,
        run: () => useUI.getState().openSettingsAt(sec),
      });
    }
    list.push({
      id: "act:check-updates",
      section: "Actions",
      label: "Check for updates",
      run: () => {
        useUI.getState().openSettingsAt("About");
        void checkForUpdate().then((res) => {
          if (res.available && res.info) pushToast("info", `Flightdeck ${res.info.version} is available — install it from Settings > About.`);
          else if (res.error) pushToast("error", `Update check failed: ${res.error}`);
          else pushToast("success", "Flightdeck is up to date.");
        });
      },
    });
    list.push({ id: "act:theme-dark", section: "Actions", label: "Switch to dark theme", run: () => setTheme("dark") });
    list.push({ id: "act:theme-light", section: "Actions", label: "Switch to light theme", run: () => setTheme("light") });
    list.push({ id: "act:toggle-panel", section: "Actions", label: "Toggle side panel", run: toggleSidePanel });
    list.push({ id: "act:attention-queue", section: "Actions", label: "Open attention queue", run: () => useUI.getState().setAttentionOpen(true) });
    list.push({
      id: "act:toggle-explorer",
      section: "Actions",
      label: explorerOpen ? "Toggle file explorer (currently open)" : "Toggle file explorer (currently closed)",
      run: () => setExplorerOpen(!explorerOpen),
    });
    list.push({ id: "act:open-broadcast", section: "Actions", label: "Open broadcast", run: () => setBroadcastOpen(true) });
    // Owner feedback item 3: whole-app zoom, same store actions the
    // Ctrl+=/-/0 shortcut and Settings > UI size use.
    list.push({ id: "act:zoom-in", section: "Actions", label: "Zoom in", run: () => useUI.getState().stepUiZoom(1) });
    list.push({ id: "act:zoom-out", section: "Actions", label: "Zoom out", run: () => useUI.getState().stepUiZoom(-1) });
    list.push({ id: "act:zoom-reset", section: "Actions", label: "Reset zoom", run: () => useUI.getState().resetUiZoom() });
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
    // UX-530: attach the real bound combo where one exists, read fresh off
    // Settings.tsx's registries on every recompute (open/close, workspace
    // changes) so a rebind is reflected without a special cache-bust path.
    const shortcutMap = buildShortcutMap();
    for (const it of list) {
      const sid = ACTION_SHORTCUT_ID[it.id];
      if (sid && shortcutMap[sid]) it.shortcut = shortcutMap[sid];
    }
    return list;
  }, [
    workspaces, switchWorkspace, focusPane, restartPane, startCreate,
    setSettingsOpen, pushToast, requestConfirm, explorerOpen, setExplorerOpen, setBroadcastOpen, setReviewPane,
  ]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      return rankByRecent(items, loadRecent());
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
          <button className="ov-x" onClick={() => setOpen(false)} title="Close"><IconClose size={16} /></button>
        </div>
        <div className="cmdp-list">
          {results.length === 0 && (
            <div className="cmdp-empty">
              {/* QOL 352: a bare "no matches" is a dead end — say what CAN be
                  searched, since that's the question the user actually has. */}
              No matches for "{query}".
              <span className="cmdp-empty-hint">
                Search workspaces by name, panes by agent or folder, or type an action
                like "settings", "review", "broadcast" or "restart".
              </span>
            </div>
          )}
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
                  {it.vendor && <VendorGlyph id={it.vendor} size={15} />}
                  {it.state && <span className={"pdot " + it.state} title={it.state} />}
                  <span className="cmdp-label">{it.label}</span>
                  {it.hint && <span className="cmdp-hint">{it.hint}</span>}
                  {/* UX-530: the bound combo, distinct from a hint path/context string. */}
                  {it.shortcut && (
                    <span className="cmdp-shortcut">
                      {it.shortcut.split("+").map((k) => <kbd key={k}>{k}</kbd>)}
                    </span>
                  )}
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
