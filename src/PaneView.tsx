import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp, type PaneModel, type PaneState } from "./store";
import { useUI } from "./ui";
import { Terminal, type TerminalHandle } from "./Terminal";
import {
  IconBranch, IconClose, IconRefresh, IconDrag, IconOverflow,
  IconMaximizePane, IconMinimize, IconFolder, IconChevron, IconDiff,
} from "./Icons";
import type { DiffSummary } from "./worktrees";
import "./panes.css";

import { vendorShort } from "./vendors";
import { closePaneWithCleanup } from "./worktrees";
const MIN_FONT = 9;
const MAX_FONT = 22;
const DEFAULT_FONT = 13;
const MIN_QUIET_SEC = 1;
const MAX_QUIET_SEC = 30;
const DEFAULT_QUIET_SEC = 3;
const GIT_POLL_MS = 30000;

interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
}

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s || p;
}

// Local — not in Icons.tsx, matches its grid (20x20, strokeWidth 1.6, round caps).
function IconSearch({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8.4" cy="8.4" r="5" />
      <path d="M12.4 12.4 L17 17" />
    </svg>
  );
}

export function PaneView({
  wsId,
  pane,
  maximized,
  onToggleMaximize,
  canReorder,
  dragging,
  dragOver,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDropHere,
}: {
  wsId: number;
  pane: PaneModel;
  maximized: boolean;
  onToggleMaximize: () => void;
  canReorder: boolean;
  dragging: boolean;
  dragOver: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDropHere: () => void;
}) {
  const focused = useApp((s) => s.workspaces.find((w) => w.id === wsId)?.focused === pane.id);
  const focusPane = useApp((s) => s.focusPane);
  const setPaneState = useApp((s) => s.setPaneState);
  const restartPane = useApp((s) => s.restartPane);
  const renamePane = useApp((s) => s.renamePane);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);
  const dead = pane.state === "idle" || pane.state === "error";

  // Closing a pane kills its PTY. If the agent is still live, confirm first —
  // a misclick otherwise ends a running session with no way back (matches the
  // same guard the workspace-close path uses). Isolated panes get their
  // worktree cleaned up too (dirty ones prompt keep/discard afterwards).
  const isolated = !!pane.worktreePath;
  const tryClosePane = () => {
    setMenuOpen(false);
    if (dead) { closePaneWithCleanup(wsId, pane); return; }
    requestConfirm({
      title: `Close ${displayName}?`,
      body:
        "This pane is still live. Closing it ends the session — the running agent can't be brought back." +
        (isolated ? " Its worktree will be cleaned up (you'll be asked about unmerged work)." : ""),
      confirmLabel: "Close & end session",
      danger: true,
      onConfirm: () => closePaneWithCleanup(wsId, pane),
    });
  };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.title ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT);
  const [ligatures, setLigatures] = useState(false);
  const [quietSec, setQuietSec] = useState(DEFAULT_QUIET_SEC);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number } | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  // Diff-stat badge for isolated panes: "what did this agent change" at a
  // glance, polled on the same cadence as the branch pill. Click → review drawer.
  const [diffStat, setDiffStat] = useState<{ files: number; added: number; deleted: number } | null>(null);
  const setReviewPane = useUI((s) => s.setReviewPane);
  // Live foreground process name (backend pty://proc via Terminal's onProc).
  const [procName, setProcName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<TerminalHandle>(null);

  useEffect(() => {
    if (!searchOpen) { setMatchInfo(null); return; }
    findRef.current?.focus();
    findRef.current?.select();
    const unsub = terminalRef.current?.onSearchResults((e) => setMatchInfo({ index: e.resultIndex, count: e.resultCount }));
    return () => unsub?.();
  }, [searchOpen]);

  const runFind = (query: string, dir: "next" | "prev") => {
    if (!query) { terminalRef.current?.clearSearch(); setMatchInfo(null); return; }
    if (dir === "next") terminalRef.current?.findNext(query, { incremental: true });
    else terminalRef.current?.findPrevious(query);
  };

  const closeSearch = () => {
    terminalRef.current?.clearSearch();
    setSearchOpen(false);
    setQuery("");
    setMatchInfo(null);
  };

  // The menu is portalled to <body> — `.pane` clips overflow (and so does the
  // resizable-panel wrapper), so an absolutely-positioned child would be cut off.
  const openMenu = () => {
    const r = menuBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.right - 220) });
    setMenuOpen(true);
  };
  const closeMenu = () => setMenuOpen(false);

  useEffect(() => {
    if (!editing) return;
    setDraft(pane.title ?? "");
    nameRef.current?.focus();
    nameRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commitRename = () => {
    renamePane(pane.id, draft);
    setEditing(false);
  };

  const copyCwd = async () => {
    try {
      await navigator.clipboard.writeText(pane.cwd);
      pushToast("success", "Copied working directory.");
    } catch {
      pushToast("error", "Couldn't copy — clipboard unavailable.");
    }
    setMenuOpen(false);
  };

  const reveal = async () => {
    try {
      await revealItemInDir(pane.cwd);
    } catch {
      pushToast("error", "Couldn't open Explorer for this folder.");
    }
    setMenuOpen(false);
  };

  const displayName = pane.title || vendorShort(pane.vendor);

  // Real git branch for this pane's cwd. Cheap to poll — re-check on mount,
  // on pane restart (epoch bump), and every 30s. Degrades silently: any
  // invoke failure (git missing, cwd gone) just hides the pill.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await invoke<GitStatus>("git_status", { cwd: pane.cwd });
        if (!cancelled) setGitStatus(status);
      } catch {
        if (!cancelled) setGitStatus(null);
      }
    };
    poll();
    const id = setInterval(poll, GIT_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [pane.cwd, pane.epoch]);

  // Diff-stat badge (isolated panes only — plain panes would just mirror the
  // user's own uncommitted work, which isn't this pane's doing).
  useEffect(() => {
    if (!pane.worktreePath) { setDiffStat(null); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<DiffSummary>("git_diff_summary", { cwd: pane.cwd, base: pane.baseBranch ?? null });
        if (!cancelled) setDiffStat({ files: s.files.length, added: s.totalAdded, deleted: s.totalDeleted });
      } catch {
        if (!cancelled) setDiffStat(null);
      }
    };
    poll();
    const id = setInterval(poll, GIT_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [pane.cwd, pane.epoch, pane.worktreePath, pane.baseBranch]);

  return (
    <div
      className={
        "pane" +
        (focused ? " focused" : "") +
        (maximized ? " pmax" : "") +
        (dragging ? " dragging" : "") +
        (dragOver ? " drop-target" : "")
      }
      onMouseDown={() => focusPane(wsId, pane.id)}
      onDragOver={(e) => { if (canReorder) { e.preventDefault(); onDragEnter(); } }}
      onDrop={(e) => { if (canReorder) { e.preventDefault(); onDropHere(); } }}
    >
      <div className={"pband " + pane.state} />
      <div className="phead">
        {canReorder && (
          <span
            className="pgrip"
            draggable
            title="Drag to reorder"
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
            onDragEnd={onDragEnd}
          >
            <IconDrag size={12} />
          </span>
        )}
        <span className={"pdot " + pane.state} />
        {editing ? (
          <input
            ref={nameRef}
            className="prename"
            value={draft}
            placeholder={vendorShort(pane.vendor)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setEditing(false);
              e.stopPropagation();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="pname" title="Double-click to rename" onDoubleClick={() => setEditing(true)}>
            {displayName}
          </span>
        )}
        <span className="prepo">&middot; {baseName(pane.cwd)}</span>
        {procName && <span className="pproc" title="Running process">{procName}</span>}
        {gitStatus?.isRepo && (
          <span className="branch" title={gitStatus.dirty ? "Uncommitted changes" : undefined}>
            <IconBranch size={11} /> {gitStatus.branch}
            {gitStatus.dirty && (
              <span
                aria-hidden
                style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--st-waiting)", marginLeft: 2 }}
              />
            )}
          </span>
        )}
        {diffStat && diffStat.files > 0 && (
          <button
            className="pdiff"
            onClick={() => setReviewPane(pane.id)}
            title={`${diffStat.files} file${diffStat.files === 1 ? "" : "s"} changed — review & merge`}
          >
            <IconDiff size={11} />
            <em className="add">+{diffStat.added}</em>
            <em className="del">−{diffStat.deleted}</em>
          </button>
        )}
        <span className="sp" />
        {dead && (
          <button className="prestart" onClick={() => restartPane(pane.id)} title="Restart this pane">
            <IconRefresh size={12} /> Restart
          </button>
        )}
        <button
          className={"pfindbtn" + (searchOpen ? " active" : "")}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          title="Find in scrollback"
        >
          <IconSearch size={13} />
        </button>
        <button className="pmaxbtn" onClick={onToggleMaximize} title={maximized ? "Restore" : "Maximise this pane"}>
          {maximized ? <IconMinimize size={13} /> : <IconMaximizePane size={13} />}
        </button>
        <div className="pmenu-wrap">
          <button ref={menuBtnRef} className="pmenubtn" onClick={() => (menuOpen ? closeMenu() : openMenu())} title="More actions">
            <IconOverflow size={14} />
          </button>
          {menuOpen && menuPos && createPortal(
            <div className="pmenu" style={{ top: menuPos.top, left: menuPos.left }} onMouseLeave={closeMenu}>
              <button className="pmenu-item" onClick={() => { restartPane(pane.id); closeMenu(); }}>
                <IconRefresh size={13} /> Restart
              </button>
              <button className="pmenu-item" onClick={() => { onToggleMaximize(); closeMenu(); }}>
                {maximized ? <IconMinimize size={13} /> : <IconMaximizePane size={13} />}
                {maximized ? "Restore" : "Maximise"}
              </button>
              {gitStatus?.isRepo && (
                <button className="pmenu-item" onClick={() => { setReviewPane(pane.id); closeMenu(); }}>
                  <IconDiff size={13} /> Review changes
                </button>
              )}
              <button className="pmenu-item" onClick={copyCwd}>
                <IconFolder size={13} /> Copy working directory
              </button>
              <button className="pmenu-item" onClick={reveal}>
                <IconFolder size={13} /> Reveal in Explorer
              </button>
              <div className="pmenu-zoom">
                <span className="pmenu-zoom-label">Font size</span>
                <div className="pmenu-zoom-controls">
                  <button onClick={() => setFontSize((f) => Math.max(MIN_FONT, f - 1))} title="Zoom out">&minus;</button>
                  <span>{fontSize}px</span>
                  <button onClick={() => setFontSize((f) => Math.min(MAX_FONT, f + 1))} title="Zoom in">+</button>
                  <button className="pmenu-zoom-reset" onClick={() => setFontSize(DEFAULT_FONT)} title="Reset to default">Reset</button>
                </div>
              </div>
              <div className="pmenu-row">
                <span>Ligatures</span>
                <button
                  className={"toggle" + (ligatures ? " on" : "")}
                  role="switch"
                  aria-checked={ligatures}
                  onClick={() => setLigatures((v) => !v)}
                  title="Toggle code ligatures for this pane"
                >
                  <span />
                </button>
              </div>
              <div className="pmenu-zoom">
                <span className="pmenu-zoom-label">Quiet threshold (waiting)</span>
                <div className="pmenu-zoom-controls">
                  <button onClick={() => setQuietSec((s) => Math.max(MIN_QUIET_SEC, s - 1))} title="Shorter">&minus;</button>
                  <span>{quietSec}s</span>
                  <button onClick={() => setQuietSec((s) => Math.min(MAX_QUIET_SEC, s + 1))} title="Longer">+</button>
                  <button className="pmenu-zoom-reset" onClick={() => setQuietSec(DEFAULT_QUIET_SEC)} title="Reset to default">Reset</button>
                </div>
              </div>
              <div className="pmenu-sep" />
              <button className="pmenu-item pmenu-danger" onClick={tryClosePane}>
                <IconClose size={13} /> Close pane
              </button>
            </div>,
            document.body
          )}
        </div>
        <button className="x" onClick={tryClosePane} title="Close pane"><IconClose size={12} /></button>
      </div>
      <div className="pbody">
        {pane.state === "starting" && (
          <div className="plaunching" aria-live="polite">
            Launching {vendorShort(pane.vendor)}… <span className="plaunching-sub">first output can take a few seconds</span>
          </div>
        )}
        {searchOpen && (
          <div className="pfind">
            <IconSearch size={12} />
            <input
              ref={findRef}
              value={query}
              placeholder="Find in this pane…"
              onChange={(e) => { const v = e.target.value; setQuery(v); runFind(v, "next"); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); runFind(query, e.shiftKey ? "prev" : "next"); }
                else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
                e.stopPropagation();
              }}
              onMouseDown={(e) => e.stopPropagation()}
            />
            <span className="pfind-count">
              {matchInfo ? (matchInfo.count === 0 ? "0/0" : `${matchInfo.index + 1}/${matchInfo.count}`) : ""}
            </span>
            <button onClick={() => runFind(query, "prev")} title="Previous match (Shift+Enter)">
              <IconChevron size={12} style={{ transform: "rotate(-90deg)" }} />
            </button>
            <button onClick={() => runFind(query, "next")} title="Next match (Enter)">
              <IconChevron size={12} style={{ transform: "rotate(90deg)" }} />
            </button>
            <button onClick={closeSearch} title="Close find (Esc)"><IconClose size={12} /></button>
          </div>
        )}
        <Terminal
          key={pane.epoch}
          ref={terminalRef}
          vendor={pane.vendor}
          cwd={pane.cwd}
          fontSize={fontSize}
          ligatures={ligatures}
          quietThresholdMs={quietSec * 1000}
          onExit={(crashed) => setPaneState(pane.id, crashed ? "error" : "idle")}
          onState={(st) => setPaneState(pane.id, st as PaneState)}
          onProc={setProcName}
        />
      </div>
    </div>
  );
}
