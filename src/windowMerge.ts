import { invoke } from "@tauri-apps/api/core";
import { useApp } from "./store";
import { isMainWindow } from "./persist";
import { getMultiwindow } from "./settingsStore";

// Phase 4 S9: "Merge all windows", and the merge-first rule for session-wide
// operations (named snapshots, export/import, restore points, adoptSession): they
// act on the whole session, so every secondary folds into main first and the
// operation then runs in main on the merged document.
//
// Order, for a caller that needs the merged doc:
//   1. merge_all_windows: Rust flushes each secondary's slice, folds it into main,
//      emits win://adopt to main, destroys the window, and answers the moved ids.
//   2. wait until main's store actually holds those workspaces (the adopt is async).
//   3. push main's slice now, so session.json on disk is the merged document.
//   4. only then run the operation.

/** How long to wait for main to hold the adopted workspaces before giving up. */
export const ADOPT_WAIT_MS = 8000;

let flushSlice: (() => Promise<void>) | null = null;
/** session.ts registers how to push main's slice immediately (breaks an import cycle). */
export function registerSliceFlush(fn: () => Promise<void>): void {
  flushSlice = fn;
}

/** Fold every secondary into main. Resolves with the workspace ids that moved; empty
 *  outside Tauri, on a build without the command, or with only one window. */
export async function mergeAllWindows(): Promise<number[]> {
  try {
    const ids = await invoke<number[]>("merge_all_windows");
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

/** Resolves true once every id is in main's store, false on timeout. */
export async function waitForWorkspaces(ids: number[], timeoutMs = ADOPT_WAIT_MS, pollMs = 50): Promise<boolean> {
  const have = () => {
    const known = new Set(useApp.getState().workspaces.map((w) => w.id));
    return ids.every((id) => known.has(id));
  };
  for (let waited = 0; !have(); waited += pollMs) {
    if (waited >= timeoutMs) return false;
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
  return true;
}

/** Run before any session-wide operation. Throws (the callers already show a thrown
 *  error as a toast) when this is a secondary: the operation belongs in main. A
 *  no-op with the flag off, and when there is no other window. */
export async function mergeFirst(): Promise<void> {
  if (!getMultiwindow()) return;
  if (!isMainWindow()) throw new Error("Switch to the main window first: this works on every window's workspaces.");
  const moved = await mergeAllWindows();
  if (moved.length === 0) return;
  if (!(await waitForWorkspaces(moved))) throw new Error("A merged window's workspaces did not arrive in time. Try again.");
  await flushSlice?.();
}
