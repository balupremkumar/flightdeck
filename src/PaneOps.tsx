// PaneOps.tsx — UX-553 (shift+click multi-select -> bulk restart/close/
// broadcast), UX-554 (named pane groups) and UX-562 (named session snapshots
// + restore). Three small self-contained overlays, all portalled to
// <body> and triggered from PaneView.tsx (the only place that currently
// mounts anything outside the pane-menu portal already established there).
//
// Cross-pane sends go through store.ts's paneSendRegistry (sendToPane) —
// NOT a raw `pty_write` invoke — because the numeric id the Rust PTY
// registry assigns at spawn is a different id space from PaneModel.id; only
// a pane's own Terminal instance (via TerminalHandle.paste, which each
// PaneView registers here on mount) can correctly address its own PTY.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useApp, sendToPane, type PaneGroup, type PaneModel } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { closePaneWithCleanup } from "./worktrees";
import { vendorShort } from "./vendors";
import { IconClose, IconRefresh, IconBroadcast } from "./Icons";
import {
  listSnapshots, saveSnapshot, deleteSnapshot, renameSnapshot, defPanesToNewPanes,
  type SessionSnapshot,
} from "./snapshots";
import { relTime } from "./format";
import "./panes.css";

// ---------------------------------------------------------------------------
// UX-553: bulk toolbar for the current cross-workspace selection.
// ---------------------------------------------------------------------------

export function SelectionToolbar() {
  const selectedIds = useApp((s) => s.selectedPaneIds);
  const workspaces = useApp((s) => s.workspaces);
  const clearSelection = useApp((s) => s.clearSelection);
  const restartPane = useApp((s) => s.restartPane);
  const createGroup = useApp((s) => s.createGroup);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);
  const [broadcastText, setBroadcastText] = useState("");

  // Resolve each selected id to its live (wsId, pane) — a selection can
  // outlive its pane (closePane already prunes it, but stay defensive).
  const found = selectedIds
    .map((id) => {
      for (const w of workspaces) {
        const p = w.panes.find((pp) => pp.id === id);
        if (p) return { wsId: w.id, pane: p };
      }
      return null;
    })
    .filter((x): x is { wsId: number; pane: PaneModel } => !!x);

  if (found.length === 0) return null;

  const liveCount = found.filter(({ pane }) => pane.state !== "idle" && pane.state !== "error").length;

  const restartAll = () => {
    for (const { pane } of found) restartPane(pane.id);
    pushToast("info", `Restarting ${found.length} pane${found.length === 1 ? "" : "s"}.`);
  };

  const closeAll = () => {
    for (const { wsId, pane } of found) closePaneWithCleanup(wsId, pane);
    pushToast("success", `Closed ${found.length} pane${found.length === 1 ? "" : "s"}.`);
    clearSelection();
  };

  const requestCloseAll = () => {
    if (liveCount === 0) { closeAll(); return; }
    requestConfirm({
      title: `Close ${found.length} selected pane${found.length === 1 ? "" : "s"}?`,
      body: `${liveCount} of them ${liveCount === 1 ? "is" : "are"} still live — closing ends those sessions and they can't be brought back.`,
      confirmLabel: "Close & end sessions",
      danger: true,
      onConfirm: closeAll,
    });
  };

  const broadcast = () => {
    const text = broadcastText.trim();
    if (!text) return;
    let reached = 0;
    for (const { pane } of found) if (sendToPane(pane.id, text + "\r")) reached++;
    pushToast(
      reached === found.length ? "success" : "info",
      `Sent to ${reached} of ${found.length} selected pane${found.length === 1 ? "" : "s"}.`
    );
    setBroadcastText("");
  };

  const saveAsGroup = () => {
    const name = window.prompt(`Name this group of ${found.length} pane${found.length === 1 ? "" : "s"}:`, "");
    if (name == null) return;
    createGroup(name, found.map(({ pane }) => pane.id));
    pushToast("success", `Saved group "${name.trim() || "(untitled)"}".`);
  };

  return createPortal(
    <div className="selbar" role="region" aria-label="Selected panes">
      <span className="selbar-count">{found.length} selected</span>
      <button className="selbar-btn" onClick={restartAll} title="Restart every selected pane">
        <IconRefresh size={13} /> Restart
      </button>
      <button className="selbar-btn selbar-danger" onClick={requestCloseAll} title="Close every selected pane">
        <IconClose size={13} /> Close
      </button>
      <div className="selbar-broadcast">
        <IconBroadcast size={13} />
        <input
          value={broadcastText}
          placeholder="Message the selection…"
          onChange={(e) => setBroadcastText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") broadcast(); }}
        />
        <button className="selbar-btn" disabled={!broadcastText.trim()} onClick={broadcast}>Send</button>
      </div>
      <button className="selbar-btn" onClick={saveAsGroup} title="Save this selection as a named group">
        Save as group…
      </button>
      <button className="selbar-x" onClick={clearSelection} title="Clear selection" aria-label="Clear selection">
        <IconClose size={12} />
      </button>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// UX-554: manage named groups + act on one (select/restart/close/broadcast).
// ---------------------------------------------------------------------------

export function GroupsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  useOverlayEsc(open, onClose);
  const groups = useApp((s) => s.groups);
  const workspaces = useApp((s) => s.workspaces);
  const setSelection = useApp((s) => s.setSelection);
  const deleteGroup = useApp((s) => s.deleteGroup);
  const renameGroup = useApp((s) => s.renameGroup);
  const restartPane = useApp((s) => s.restartPane);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);

  if (!open) return null;

  const liveIn = (g: PaneGroup) =>
    g.paneIds
      .map((id) => {
        for (const w of workspaces) {
          const p = w.panes.find((pp) => pp.id === id);
          if (p) return { wsId: w.id, pane: p };
        }
        return null;
      })
      .filter((x): x is { wsId: number; pane: PaneModel } => !!x);

  const restartGroup = (g: PaneGroup) => {
    const found = liveIn(g);
    for (const { pane } of found) restartPane(pane.id);
    pushToast("info", `Restarting "${g.name}" (${found.length} pane${found.length === 1 ? "" : "s"}).`);
  };

  const closeGroup = (g: PaneGroup) => {
    const found = liveIn(g);
    if (found.length === 0) { pushToast("info", "None of that group's panes are open anymore."); return; }
    requestConfirm({
      title: `Close "${g.name}" (${found.length} pane${found.length === 1 ? "" : "s"})?`,
      body: "Closing ends any still-live sessions in this group — they can't be brought back.",
      confirmLabel: "Close & end sessions",
      danger: true,
      onConfirm: () => {
        for (const { wsId, pane } of found) closePaneWithCleanup(wsId, pane);
        pushToast("success", `Closed "${g.name}".`);
      },
    });
  };

  return createPortal(
    <div className="ops-backdrop" onMouseDown={onClose}>
      <div className="ops-panel" role="dialog" aria-modal="true" aria-label="Pane groups" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ops-head">
          <span className="ops-title">Pane groups</span>
          <button className="ops-x" onClick={onClose} title="Close (Esc)" aria-label="Close"><IconClose size={14} /></button>
        </div>
        {groups.length === 0 ? (
          <div className="ops-empty">
            No groups yet — shift+click a few panes, then "Save as group…" from the selection toolbar.
          </div>
        ) : (
          <div className="ops-list">
            {groups.map((g) => {
              const found = liveIn(g);
              return (
                <div className="ops-row" key={g.id}>
                  <div className="ops-row-main">
                    <span className="ops-row-name">{g.name}</span>
                    <span className="ops-row-sub">
                      {found.length} of {g.paneIds.length} pane{g.paneIds.length === 1 ? "" : "s"} still open
                      {found.length > 0 && ` — ${found.map(({ pane }) => vendorShort(pane.vendor)).join(", ")}`}
                    </span>
                  </div>
                  <div className="ops-row-actions">
                    <button
                      title="Select these panes (opens the bulk toolbar)"
                      disabled={found.length === 0}
                      onClick={() => { setSelection(found.map(({ pane }) => pane.id)); onClose(); }}
                    >
                      Select
                    </button>
                    <button title="Restart every pane in this group" disabled={found.length === 0} onClick={() => restartGroup(g)}>
                      <IconRefresh size={12} />
                    </button>
                    <button title="Close every pane in this group" disabled={found.length === 0} onClick={() => closeGroup(g)}>
                      <IconClose size={12} />
                    </button>
                    <button
                      title="Rename this group"
                      onClick={() => {
                        const name = window.prompt("Rename group:", g.name);
                        if (name != null) renameGroup(g.id, name);
                      }}
                    >
                      Rename
                    </button>
                    <button title="Delete this group (panes are untouched)" onClick={() => deleteGroup(g.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// UX-562: named session snapshots + restore-to-snapshot.
// ---------------------------------------------------------------------------

export function SessionSnapshots({ open, onClose }: { open: boolean; onClose: () => void }) {
  useOverlayEsc(open, onClose);
  const workspaces = useApp((s) => s.workspaces);
  const activeId = useApp((s) => s.activeId);
  const createWorkspace = useApp((s) => s.createWorkspace);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);
  const [list, setList] = useState<SessionSnapshot[]>(() => listSnapshots());

  if (!open) return null;

  const refresh = () => setList(listSnapshots());

  const save = () => {
    if (workspaces.length === 0) { pushToast("info", "Nothing to snapshot — open a workspace first."); return; }
    const name = window.prompt("Name this snapshot:", "");
    if (name == null) return;
    saveSnapshot(name, workspaces, activeId);
    refresh();
    pushToast("success", "Snapshot saved.");
  };

  // Restoring adds each snapshotted workspace back as a NEW workspace
  // (fresh ids, fresh panes) rather than replacing the live session — a
  // snapshot is "bring this back", not "throw away what I have now". Worktree
  // identity isn't reattached here (that machinery lives in worktrees.ts,
  // which owns spawnPane/preparePanes and isn't this file's to call into for
  // a bulk multi-workspace restore) — a snapshotted isolated pane restores as
  // a plain pane at the same cwd; if that path was a worktree that's since
  // been GC'd, the pane simply shows its usual "folder not found" pane error.
  const restore = (snap: SessionSnapshot) => {
    requestConfirm({
      title: `Restore "${snap.name}"?`,
      body: `Reopens ${snap.workspaces.length} workspace${snap.workspaces.length === 1 ? "" : "s"} from ${relTime(snap.savedAt)} as new tabs alongside what's already open, and relaunches each agent.`,
      confirmLabel: "Restore",
      onConfirm: () => {
        for (const w of snap.workspaces) {
          createWorkspace(w.root, defPanesToNewPanes(w.panes), w.setupCmd);
        }
        pushToast("success", `Restored "${snap.name}".`);
        onClose();
      },
    });
  };

  return createPortal(
    <div className="ops-backdrop" onMouseDown={onClose}>
      <div className="ops-panel" role="dialog" aria-modal="true" aria-label="Session snapshots" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ops-head">
          <span className="ops-title">Session snapshots</span>
          <button className="ops-x" onClick={onClose} title="Close (Esc)" aria-label="Close"><IconClose size={14} /></button>
        </div>
        <div className="ops-toolbar">
          <button className="selbar-btn" onClick={save}>Save current session as a snapshot…</button>
        </div>
        {list.length === 0 ? (
          <div className="ops-empty">No snapshots yet — save one to come back to this exact set of workspaces later.</div>
        ) : (
          <div className="ops-list">
            {list.map((s) => (
              <div className="ops-row" key={s.id}>
                <div className="ops-row-main">
                  <span className="ops-row-name">{s.name}</span>
                  <span className="ops-row-sub">
                    {relTime(s.savedAt)} · {s.workspaces.length} workspace{s.workspaces.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="ops-row-actions">
                  <button onClick={() => restore(s)}>Restore</button>
                  <button
                    title="Rename this snapshot"
                    onClick={() => {
                      const name = window.prompt("Rename snapshot:", s.name);
                      if (name != null) { renameSnapshot(s.id, name); refresh(); }
                    }}
                  >
                    Rename
                  </button>
                  <button title="Delete this snapshot" onClick={() => { deleteSnapshot(s.id); refresh(); }}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
