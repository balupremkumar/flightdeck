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
  // QL-784: last-used theme per mode + the Light/Dark/Follow-Windows choice.
  // Appearance preferences, so a settings reset clears them with the theme.
  "flightdeck-theme-dark",
  "flightdeck-theme-light",
  "flightdeck-appearance-mode",
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
  // UX-596/QL-742: per-pane memory warning ceiling (MB) + the live-apply event
  // name that travels with it, same pairing as the terminal settings above.
  "flightdeck-memory-ceiling",
  "flightdeck-memory-ceiling-changed",
  "flightdeck-notify-settings",
  "flightdeck-auto-queue",
  "flightdeck-follow-attention",
  "flightdeck-explorer-width",
  "flightdeck-explorer-scope",
  "flightdeck-explorer-open",
  "flightdeck-explorer-expanded",
  "flightdeck-diff-split",
  "flightdeck-vendor-fonts",
  // UX-560: per-vendor "quiet before we call it waiting" default. A cosmetic
  // tuning preference, so a settings reset should clear it with the rest.
  "flightdeck-vendor-quiet",
  "flightdeck-ws-tint",
  "flightdeck-ws-sort",
  "flightdeck-isolate",
  "flightdeck-auto-update-check",
  "flightdeck-releases-dir",
  "flightdeck-editor-settings",
] as const;

/**
 * Working state, NOT preferences: what you were doing rather than how you like
 * things. A settings reset must leave these alone — wiping someone's recent
 * folders or last-active times because they wanted default colours would be a
 * nasty surprise.
 */
export const SESSION_KEYS = [
  // K0a: repos the user has consciously let a trust-requiring agent into.
  // Deliberately NOT a preference — "reset all settings" is a cosmetic action
  // and must not silently clear a security decision. (Re-prompting would be the
  // safe direction, but a surprise prompt after a colour reset is still wrong.)
  "flightdeck-trusted-repos",
  "flightdeck-clean-exit",
  "flightdeck-broadcast-snippets",
  "flightdeck-recent-roots",
  "flightdeck-cmdp-recent",
  "flightdeck-ws-lastactive",
  // UX-562: named session snapshots. Emphatically NOT a preference — a
  // settings reset must never destroy saved sessions the user deliberately
  // named and kept.
  "flightdeck-session-snapshots",
  // UX-600: bookkeeping for the "what's new since your last version" panel —
  // not a preference (nothing to configure), so a settings reset must not
  // make the banner reappear for a version you've already seen.
  "flightdeck-whatsnew-seen-version",
  "flightdeck-pending-release-notes",
  // UPD-1: the last failed update attempt, kept so Settings > About can still
  // show it after the boot toast has gone. Not a preference — a colour reset
  // must not erase the only record of "your update silently did nothing".
  "flightdeck-update-failure",
  // UX-551: per-vendor sent-prompt history (prompthistory.ts) — recall state,
  // not a preference, same reasoning as flightdeck-broadcast-snippets above.
  "flightdeck-prompt-history",
  // UX-540/527 (other wave-1 work): per-pane scroll position and the recent-
  // files list are both "what you were doing", not appearance/behaviour.
  "flightdeck-explorer-scroll",
  "flightdeck-quickopen-recent",
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
