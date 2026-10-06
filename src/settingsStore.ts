// settingsStore.ts: the non-UI half of Settings (getters, defaults, pure helpers).
// Eager on purpose: boot, Terminal, session and the palette read these, and
// Settings.tsx itself is a lazy chunk. Settings.tsx re-exports everything here.
import { useEffect } from "react";
import { relTime } from "./format";
import { useUI } from "./ui";
import { isMainWindow } from "./persist";
import { getPendingReleaseNotes, clearPendingReleaseNotes } from "./updater";

// ---------------------------------------------------------------------
// Terminal settings (88). Persisted + exported for Terminal.tsx to read.
// Terminal.tsx (owned by another agent) can do:
//   import { getTerminalSettings } from "./Settings";
//   const t = getTerminalSettings();
//   new XTerm({ fontFamily: t.fontFamily, fontSize: t.fontSize, cursorStyle: t.cursorStyle, scrollback: t.scrollback, ... })
// and optionally listen for live changes:
//   window.addEventListener("flightdeck-terminal-settings-changed", (e) => { ... (e as CustomEvent).detail })
// ---------------------------------------------------------------------
export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  /** 1.5a: xterm minimumContrastRatio. 1 = off, 4.5 = WCAG AA (VS Code's default). */
  minimumContrastRatio: number;
  /** 1.5c: xterm lineHeight multiplier (1 = xterm's own default). */
  lineHeight: number;
  /** H2: selecting text with the mouse copies it (Windows Terminal style). */
  copyOnSelect: boolean;
  /** H2: right-click copies a selection / pastes, or opens the pane menu. */
  rightClick: "paste" | "menu";
}
export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: "JetBrains Mono", fontSize: 12.5, cursorStyle: "block", scrollback: 5000,
  minimumContrastRatio: 4.5, lineHeight: 1,
  copyOnSelect: true, rightClick: "paste",
};
export const CONTRAST_RANGE = { min: 1, max: 7, step: 0.5 } as const;
export const TERM_LINE_HEIGHT_RANGE = { min: 1, max: 1.6, step: 0.05 } as const;
export function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}
/** The xterm options this module owns, clamped. Used for creation and live apply. */
export function terminalReadabilityOptions(t: TerminalSettings = getTerminalSettings()): { minimumContrastRatio: number; lineHeight: number } {
  return {
    minimumContrastRatio: clampNum(t.minimumContrastRatio, CONTRAST_RANGE.min, CONTRAST_RANGE.max, DEFAULT_TERMINAL_SETTINGS.minimumContrastRatio),
    lineHeight: clampNum(t.lineHeight, TERM_LINE_HEIGHT_RANGE.min, TERM_LINE_HEIGHT_RANGE.max, DEFAULT_TERMINAL_SETTINGS.lineHeight),
  };
}

// ---------------------------------------------------------------------
// Reading settings (1.5b/1.5c): Preview text size, interface text size,
// Preview line height and reading width. Persisted at
// "flightdeck-reading-settings" and applied as root CSS variables
// (--prv-fs, --prv-lh, --prv-width, --ui-fs-scale), so no component needs to
// re-render. Interface text size scales the --fs-* tokens only: terminals are
// untouched and whole-app zoom (applyUiScale) stays independent.
// ---------------------------------------------------------------------
export type PreviewWidth = "narrow" | "medium" | "full";
export interface ReadingSettings {
  previewFontSize: number;
  uiTextScale: number;
  previewLineHeight: number;
  previewWidth: PreviewWidth;
}
export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  previewFontSize: 14, uiTextScale: 1, previewLineHeight: 1.6, previewWidth: "medium",
};
export const PREVIEW_FONT_RANGE = { min: 10, max: 24, step: 1 } as const;
export const UI_TEXT_SCALE_RANGE = { min: 0.85, max: 1.3, step: 0.05 } as const;
export const PREVIEW_LH_RANGE = { min: 1.4, max: 1.9, step: 0.05 } as const;
export const PREVIEW_WIDTHS: Record<PreviewWidth, { label: string; css: string }> = {
  narrow: { label: "Narrow", css: "70ch" },
  medium: { label: "Medium", css: "90ch" },
  full: { label: "Full", css: "none" },
};
export const READING_SETTINGS_KEY = "flightdeck-reading-settings";
export function getReadingSettings(): ReadingSettings {
  const d = DEFAULT_READING_SETTINGS;
  try {
    const raw = localStorage.getItem(READING_SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw) ?? {};
      return {
        previewFontSize: clampNum(p.previewFontSize, PREVIEW_FONT_RANGE.min, PREVIEW_FONT_RANGE.max, d.previewFontSize),
        uiTextScale: clampNum(p.uiTextScale, UI_TEXT_SCALE_RANGE.min, UI_TEXT_SCALE_RANGE.max, d.uiTextScale),
        previewLineHeight: clampNum(p.previewLineHeight, PREVIEW_LH_RANGE.min, PREVIEW_LH_RANGE.max, d.previewLineHeight),
        previewWidth: p.previewWidth in PREVIEW_WIDTHS ? p.previewWidth : d.previewWidth,
      };
    }
  } catch { /* non-persistent */ }
  return d;
}
/** Writes the CSS variables. Safe to call at boot before React mounts. */
export function applyReadingSettings(r: ReadingSettings = getReadingSettings()): void {
  const st = document.documentElement.style;
  st.setProperty("--prv-fs", `${r.previewFontSize}px`);
  st.setProperty("--prv-lh", String(r.previewLineHeight));
  st.setProperty("--prv-width", PREVIEW_WIDTHS[r.previewWidth].css);
  st.setProperty("--ui-fs-scale", String(r.uiTextScale));
}
export function saveReadingSettings(patch: Partial<ReadingSettings>): ReadingSettings {
  const next = { ...getReadingSettings(), ...patch };
  try { localStorage.setItem(READING_SETTINGS_KEY, JSON.stringify(next)); } catch { /* non-persistent */ }
  applyReadingSettings(next);
  return next;
}

// 1.5a preview helpers: WCAG contrast, and the colour xterm would nudge a dim
// foreground to for a given minimum ratio (it lightens or darkens until met).
export function parseRgb(css: string): [number, number, number] | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
export function adjustForContrast(fg: [number, number, number], bg: [number, number, number], ratio: number): [number, number, number] {
  if (ratio <= 1 || contrastRatio(fg, bg) >= ratio) return fg;
  const target: [number, number, number] = luminance(bg) > 0.5 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = fg.map((v, i) => Math.round(v + (target[i] - v) * t)) as [number, number, number];
    if (contrastRatio(c, bg) >= ratio) return c;
  }
  return target;
}
export const TERMINAL_FONTS = ["JetBrains Mono", "Cascadia Code", "Consolas", "Fira Code", "Menlo", "ui-monospace"];

export function getTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem("flightdeck-terminal-settings");
    if (raw) return { ...DEFAULT_TERMINAL_SETTINGS, ...JSON.parse(raw) };
  } catch { /* non-persistent */ }
  return DEFAULT_TERMINAL_SETTINGS;
}
export function saveTerminalSettings(patch: Partial<TerminalSettings>): TerminalSettings {
  const next = { ...getTerminalSettings(), ...patch };
  try { localStorage.setItem("flightdeck-terminal-settings", JSON.stringify(next)); } catch { /* non-persistent */ }
  window.dispatchEvent(new CustomEvent("flightdeck-terminal-settings-changed", { detail: next }));
  return next;
}

// ---------------------------------------------------------------------
// Shortcut editor (89). Rebinding is persisted here; the two real
// shortcuts today (Ctrl+, and Ctrl+B) are still hardcoded in Cockpit.tsx's
// keydown handler (a file this agent doesn't own) — see the report for the
// small diff that would make it read `getShortcuts()` instead.
// ---------------------------------------------------------------------
export interface ShortcutDef { id: string; label: string; combo: string; }
export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  { id: "settings", label: "Open settings", combo: "Ctrl+," },
  { id: "toggle-panel", label: "Toggle side panel", combo: "Ctrl+B" },
];
// Shipped shortcuts that aren't rebindable — hardcoded elsewhere (CommandPalette's
// own key handler, Cockpit's global keydown, PaneView's pane-scoped ones). Shown
// here read-only so Settings doesn't undersell what the app actually supports.
// UX-545/530: this is now the single source both the Settings list, the
// command palette's shortcut hints, and the standalone cheat sheet
// (Shortcuts.tsx) read from — the fix for the old #105/#269 duplicate-entry
// problem was never having two hand-typed copies to drift apart.
export const FIXED_SHORTCUTS: ShortcutDef[] = [
  { id: "cmdp-k", label: "Command palette", combo: "Ctrl+K" },
  { id: "quickopen-p", label: "Quick open (go to file)", combo: "Ctrl+P" },
  { id: "focus-recent-output", label: "Jump to pane with newest output", combo: "`" },
  { id: "cycle-attention", label: "Cycle panes needing attention", combo: "Ctrl+Alt+Shift+Arrows" },
  { id: "nav-back-forward", label: "Preview back / forward", combo: "Mouse 4 / 5" },
  { id: "cheat-sheet", label: "Keyboard shortcuts cheat sheet", combo: "?" },
  { id: "switch-workspace", label: "Switch to workspace 1-9", combo: "Ctrl+1..9" },
  { id: "cycle-workspace", label: "Cycle workspaces (most-recent first)", combo: "Ctrl+Tab" },
  { id: "cycle-workspace-back", label: "Cycle workspaces backwards", combo: "Ctrl+Shift+Tab" },
  { id: "attention-queue", label: "Open attention queue", combo: "Ctrl+Shift+A" },
  { id: "home", label: "Open Home", combo: "Ctrl+Shift+H" },
  { id: "focus-pane-n", label: "Focus pane 1-9 in this workspace", combo: "Alt+1..9" },
  { id: "focus-pane-arrows", label: "Move pane focus", combo: "Ctrl+Alt+Arrows" },
  { id: "close-pane", label: "Close the focused pane", combo: "Ctrl+W" },
  { id: "toggle-chat-view", label: "Toggle Terminal / Chat view (Claude pane)", combo: "Ctrl+Shift+M" },
  { id: "close-workspace", label: "Close the active workspace", combo: "Ctrl+Shift+W" },
  { id: "zoom-in", label: "Zoom in (whole app)", combo: "Ctrl+=" },
  { id: "zoom-out", label: "Zoom out (whole app)", combo: "Ctrl+-" },
  { id: "zoom-reset", label: "Reset zoom", combo: "Ctrl+0" },
  // Phase 4: active only with Settings > Windows > Multiple windows (preview) on.
  { id: "move-workspace-window", label: "Move workspace to new window (multiple windows preview)", combo: "Ctrl+Shift+N" },
  { id: "next-window", label: "Next window (multiple windows preview)", combo: "Ctrl+Shift+O" },
];
// Bound only while a specific surface has focus, so they're listed separately
// in the cheat sheet rather than implying they work everywhere.
export const CONTEXTUAL_SHORTCUTS: Array<ShortcutDef & { context: string }> = [
  { id: "review-next-file", label: "Next changed file", combo: "J", context: "Review drawer" },
  { id: "review-prev-file", label: "Previous changed file", combo: "K", context: "Review drawer" },
  { id: "review-next-hunk", label: "Next diff hunk", combo: "N", context: "Review drawer" },
  { id: "review-prev-hunk", label: "Previous diff hunk", combo: "P", context: "Review drawer" },
];
export function getShortcuts(): ShortcutDef[] {
  let overrides: Record<string, string> = {};
  try { overrides = JSON.parse(localStorage.getItem("flightdeck-shortcuts") || "{}"); } catch { /* non-persistent */ }
  return DEFAULT_SHORTCUTS.map((s) => ({ ...s, combo: overrides[s.id] ?? s.combo }));
}
export function saveShortcut(id: string, combo: string) {
  let overrides: Record<string, string> = {};
  try { overrides = JSON.parse(localStorage.getItem("flightdeck-shortcuts") || "{}"); } catch { /* non-persistent */ }
  overrides[id] = combo;
  try { localStorage.setItem("flightdeck-shortcuts", JSON.stringify(overrides)); } catch { /* non-persistent */ }
}
export function resetShortcuts() {
  try { localStorage.removeItem("flightdeck-shortcuts"); } catch { /* non-persistent */ }
}
export function formatCombo(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join("+");
}

// ---------------------------------------------------------------------
// Agents settings (90). Default vendor + per-vendor flags/binary path
// overrides. Vendor ids mirror src-tauri/src/lib.rs's VENDORS table.
// Persisted here for the launcher / pty_spawn call sites to read later.
// ---------------------------------------------------------------------
// Vendor list comes from the Rust registry (src/vendors.ts) — never hardcode it
// here, or a newly-added agent silently gets no settings row (BACKLOG 216).
export interface AgentSettings {
  defaultVendor: string;
  flags: Record<string, string>;
  binaryPaths: Record<string, string>;
  /** TN: initial detail level of the Chat view's Normal/Verbose toggle. */
  chatDetail: "normal" | "verbose";
  /** TN1: the view NEW Claude panes open in (saved panes keep their own). */
  openClaudeIn: "chat" | "terminal";
}
export const DEFAULT_AGENT_SETTINGS: AgentSettings = { defaultVendor: "claude", flags: {}, binaryPaths: {}, chatDetail: "normal", openClaudeIn: "chat" };
export function getAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem("flightdeck-agent-settings");
    if (raw) {
      const p = JSON.parse(raw);
      return { ...DEFAULT_AGENT_SETTINGS, ...p, flags: { ...p.flags }, binaryPaths: { ...p.binaryPaths } };
    }
  } catch { /* non-persistent */ }
  return DEFAULT_AGENT_SETTINGS;
}
export function saveAgentSettings(next: AgentSettings) {
  try { localStorage.setItem("flightdeck-agent-settings", JSON.stringify(next)); } catch { /* non-persistent */ }
}

// ---------------------------------------------------------------------
// Editor choice (UX-517 / UX-516). Persisted here for the open-in-editor
// call site (elsewhere) to read. Persisted key: "flightdeck-editor-settings".
// Shape: { editor: EditorId, command: string }. `command` is always the FULL
// resolved command template (preset commands are copied in verbatim when a
// preset is picked, so the consumer never needs its own copy of the preset
// table) — replace the literal substrings "{file}", "{line}" and "{col}" with the
// target path and 1-based line number, then run it. Presets shell out via
// each editor's own CLI launcher; "custom" is whatever the user typed.
// ---------------------------------------------------------------------
export type EditorId = "vscode" | "vscode-insiders" | "jetbrains" | "notepadpp" | "custom";
export interface EditorSettings { editor: EditorId; command: string; }
export const EDITOR_PRESETS: Record<Exclude<EditorId, "custom">, { label: string; command: string }> = {
  vscode: { label: "VS Code", command: 'code --goto "{file}:{line}:{col}"' },
  "vscode-insiders": { label: "VS Code Insiders", command: 'code-insiders --goto "{file}:{line}:{col}"' },
  jetbrains: { label: "JetBrains IDE", command: 'idea64 --line {line} "{file}"' },
  notepadpp: { label: "Notepad++", command: 'notepad++ -n{line} "{file}"' },
};
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { editor: "vscode", command: EDITOR_PRESETS.vscode.command };
export const EDITOR_SETTINGS_KEY = "flightdeck-editor-settings";
export function getEditorSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(EDITOR_SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.editor === "string" && typeof p.command === "string") return p;
    }
  } catch { /* non-persistent */ }
  return DEFAULT_EDITOR_SETTINGS;
}
export function saveEditorSettings(next: EditorSettings) {
  try { localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(next)); } catch { /* non-persistent */ }
}
/** Fills a command template with a concrete file (and optional 1-based line).
 *  Pure — shared by the live preview below and by whichever call site ends up
 *  owning the actual editor launch. */
export function resolveEditorCommand(template: string, file: string, line?: number, col?: number): string {
  // .split().join() rather than replaceAll — this project targets ES2020.
  return template
    .split("{file}").join(file)
    .split("{line}").join(line != null ? String(line) : "1")
    .split("{col}").join(col != null ? String(col) : "1");
}

// ---------------------------------------------------------------------
// Startup behaviour (91).
// ---------------------------------------------------------------------
export type StartupBehavior = "reopen" | "launcher";
export function getStartupBehavior(): StartupBehavior {
  try { return (localStorage.getItem("flightdeck-startup") as StartupBehavior) || "launcher"; } catch { return "launcher"; }
}
export function saveStartupBehavior(v: StartupBehavior) {
  try { localStorage.setItem("flightdeck-startup", v); } catch { /* non-persistent */ }
}

// Phase 4: multiple windows (preview), default off. Main reports it to Rust in
// window_boot, so a change applies on the next launch.
export function getMultiwindow(): boolean {
  try { return localStorage.getItem("flightdeck-multiwindow") === "1"; } catch { return false; }
}
export function saveMultiwindow(on: boolean) {
  try { localStorage.setItem("flightdeck-multiwindow", on ? "1" : "0"); } catch { /* non-persistent */ }
}

// Shown in About + useful for bug reports. Keep in step with package.json /
// tauri.conf.json version bumps.
export const APP_VERSION = "0.6.0";

// UX-600: "what's new since your last version", fed by the release manifest's
// own `notes` field (releases\latest.json, round-tripped through updater.ts'
// getPendingReleaseNotes — see the comment there) rather than a second
// hand-typed copy of the changelog below. Pure so it's testable without a
// component: seenVersion is what Settings last recorded showing, pending is
// whatever checkForUpdate most recently captured.
export function shouldShowWhatsNew(
  currentVersion: string,
  seenVersion: string | null,
  pending: { version: string; notes: string } | null
): boolean {
  if (currentVersion === seenVersion) return false;
  return !!pending && pending.version === currentVersion && pending.notes.trim().length > 0;
}
export const WHATSNEW_SEEN_KEY = "flightdeck-whatsnew-seen-version";

// UX-600: runs once at boot from App (eager). It used to live in Settings,
// which is a lazy chunk mounted only while open, so the boot toast never fired.
export function useWhatsNew() {
  useEffect(() => {
    if (!isMainWindow()) return; // secondary windows never show the update banner
    let seen: string | null = null;
    try { seen = localStorage.getItem(WHATSNEW_SEEN_KEY); } catch { /* non-persistent */ }
    const pending = getPendingReleaseNotes();
    if (shouldShowWhatsNew(APP_VERSION, seen, pending)) {
      useUI.getState().setWhatsNew(pending);
      useUI.getState().pushToast("info", `Updated to Flightdeck ${APP_VERSION} — see What’s new in Settings > About.`);
    }
    try { localStorage.setItem(WHATSNEW_SEEN_KEY, APP_VERSION); } catch { /* non-persistent */ }
    clearPendingReleaseNotes();
  }, []);
}

// Newest first; trim to the last ~10 entries as it grows.
export const CHANGELOG: Array<{ date: string; text: string }> = [
  { date: "2026-07-20", text: "\"Needs approval\" badge when an agent is blocked on a permission prompt; attention queue ranks it first." },
  { date: "2026-07-20", text: "Add any agent by dropping a JSON manifest in the vendors folder — no rebuild (see Agents above)." },
  { date: "2026-07-20", text: "Sessions persist: workspaces, panes, worktrees and the Board survive a restart, with a reopen prompt." },
  { date: "2026-07-20", text: "Custom accent colour — pick any colour; dark & light variants are derived automatically." },
  { date: "2026-07-20", text: "Diagnostics: per-pane CPU/memory, stray-process cleanup, redacted support-bundle export." },
  { date: "2026-07-19", text: "Worktree isolation: each agent works on its own branch in its own folder copy, with a review & merge drawer." },
];

// ---------------------------------------------------------------------
// Memory ceiling (UX-596, wired by QL-742). health.rs has always accepted a
// per-call `memory_warn_mb` and clamped it; the user-facing half was never
// built, so every pane_health call fell through to the backend's 1024MB
// default and the "configurable" ceiling was inert. This is that half.
//
// Persisted key: flightdeck-memory-ceiling (a plain number of MB). Instant
// apply: the setter dispatches flightdeck-memory-ceiling-changed, which the
// always-on health poll (Notifications.tsx → poll.ts) listens for, so a new
// ceiling re-samples every pane at once rather than at the next 30s tick.
// Bounds mirror health.rs's own clamp, so the UI can never offer a value the
// backend would quietly reject.
// ---------------------------------------------------------------------
export const DEFAULT_MEMORY_CEILING_MB = 1024;
export const MIN_MEMORY_CEILING_MB = 64;
export const MAX_MEMORY_CEILING_MB = 65536;
export const MEMORY_CEILING_KEY = "flightdeck-memory-ceiling";
export const MEMORY_CEILING_EVENT = "flightdeck-memory-ceiling-changed";

/** Same clamp health.rs applies, so what Settings shows is what the backend
 *  will use. Anything unparseable falls back to the default rather than 0 —
 *  a ceiling of 0 would flag every pane forever. */
export function clampMemoryCeiling(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_MEMORY_CEILING_MB;
  return Math.min(MAX_MEMORY_CEILING_MB, Math.max(MIN_MEMORY_CEILING_MB, Math.round(mb)));
}
export function getMemoryCeilingMb(): number {
  try {
    const raw = localStorage.getItem(MEMORY_CEILING_KEY);
    if (raw != null) return clampMemoryCeiling(Number(raw));
  } catch { /* non-persistent */ }
  return DEFAULT_MEMORY_CEILING_MB;
}
/** Persists and broadcasts; returns the value actually stored (clamped). */
export function setMemoryCeilingMb(mb: number): number {
  const next = clampMemoryCeiling(mb);
  try { localStorage.setItem(MEMORY_CEILING_KEY, String(next)); } catch { /* non-persistent */ }
  window.dispatchEvent(new CustomEvent(MEMORY_CEILING_EVENT, { detail: next }));
  return next;
}

// ---------------------------------------------------------------------
// QL-720: whether Claude Code's hooks are installed.
//
// The authority is ~/.claude/settings.json, which only the backend can read, so
// this is a CACHE of an external fact rather than a preference — which is why
// it lives in SESSION_KEYS (storageKeys.ts) and a settings reset leaves it
// alone. Its job is the first frame: Notifications can subscribe to hook events
// immediately on launch instead of waiting for an IPC round-trip, and the
// backend's answer then confirms or corrects it.
// ---------------------------------------------------------------------
export const HOOKS_INSTALLED_KEY = "flightdeck-hooks-installed";
export const HOOKS_CHANGED_EVENT = "flightdeck-hooks-changed";

export function hooksInstalled(): boolean {
  try { return localStorage.getItem(HOOKS_INSTALLED_KEY) === "1"; } catch { return false; }
}
/** Persists and broadcasts, same pairing as the memory ceiling above. */
export function setHooksInstalled(on: boolean): void {
  try {
    if (on) localStorage.setItem(HOOKS_INSTALLED_KEY, "1");
    else localStorage.removeItem(HOOKS_INSTALLED_KEY);
  } catch { /* non-persistent */ }
  window.dispatchEvent(new CustomEvent(HOOKS_CHANGED_EVENT, { detail: on }));
}

export interface HookStatus {
  relayInstalled: boolean;
  hooksDir: string;
  settingsPath: string;
  settingsInstalled: boolean;
  settingsError: string | null;
  lastEventAgeMs: number | null;
}

/** The one status sentence the row shows. Deliberately says what is true right
 *  now rather than what should be true: "installed, but Flightdeck's relay is
 *  missing" is a real state (app data wiped, or the folder was cleaned) and it
 *  needs its own line, because reinstalling is the fix and nothing else is. */
export function hookStatusLine(s: HookStatus | null, now: number = Date.now()): string {
  if (!s) return "Checking…";
  if (s.settingsError) return s.settingsError;
  if (!s.relayInstalled) return "Flightdeck's relay script is missing — restart Flightdeck, then install.";
  if (!s.settingsInstalled) return "Not installed — Flightdeck is guessing pane state from terminal output.";
  if (s.lastEventAgeMs == null) return "Installed — waiting for the first hook to fire.";
  return `Installed — last hook ${relTime(now - s.lastEventAgeMs, now)}.`;
}

