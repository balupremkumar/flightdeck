// session.ts — wires the store to the Rust persist module (feature 7 / R4 +
// UI-46). Until now persist.rs/persist.ts were built-but-unwired: closing
// Flightdeck silently discarded every workspace. This module owns:
//   - autosave: store changes -> debounced save_session (skips no-op writes)
//   - boot restore: "Reopen last session?" prompt -> hydrate the store
//   - worktree reconcile: a restored isolated pane reattaches its worktree
//     (recreates it from the surviving branch if the dir was GC'd), falling
//     back to the workspace root if the repo itself is gone
//   - safe-mode banner (--safe-mode / FLIGHTDECK_SAFE_MODE suppresses restore)
import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel, type Workspace } from "./store";
import { useUI } from "./ui";
import {
  loadSession, isSafeMode, hasPreviousSession, makeDebouncedSave,
  type SessionDraft, type PersistedWorkspace,
} from "./persist";
import { repoToplevel, closeWorkspaceWithCleanup, type WorktreeInfo } from "./worktrees";
import { useBoardStore, getBoardState, setBoardState } from "./board/boardStore";
import type { BoardCards } from "./board/types";
import { getStartupBehavior } from "./Settings";

function toDraft(workspaces: Workspace[], activeId: number | null): SessionDraft {
  return {
    activeWorkspaceId: activeId,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      root: w.root,
      setupCmd: w.setupCmd,
      panes: w.panes.map((p) => ({
        id: p.id,
        vendor: p.vendor,
        cwd: p.cwd,
        title: p.title,
        worktreePath: p.worktreePath,
        branch: p.branch,
        baseBranch: p.baseBranch,
      })),
    })),
    // The board rides in the opaque prefs blob (BACKLOG 229 — cards were
    // in-memory only; every restart wiped the Kanban).
    uiPrefs: { board: getBoardState() },
  };
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

let lastSavedJson = "";

export function startAutosave() {
  const saver = makeDebouncedSave(800);
  const scheduleIfChanged = () => {
    const s = useApp.getState();
    const draft = toDraft(s.workspaces, s.activeId);
    const json = JSON.stringify(draft);
    // Pane-state churn (starting/waiting/running) hits this subscriber
    // constantly but never changes the persisted shape — skip identical drafts.
    if (json === lastSavedJson) return;
    lastSavedJson = json;
    saver.schedule(draft);
  };
  useApp.subscribe(scheduleIfChanged);
  useBoardStore.subscribe(scheduleIfChanged); // card edits persist too (229)
  // Best-effort last write on the way out; the 800ms debounce means almost
  // everything is already on disk, this just narrows the window.
  window.addEventListener("beforeunload", () => saver.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saver.flush();
  });
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Reattach one persisted pane's worktree (D5/D6 reconcile):
 *  - worktree dir still valid  -> keep as-is
 *  - dir gone, branch survived -> git_worktree_add reattaches it (idempotent)
 *  - repo/branch gone          -> plain pane at the workspace root            */
async function reconcilePane(p: PaneModel, wsRoot: string, wsSetupCmd?: string): Promise<PaneModel> {
  if (!p.worktreePath) return p;
  if ((await repoToplevel(p.cwd)) != null) return p; // worktree intact
  const slug = p.branch?.startsWith("flightdeck/") ? p.branch.slice("flightdeck/".length) : null;
  if (slug) {
    try {
      const wt = await invoke<WorktreeInfo>("git_worktree_add", { repoDir: wsRoot, slug });
      // A recreated worktree dir is fresh (no node_modules) — re-run setup.
      const needsSetup = (wt.created && !!wsSetupCmd) || undefined;
      return { ...p, cwd: wt.path, worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch, needsSetup };
    } catch {
      /* fall through to the plain-pane fallback */
    }
  }
  useUI.getState().pushToast("info", `Couldn't reattach ${p.branch ?? "a worktree"} — pane reopened at the workspace root.`);
  return { ...p, cwd: wsRoot, worktreePath: undefined, branch: undefined, baseBranch: undefined };
}

export async function hydrateFrom(persisted: PersistedWorkspace[], activeId: number | null) {
  const workspaces: Workspace[] = [];
  for (const w of persisted) {
    const panes: PaneModel[] = [];
    for (const p of w.panes) {
      const model: PaneModel = {
        id: p.id,
        vendor: p.vendor,
        cwd: p.cwd,
        state: "starting",
        epoch: 0,
        title: p.title,
        worktreePath: p.worktreePath,
        branch: p.branch,
        baseBranch: p.baseBranch,
      };
      panes.push(await reconcilePane(model, w.root, w.setupCmd));
    }
    workspaces.push({ id: w.id, name: w.name, root: w.root, setupCmd: w.setupCmd, panes, focused: panes[0]?.id ?? null });
  }
  useApp.getState().hydrate(workspaces, activeId);
}

/** UI-191: adopt a restore point / imported backup as the live session.
 *  Closes what's open first (cleaning up its worktrees) so nothing is stranded,
 *  then hydrates and persists the adopted document as current. */
export async function adoptSession(doc: { workspaces: PersistedWorkspace[]; activeWorkspaceId: number | null }) {
  for (const w of useApp.getState().workspaces) {
    closeWorkspaceWithCleanup({ id: w.id, panes: w.panes });
  }
  await hydrateFrom(doc.workspaces, doc.activeWorkspaceId);
}

/** Boot entry: offer to reopen the previous session. Mounting a restored pane
 *  respawns its PTY, so "reopen" relaunches the agents in place. */
export async function offerSessionRestore() {
  try {
    if (await isSafeMode()) {
      useUI.getState().pushToast("info", "Started in safe mode — previous session not restored.");
      // Still let the user know one exists (BACKLOG 80: safe mode suppresses
      // auto-restore, not awareness).
      if (await hasPreviousSession())
        useUI.getState().pushToast("info", "A previous session exists — restart without safe mode to reopen it.");
      return;
    }
    const doc = await loadSession();
    if (!doc) return;
    // The board restores unconditionally (it's workspace-independent state) —
    // declining the workspace prompt shouldn't wipe the task list.
    const board = (doc.uiPrefs as { board?: BoardCards } | null)?.board;
    if (board && typeof board === "object") setBoardState(board);
    if (doc.workspaces.length === 0) return;
    if (useApp.getState().workspaces.length > 0) return; // user already moving
    // Settings > Startup (91) — persisted-but-inert until now. "Reopen last
    // session" skips the prompt entirely; "Show launcher" asks first.
    if (getStartupBehavior() === "reopen") {
      void hydrateFrom(doc.workspaces, doc.activeWorkspaceId);
      return;
    }
    const nPanes = doc.workspaces.reduce((n, w) => n + w.panes.length, 0);
    useUI.getState().requestConfirm({
      title: "Reopen last session?",
      body: `${doc.workspaces.length} workspace${doc.workspaces.length === 1 ? "" : "s"} with ${nPanes} pane${nPanes === 1 ? "" : "s"} from last time. Reopening relaunches each agent in its directory (isolated panes reattach their worktrees).`,
      confirmLabel: "Reopen session",
      onConfirm: () => { void hydrateFrom(doc.workspaces, doc.activeWorkspaceId); },
    });
  } catch {
    /* browser preview / corrupt doc — start clean, never block launch */
  }
}
