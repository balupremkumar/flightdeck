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
import { repoToplevel, type WorktreeInfo } from "./worktrees";

function toDraft(workspaces: Workspace[], activeId: number | null): SessionDraft {
  return {
    activeWorkspaceId: activeId,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      root: w.root,
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
    uiPrefs: {},
  };
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

let lastSavedJson = "";

export function startAutosave() {
  const saver = makeDebouncedSave(800);
  useApp.subscribe((s) => {
    const draft = toDraft(s.workspaces, s.activeId);
    const json = JSON.stringify(draft);
    // Pane-state churn (starting/waiting/running) hits this subscriber
    // constantly but never changes the persisted shape — skip identical drafts.
    if (json === lastSavedJson) return;
    lastSavedJson = json;
    saver.schedule(draft);
  });
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
async function reconcilePane(p: PaneModel, wsRoot: string): Promise<PaneModel> {
  if (!p.worktreePath) return p;
  if ((await repoToplevel(p.cwd)) != null) return p; // worktree intact
  const slug = p.branch?.startsWith("flightdeck/") ? p.branch.slice("flightdeck/".length) : null;
  if (slug) {
    try {
      const wt = await invoke<WorktreeInfo>("git_worktree_add", { repoDir: wsRoot, slug });
      return { ...p, cwd: wt.path, worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch };
    } catch {
      /* fall through to the plain-pane fallback */
    }
  }
  useUI.getState().pushToast("info", `Couldn't reattach ${p.branch ?? "a worktree"} — pane reopened at the workspace root.`);
  return { ...p, cwd: wsRoot, worktreePath: undefined, branch: undefined, baseBranch: undefined };
}

async function hydrateFrom(persisted: PersistedWorkspace[], activeId: number | null) {
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
      panes.push(await reconcilePane(model, w.root));
    }
    workspaces.push({ id: w.id, name: w.name, root: w.root, panes, focused: panes[0]?.id ?? null });
  }
  useApp.getState().hydrate(workspaces, activeId);
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
    if (!doc || doc.workspaces.length === 0) return;
    if (useApp.getState().workspaces.length > 0) return; // user already moving
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
