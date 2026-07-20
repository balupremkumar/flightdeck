import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, DragEvent as ReactDragEvent, SVGProps } from "react";
import { useApp, type PaneModel, type Workspace } from "./store";
import { useUI } from "./ui";
import { defaultCycle } from "./vendors";
import { closeWorkspaceWithCleanup, preparePanes, isolationPref, rememberedOrSuggestedSetup } from "./worktrees";
import { IconPlus, IconClose, IconBoard, IconDrag, IconBranch } from "./Icons";
import { relTime as fmtRel, timeTitle, compact, num } from "./format";
import { cachedInvoke, usePoll } from "./poll";
import { PANE_DRAG_TYPE } from "./PaneView";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import "./leftpanel.css";

function initial(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

// UI-22: "starting" counts separately — a workspace reading "3 running" when
// all three are still launching is a lie the roll-up used to tell.
function rollup(panes: PaneModel[]) {
  return {
    total: panes.length,
    starting: panes.filter((p) => p.state === "starting").length,
    running: panes.filter((p) => p.state === "running").length,
    waiting: panes.filter((p) => p.state === "waiting" || p.state === "permission").length,
    error: panes.filter((p) => p.state === "error").length,
  };
}

type View = "terminals" | "board";
type MenuState = { wsId: number; x: number; y: number } | null;

const LAST_ACTIVE_KEY = "flightdeck-ws-lastactive";
function loadLastActive(): Record<number, number> {
  try { return JSON.parse(localStorage.getItem(LAST_ACTIVE_KEY) || "{}"); } catch { return {}; }
}
function saveLastActive(m: Record<number, number>) {
  try { localStorage.setItem(LAST_ACTIVE_KEY, JSON.stringify(m)); } catch { /* non-persistent */ }
}
function relTime(ts: number | undefined, now: number): string | null {
  return ts ? fmtRel(ts, now) : null;
}

// UI-153: a stable per-repo colour so the same workspace reads as the same
// tile across restarts, no palette to maintain. A cheap string hash into hue,
// fixed saturation/lightness so every tile stays legible against the ring
// treatment below.
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
// Hex, not an hsl() string — `<input type="color">` (used for the override
// picker) only accepts #rrggbb, and the same value has to work as both the
// picker's default and the ring colour.
function hueToHex(hue: number, sat: number, light: number): string {
  const a = (sat / 100) * Math.min(light / 100, 1 - light / 100);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const c = light / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function autoTint(root: string): string {
  return hueToHex(hashHue(root), 60, 46);
}

const TINT_KEY = "flightdeck-ws-tint";
function loadTints(): Record<number, string> {
  try { return JSON.parse(localStorage.getItem(TINT_KEY) || "{}"); } catch { return {}; }
}
function saveTints(m: Record<number, string>) {
  try { localStorage.setItem(TINT_KEY, JSON.stringify(m)); } catch { /* non-persistent */ }
}

// UI-155: sort-by-last-active is a view preference, not working state itself —
// remembered so it doesn't reset to manual order every launch.
const SORT_KEY = "flightdeck-ws-sort";

const SortIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg width={13} height={13} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M10 4v12M10 4 6 8M10 4l4 4" />
    <path d="M4 15h5M4 11h3" />
  </svg>
);

// Default pane mix for a workspace spun up by dropping a folder. Comes from the
// vendor registry (installed agents), not a hardcoded list.

export function LeftPanel({ expanded, view, setView }: { expanded: boolean; view: View; setView: (v: View) => void }) {
  const workspaces = useApp((s) => s.workspaces);
  const activeId = useApp((s) => s.activeId);
  const switchWorkspace = useApp((s) => s.switchWorkspace);
  const startCreate = useApp((s) => s.startCreate);
  const createWorkspace = useApp((s) => s.createWorkspace);
  const renameWorkspace = useApp((s) => s.renameWorkspace);
  const reorderWorkspaces = useApp((s) => s.reorderWorkspaces);
  const requestConfirm = useUI((s) => s.requestConfirm);
  const pushToast = useUI((s) => s.pushToast);
  const movePaneToWorkspace = useApp((s) => s.movePaneToWorkspace);
  // UI-232: token spend is per-pane today, so "how heavy is this workspace"
  // needed adding up by eye. Shares PaneView's cache — no extra backend calls.
  const [tokens, setTokens] = useState<Record<number, number>>({});
  usePoll(async () => {
    const next: Record<number, number> = {};
    for (const w of useApp.getState().workspaces) {
      let total = 0;
      for (const p of w.panes) {
        try {
          const u = await cachedInvoke<{ contextTokens: number } | null>("pane_usage", { cwd: p.cwd }, 7000);
          if (u) total += u.contextTokens;
        } catch { /* pane has no transcript — contributes nothing */ }
      }
      if (total > 0) next[w.id] = total;
    }
    setTokens(next);
  }, 20000, [], expanded);

  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [folderOver, setFolderOver] = useState(false);
  const [lastActive, setLastActive] = useState<Record<number, number>>(() => loadLastActive());
  const [tints, setTints] = useState<Record<number, string>>(() => loadTints());
  const [sortByLast, setSortByLast] = useState<boolean>(() => {
    try { return localStorage.getItem(SORT_KEY) === "1"; } catch { return false; }
  });
  const [, forceTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const toggleSort = () => {
    setSortByLast((v) => {
      const next = !v;
      try { localStorage.setItem(SORT_KEY, next ? "1" : "0"); } catch { /* non-persistent */ }
      return next;
    });
  };

  const tintFor = (w: Workspace) => tints[w.id] ?? autoTint(w.root);
  const setTint = (id: number, color: string) => {
    setTints((m) => { const next = { ...m, [id]: color }; saveTints(next); return next; });
  };
  const resetTint = (id: number) => {
    setTints((m) => { const next = { ...m }; delete next[id]; saveTints(next); return next; });
  };

  const touch = (id: number) => {
    setLastActive((m) => {
      const next = { ...m, [id]: Date.now() };
      saveLastActive(next);
      return next;
    });
  };

  const openWs = (id: number) => { switchWorkspace(id); setView("terminals"); touch(id); };

  // Relative "Xm ago" labels stay fresh without a live-ticking clock.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // Ctrl+1..9 — jump straight to that workspace. Guarded so it doesn't steal
  // keystrokes from a focused terminal (same pattern as Cockpit's Ctrl+B).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest?.(".pbody")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9) {
        const w = workspaces[n - 1];
        if (w) { e.preventDefault(); openWs(w.id); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces]);

  // Drop a folder anywhere onto the panel to spin up a new workspace rooted there.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // getCurrentWebview() throws outside a real Tauri window (reads
    // __TAURI_INTERNALS__) — guard so browser previews/QA rigs don't crash.
    let webview: ReturnType<typeof getCurrentWebview>;
    try { webview = getCurrentWebview(); } catch { return; }
    webview
      .onDragDropEvent((e) => {
        const el = panelRef.current;
        if (e.payload.type === "leave") { setFolderOver(false); return; }
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const x = e.payload.position.x / dpr;
        const y = e.payload.position.y / dpr;
        const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        if (e.payload.type === "enter" || e.payload.type === "over") { setFolderOver(inside); return; }
        // type === "drop"
        setFolderOver(false);
        if (!inside) return;
        const path = e.payload.paths[0];
        if (!path) return;
        invoke("fs_list_dir", { path })
          .then(async () => {
            const cycle = defaultCycle();
            const slots = Array.from({ length: 4 }, (_, i) => ({ vendor: cycle[i % cycle.length], cwd: path }));
            // Same worktree-aware path as New Workspace — a dropped repo gets
            // isolated panes per the remembered preference.
            const panes = await preparePanes(slots, isolationPref());
            createWorkspace(path, panes, await rememberedOrSuggestedSetup(path));
            setView("terminals");
            pushToast("success", `Created workspace from ${path}`);
          })
          .catch(() => pushToast("error", "That drop wasn't a folder — nothing created"));
      })
      .then((fn) => { if (!cancelled) unlisten = fn; else fn(); });
    return () => { cancelled = true; unlisten?.(); };
  }, [createWorkspace, setView, pushToast]);

  // Context menu: dismiss on outside click / Esc.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey, true); };
  }, [menu]);

  useEffect(() => {
    if (renameId != null) { renameInputRef.current?.focus(); renameInputRef.current?.select(); }
  }, [renameId]);

  const doClose = (w: { id: number; name: string; panes: PaneModel[] }) => {
    const live = w.panes.some((p) => p.state === "running" || p.state === "starting" || p.state === "waiting");
    if (live) {
      const n = w.panes.length;
      requestConfirm({
        title: `Close ${w.name}?`,
        body: `${n} pane${n === 1 ? "" : "s"} still live. Closing ends ${n === 1 ? "its session" : "their sessions"} — the running agents can't be brought back.`,
        confirmLabel: "Close & end sessions",
        danger: true,
        onConfirm: () => { closeWorkspaceWithCleanup(w); pushToast("info", `Closed ${w.name}`); },
      });
    } else {
      closeWorkspaceWithCleanup(w);
    }
  };

  const openMenu = (e: ReactMouseEvent, wsId: number) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ wsId, x: e.clientX, y: e.clientY });
  };

  const startRename = (w: { id: number; name: string }) => {
    setMenu(null);
    // The rail (collapsed) mode has no room for an inline text field — fall
    // back to a native prompt there so "Rename" is never a silent no-op.
    if (!expanded) {
      const next = window.prompt("Rename workspace", w.name);
      if (next != null) renameWorkspace(w.id, next);
      return;
    }
    setRenameId(w.id);
    setRenameValue(w.name);
  };
  const commitRename = () => {
    if (renameId != null) renameWorkspace(renameId, renameValue);
    setRenameId(null);
  };

  const duplicate = (w: Workspace) => {
    setMenu(null);
    // Isolated panes must NOT share the original's worktrees — re-prepare from
    // the workspace root so the duplicate gets fresh worktrees of its own.
    void preparePanes(
      w.panes.map((p) => ({ vendor: p.vendor, cwd: p.worktreePath ? w.root : p.cwd })),
      w.panes.some((p) => !!p.worktreePath)
    ).then((panes) => {
      createWorkspace(w.root, panes, w.setupCmd);
      pushToast("success", `Duplicated ${w.name}`);
    });
  };

  // UI-154: derive the browser URL from the repo's origin remote. Reuses the
  // same host parsing as the PR handoff, so an unrecognised remote says so
  // instead of opening something wrong.
  const openRepoOnHost = async (w: Workspace) => {
    setMenu(null);
    try {
      const url = await invoke<string | null>("git_repo_web_url", { cwd: w.root });
      if (!url) { pushToast("info", "No recognised origin remote for this workspace."); return; }
      await openUrl(url);
    } catch {
      pushToast("error", "Couldn't work out this repo's web address.");
    }
  };

  const reveal = async (w: Workspace) => {
    setMenu(null);
    try { await revealItemInDir(w.root); }
    catch { pushToast("error", `Couldn't reveal ${w.root}`); }
  };

  const onRowDragStart = (e: ReactDragEvent, id: number) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  };
  // UI-151: a tile accepts two different drags — another TILE (reorder) or a
  // PANE from the grid (move it here). Distinguished by the payload type, since
  // dragId is only set by tile drags.
  const isPaneDrag = (e: ReactDragEvent) => e.dataTransfer.types.includes(PANE_DRAG_TYPE);

  const onRowDragOver = (e: ReactDragEvent, id: number) => {
    if (isPaneDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverId(id);
      return;
    }
    if (dragId == null || dragId === id) return;
    e.preventDefault();
    setDragOverId(id);
  };
  const onRowDrop = (e: ReactDragEvent, id: number) => {
    e.preventDefault();
    if (isPaneDrag(e)) {
      try {
        const { wsId, paneId } = JSON.parse(e.dataTransfer.getData(PANE_DRAG_TYPE));
        if (wsId !== id) {
          movePaneToWorkspace(wsId, paneId, id);
          const target = workspaces.find((w) => w.id === id);
          pushToast("success", `Moved the pane to ${target?.name ?? "that workspace"}.`);
        }
      } catch { /* malformed payload — ignore rather than crash the drop */ }
      setDragId(null);
      setDragOverId(null);
      return;
    }
    if (dragId != null && dragId !== id) {
      const from = workspaces.findIndex((w) => w.id === dragId);
      const to = workspaces.findIndex((w) => w.id === id);
      if (from >= 0 && to >= 0) reorderWorkspaces(from, to);
    }
    setDragId(null);
    setDragOverId(null);
  };
  const onRowDragEnd = () => { setDragId(null); setDragOverId(null); };

  const filtered = search.trim()
    ? workspaces.filter((w) => w.name.toLowerCase().includes(search.trim().toLowerCase()))
    : workspaces;
  // UI-155: sorting is a display order, not a reorder of the underlying list —
  // drag-reorder still writes the manual order underneath, it's just not what
  // you see until sort is switched back off.
  const ordered = sortByLast
    ? [...filtered].sort((a, b) => (lastActive[b.id] ?? 0) - (lastActive[a.id] ?? 0))
    : filtered;
  const menuWs = menu ? workspaces.find((w) => w.id === menu.wsId) ?? null : null;
  const now = Date.now();

  const contextMenu = menu && menuWs && (
    <div className="lp-menu" style={{ left: menu.x, top: menu.y }}>
      <button onClick={() => { openWs(menuWs.id); setMenu(null); }}>Open</button>
      <button onClick={() => startRename(menuWs)}>Rename</button>
      <button onClick={() => duplicate(menuWs)}>Duplicate</button>
      <button onClick={() => reveal(menuWs)}>Reveal in Explorer</button>
      {/* UI-154: jump straight to the repo's host page when there's an origin. */}
      <button onClick={() => void openRepoOnHost(menuWs)}>Open repo on GitHub</button>
      <div className="lp-menu-sep" />
      {/* UI-153: per-repo auto colour, overridable; native input keeps this to
          one control instead of a bespoke swatch grid. */}
      <div className="lp-menu-color" onMouseDown={(e) => e.stopPropagation()}>
        <span>Tile colour</span>
        <input
          type="color"
          className="lp-menu-swatch"
          value={tints[menuWs.id] ?? autoTint(menuWs.root)}
          onChange={(e) => setTint(menuWs.id, e.target.value)}
          title="Choose a tile colour"
        />
        {tints[menuWs.id] && (
          <button className="lp-menu-color-reset" onClick={() => resetTint(menuWs.id)} title="Use the automatic colour">
            Reset
          </button>
        )}
      </div>
      <div className="lp-menu-sep" />
      <button className="danger" onClick={() => { setMenu(null); doClose(menuWs); }}>Close</button>
    </div>
  );
  const dropHint = folderOver && <div className="lp-drop-hint">Drop to create a workspace here</div>;

  if (!expanded) {
    return (
      <div className={"lpanel" + (folderOver ? " lp-drop-over" : "")} ref={panelRef}>
        <button className="lp-ic add" onClick={startCreate} title="New workspace" data-tip="New workspace"><IconPlus size={18} /></button>
        {workspaces.map((w) => {
          const r = rollup(w.panes);
          const active = w.id === activeId && view === "terminals";
          return (
            <button
              className={"lp-ic" + (active ? " active" : "")}
              key={w.id}
              onClick={() => openWs(w.id)}
              onContextMenu={(e) => openMenu(e, w.id)}
              title={w.name}
              data-tip={w.name}
              style={{ boxShadow: `inset 0 0 0 2px ${tintFor(w)}` }}
            >
              {initial(w.name)}
              <span className="lp-badge sm">{r.total}</span>
              {r.waiting > 0 && !active && <span className="lp-wait sm" />}
            </button>
          );
        })}
        <div className="lp-rail-sep" />
        <button className={"lp-ic board-ic" + (view === "board" ? " active" : "")} onClick={() => setView("board")} title="Board" data-tip="Board"><IconBoard size={19} /></button>
        {dropHint}
        {contextMenu}
      </div>
    );
  }

  return (
    <div className={"lpanel exp" + (folderOver ? " lp-drop-over" : "")} ref={panelRef}>
      <div className="lp-head">
        <span className="lp-title">Workspaces</span>
        <span className="lp-count">{workspaces.length}</span>
        {/* UI-155: drag-reorder still exists underneath — sort just changes
            what's displayed, so it's re-enabled the moment this is off again. */}
        <button
          className={"lp-sort" + (sortByLast ? " on" : "")}
          onClick={toggleSort}
          title={sortByLast ? "Sorted by last active — click for manual order" : "Sort by last active"}
        >
          <SortIcon />
        </button>
        <button className="lp-add" onClick={startCreate} title="New workspace"><IconPlus size={16} /></button>
      </div>
      {workspaces.length > 3 && (
        <div className="lp-search-wrap">
          <input
            className="lp-search"
            placeholder="Filter workspaces…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
      <div className={"lp-list" + (sortByLast ? " sorted" : "")}>
        {filtered.length === 0 && search.trim() && <div className="lp-empty">No workspaces match "{search.trim()}"</div>}
        {ordered.map((w) => {
          const r = rollup(w.panes);
          const active = w.id === activeId && view === "terminals";
          const isRenaming = renameId === w.id;
          const last = relTime(lastActive[w.id], now);
          return (
            <div
              className={
                "lp-ws" +
                (active ? " active" : "") +
                (dragId === w.id ? " dragging" : "") +
                (dragOverId === w.id && dragId !== w.id ? " drag-over" : "")
              }
              key={w.id}
              draggable={!isRenaming && !sortByLast}
              onDragStart={(e) => onRowDragStart(e, w.id)}
              onDragOver={(e) => onRowDragOver(e, w.id)}
              onDrop={(e) => onRowDrop(e, w.id)}
              onDragEnd={onRowDragEnd}
              onClick={() => openWs(w.id)}
              onContextMenu={(e) => openMenu(e, w.id)}
            >
              <span className="lp-drag-handle"><IconDrag size={12} /></span>
              <span className="lp-i" style={{ boxShadow: `inset 0 0 0 2px ${tintFor(w)}` }}>{initial(w.name)}</span>
              <span className="lp-body">
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    className="lp-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenameId(null);
                    }}
                  />
                ) : (
                  <span className="lp-name" onDoubleClick={(e) => { e.stopPropagation(); startRename(w); }}>{w.name}</span>
                )}
                <span className="lp-meta">
                  {/* UI-149: the tile shows this workspace's actual pane layout
                      and per-pane state — a glanceable mirror of the grid. */}
                  {r.total > 0 && (
                    <span
                      className="lp-mini"
                      style={{ gridTemplateColumns: `repeat(${Math.min(3, Math.ceil(Math.sqrt(w.panes.length)))}, 1fr)` }}
                      title={`${w.panes.length} pane${w.panes.length === 1 ? "" : "s"}`}
                      aria-hidden
                    >
                      {w.panes.slice(0, 9).map((p) => (<i key={p.id} className={"lp-mini-c " + p.state} />))}
                    </span>
                  )}
                  {/* UI-150: isolated panes mean worktrees on disk — say how many. */}
                  {w.panes.some((p) => p.worktreePath) && (
                    <span className="lp-stat lp-wt" title={`${w.panes.filter((p) => p.worktreePath).length} isolated worktree(s)`}>
                      <IconBranch size={9} />{w.panes.filter((p) => p.worktreePath).length}
                    </span>
                  )}
                  {r.starting > 0 && <span className="lp-stat start" title="Still launching"><i />{r.starting}</span>}
                  {r.running > 0 && <span className="lp-stat run"><i />{r.running}</span>}
                  {r.waiting > 0 && <span className="lp-stat wait"><i />{r.waiting}</span>}
                  {r.error > 0 && <span className="lp-stat err"><i />{r.error}</span>}
                  {r.total === 0 && <span className="lp-stat empty">empty</span>}
                  {tokens[w.id] > 0 && (
                    <span className="lp-stat lp-tok" title={`${num(tokens[w.id])} tokens of context across this workspace's agents`}>
                      {compact(tokens[w.id])}
                    </span>
                  )}
                  {last && (
                    <span className="lp-stat lp-last" title={lastActive[w.id] ? timeTitle(lastActive[w.id]) : undefined}>
                      {last}
                    </span>
                  )}
                </span>
              </span>
              {r.waiting > 0 && <span className="lp-wait" title="Waiting on you" />}
              <button className="lp-x" onClick={(e) => { e.stopPropagation(); doClose(w); }} title="Close workspace"><IconClose size={12} /></button>
            </div>
          );
        })}
      </div>
      <div className="lp-sep" />
      <div className={"lp-app" + (view === "board" ? " active" : "")} onClick={() => setView("board")}>
        {/* NOT class "board" — Board.css declares a global .board for the board screen */}
        <span className="lp-i lp-board-i"><IconBoard size={16} /></span>
        <span className="lp-name">Board</span>
      </div>
      {dropHint}
      {contextMenu}
    </div>
  );
}
