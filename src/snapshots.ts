// snapshots.ts — UX-562 named session snapshots + restore-to-snapshot, and
// UX-563 export/import a single workspace definition to a file.
//
// Deliberately independent of the Rust persist.rs module (that's SQLite/JSON
// session-doc territory the auto-restore-on-launch path already owns via
// session.ts + persist.ts) — a *named* snapshot is a point-in-time the user
// explicitly chose to keep, browsable and restorable without touching the
// "reopen last session" machinery. Stored in localStorage, same tier as
// prompthistory.ts/quickopen.ts's persisted lists elsewhere in this app.
//
// Both features reuse the same minimal "workspace definition" shape
// (id/name/root/setupCmd/panes[vendor,cwd,title,worktree ids]) — a snapshot
// is really just "N of these plus which was active", and a workspace export
// is exactly one of them on its own.

import type { Workspace } from "./store";

export interface DefPane {
  vendor: string;
  cwd: string;
  title?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
}
export interface WorkspaceDef {
  id: number;
  name: string;
  root: string;
  setupCmd?: string;
  panes: DefPane[];
}

function toDef(w: Workspace): WorkspaceDef {
  return {
    id: w.id,
    name: w.name,
    root: w.root,
    setupCmd: w.setupCmd,
    panes: w.panes.map((p): DefPane => ({
      vendor: p.vendor,
      cwd: p.cwd,
      title: p.title,
      worktreePath: p.worktreePath,
      branch: p.branch,
      baseBranch: p.baseBranch,
    })),
  };
}

function isDefPane(x: unknown): x is DefPane {
  return !!x && typeof x === "object" && typeof (x as DefPane).vendor === "string" && typeof (x as DefPane).cwd === "string";
}

/** Throws with a human-readable message on anything that isn't a workspace
 *  definition this app could have produced — never partially imports. */
export function parseWorkspaceDef(json: string): WorkspaceDef {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const w = (doc as { workspace?: unknown } | null)?.workspace ?? doc;
  if (!w || typeof w !== "object") throw new Error("Not a Flightdeck workspace export.");
  const rec = w as Record<string, unknown>;
  if (typeof rec.root !== "string" || !rec.root) throw new Error("Missing the workspace's root folder.");
  if (!Array.isArray(rec.panes) || !rec.panes.every(isDefPane)) throw new Error("Missing or malformed pane list.");
  return {
    id: typeof rec.id === "number" ? rec.id : 0,
    name: typeof rec.name === "string" && rec.name ? rec.name : rec.root,
    root: rec.root,
    setupCmd: typeof rec.setupCmd === "string" ? rec.setupCmd : undefined,
    panes: rec.panes as DefPane[],
  };
}

export function serializeWorkspaceExport(w: Workspace): string {
  return JSON.stringify({ version: 1, exportedAt: Date.now(), workspace: toDef(w) }, null, 2);
}

// ---------------------------------------------------------------------------
// Named snapshots (UX-562)
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  id: string;
  name: string;
  savedAt: number;
  activeWorkspaceId: number | null;
  workspaces: WorkspaceDef[];
}

const SNAPSHOTS_KEY = "flightdeck-session-snapshots";
const MAX_SNAPSHOTS = 30;

function readAll(): SessionSnapshot[] {
  try {
    const v = JSON.parse(localStorage.getItem(SNAPSHOTS_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeAll(list: SessionSnapshot[]): void {
  try { localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(list.slice(0, MAX_SNAPSHOTS))); } catch { /* non-persistent */ }
}

/** Newest first. */
export function listSnapshots(): SessionSnapshot[] {
  return readAll().sort((a, b) => b.savedAt - a.savedAt);
}

export function saveSnapshot(name: string, workspaces: Workspace[], activeWorkspaceId: number | null): SessionSnapshot {
  const snap: SessionSnapshot = {
    id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim().slice(0, 60) || `Snapshot ${new Date().toLocaleString()}`,
    savedAt: Date.now(),
    activeWorkspaceId,
    workspaces: workspaces.map(toDef),
  };
  writeAll([snap, ...readAll()]);
  return snap;
}

export function deleteSnapshot(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}

export function renameSnapshot(id: string, name: string): void {
  writeAll(readAll().map((s) => (s.id === id ? { ...s, name: name.trim().slice(0, 60) || s.name } : s)));
}

/** Fresh PaneModel[] for restoring a snapshot's workspace into the store —
 *  always "starting"/epoch 0, same convention as session.ts's own restore
 *  path, since a restored pane's process never actually survived. IDs are
 *  reassigned by the caller (store.ts's createWorkspace/addPane, via their
 *  own id sequences) rather than reused from the snapshot, so restoring the
 *  same snapshot twice never collides with itself or the live session. */
export function defPanesToNewPanes(panes: DefPane[]): { vendor: string; cwd: string; worktreePath?: string; branch?: string; baseBranch?: string }[] {
  return panes.map((p) => ({ vendor: p.vendor, cwd: p.cwd, worktreePath: p.worktreePath, branch: p.branch, baseBranch: p.baseBranch }));
}
