import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, DragEvent as ReactDragEvent } from "react";
import { useApp, type PaneModel, type Workspace } from "./store";
import { useUI } from "./ui";
import { defaultCycle } from "./vendors";
import { closeWorkspaceWithCleanup, preparePanes, isolationPref } from "./worktrees";
import { IconPlus, IconClose, IconBoard, IconDrag } from "./Icons";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
    waiting: panes.filter((p) => p.state === "waiting").length,
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
  if (!ts) return null;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

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

  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [folderOver, setFolderOver] = useState(false);
  const [lastActive, setLastActive] = useState<Record<number, number>>(() => loadLastActive());
  const [, forceTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
            createWorkspace(path, panes);
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
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey); };
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
      createWorkspace(w.root, panes);
      pushToast("success", `Duplicated ${w.name}`);
    });
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
  const onRowDragOver = (e: ReactDragEvent, id: number) => {
    if (dragId == null || dragId === id) return;
    e.preventDefault();
    setDragOverId(id);
  };
  const onRowDrop = (e: ReactDragEvent, id: number) => {
    e.preventDefault();
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
  const menuWs = menu ? workspaces.find((w) => w.id === menu.wsId) ?? null : null;
  const now = Date.now();

  const contextMenu = menu && menuWs && (
    <div className="lp-menu" style={{ left: menu.x, top: menu.y }}>
      <button onClick={() => { openWs(menuWs.id); setMenu(null); }}>Open</button>
      <button onClick={() => startRename(menuWs)}>Rename</button>
      <button onClick={() => duplicate(menuWs)}>Duplicate</button>
      <button onClick={() => reveal(menuWs)}>Reveal in Explorer</button>
      <div className="lp-menu-sep" />
      <button className="danger" onClick={() => { setMenu(null); doClose(menuWs); }}>Close</button>
    </div>
  );
  const dropHint = folderOver && <div className="lp-drop-hint">Drop to create a workspace here</div>;

  if (!expanded) {
    return (
      <div className={"lpanel" + (folderOver ? " lp-drop-over" : "")} ref={panelRef}>
        <button className="lp-ic add" onClick={startCreate} title="New workspace"><IconPlus size={18} /></button>
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
            >
              {initial(w.name)}
              <span className="lp-badge sm">{r.total}</span>
              {r.waiting > 0 && !active && <span className="lp-wait sm" />}
            </button>
          );
        })}
        <div className="lp-rail-sep" />
        <button className={"lp-ic board-ic" + (view === "board" ? " active" : "")} onClick={() => setView("board")} title="Board"><IconBoard size={19} /></button>
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
      <div className="lp-list">
        {filtered.length === 0 && search.trim() && <div className="lp-empty">No workspaces match "{search.trim()}"</div>}
        {filtered.map((w) => {
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
              draggable={!isRenaming}
              onDragStart={(e) => onRowDragStart(e, w.id)}
              onDragOver={(e) => onRowDragOver(e, w.id)}
              onDrop={(e) => onRowDrop(e, w.id)}
              onDragEnd={onRowDragEnd}
              onClick={() => openWs(w.id)}
              onContextMenu={(e) => openMenu(e, w.id)}
            >
              <span className="lp-drag-handle"><IconDrag size={12} /></span>
              <span className="lp-i">{initial(w.name)}</span>
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
                  {r.starting > 0 && <span className="lp-stat start" title="Still launching"><i />{r.starting}</span>}
                  {r.running > 0 && <span className="lp-stat run"><i />{r.running}</span>}
                  {r.waiting > 0 && <span className="lp-stat wait"><i />{r.waiting}</span>}
                  {r.error > 0 && <span className="lp-stat err"><i />{r.error}</span>}
                  {r.total === 0 && <span className="lp-stat empty">empty</span>}
                  {last && <span className="lp-stat lp-last">{last}</span>}
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
