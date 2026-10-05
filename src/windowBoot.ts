import { invoke } from "@tauri-apps/api/core";
import { getMultiwindow } from "./settingsStore";
import { setWindowOrdinal } from "./store";
import type { SessionDraft } from "./persist";

// Phase 4: tell Rust this window is up, learn its label/ordinal (pane-id
// partition) and, for a secondary, its slice. Then keep a heartbeat going so
// Rust can re-adopt this window's workspaces if the webview dies silently.
export interface BootInfo { label: string; ordinal: number; slice?: SessionDraft | null }

export const HEARTBEAT_MS = 2000;

let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Null outside Tauri or on a build without the command: single-window behaviour. */
export async function bootWindow(): Promise<BootInfo | null> {
  try {
    const info = await invoke<BootInfo>("window_boot", { multiwindow: getMultiwindow() });
    if (!info || typeof info.ordinal !== "number") return null;
    setWindowOrdinal(info.ordinal);
    if (heartbeat === undefined) {
      heartbeat = setInterval(() => { void invoke("window_heartbeat").catch(() => { /* Rust gone or reloading */ }); }, HEARTBEAT_MS);
    }
    return info;
  } catch {
    return null;
  }
}
