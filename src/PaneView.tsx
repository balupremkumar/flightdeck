import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp, type PaneModel, type PaneState } from "./store";
import { useUI } from "./ui";
import { Terminal } from "./Terminal";
import {
  IconBranch, IconClose, IconRefresh, IconDrag, IconOverflow,
  IconMaximizePane, IconMinimize, IconFolder,
} from "./Icons";
import "./panes.css";

const LABEL: Record<string, string> = { claude: "claude-code", agy: "antigravity", kimi: "kimi", pwsh: "pwsh" };
const MIN_FONT = 9;
const MAX_FONT = 22;
const DEFAULT_FONT = 13;

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s || p;
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
  const closePane = useApp((s) => s.closePane);
  const setPaneState = useApp((s) => s.setPaneState);
  const restartPane = useApp((s) => s.restartPane);
  const renamePane = useApp((s) => s.renamePane);
  const pushToast = useUI((s) => s.pushToast);
  const dead = pane.state === "idle" || pane.state === "error";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.title ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT);
  const nameRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

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

  const displayName = pane.title || LABEL[pane.vendor] || pane.vendor;

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
            placeholder={LABEL[pane.vendor] ?? pane.vendor}
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
        <span className="branch"><IconBranch size={11} /> main</span>
        <span className="sp" />
        {dead && (
          <button className="prestart" onClick={() => restartPane(pane.id)} title="Restart this pane">
            <IconRefresh size={12} /> Restart
          </button>
        )}
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
              <div className="pmenu-sep" />
              <button className="pmenu-item pmenu-danger" onClick={() => { closePane(wsId, pane.id); closeMenu(); }}>
                <IconClose size={13} /> Close pane
              </button>
            </div>,
            document.body
          )}
        </div>
        <button className="x" onClick={() => closePane(wsId, pane.id)} title="Close pane"><IconClose size={12} /></button>
      </div>
      <div className="pbody">
        <Terminal
          key={pane.epoch}
          vendor={pane.vendor}
          cwd={pane.cwd}
          fontSize={fontSize}
          onExit={(crashed) => setPaneState(pane.id, crashed ? "error" : "idle")}
          onState={(st) => setPaneState(pane.id, st as PaneState)}
        />
      </div>
    </div>
  );
}
