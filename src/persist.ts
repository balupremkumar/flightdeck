import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Typed client for the Rust `persist` module (src-tauri/src/persist.rs).
// JSON-document session persistence in the app-data dir; not wired into
// store.ts here — see the wiring diff in the build report.
//
// Correctness: `PersistedPane` carries no `state`. Panes are live processes —
// a restored pane is always dead/idle; the caller must relaunch it (store's
// `restartPane`) rather than assume the process survived.

export interface PersistedPane {
  id: number;
  vendor: string;
  cwd: string;
  title?: string;
  // Worktree isolation: lets restore reattach/recreate the pane's worktree and
  // tells launch-time GC which worktrees are still claimed. Absent for plain panes.
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  // UX-581: the pane's typed-but-unsent input line, so a restart doesn't
  // silently discard what you were part-way through writing.
  draft?: string;
  // The user typed the title; absent (false) for auto-titled panes and old docs.
  titleManual?: boolean;
}

export interface PersistedWorkspace {
  id: number;
  name: string;
  root: string;
  // Worktree setup command — re-runs when restore recreates a pane's worktree.
  setupCmd?: string;
  panes: PersistedPane[];
}

export interface SessionDoc {
  version: number;
  savedAt: number;
  activeWorkspaceId: number | null;
  workspaces: PersistedWorkspace[];
  // Opaque UI-preference blob (theme, ui scale, panel collapsed, ...) — shaped
  // by the caller, round-tripped as-is.
  uiPrefs: unknown;
  // Which window held which workspaces (Rust `windows[]`). Main's load keeps the
  // secondaries' entries so boot can tell a session has more than main's slice.
  windows?: { label: string; workspaceIds: number[]; activeWorkspaceId?: number | null }[];
}

// What the caller hands to saveSession: everything except the fields the
// backend stamps itself (version, savedAt).
export type SessionDraft = Omit<SessionDoc, "version" | "savedAt">;

export interface RestorePointInfo {
  id: string;
  savedAt: number;
}

// (199) Whether the app was launched with --safe-mode or FLIGHTDECK_SAFE_MODE,
// which suppresses auto-restore. Query this to show a "started in safe mode"
// banner; loadSession() already returns null under safe mode on its own.
export async function isSafeMode(): Promise<boolean> {
  return invoke<boolean>("is_safe_mode");
}

// (80) Reports whether a previous session exists, independent of safe mode —
// lets the UI offer a "reopen last session" prompt even while restore is
// suppressed.
export async function hasPreviousSession(): Promise<boolean> {
  return invoke<boolean>("has_previous_session");
}

// Null means "nothing to restore" (first run, or safe mode active). Only a
// genuinely corrupt session.json rejects.
export async function loadSession(): Promise<SessionDoc | null> {
  return invoke<SessionDoc | null>("load_session");
}

export async function saveSession(doc: SessionDraft): Promise<void> {
  await invoke("save_session", { doc });
}

// Phase 4: pushes this window's slice to the Rust single writer, which merges
// per-window slices and owns the document. The window label is taken from the
// calling window on the Rust side, never sent from here. `flush` skips Rust's
// own 800 ms debounce (beforeunload).
/** Phase 4: boot-only work (restore prompt, worktree GC, clean-exit sentinel,
 *  what's-new) belongs to the "main" window. True outside Tauri (browser
 *  preview, tests) where there is no window label. */
export function isMainWindow(): boolean {
  try { return getCurrentWindow().label === "main"; } catch { return true; }
}

export async function putSlice(slice: SessionDraft, flush = false): Promise<void> {
  try {
    await invoke("session_put_slice", { slice, flush });
  } catch { /* browser preview, or a Rust build without the command */ }
}

// Debounced save: coalesces bursts of store changes (pane add/close, rename,
// reorder, workspace switch, ...) into one write + one restore-point snapshot.
// Call `schedule` on every change the caller wants persisted; call `flush` on
// app shutdown/exit to guarantee the last change lands.
export interface DebouncedSave {
  schedule: (doc: SessionDraft) => void;
  /** `final` marks the exit-time flush, which also skips Rust's debounce. */
  flush: (final?: boolean) => void;
}

export function makeDebouncedSave(delayMs = 800): DebouncedSave {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: SessionDraft | undefined;

  function flush(final = false): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending) {
      const doc = pending;
      pending = undefined;
      // S6b: Rust is the single writer of session.json. saveSession stays
      // exported for one release for import/export paths only.
      void putSlice(doc, final);
    }
  }

  function schedule(doc: SessionDraft): void {
    pending = doc;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => flush(), delayMs);
  }

  return { schedule, flush };
}

// (200) Restore points, newest first.
export async function listRestorePoints(): Promise<RestorePointInfo[]> {
  return invoke<RestorePointInfo[]>("list_restore_points");
}

// Reads a restore point's content. Does not make it the active session —
// call saveSession(doc) afterwards if the caller wants it committed as current.
export async function restoreFromPoint(id: string): Promise<SessionDoc> {
  return invoke<SessionDoc>("restore_from_point", { id });
}

// (201) One-file backup/restore of everything this module persists.
export async function exportBackup(destPath: string): Promise<void> {
  await invoke("export_backup", { destPath });
}

// Returns the restored session (if the backup had one) so the caller can load
// it straight into the store without a second round trip.
export async function importBackup(srcPath: string): Promise<SessionDoc | null> {
  return invoke<SessionDoc | null>("import_backup", { srcPath });
}
