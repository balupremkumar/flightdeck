import { invoke } from "@tauri-apps/api/core";
import { getMultiwindow } from "./settingsStore";
import { useApp } from "./store";
import { useUI } from "./ui";
import { moveWorkspaceToNewWindow } from "./windowMove";

// Phase 4: the user-facing multi-window commands, shared by the keyboard chords
// (Cockpit.tsx) and the command palette so both do exactly the same thing. Every
// one is a no-op with the flag off ("Multiple windows (preview)" in Settings).

/** Chords, also listed in FIXED_SHORTCUTS (settingsStore.ts) for the cheat sheet. */
export const MOVE_WINDOW_CHORD = { key: "n", label: "Ctrl+Shift+N" };
export const NEXT_WINDOW_CHORD = { key: "o", label: "Ctrl+Shift+O" };

export function multiwindowEnabled(): boolean {
  return getMultiwindow();
}

/** Move the active workspace to a window of its own. */
export async function moveActiveWorkspaceToNewWindow(): Promise<void> {
  if (!multiwindowEnabled()) return;
  const id = useApp.getState().activeId;
  if (id == null) {
    useUI.getState().pushToast("info", "Open a workspace first, then move it to a new window.");
    return;
  }
  await moveWorkspaceToNewWindow(id);
}

/** Bring the next Flightdeck window to the front (the user just asked for it). */
export async function focusNextWindow(): Promise<void> {
  if (!multiwindowEnabled()) return;
  try {
    const next = await invoke<string | null>("window_focus_next");
    if (!next) useUI.getState().pushToast("info", "There is only one window.");
  } catch { /* browser preview */ }
}
