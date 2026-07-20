import { create } from "zustand";

// "permission" = the agent printed an interactive approval prompt and is
// blocked on the user (UI-2/#220) — a louder sub-case of "waiting", detected
// from output patterns in Terminal.tsx.
export type PaneState = "starting" | "running" | "idle" | "waiting" | "permission" | "error";
// Worktree isolation (Tier 0): set when the pane runs in its own git worktree.
// `cwd` then IS the worktree path; `baseBranch` is what review diffs against
// and what merge-back targets. All absent for a plain (shared-folder) pane.
export interface WorktreeRef { worktreePath: string; branch: string; baseBranch: string; }
// `epoch` bumps on restart; PaneView keys the Terminal on it so a bump remounts
// the component and respawns the PTY (same cwd — an isolated pane restarts
// into its existing worktree, never a new one).
// `needsSetup`: the pane's worktree was freshly created and the workspace has a
// setup command — the next PTY spawn runs it before the agent (Tier 0 follow-up).
// Cleared once a spawn has consumed it so Restart doesn't re-run e.g. `npm ci`.
export interface PaneModel extends Partial<WorktreeRef> { id: number; vendor: string; cwd: string; state: PaneState; epoch: number; title?: string; needsSetup?: boolean; }
export interface Workspace { id: number; name: string; root: string; panes: PaneModel[]; focused: number | null; setupCmd?: string; }
export interface NewPane extends Partial<WorktreeRef> { vendor: string; cwd: string; needsSetup?: boolean; }

interface AppState {
  workspaces: Workspace[];
  activeId: number | null;
  creating: boolean; // is the New Workspace dialog open (as an overlay)
  startCreate: () => void;
  cancelCreate: () => void;
  createWorkspace: (root: string, panes: NewPane[], setupCmd?: string) => void;
  closeWorkspace: (id: number) => void;
  switchWorkspace: (id: number) => void;
  addPane: (wsId: number, vendor: string, cwd: string, wt?: WorktreeRef, needsSetup?: boolean) => void;
  clearNeedsSetup: (paneId: number) => void;
  closePane: (wsId: number, paneId: number) => void;
  focusPane: (wsId: number, paneId: number) => void;
  setPaneState: (paneId: number, state: PaneState) => void;
  restartPane: (paneId: number) => void;
  renamePane: (paneId: number, title: string) => void;
  renameWorkspace: (wsId: number, name: string) => void;
  reorderWorkspaces: (from: number, to: number) => void;
  movePane: (wsId: number, from: number, to: number) => void;
  // Session restore (session.ts): replace the whole tree with persisted state.
  hydrate: (workspaces: Workspace[], activeId: number | null) => void;
}

function reorder<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

let wseq = 0;
let pseq = 0;
function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s || p;
}

export const useApp = create<AppState>((set) => ({
  workspaces: [],
  activeId: null,
  creating: false,

  startCreate: () => set({ creating: true }),
  cancelCreate: () => set((s) => (s.workspaces.length ? { creating: false } : s)),

  createWorkspace: (root, panes, setupCmd) =>
    set((s) => {
      const ws: Workspace = {
        id: ++wseq,
        name: baseName(root),
        root,
        setupCmd: setupCmd?.trim() || undefined,
        panes: panes.map((p) => ({
          id: ++pseq,
          vendor: p.vendor,
          cwd: p.cwd,
          state: "starting" as PaneState,
          epoch: 0,
          worktreePath: p.worktreePath,
          branch: p.branch,
          baseBranch: p.baseBranch,
          needsSetup: (p.needsSetup && !!setupCmd?.trim()) || undefined,
        })),
        focused: null,
      };
      ws.focused = ws.panes[0]?.id ?? null;
      return { workspaces: [...s.workspaces, ws], activeId: ws.id, creating: false };
    }),

  closeWorkspace: (id) =>
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const activeId = s.activeId === id ? (workspaces[workspaces.length - 1]?.id ?? null) : s.activeId;
      return { workspaces, activeId };
    }),

  switchWorkspace: (id) => set({ activeId: id }),

  addPane: (wsId, vendor, cwd, wt, needsSetup) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== wsId) return w;
        const pane: PaneModel = { id: ++pseq, vendor, cwd, state: "starting", epoch: 0, needsSetup: needsSetup || undefined, ...wt };
        return { ...w, panes: [...w.panes, pane], focused: pane.id };
      }),
    })),

  clearNeedsSetup: (paneId) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => ({
        ...w,
        panes: w.panes.map((p) => (p.id === paneId && p.needsSetup ? { ...p, needsSetup: undefined } : p)),
      })),
    })),

  closePane: (wsId, paneId) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === wsId
          ? { ...w, panes: w.panes.filter((p) => p.id !== paneId), focused: w.focused === paneId ? null : w.focused }
          : w
      ),
    })),

  focusPane: (wsId, paneId) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, focused: paneId } : w)) })),

  setPaneState: (paneId, state) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => ({
        ...w,
        panes: w.panes.map((p) => (p.id === paneId ? { ...p, state } : p)),
      })),
    })),

  restartPane: (paneId) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => ({
        ...w,
        panes: w.panes.map((p) =>
          p.id === paneId ? { ...p, epoch: p.epoch + 1, state: "starting" as PaneState } : p
        ),
      })),
    })),

  // Rename guards (UI-26): cap length so a pasted novel can't overflow the
  // fixed-width header/tile layouts.
  renamePane: (paneId, title) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => ({
        ...w,
        panes: w.panes.map((p) => (p.id === paneId ? { ...p, title: title.trim().slice(0, 60) || undefined } : p)),
      })),
    })),

  renameWorkspace: (wsId, name) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, name: name.trim().slice(0, 60) || w.name } : w)),
    })),

  reorderWorkspaces: (from, to) => set((s) => ({ workspaces: reorder(s.workspaces, from, to) })),

  movePane: (wsId, from, to) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, panes: reorder(w.panes, from, to) } : w)),
    })),

  hydrate: (workspaces, activeId) =>
    set(() => {
      // Bump the id counters past everything restored so new workspaces/panes
      // can never collide with persisted ids.
      for (const w of workspaces) {
        wseq = Math.max(wseq, w.id);
        for (const p of w.panes) pseq = Math.max(pseq, p.id);
      }
      const validActive = workspaces.some((w) => w.id === activeId)
        ? activeId
        : workspaces[workspaces.length - 1]?.id ?? null;
      return { workspaces, activeId: validActive, creating: false };
    }),
}));
