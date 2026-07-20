// storageKeys.ts — the canonical list of what Flightdeck persists.
//
// This exists because "reset all settings" drifted twice: it listed
// `flightdeck-ui-scale` and `flightdeck-colorblind` while the code actually
// writes `flightdeck-uiscale` and `flightdeck-cb-safe`, so those two settings
// silently survived a reset. storageKeys.test.ts now scans the source for every
// `flightdeck-*` key and fails if one isn't classified here, which makes the
// drift impossible rather than merely fixed.

/** Appearance and behaviour preferences. "Reset all settings" clears these. */
export const PREFERENCE_KEYS = [
  "flightdeck-theme",
  "flightdeck-theme-id",
  "flightdeck-theme-custom",
  "flightdeck-accent",
  "flightdeck-accent-custom",
  "flightdeck-vendor-accents",
  "flightdeck-cb-safe",
  "flightdeck-reduced-motion",
  "flightdeck-uiscale",
  "flightdeck-terminal-settings",
  "flightdeck-terminal-settings-changed",
  "flightdeck-shortcuts",
  "flightdeck-agent-settings",
  "flightdeck-startup",
  "flightdeck-notify-settings",
  "flightdeck-auto-queue",
  "flightdeck-follow-attention",
  "flightdeck-explorer-width",
  "flightdeck-explorer-scope",
  "flightdeck-explorer-open",
  "flightdeck-explorer-expanded",
  "flightdeck-diff-split",
  "flightdeck-vendor-fonts",
  "flightdeck-ws-tint",
  "flightdeck-ws-sort",
  "flightdeck-isolate",
] as const;

/**
 * Working state, NOT preferences: what you were doing rather than how you like
 * things. A settings reset must leave these alone — wiping someone's recent
 * folders or last-active times because they wanted default colours would be a
 * nasty surprise.
 */
export const SESSION_KEYS = [
  "flightdeck-clean-exit",
  "flightdeck-recent-roots",
  "flightdeck-cmdp-recent",
  "flightdeck-ws-lastactive",
] as const;

/**
 * Per-repo keys, written as `<prefix><repo path>`. Also working state.
 */
export const SESSION_KEY_PREFIXES = ["flightdeck-setup:", "flightdeck-layout:"] as const;

/** Clear every preference key. Session/working state is deliberately untouched. */
export function clearPreferences() {
  for (const k of PREFERENCE_KEYS) {
    try { localStorage.removeItem(k); } catch { /* non-persistent */ }
  }
}
