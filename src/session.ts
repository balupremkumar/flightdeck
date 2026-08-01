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
import { useApp, type PaneModel, type PaneGroup, type Workspace } from "./store";
import { useUI } from "./ui";
import {
  loadSession, isSafeMode, hasPreviousSession, makeDebouncedSave,
  type SessionDraft, type PersistedWorkspace,
} from "./persist";
import { repoToplevel, closeWorkspaceWithCleanup, type WorktreeInfo } from "./worktrees";
import { useBoardStore, getBoardState, setBoardState } from "./board/boardStore";
import type { BoardCards } from "./board/types";
import { getStartupBehavior } from "./Settings";
import { lastLine } from "./attention";

// UX-581: `draft` (the pane's unsent input line) isn't on persist.ts's
// PersistedPane type yet — that file belongs to the persist.rs wiring, not
// this module. The Rust side (persist.rs PersistedPane.draft) already
// round-trips it; these local widened types let session.ts read/write the
// field without waiting on persist.ts's type to catch up. JSON doesn't care
// about the TS type, so this is fully functional today, not just a stub.
type DraftPane = PersistedWorkspace["panes"][number] & { draft?: string };
type DraftWorkspace = Omit<PersistedWorkspace, "panes"> & { panes: DraftPane[] };

// UX-561: what each pane was doing at save time — vendor, title, cwd, its
// live state and its last output line (attention.ts's lastLine, the same
// source the attention queue and Broadcast's output preview already read).
// Recomputed on every save (not just at quit) so the doc's summary is never
// more than one autosave cycle stale, and a hard-crash still leaves a recent
// one behind rather than nothing.
export interface PaneSummaryEntry {
  workspaceName: string;
  vendor: string;
  title?: string;
  cwd: string;
  state: string;
  lastLine?: string;
}

function summarize(workspaces: Workspace[]): PaneSummaryEntry[] {
  return workspaces.flatMap((w) =>
    w.panes.map((p): PaneSummaryEntry => ({
      workspaceName: w.name,
      vendor: p.vendor,
      title: p.title,
      cwd: p.cwd,
      state: p.state,
      lastLine: lastLine.get(p.id),
    }))
  );
}

function toDraft(workspaces: Workspace[], activeId: number | null): SessionDraft {
  return {
    activeWorkspaceId: activeId,
    workspaces: workspaces.map((w): DraftWorkspace => ({
      id: w.id,
      name: w.name,
      root: w.root,
      setupCmd: w.setupCmd,
      panes: w.panes.map((p): DraftPane => ({
        id: p.id,
        vendor: p.vendor,
        cwd: p.cwd,
        title: p.title,
        worktreePath: p.worktreePath,
        branch: p.branch,
        baseBranch: p.baseBranch,
        draft: p.draft,
      })),
    })),
    // The board rides in the opaque prefs blob (BACKLOG 229 — cards were
    // in-memory only; every restart wiped the Kanban). UX-554/561: pane
    // groups and the "what was each pane doing" summary ride alongside it —
    // all three are caller-shaped and round-tripped as-is by persist.rs
    // (SessionDoc.uiPrefs is `unknown` on that side), so adding fields here
    // needs no Rust/persist.ts change and is automatically backward
    // compatible: an old doc simply has these keys absent, and every reader
    // below treats absence as "none" rather than throwing.
    uiPrefs: { board: getBoardState(), groups: useApp.getState().groups, summary: summarize(workspaces) },
  };
}

/** UX-561: the session summary from the doc currently on disk, or an empty
 *  list if there isn't one yet (first run, or a pre-UX-561 doc). Read this
 *  for a "what was I doing last time" surface — it does not itself restore
 *  anything. */
export async function lastSessionSummary(): Promise<PaneSummaryEntry[]> {
  try {
    const doc = await loadSession();
    return parseUiPrefs(doc?.uiPrefs).summary;
  } catch {
    return [];
  }
}

/** Backward-compatible parse of the opaque `uiPrefs` blob (see toDraft's
 *  comment on why it's safe to grow this without a persist.rs/persist.ts
 *  change). `uiPrefs` is `unknown` end to end — a doc saved before UX-554/561
 *  shipped simply has `groups`/`summary` absent, and every field here
 *  defaults rather than throws, so an old doc loads exactly as before, just
 *  with an empty groups list and summary. Exported standalone (not inlined
 *  into offerSessionRestore) so this exact compatibility contract is unit
 *  testable without needing to drive the whole restore-prompt flow. */
export function parseUiPrefs(uiPrefs: unknown): { board?: BoardCards; groups: PaneGroup[]; summary: PaneSummaryEntry[] } {
  const p = (uiPrefs && typeof uiPrefs === "object" ? uiPrefs : {}) as {
    board?: BoardCards; groups?: unknown; summary?: unknown;
  };
  return {
    board: p.board && typeof p.board === "object" ? p.board : undefined,
    groups: Array.isArray(p.groups) ? (p.groups as PaneGroup[]) : [],
    summary: Array.isArray(p.summary) ? (p.summary as PaneSummaryEntry[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

let lastSavedJson = "";
/** UI-196: when the session last hit disk, for the Settings readout. Persisting
 *  silently is right, but "is my work actually being saved?" deserves an answer. */
let lastSavedAt = 0;
export function lastSessionSaveAt(): number { return lastSavedAt; }

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
    lastSavedAt = Date.now();
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

/** UX-583: per-pane worktree reconcile outcome, named so the UI can render
 *  exactly what happened rather than a generic "session restored" banner. */
export type PaneReconcileStatus =
  | "plain"       // not an isolated pane — nothing to reconcile
  | "intact"      // worktree dir still valid, used as-is
  | "reattached"  // dir was gone, branch survived — worktree recreated
  | "fell-back";  // repo/branch gone — pane reopened at the workspace root

/** UX-583: names exactly which workspaces/panes came back from a restore and
 *  how each pane's worktree reconciled, so a crash-recovery banner can say
 *  more than "restored your session". Set at the end of every `hydrateFrom`
 *  call (including `adoptSession`); read with `lastRestoreReport()`. */
export interface RestoredPane {
  paneId: number;
  workspaceId: number;
  workspaceName: string;
  vendor: string;
  title?: string;
  status: PaneReconcileStatus;
}

let restoreReport: RestoredPane[] = [];
/** UX-583: what the most recent `hydrateFrom` restored, for a banner to name. */
export function lastRestoreReport(): RestoredPane[] {
  return restoreReport;
}

/** Reattach one persisted pane's worktree (D5/D6 reconcile):
 *  - worktree dir still valid  -> keep as-is
 *  - dir gone, branch survived -> git_worktree_add reattaches it (idempotent)
 *  - repo/branch gone          -> plain pane at the workspace root            */
async function reconcilePane(
  p: PaneModel,
  wsRoot: string,
  wsSetupCmd?: string
): Promise<{ pane: PaneModel; status: PaneReconcileStatus }> {
  if (!p.worktreePath) return { pane: p, status: "plain" };
  if ((await repoToplevel(p.cwd)) != null) return { pane: p, status: "intact" };
  const slug = p.branch?.startsWith("flightdeck/") ? p.branch.slice("flightdeck/".length) : null;
  if (slug) {
    try {
      const wt = await invoke<WorktreeInfo>("git_worktree_add", { repoDir: wsRoot, slug });
      // A recreated worktree dir is fresh (no node_modules) — re-run setup.
      const needsSetup = (wt.created && !!wsSetupCmd) || undefined;
      return {
        pane: { ...p, cwd: wt.path, worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch, needsSetup },
        status: "reattached",
      };
    } catch {
      /* fall through to the plain-pane fallback */
    }
  }
  useUI.getState().pushToast(
    "info",
    `Couldn't reattach ${p.branch ?? "a worktree"} in ${wsRoot.split(/[\\\/]/).pop() || wsRoot} ` +
    `(its repo or branch is gone) — the pane reopened at the workspace root instead.`
  );
  return {
    pane: { ...p, cwd: wsRoot, worktreePath: undefined, branch: undefined, baseBranch: undefined },
    status: "fell-back",
  };
}

export async function hydrateFrom(persisted: PersistedWorkspace[], activeId: number | null) {
  const workspaces: Workspace[] = [];
  const report: RestoredPane[] = [];
  for (const w of persisted) {
    const panes: PaneModel[] = [];
    for (const raw of w.panes) {
      const p = raw as DraftPane;
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
        draft: p.draft, // UX-581: the unsent line survives the restart too
      };
      const { pane, status } = await reconcilePane(model, w.root, w.setupCmd);
      panes.push(pane);
      report.push({
        paneId: pane.id,
        workspaceId: w.id,
        workspaceName: w.name,
        vendor: pane.vendor,
        title: pane.title,
        status,
      });
    }
    workspaces.push({ id: w.id, name: w.name, root: w.root, setupCmd: w.setupCmd, panes, focused: panes[0]?.id ?? null });
  }
  restoreReport = report;
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

// UI-197: a clean-exit sentinel. Flightdeck holds live agent processes, so a
// disappearance without a clean shutdown is worth noticing — and it's exactly
// the moment a support bundle is useful, while the evidence is still fresh.
const CLEAN_EXIT_KEY = "flightdeck-clean-exit";

/** True when the previous run ended without going through the quit path. */
export function crashedLastRun(): boolean {
  try {
    // Absent = first run ever, which is not a crash.
    const v = localStorage.getItem(CLEAN_EXIT_KEY);
    return v === "0";
  } catch { return false; }
}

/** Call once at boot, AFTER reading crashedLastRun(). */
export function armCleanExitSentinel() {
  try {
    localStorage.setItem(CLEAN_EXIT_KEY, "0");
  } catch { /* non-persistent */ }
  // Mark clean on the way out. beforeunload covers window close and quit;
  // a hard kill or power loss deliberately leaves the "0".
  window.addEventListener("beforeunload", () => {
    try { localStorage.setItem(CLEAN_EXIT_KEY, "1"); } catch { /* non-persistent */ }
  });
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
    // The board (and, UX-554, pane groups) restore unconditionally — both are
    // workspace-independent state, so declining the workspace prompt below
    // shouldn't wipe them. parseUiPrefs is the backward-compat boundary: a
    // doc saved before this shipped just has both absent (see its own doc
    // comment + session.test.ts).
    const prefs = parseUiPrefs(doc.uiPrefs);
    if (prefs.board) setBoardState(prefs.board);
    if (prefs.groups.length) useApp.getState().hydrateGroups(prefs.groups);
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
