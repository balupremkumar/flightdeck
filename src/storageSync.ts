import { bootAppearance } from "./themes";
import {
  applyReadingSettings, getMemoryCeilingMb, getTerminalSettings, hooksInstalled,
  HOOKS_CHANGED_EVENT, HOOKS_INSTALLED_KEY, MEMORY_CEILING_EVENT, MEMORY_CEILING_KEY, READING_SETTINGS_KEY,
} from "./settingsStore";

// Phase 4 S13: live settings across windows. Windows of one app share localStorage, and
// the browser fires `storage` in every OTHER window when a key changes. Settings applies a
// change in its own window by dispatching a same-context event (or re-running the apply
// function); this listener does the same for the windows that did not make the change,
// so a theme or terminal setting changed in one window shows up in all of them at once.
// The window that wrote never receives the event, so nothing loops.

export type SyncAction = "terminal" | "memory" | "hooks" | "appearance" | "reading";

const TERMINAL_KEY = "flightdeck-terminal-settings";
/** Everything bootAppearance() reads: theme, mode memory, accent, colour-blind, motion. */
const APPEARANCE_KEYS = new Set([
  "flightdeck-theme", "flightdeck-theme-id", "flightdeck-theme-custom", "flightdeck-theme-dark",
  "flightdeck-theme-light", "flightdeck-appearance-mode", "flightdeck-accent", "flightdeck-accent-custom",
  "flightdeck-cb-safe", "flightdeck-reduced-motion",
]);

/** What a change to `key` needs re-applied. `null` is `localStorage.clear()`: everything. */
export function actionsFor(key: string | null): SyncAction[] {
  if (key === null) return ["terminal", "memory", "hooks", "appearance", "reading"];
  if (key === TERMINAL_KEY) return ["terminal"];
  if (key === MEMORY_CEILING_KEY) return ["memory"];
  if (key === HOOKS_INSTALLED_KEY) return ["hooks"];
  if (key === READING_SETTINGS_KEY) return ["reading"];
  if (APPEARANCE_KEYS.has(key)) return ["appearance"];
  return [];
}

const RUN: Record<SyncAction, () => void> = {
  terminal: () => window.dispatchEvent(new CustomEvent("flightdeck-terminal-settings-changed", { detail: getTerminalSettings() })),
  memory: () => window.dispatchEvent(new CustomEvent(MEMORY_CEILING_EVENT, { detail: getMemoryCeilingMb() })),
  hooks: () => window.dispatchEvent(new CustomEvent(HOOKS_CHANGED_EVENT, { detail: hooksInstalled() })),
  appearance: () => bootAppearance(),
  reading: () => applyReadingSettings(),
};

export function applyStorageChange(key: string | null): void {
  for (const a of new Set(actionsFor(key))) {
    try { RUN[a](); } catch { /* one bad apply must not stop the others */ }
  }
}

/** Arm once, from main.tsx. Inert with a single window (no other writer exists). */
export function armStorageSync(): void {
  window.addEventListener("storage", (e) => {
    if (e.storageArea && e.storageArea !== window.localStorage) return;
    applyStorageChange(e.key);
  });
}
