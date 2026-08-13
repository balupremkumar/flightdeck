import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { revealPath } from "./reveal";
import { useUI, useOverlayEsc, ZOOM_STEPS } from "./ui";
import { useApp } from "./store";
import { bytes, relTime, absTime } from "./format";
import { useFocusTrap } from "./useFocusTrap";
import { listRestorePoints, restoreFromPoint, exportBackup, importBackup, type RestorePointInfo } from "./persist";
import { adoptSession, lastSessionSaveAt } from "./session";
import { clearPreferences, PREFERENCE_KEYS } from "./storageKeys";
import {
  checkForUpdate, installUpdate, getReleasesDir, setReleasesDir,
  getAutoUpdateCheck, setAutoUpdateCheck, DEFAULT_RELEASES_DIR,
  getPendingReleaseNotes, clearPendingReleaseNotes, type UpdateCheckResult,
  getUpdateFailure, clearUpdateFailure,
  listRollbackCandidates, type RollbackCandidate,
} from "./updater";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { trustedRepos, untrustRepo } from "./trust";
import { spawnPane } from "./worktrees";
import { useVendors, vendorColor, vendorAccentOverrides, setVendorAccentOverride } from "./vendors";
import { IconClose } from "./Icons";
import { ConfigDoctorView } from "./ConfigDoctorView";
import {
  THEMES, ACCENTS, findTheme, findAccent, CUSTOM_ACCENT_ID, customAccentHex, setCustomAccent,
  applyTheme, applyAccent, setAccent,
  currentThemeId, currentAccentId,
  isColorBlindSafe, setColorBlindSafe, applyColorBlindSafe,
  isReducedMotion, setReducedMotion,
  exportThemeJson, importThemeJson,
  DEFAULT_THEME_ID, DEFAULT_ACCENT_ID,
  appearanceMode, setAppearanceMode, applyThemeForMode, type AppearanceMode,
} from "./themes";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getName } from "@tauri-apps/api/app";
import "./overlays.css";

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
}
const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: "JetBrains Mono", fontSize: 12.5, cursorStyle: "block", scrollback: 5000,
};
const TERMINAL_FONTS = ["JetBrains Mono", "Cascadia Code", "Consolas", "Fira Code", "Menlo", "ui-monospace"];

export function getTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem("flightdeck-terminal-settings");
    if (raw) return { ...DEFAULT_TERMINAL_SETTINGS, ...JSON.parse(raw) };
  } catch { /* non-persistent */ }
  return DEFAULT_TERMINAL_SETTINGS;
}
function saveTerminalSettings(patch: Partial<TerminalSettings>): TerminalSettings {
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
const DEFAULT_SHORTCUTS: ShortcutDef[] = [
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
  { id: "focus-pane-n", label: "Focus pane 1-9 in this workspace", combo: "Alt+1..9" },
  { id: "focus-pane-arrows", label: "Move pane focus", combo: "Ctrl+Alt+Arrows" },
  { id: "close-pane", label: "Close the focused pane", combo: "Ctrl+W" },
  { id: "close-workspace", label: "Close the active workspace", combo: "Ctrl+Shift+W" },
  { id: "zoom-in", label: "Zoom in (whole app)", combo: "Ctrl+=" },
  { id: "zoom-out", label: "Zoom out (whole app)", combo: "Ctrl+-" },
  { id: "zoom-reset", label: "Reset zoom", combo: "Ctrl+0" },
];
// Bound only while a specific surface has focus, so they're listed separately
// in the cheat sheet rather than implying they work everywhere.
export const CONTEXTUAL_SHORTCUTS: Array<ShortcutDef & { context: string }> = [
  { id: "review-next-file", label: "Next changed file", combo: "J", context: "Review drawer" },
  { id: "review-prev-file", label: "Previous changed file", combo: "K", context: "Review drawer" },
  { id: "review-next-hunk", label: "Next diff hunk", combo: "N", context: "Review drawer" },
  { id: "review-prev-hunk", label: "Previous diff hunk", combo: "P", context: "Review drawer" },
  { id: "board-move-column", label: "Move focused card to the next/previous column", combo: "Arrow ←/→", context: "Board (card focused)" },
  { id: "board-reorder-card", label: "Reorder the focused card within its column", combo: "Arrow ↑/↓", context: "Board (card focused)" },
];
export function getShortcuts(): ShortcutDef[] {
  let overrides: Record<string, string> = {};
  try { overrides = JSON.parse(localStorage.getItem("flightdeck-shortcuts") || "{}"); } catch { /* non-persistent */ }
  return DEFAULT_SHORTCUTS.map((s) => ({ ...s, combo: overrides[s.id] ?? s.combo }));
}
function saveShortcut(id: string, combo: string) {
  let overrides: Record<string, string> = {};
  try { overrides = JSON.parse(localStorage.getItem("flightdeck-shortcuts") || "{}"); } catch { /* non-persistent */ }
  overrides[id] = combo;
  try { localStorage.setItem("flightdeck-shortcuts", JSON.stringify(overrides)); } catch { /* non-persistent */ }
}
function resetShortcuts() {
  try { localStorage.removeItem("flightdeck-shortcuts"); } catch { /* non-persistent */ }
}
function formatCombo(e: KeyboardEvent): string | null {
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
}
const DEFAULT_AGENT_SETTINGS: AgentSettings = { defaultVendor: "claude", flags: {}, binaryPaths: {} };
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
function saveAgentSettings(next: AgentSettings) {
  try { localStorage.setItem("flightdeck-agent-settings", JSON.stringify(next)); } catch { /* non-persistent */ }
}

// ---------------------------------------------------------------------
// Editor choice (UX-517 / UX-516). Persisted here for the open-in-editor
// call site (elsewhere) to read. Persisted key: "flightdeck-editor-settings".
// Shape: { editor: EditorId, command: string }. `command` is always the FULL
// resolved command template (preset commands are copied in verbatim when a
// preset is picked, so the consumer never needs its own copy of the preset
// table) — replace the literal substrings "{file}" and "{line}" with the
// target path and 1-based line number, then run it. Presets shell out via
// each editor's own CLI launcher; "custom" is whatever the user typed.
// ---------------------------------------------------------------------
export type EditorId = "vscode" | "vscode-insiders" | "jetbrains" | "notepadpp" | "custom";
export interface EditorSettings { editor: EditorId; command: string; }
export const EDITOR_PRESETS: Record<Exclude<EditorId, "custom">, { label: string; command: string }> = {
  vscode: { label: "VS Code", command: 'code --goto "{file}:{line}"' },
  "vscode-insiders": { label: "VS Code Insiders", command: 'code-insiders --goto "{file}:{line}"' },
  jetbrains: { label: "JetBrains IDE", command: 'idea64 --line {line} "{file}"' },
  notepadpp: { label: "Notepad++", command: 'notepad++ -n{line} "{file}"' },
};
const DEFAULT_EDITOR_SETTINGS: EditorSettings = { editor: "vscode", command: EDITOR_PRESETS.vscode.command };
const EDITOR_SETTINGS_KEY = "flightdeck-editor-settings";
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
function saveEditorSettings(next: EditorSettings) {
  try { localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(next)); } catch { /* non-persistent */ }
}
/** Fills a command template with a concrete file (and optional 1-based line).
 *  Pure — shared by the live preview below and by whichever call site ends up
 *  owning the actual editor launch. */
export function resolveEditorCommand(template: string, file: string, line?: number): string {
  // .split().join() rather than replaceAll — this project targets ES2020.
  return template.split("{file}").join(file).split("{line}").join(line != null ? String(line) : "1");
}

// ---------------------------------------------------------------------
// Startup behaviour (91).
// ---------------------------------------------------------------------
export type StartupBehavior = "reopen" | "launcher";
export function getStartupBehavior(): StartupBehavior {
  try { return (localStorage.getItem("flightdeck-startup") as StartupBehavior) || "launcher"; } catch { return "launcher"; }
}
function saveStartupBehavior(v: StartupBehavior) {
  try { localStorage.setItem("flightdeck-startup", v); } catch { /* non-persistent */ }
}

// Shown in About + useful for bug reports. Keep in step with package.json /
// tauri.conf.json version bumps.
export const APP_VERSION = "0.5.4";

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
const WHATSNEW_SEEN_KEY = "flightdeck-whatsnew-seen-version";

// Newest first; trim to the last ~10 entries as it grows.
const CHANGELOG: Array<{ date: string; text: string }> = [
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
const MEMORY_CEILING_KEY = "flightdeck-memory-ceiling";
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
const HOOKS_INSTALLED_KEY = "flightdeck-hooks-installed";
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

// ---------------------------------------------------------------------
// Diagnostics (UI-4 / QOL 375-377): surfaces three backend capabilities that
// were built + tested but had zero UI — per-pane health, stray-process
// recovery, and the redacted support bundle.
// ---------------------------------------------------------------------
interface PaneHealthRow {
  paneId: number; pid: number; cpuPercent: number; memoryMb: number; procName: string;
  /** UX-596: the threshold the backend compared this reading against, echoed
   *  back so the UI can label the number instead of inventing its own. */
  memoryWarnMb?: number;
  overMemoryWarn?: boolean;
}
interface OrphanRow { pid: number; ppid: number; name: string; }

// UI-633: threshold colouring for the health table. Memory uses the backend's
// own resolved ceiling (`overMemoryWarn`), so there is exactly one memory
// threshold in the app; critical is simply double that same number, not a
// second invented one. CPU has no backend threshold, so it gets an explicit
// one here: cpuPercent is % of ONE core and is not normalised across cores, so
// ~a saturated core warns and two-plus saturated cores is critical.
const CPU_WARN_PERCENT = 90;
const CPU_CRIT_PERCENT = 200;
export function cpuLevelClass(cpuPercent: number): string {
  if (cpuPercent >= CPU_CRIT_PERCENT) return "diag-crit";
  if (cpuPercent >= CPU_WARN_PERCENT) return "diag-warn";
  return "";
}
export function memoryLevelClass(h: Pick<PaneHealthRow, "memoryMb" | "memoryWarnMb" | "overMemoryWarn">): string {
  const warnMb = h.memoryWarnMb;
  if (warnMb && h.memoryMb >= warnMb * 2) return "diag-crit";
  // Trust the backend's own compare when it made one; fall back to the echoed
  // threshold only if an older build didn't send the boolean.
  if (h.overMemoryWarn ?? (warnMb ? h.memoryMb >= warnMb : false)) return "diag-warn";
  return "";
}

// UX-599: one small header row shape shared by every section that has real
// per-section preference state to reset, so "reset this section" reads as one
// consistent affordance rather than a bespoke button per section (UI-632).
function SectionHead({ label, onReset }: { label: string; onReset?: () => void }) {
  return (
    <div className="set-section-head">
      <div className="set-label">{label}</div>
      {onReset && (
        <button className="set-section-reset" onClick={onReset}>Reset section</button>
      )}
    </div>
  );
}

// UI-185: ~60s of CPU history per pane, sampled at the same 3s cadence as the
// health poll (20 points). Plain inline SVG — one polyline, no charting lib.
const CPU_HISTORY_LEN = 20;
function Sparkline({ data }: { data: number[] }) {
  const w = 56, h = 18;
  if (data.length < 2) return <svg width={w} height={h} className="diag-spark" aria-hidden="true" />;
  const points = data
    .map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - (Math.min(v, 100) / 100) * h).toFixed(1)}`)
    .join(" ");
  const latest = data[data.length - 1];
  return (
    <svg width={w} height={h} className="diag-spark" role="img" aria-label={`CPU trend, latest ${latest.toFixed(0)}%`}>
      <polyline className="diag-spark-line" points={points} fill="none" strokeWidth="1.5" />
    </svg>
  );
}

// UI-191/192: restore points and one-file backup. persist.rs has shipped all
// of this since wave 2 with zero UI — every autosave already writes a snapshot,
// they were just unreachable.
function SessionSection() {
  const [points, setPoints] = useState<RestorePointInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    listRestorePoints()
      .then(setPoints)
      .catch(() => setPoints([]));
  };
  useEffect(refresh, []);

  const restore = (pt: RestorePointInfo) => {
    useUI.getState().requestConfirm({
      title: `Restore the session from ${relTime(pt.savedAt)}?`,
      body: "Your open workspaces are closed first (their isolated worktrees are cleaned up, keeping any work on its branch), then this snapshot is reopened. Running agents end.",
      confirmLabel: "Restore this point",
      danger: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          const doc = await restoreFromPoint(pt.id);
          await adoptSession(doc);
          useUI.getState().pushToast("success", `Restored the session from ${relTime(pt.savedAt)}.`);
        } catch (e) {
          useUI.getState().pushToast("error", `Couldn’t restore: ${String(e)}`);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const doExport = async () => {
    const dest = await save({
      title: "Save Flightdeck backup",
      defaultPath: `flightdeck-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    }).catch(() => null);
    if (!dest) return;
    try {
      await exportBackup(dest);
      useUI.getState().pushToast("success", "Backup saved.");
    } catch (e) {
      useUI.getState().pushToast("error", `Backup failed: ${String(e)}`);
    }
  };

  const doImport = async () => {
    const src = await openDialog({
      title: "Import Flightdeck backup",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    }).catch(() => null);
    if (typeof src !== "string") return;
    useUI.getState().requestConfirm({
      title: "Import this backup?",
      body: "It replaces your current session: open workspaces close (worktrees cleaned up, work kept on branches) and the backup’s workspaces reopen.",
      confirmLabel: "Import & replace",
      danger: true,
      onConfirm: async () => {
        try {
          const doc = await importBackup(src);
          if (doc) {
            await adoptSession(doc);
            useUI.getState().pushToast("success", "Backup imported.");
          } else {
            useUI.getState().pushToast("info", "That backup had no session in it — settings only.");
          }
          refresh();
        } catch (e) {
          useUI.getState().pushToast("error", `Import failed: ${String(e)}`);
        }
      },
    });
  };

  return (
    <section className="set-section">
      <div className="set-label">Session</div>
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Restore points</span>
          <span className="set-row-sub">Automatic snapshots, newest first — taken as you work</span>
        </div>
        <button className="set-btn" onClick={refresh}>Refresh</button>
      </div>
      {points === null && <div className="diag-empty">Loading…</div>}
      {points && points.length === 0 && (
        <div className="diag-empty">No restore points yet — they appear as the session autosaves.</div>
      )}
      {points && points.length > 0 && (
        <div className="diag-table" role="table" aria-label="Restore points">
          {points.map((pt) => (
            <div className="diag-tr" role="row" key={pt.id}>
              <span title={absTime(pt.savedAt)}>{relTime(pt.savedAt)}</span>
              <span className="diag-proc">{absTime(pt.savedAt)}</span>
              <span />
              <span />
              <button className="set-btn" disabled={busy} onClick={() => restore(pt)}>Restore</button>
            </div>
          ))}
        </div>
      )}

      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Backup</span>
          <span className="set-row-sub">One file with your session and preferences</span>
        </div>
        <button className="set-btn" onClick={() => void doExport()}>Export…</button>
        <button className="set-btn" onClick={() => void doImport()}>Import…</button>
      </div>
    </section>
  );
}

// In-app self-update (local-file only — no network, see src-tauri/src/updates.rs).
// Lives in the About section. `updateAvailable` comes from the shared store so
// this agrees with whatever last triggered a check (startup toast, the command
// palette, or the button below).
/** UX-592: how long the UI waits for a check before giving up on it. */
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
function UpdatesBlock() {
  const updateAvailable = useUI((s) => s.updateAvailable);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [autoCheck, setAutoCheckState] = useState(getAutoUpdateCheck());
  const [releasesDir, setReleasesDirState] = useState(getReleasesDir());
  // UPD-1: an update that failed did so while the app was CLOSED, so the only
  // in-app trace was a toast the user may never have seen. Keep it here until
  // it's dismissed — "the update silently did nothing" is the failure this
  // whole path exists to prevent.
  const [failure, setFailure] = useState(() => getUpdateFailure());

  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    // UX-592: the check itself never rejects (updater.ts catches), but it CAN
    // fail to answer: the releases folder is user-configurable and may be a
    // UNC share, and reading an unreachable share blocks for the SMB timeout.
    // Without a bound the button would sit on "Checking…", disabled, forever.
    // The underlying read can't be cancelled, so stop waiting on it and say so.
    const res = await Promise.race<UpdateCheckResult>([
      checkForUpdate(),
      new Promise<UpdateCheckResult>((resolve) =>
        window.setTimeout(
          () => resolve({ available: false, error: "The releases folder didn’t answer in 10 seconds. If it’s on a network drive, check that you’re connected." }),
          UPDATE_CHECK_TIMEOUT_MS,
        ),
      ),
    ]);
    setChecking(false);
    setLastCheckedAt(Date.now());
    if (res.error) setCheckError(res.error);
  };

  const doInstallPath = async (installerPath: string) => {
    setInstalling(true);
    setInstallError(null);
    try {
      await installUpdate(installerPath);
      // On success the app exits itself (updates.rs) — nothing else to do.
    } catch (e) {
      setInstalling(false);
      setInstallError(String(e));
    }
  };
  const doInstall = () => updateAvailable && void doInstallPath(updateAvailable.installerPath);

  const confirmInstall = () => {
    if (!updateAvailable) return;
    // Same live-session itemisation closePaneGuarded/closeWorkspaceGuarded use
    // (worktrees.ts) — an update install ends every running agent same as a quit.
    const live = useApp.getState().workspaces
      .flatMap((w) => w.panes)
      .filter((p) => p.state === "running" || p.state === "starting" || p.state === "waiting" || p.state === "permission");
    const liveNote = live.length > 0
      ? ` ${live.length} pane${live.length === 1 ? "" : "s"} still live — closing ends ${live.length === 1 ? "its session" : "their sessions"}, the running agents can’t be brought back.`
      : "";
    useUI.getState().requestConfirm({
      title: "Restart Flightdeck to finish updating?",
      body: `Installs Flightdeck ${updateAvailable.version} and relaunches.${liveNote}`,
      confirmLabel: "Install & restart",
      danger: live.length > 0,
      onConfirm: () => void doInstall(),
    });
  };

  // Rollback (deployment rework, phase 3): every cut leaves its installer in
  // the releases folder, so "go back to the version that worked" is a button
  // here instead of an uninstall/hunt/reinstall loop.
  const [rollbacks, setRollbacks] = useState<RollbackCandidate[]>([]);
  const [rollbackTo, setRollbackTo] = useState("");
  useEffect(() => {
    void listRollbackCandidates().then((c) => {
      setRollbacks(c);
      if (c.length > 0) setRollbackTo(c[0].version);
    });
  }, []);
  const confirmRollback = () => {
    const cand = rollbacks.find((c) => c.version === rollbackTo);
    if (!cand) return;
    const live = useApp.getState().workspaces
      .flatMap((w) => w.panes)
      .filter((p) => p.state === "running" || p.state === "starting" || p.state === "waiting" || p.state === "permission");
    const liveNote = live.length > 0
      ? ` ${live.length} pane${live.length === 1 ? "" : "s"} still live — closing ends ${live.length === 1 ? "its session" : "their sessions"}.`
      : "";
    useUI.getState().requestConfirm({
      title: `Roll back to Flightdeck ${cand.version}?`,
      body: `Installs ${cand.version} over ${APP_VERSION} and relaunches. Sessions and settings are kept, though features added since ${cand.version} won’t understand their newer data.${liveNote}`,
      confirmLabel: "Roll back & restart",
      danger: true,
      onConfirm: () => void doInstallPath(cand.installerPath),
    });
  };

  const toggleAutoCheck = () => {
    const next = !autoCheck;
    setAutoCheckState(next);
    setAutoUpdateCheck(next);
  };

  const commitReleasesDir = (v: string) => {
    setReleasesDirState(v);
    setReleasesDir(v);
  };

  // Canary flavour (deployment rework): a side-by-side trial install that
  // never self-updates — updates.rs returns none/rejects for it, so the whole
  // check/install UI would only mislead. Say what this build is instead.
  const [isCanary, setIsCanary] = useState(false);
  useEffect(() => {
    getName().then((n) => setIsCanary(n.includes("Canary"))).catch(() => {});
  }, []);
  if (isCanary) {
    return (
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Updates — Canary channel</span>
          <span className="set-row-sub">
            This is the side-by-side trial build with its own copy of your data. It never
            self-updates and never touches the stable install. Happy with it? Install the stable
            build of this version. Broken? Uninstall it — stable is exactly as you left it.
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Updates</span>
          {/* UX-584: one honest line per real state — checking, ready, up to
              date, or failed (below). There's no separate "downloading" state:
              the update is a local file already on this machine (see Settings
              > Releases folder), so nothing is fetched over the network. */}
          <span className="set-row-sub">
            {checking
              ? "Checking…"
              : installing
              ? `Installing ${updateAvailable?.version ?? ""}…`
              : updateAvailable
              ? `Ready to install — Flightdeck ${updateAvailable.version}`
              : checkError
              ? "Couldn’t check — see below"
              : lastCheckedAt
              ? `Up to date — checked ${relTime(lastCheckedAt)}`
              : "Not checked yet this session"}
          </span>
        </div>
        <button className="set-btn" onClick={() => void runCheck()} disabled={checking || installing}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>
      {checkError && <div className="set-error">Couldn’t check for updates: {checkError}</div>}
      {failure && (
        <div className="set-error set-update-failure">
          <div>Version {failure.version} didn’t install. {failure.message}</div>
          {failure.exitCode != null && <div className="set-error-detail">Installer exit code: {failure.exitCode}</div>}
          {failure.detail && <div className="set-error-detail">{failure.detail}</div>}
          <div className="set-update-failure-actions">
            {failure.manualPath && (
              <button
                className="set-btn"
                onClick={() => { void revealItemInDir(failure.manualPath!).catch(() => { /* best effort */ }); }}
              >
                Show me the installer
              </button>
            )}
            <button className="set-btn" onClick={() => { clearUpdateFailure(); setFailure(null); }}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {updateAvailable && (
        <div className="set-row set-row-block">
          {/* UX-585: the manifest's own notes, shown before the install button
              is ever clicked — never asking for a leap of faith. */}
          {updateAvailable.notes && (
            <div className="set-update-notes">
              <div className="set-update-notes-t">What’s in {updateAvailable.version}</div>
              <div className="set-row-sub" style={{ whiteSpace: "pre-wrap" }}>{updateAvailable.notes}</div>
            </div>
          )}
          <button className="set-btn" onClick={confirmInstall} disabled={installing}>
            {installing ? "Installing…" : `Install ${updateAvailable.version} and restart`}
          </button>
          {installError && <div className="set-error">Couldn’t install: {installError}</div>}
        </div>
      )}
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Check for updates automatically</span>
          <span className="set-row-sub">Silent check on launch, once per session</span>
        </div>
        <button className={"toggle" + (autoCheck ? " on" : "")} role="switch" aria-checked={autoCheck} onClick={toggleAutoCheck}><span /></button>
      </div>
      {rollbacks.length > 0 && (
        <div className="set-row">
          <div className="set-row-t">
            <span className="set-row-name">Roll back</span>
            <span className="set-row-sub">Reinstall an earlier version from the releases folder</span>
          </div>
          <select
            className="set-select"
            aria-label="Version to roll back to"
            value={rollbackTo}
            onChange={(e) => setRollbackTo(e.target.value)}
            disabled={installing}
          >
            {rollbacks.map((c) => <option key={c.version} value={c.version}>v{c.version}</option>)}
          </select>
          <button className="set-btn" onClick={confirmRollback} disabled={installing}>Roll back…</button>
        </div>
      )}
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Releases folder</span>
          <span className="set-row-sub">Where latest.json and the installer live</span>
        </div>
        <input
          className="set-search set-releases-dir"
          value={releasesDir}
          placeholder={DEFAULT_RELEASES_DIR}
          onChange={(e) => commitReleasesDir(e.target.value)}
        />
      </div>
    </>
  );
}

interface WorktreeEntry {
  path: string; repo: string; branch: string; baseBranch: string; bytes: number; orphan: boolean;
}

function DiagnosticsSection() {
  const [worktrees, setWorktrees] = useState<WorktreeEntry[] | null>(null);
  const [wtBusy, setWtBusy] = useState(false);

  const loadWorktrees = async () => {
    setWtBusy(true);
    try {
      // Claimed = every worktree a live pane owns; anything else is reapable.
      const claimed = useApp.getState().workspaces.flatMap((w) =>
        w.panes.map((p) => p.worktreePath).filter((x): x is string => !!x)
      );
      setWorktrees(await invoke<WorktreeEntry[]>("git_worktree_list", { claimed }));
    } catch {
      setWorktrees([]);
    } finally {
      setWtBusy(false);
    }
  };

  const reapOrphanWorktrees = () => {
    const orphans = (worktrees ?? []).filter((w) => w.orphan);
    if (orphans.length === 0) return;
    useUI.getState().requestConfirm({
      title: `Clean ${orphans.length} unused worktree${orphans.length === 1 ? "" : "s"}?`,
      body: "These aren’t claimed by any open pane. Any uncommitted work in them is committed to their branch first, so nothing is lost — only the folders go.",
      confirmLabel: "Clean up",
      onConfirm: async () => {
        let freed = 0;
        for (const w of orphans) {
          try { await invoke("git_worktree_remove", { worktreePath: w.path, mode: "keep" }); freed += w.bytes; } catch { /* keep going */ }
        }
        useUI.getState().pushToast("success", `Freed ${bytes(freed)} (work kept on branches).`);
        void loadWorktrees();
      },
    });
  };

  const pushToast = useUI((s) => s.pushToast);
  const [health, setHealth] = useState<PaneHealthRow[] | null>(null);
  const [cpuHistory, setCpuHistory] = useState<Record<number, number[]>>({});
  const [orphans, setOrphans] = useState<OrphanRow[] | null>(null);
  const [scanning, setScanning] = useState(false);

  // UX-596/QL-742: the ceiling this table (and the cockpit's always-on poll)
  // judges memory against. Local draft so a half-typed "2" doesn't snap to the
  // 64MB floor mid-keystroke; only a value the backend would accept as-is
  // applies live, the rest is clamped on blur.
  const [ceiling, setCeiling] = useState(getMemoryCeilingMb);
  const [ceilingDraft, setCeilingDraft] = useState(() => String(getMemoryCeilingMb()));
  const commitCeiling = (mb: number) => {
    const next = setMemoryCeilingMb(mb);
    setCeiling(next);
    setCeilingDraft(String(next));
  };

  // Poll health while the section is on screen. First sample reads 0% CPU by
  // design (delta-based); ticks refine it.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      // UX-596: pass the configured ceiling — omitting it is what made the
      // setting inert, since the backend then resolved its own default.
      invoke<PaneHealthRow[]>("pane_health", { memoryWarnMb: ceiling })
        .then((rows) => {
          if (cancelled) return;
          setHealth(rows);
          // UI-185: append this tick's sample per pane, capped to ~60s of history.
          // A pane that's gone (closed) simply stops accumulating — its old
          // history is dropped along with everything else next render since
          // we rebuild the map from the live rows rather than patching it.
          setCpuHistory((prev) => {
            const next: Record<number, number[]> = {};
            for (const r of rows) next[r.paneId] = [...(prev[r.paneId] ?? []), r.cpuPercent].slice(-CPU_HISTORY_LEN);
            return next;
          });
        })
        .catch(() => { if (!cancelled) setHealth(null); });
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [ceiling]);

  const scanOrphans = () => {
    setScanning(true);
    invoke<OrphanRow[]>("recover_orphans")
      .then(setOrphans)
      .catch(() => pushToast("error", "Couldn’t scan for stray processes."))
      .finally(() => setScanning(false));
  };

  const killOrphans = () => {
    if (!orphans || orphans.length === 0) return;
    invoke("kill_orphans", { pids: orphans.map((o) => o.pid) })
      .then(() => { pushToast("success", `Ended ${orphans.length} stray process tree${orphans.length === 1 ? "" : "s"}.`); setOrphans([]); })
      .catch(() => pushToast("error", "Couldn’t end the stray processes."));
  };

  // QL-720: Claude Code hooks. Opt-in and reversible, and never installed
  // automatically — this row is the only way our entries reach the user's
  // ~/.claude/settings.json, and the confirm below names the exact file.
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null);
  const [hookBusy, setHookBusy] = useState(false);
  const refreshHooks = () =>
    invoke<HookStatus>("hook_events_status")
      .then((s) => { setHookStatus(s); setHooksInstalled(s.settingsInstalled); })
      .catch(() => setHookStatus(null));
  useEffect(() => { void refreshHooks(); }, []);

  const installHooks = () => {
    if (!hookStatus) return;
    useUI.getState().requestConfirm({
      title: "Let Claude Code tell Flightdeck when it needs you?",
      // Says exactly what is edited, what is added, and where the backup goes.
      // No summary-of-a-summary: this is someone's hand-edited config.
      body:
        `Flightdeck will add two hooks (Notification and Stop) to ${hookStatus.settingsPath}. ` +
        `They run one small script from ${hookStatus.hooksDir}, which only appends the event to a log Flightdeck reads. ` +
        `A timestamped .bak copy of settings.json is written next to it first, and your own hooks and settings are left exactly as they are. ` +
        `Uninstall removes only Flightdeck's two entries.`,
      confirmLabel: "Install hooks",
      onConfirm: async () => {
        setHookBusy(true);
        try {
          const r = await invoke<{ changed: boolean; backupPath: string | null }>("install_claude_hooks");
          await refreshHooks();
          pushToast(
            "success",
            r.changed
              ? `Hooks installed. Backup: ${r.backupPath ?? "none needed (new file)"}. Restart your Claude panes to pick them up.`
              : "Hooks were already installed — nothing changed."
          );
        } catch (e) {
          pushToast("error", `Couldn’t install the hooks: ${String(e)}`);
        } finally {
          setHookBusy(false);
        }
      },
    });
  };

  const uninstallHooks = () => {
    if (!hookStatus) return;
    useUI.getState().requestConfirm({
      title: "Remove Flightdeck's Claude Code hooks?",
      body:
        `Only the two entries pointing at ${hookStatus.hooksDir} are removed from ${hookStatus.settingsPath}; ` +
        `everything else in the file stays, and a .bak copy is written first. ` +
        `Pane state goes back to being guessed from terminal output.`,
      confirmLabel: "Remove",
      onConfirm: async () => {
        setHookBusy(true);
        try {
          const r = await invoke<{ changed: boolean; backupPath: string | null }>("uninstall_claude_hooks");
          await refreshHooks();
          pushToast("success", r.changed ? `Hooks removed. Backup: ${r.backupPath ?? "none"}.` : "No Flightdeck hooks were installed.");
        } catch (e) {
          pushToast("error", `Couldn’t remove the hooks: ${String(e)}`);
        } finally {
          setHookBusy(false);
        }
      },
    });
  };

  const openErrorLog = async () => {
    try {
      const p = await invoke<string | null>("log_file_path");
      if (!p) {
        pushToast("info", "No error log yet — nothing has been recorded this install.");
        return;
      }
      await revealPath(p);
    } catch (e) {
      pushToast("error", `Couldn’t open the error log: ${String(e)}`);
    }
  };

  const exportBundle = async () => {
    try {
      const dest = await save({ defaultPath: "flightdeck-support.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!dest) return;
      await invoke("export_support_bundle", { destPath: dest });
      pushToast("success", "Support bundle exported (secrets redacted).");
    } catch (e) {
      pushToast("error", `Couldn’t export the bundle: ${String(e)}`);
    }
  };

  return (
    <section className="set-section">
      <div className="set-label">Diagnostics</div>

      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Pane health</span>
          <span className="set-row-sub">
            CPU is % of one core since the last sample
            {/* UI-186: Flightdeck's own total only — there's no backend command
                for total system RAM, so no percentage-of-system is claimed. */}
            {health && health.length > 0 && ` · ${bytes(health.reduce((n, h) => n + h.memoryMb, 0) * 1024 * 1024)} total across ${health.length} pane${health.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>
      {health && health.length > 0 ? (
        <div className="diag-table" role="table" aria-label="Per-pane process health">
          <div className="diag-tr diag-tr-health diag-th" role="row">
            <span>Pane</span><span>Process</span><span>PID</span><span>CPU</span><span>Trend</span><span>Memory</span>
          </div>
          {health.map((h) => (
            <div className="diag-tr diag-tr-health" role="row" key={h.paneId}>
              <span>#{h.paneId}</span>
              <span className="diag-proc">{h.procName || "—"}</span>
              <span>{h.pid}</span>
              {/* UI-633: only a reading that needs a look is coloured; a normal
                  pane stays flat so the table doesn't read as an alarm. */}
              <span
                className={cpuLevelClass(h.cpuPercent)}
                title={h.cpuPercent >= CPU_WARN_PERCENT ? `Over ${CPU_WARN_PERCENT}% of one core` : undefined}
              >
                {h.cpuPercent.toFixed(1)}%
              </span>
              {/* UI-185: ~60s CPU trend — cpuHistory accumulates alongside health. */}
              <Sparkline data={cpuHistory[h.paneId] ?? []} />
              <span
                className={memoryLevelClass(h)}
                title={h.memoryWarnMb ? `Memory ceiling: ${h.memoryWarnMb.toFixed(0)} MB` : undefined}
              >
                {h.memoryMb.toFixed(0)} MB
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="diag-empty">{health === null ? "Health data unavailable in this environment." : "No live panes to sample."}</div>
      )}

      {/* UX-596/QL-742: the one memory threshold in the app. It colours the
          table above, and the cockpit flags any pane over it in the pane
          header without Settings being open. */}
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Memory ceiling</span>
          <span className="set-row-sub">
            Flag a pane using more than this many MB. Checked every 30s in the background; the pane header shows a chip.
          </span>
        </div>
        <input
          className="set-input set-input-num" type="number"
          min={MIN_MEMORY_CEILING_MB} max={MAX_MEMORY_CEILING_MB} step={64}
          aria-label={`Memory ceiling in MB (${MIN_MEMORY_CEILING_MB}–${MAX_MEMORY_CEILING_MB})`}
          value={ceilingDraft}
          onChange={(e) => {
            setCeilingDraft(e.target.value);
            const mb = Number(e.target.value);
            if (Number.isFinite(mb) && mb >= MIN_MEMORY_CEILING_MB && mb <= MAX_MEMORY_CEILING_MB) {
              setCeiling(setMemoryCeilingMb(mb));
            }
          }}
          onBlur={() => commitCeiling(Number(ceilingDraft))}
          onKeyDown={(e) => { if (e.key === "Enter") commitCeiling(Number(ceilingDraft)); }}
        />
      </div>

      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Stray agent processes</span>
          <span className="set-row-sub">Agent trees left running by a crash or force-quit</span>
        </div>
        <button className="set-btn" onClick={scanOrphans} disabled={scanning}>{scanning ? "Scanning…" : "Scan"}</button>
        {orphans && orphans.length > 0 && (
          <button className="set-btn danger" onClick={killOrphans}>End {orphans.length} stray</button>
        )}
      </div>
      {orphans && orphans.length === 0 && <div className="diag-empty">No strays found — every agent process belongs to a live pane.</div>}
      {orphans && orphans.length > 0 && (
        <div className="diag-table">
          {orphans.map((o) => (
            <div className="diag-tr" key={o.pid}><span>{o.name}</span><span>PID {o.pid}</span><span /><span /><span /></div>
          ))}
        </div>
      )}

      {/* UI-187: worktrees are the app's biggest disk footprint and were
          invisible — list them, size them, and allow reaping the orphans. */}
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Worktrees on disk</span>
          <span className="set-row-sub">
            {worktrees ? `${worktrees.length} total · ${bytes(worktrees.reduce((n, w) => n + w.bytes, 0))}` : "Isolated agent checkouts under app data"}
          </span>
        </div>
        <button className="set-btn" onClick={loadWorktrees} disabled={wtBusy}>{wtBusy ? "Scanning…" : "Scan"}</button>
        {worktrees && worktrees.some((w) => w.orphan) && (
          <button className="set-btn danger" onClick={reapOrphanWorktrees}>
            Clean {worktrees.filter((w) => w.orphan).length} unused
          </button>
        )}
      </div>
      {worktrees && worktrees.length === 0 && <div className="diag-empty">No worktrees on disk.</div>}
      {worktrees && worktrees.length > 0 && (
        <div className="diag-table" role="table" aria-label="Worktrees on disk">
          <div className="diag-tr diag-th" role="row">
            <span>Branch</span><span>Repo</span><span>Size</span><span>State</span><span />
          </div>
          {worktrees.map((w) => (
            <div className="diag-tr" role="row" key={w.path} title={w.path}>
              <span className="diag-proc">{w.branch || "—"}</span>
              <span className="diag-proc">{w.repo.split(/[\/]/).pop() || "—"}</span>
              <span>{bytes(w.bytes)}</span>
              <span className={w.orphan ? "diag-orphan" : ""}>{w.orphan ? "unused" : "in use"}</span>
              <span />
            </div>
          ))}
        </div>
      )}

      {/* QL-720: opt-in, reversible, and off until pressed. */}
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Claude Code hooks</span>
          <span className="set-row-sub" title={hookStatus?.settingsPath || undefined}>
            {hookStatusLine(hookStatus)}
          </span>
        </div>
        {hookStatus?.settingsInstalled ? (
          <button className="set-btn" onClick={uninstallHooks} disabled={hookBusy}>Remove</button>
        ) : (
          <button className="set-btn" onClick={installHooks} disabled={hookBusy || !hookStatus?.relayInstalled}>
            Install…
          </button>
        )}
      </div>

      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Support bundle</span>
          <span className="set-row-sub">Redacted app + pane snapshot + error-log tail for bug reports</span>
        </div>
        <button className="set-btn" onClick={() => void exportBundle()}>Export…</button>
      </div>

      {/* Flight recorder (post-0.5.3): panics, render crashes and unhandled
          rejections all land in one on-disk log. This reveals it. */}
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Error log</span>
          <span className="set-row-sub">Crashes and errors from this and previous runs, secrets redacted</span>
        </div>
        <button className="set-btn" onClick={() => void openErrorLog()}>Open…</button>
      </div>

      {/* QL-774 + QL-773: read-only doctor for the Claude settings files behind
          the focused pane, plus the hooks they declare. Lives here because it
          answers the same class of question as the rest of Diagnostics — "why
          is it behaving like that?" — and reuses these tables. */}
      <ConfigDoctorView />
    </section>
  );
}

// UI-194: Kove brand swatches for the custom-accent picker — same hexes as
// theme.css's --ice/--azure/--aqua/--deepblue, offered as one-click presets
// alongside the raw <input type=color>.
const KOVE_PRESETS = ["#9AE9FF", "#43A6F5", "#57E5C6", "#3F6BFF"];
const MAX_RECENT_ACCENTS = 6;

// ---------------------------------------------------------------------
// UI-182: export/import every preference in one file, not just the theme.
// exportThemeJson/importThemeJson (themes.ts) read/write computed CSS tokens;
// this is the flatter thing underneath — the raw localStorage values for
// every key in PREFERENCE_KEYS. Import is deliberately allow-listed against
// that same list rather than writing whatever keys the file happens to
// contain, so a hand-edited or malicious file can't smuggle in something
// that isn't a known preference (and definitely never a SESSION_KEYS entry).
// ---------------------------------------------------------------------
function exportAllSettingsJson(): string {
  const values: Record<string, string> = {};
  for (const k of PREFERENCE_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) values[k] = v;
  }
  // Tag is just app: flightdeck (no dashed suffix) — storageKeys.test.ts
  // treats any quoted flightdeck-prefixed literal as a storage key to
  // classify, and this one isn't a localStorage key at all.
  return JSON.stringify({ app: "flightdeck", kind: "settings", version: 1, values }, null, 2);
}
function importAllSettingsJson(json: string): boolean {
  let parsed: { values?: Record<string, unknown> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (!parsed.values || typeof parsed.values !== "object") return false;
  const known = new Set<string>(PREFERENCE_KEYS);
  let applied = 0;
  for (const [k, v] of Object.entries(parsed.values)) {
    if (!known.has(k) || typeof v !== "string") continue; // never trust the file blindly
    try { localStorage.setItem(k, v); applied++; } catch { /* non-persistent */ }
  }
  return applied > 0;
}

export function Settings() {
  const open = useUI((s) => s.settingsOpen);
  const setOpen = useUI((s) => s.setSettingsOpen);
  const vendors = useVendors((s) => s.vendors);

  const [themeId, setThemeId] = useState(currentThemeId());
  const [appearance, setAppearance] = useState<AppearanceMode>(appearanceMode());
  const [accentId, setAccentId] = useState(currentAccentId());
  const [customHex, setCustomHex] = useState(customAccentHex());
  const [cbSafe, setCbSafe] = useState(isColorBlindSafe());
  const [reducedMotion, setReducedMotionOn] = useState(isReducedMotion());
  const uiZoom = useUI((s) => s.uiZoom);
  const setUiZoom = useUI((s) => s.setUiZoom);
  const stepUiZoom = useUI((s) => s.stepUiZoom);
  const [term, setTerm] = useState(getTerminalSettings());
  const [shortcuts, setShortcuts] = useState(getShortcuts());
  const [capturing, setCapturing] = useState<string | null>(null);
  // UI-190: a rebind that collides with an existing binding, pending the user's
  // decision to reassign (which clears the old one) or cancel.
  const [conflict, setConflict] = useState<
    { combo: string; otherId?: string; otherLabel: string; forId: string; fixed: boolean } | null
  >(null);
  const [agents, setAgents] = useState(getAgentSettings());
  const [startup, setStartup] = useState(getStartupBehavior());
  const [editor, setEditor] = useState(getEditorSettings());
  // UX-588: per-vendor "does it actually launch" probe result. Session-only —
  // the app-mounted Settings instance keeps it even while the modal is closed
  // (see the "test launch" click handler, which closes Settings so the pane
  // is visible), so the checklist is still there next time it's reopened.
  const [launchCheck, setLaunchCheck] = useState<Record<string, "testing" | "ok" | "error">>({});
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // UI-182: separate file + error state from the theme import above it — the
  // two imports are unrelated formats and a bad file in one shouldn't clear
  // the other's error message.
  const [allSettingsImportError, setAllSettingsImportError] = useState<string | null>(null);
  const allSettingsFileRef = useRef<HTMLInputElement>(null);
  // UI-194: colours picked via the custom swatch this session, newest first.
  // Session-only (not persisted) — recency is a soft convenience, not a
  // setting worth its own storage key and reset-on-clear semantics.
  const [recentAccents, setRecentAccents] = useState<string[]>([]);

  // UI-196: a slow tick is enough — this is reassurance, not telemetry.
  const [savedAgo, setSavedAgo] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const at = lastSessionSaveAt();
      setSavedAgo(at ? relTime(at) : null);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  // UX-600: compare the running version against what was last acknowledged.
  // Runs once on mount regardless of whether Settings is open, so a toast can
  // fire the moment the app boots on a freshly-installed version, not only
  // when Balu happens to open Settings. Notes only ever come from the release
  // manifest (see updater.ts) — never invented copy.
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: string } | null>(null);
  useEffect(() => {
    let seen: string | null = null;
    try { seen = localStorage.getItem(WHATSNEW_SEEN_KEY); } catch { /* non-persistent */ }
    const pending = getPendingReleaseNotes();
    if (shouldShowWhatsNew(APP_VERSION, seen, pending)) {
      setWhatsNew(pending);
      useUI.getState().pushToast("info", `Updated to Flightdeck ${APP_VERSION} — see What’s new in Settings > About.`);
    }
    try { localStorage.setItem(WHATSNEW_SEEN_KEY, APP_VERSION); } catch { /* non-persistent */ }
    clearPendingReleaseNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // UI-181: the palette can ask for a specific section. Consume the request
  // once and scroll to it — leaving it set would re-jump on the next open.
  const jumpTo = useUI((s) => s.settingsJumpTo);
  useEffect(() => {
    if (!open || !jumpTo) return;
    const root = bodyRef.current;
    if (!root) return;
    const target = Array.from(root.querySelectorAll<HTMLElement>(".set-section")).find((sec) =>
      sec.querySelector(".set-label")?.textContent?.trim().toLowerCase() === jumpTo.toLowerCase()
    );
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    useUI.getState().clearSettingsJump();
  }, [open, jumpTo]);

  // UI-180: live section filter. Matching is done on rendered text rather than
  // a hand-maintained keyword table, so a new section is searchable for free.
  const [q, setQ] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  // UI-30: Tab could walk out of the modal into the app behind the scrim.
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, open);
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const needle = q.trim().toLowerCase();
    let shown = 0;
    for (const sec of Array.from(root.querySelectorAll<HTMLElement>(".set-section"))) {
      const hit = !needle || (sec.textContent ?? "").toLowerCase().includes(needle);
      sec.style.display = hit ? "" : "none";
      if (hit) shown++;
    }
    const empty = root.querySelector<HTMLElement>(".set-noresults");
    if (empty) empty.style.display = shown === 0 ? "" : "none";
  });

  // K0a: repos the user has granted a trust-requiring agent access to.
  const [trusted, setTrusted] = useState<string[]>(() => trustedRepos());
  useEffect(() => { setTrusted(trustedRepos()); }, []);

  // UI-111: "not installed" / "not signed in" chips open a popover instead of
  // cramming copy/get-it/run-login buttons into the chip itself. Portalled to
  // <body> and positioned via the trigger's own rect (fixed), the same
  // pattern as the pane overflow menu, so it isn't clipped by set-body's own
  // scroll/mask.
  const [popover, setPopover] = useState<{ vendorId: string; kind: "install" | "auth" } | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  function openAgentPopover(e: React.MouseEvent<HTMLButtonElement>, vendorId: string, kind: "install" | "auth") {
    if (popover?.vendorId === vendorId && popover.kind === kind) { setPopover(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setPopoverPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 296) });
    setPopover({ vendorId, kind });
  }
  // UX-542/543: registered on the shared overlay stack — opens strictly after
  // Settings itself, so it naturally sits on top and takes the next Esc
  // first (LIFO), without Settings needing to know about it explicitly.
  useOverlayEsc(!!popover, () => setPopover(null));
  useEffect(() => {
    if (!popover) return;
    const onMouseDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".agent-popover") && !el.closest(".agent-popover-trigger")) setPopover(null);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [popover]);
  const popoverVendor = popover ? vendors.find((v) => v.id === popover.vendorId) ?? null : null;

  // UI-189: manifests that failed to parse — silently skipping them made a
  // typo'd vendor file indistinguishable from a missing one.
  const [manifestProblems, setManifestProblems] = useState<{ file: string; error: string }[]>([]);
  useEffect(() => {
    void invoke<{ file: string; error: string }[]>("manifest_problems")
      .then(setManifestProblems)
      .catch(() => setManifestProblems([]));
  }, []);

  // Re-probe install + auth state (#219) each time Settings opens — a login
  // completed in a pane should show as "signed in" without an app restart.
  useEffect(() => { void useVendors.getState().refresh(); }, []);

  // UX-542/543: capturing is a nested modal sub-state (rebinding a shortcut,
  // not itself an on-screen overlay) — pushed onto the SAME shared stack, on
  // top of Settings' own entry below, so an Esc cancels ONLY the capture and
  // leaves Settings open, rather than the raw combo-listener's own Escape
  // branch racing Cockpit's global dispatcher (both are window listeners;
  // registration order between them isn't guaranteed). `restoreFocus: false`
  // — the rebind button that started capturing already holds focus.
  useOverlayEsc(!!capturing, () => setCapturing(null), { restoreFocus: false });
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      const combo = formatCombo(e);
      if (!combo) return;
      // UI-190: binding a combo that's already taken silently shadowed the
      // other action — whichever handler ran first won, with no way to tell.
      // A clash with a FIXED shortcut can't be reassigned away, so it's a hard
      // refusal; a clash with another rebindable one offers the swap.
      const fixed = FIXED_SHORTCUTS.find((f) => f.combo.toLowerCase() === combo.toLowerCase());
      if (fixed) {
        setConflict({ combo, otherLabel: fixed.label, forId: capturing, fixed: true });
        setCapturing(null);
        return;
      }
      const clash = getShortcuts().find((sc) => sc.id !== capturing && sc.combo === combo);
      if (clash) {
        setConflict({ combo, otherId: clash.id, otherLabel: clash.label, forId: capturing, fixed: false });
        setCapturing(null);
        return;
      }
      saveShortcut(capturing, combo);
      setShortcuts(getShortcuts());
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  // Esc closes — every other overlay does; Settings was the odd one out (QOL
  // 328). UX-542/543: on the shared overlay stack now, so this fires only
  // when Settings is the top-most overlay — capturing and popover above
  // (both pushed after Settings, see their own useOverlayEsc calls) take Esc
  // first, no manual `!capturing && !popover` guard needed any more.
  useOverlayEsc(open, () => setOpen(false));

  if (!open) return null;

  const mode = themeId === "custom" ? "dark" : findTheme(themeId).mode;
  // QL-792: some themes own their accent (High Contrast for accessibility,
  // Graphite because a saturated accent undoes its whole point). Exact-id
  // lookup, so an imported "custom" theme still gets the picker.
  const fixedAccentNote = THEMES.find((t) => t.id === themeId)?.fixedAccent;

  function selectTheme(id: string) {
    if (id === "custom") return; // custom is only reached via import, not clickable directly
    applyTheme(id);
    setThemeId(id);
    applyAccent(accentId, findTheme(id).mode);
    // The colour-blind palette is mode-specific — reapply so a light theme
    // doesn't keep the dark-tuned values (which fail contrast on a light ground).
    applyColorBlindSafe(isColorBlindSafe(), findTheme(id).mode);
    // QL-784: keep the Light/Dark segment honest about what's on screen. While
    // following Windows the choice stays "Follow Windows" — the pick is just
    // remembered as this mode's theme (applyTheme does that) and the OS keeps
    // driving which of the two is shown.
    if (appearance !== "system") {
      const next = findTheme(id).mode;
      setAppearanceMode(next);
      setAppearance(next);
    }
  }

  // QL-784: Light / Dark / Follow Windows. Light and Dark land on the theme
  // last used in that mode rather than a hardcoded pair; Follow Windows reads
  // the OS theme now, and App's onThemeChanged listener keeps it in step after
  // that. Persisted immediately, like every other row in this panel.
  function selectAppearance(next: AppearanceMode) {
    setAppearanceMode(next);
    setAppearance(next);
    if (next !== "system") {
      setThemeId(applyThemeForMode(next));
      return;
    }
    try {
      getCurrentWindow()
        .theme()
        .then((t) => { if (t) setThemeId(applyThemeForMode(t === "light" ? "light" : "dark")); })
        .catch(() => { /* browser preview — keep whatever is on screen */ });
    } catch { /* browser preview */ }
  }
  function selectAccent(id: string) {
    setAccent(id, mode);
    setAccentId(id);
  }
  function toggleCbSafe() {
    const next = !cbSafe;
    setColorBlindSafe(next);
    setCbSafe(next);
  }
  function toggleReducedMotion() {
    const next = !reducedMotion;
    setReducedMotion(next);
    setReducedMotionOn(next);
  }
  function handleExport() {
    const json = exportThemeJson(findTheme(themeId).label);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flightdeck-theme-${themeId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ok = importThemeJson(String(reader.result));
      if (ok) { setThemeId("custom"); setImportError(null); }
      else setImportError("That file doesn’t look like a Flightdeck theme export.");
    };
    reader.readAsText(file);
  }

  // UI-194: one place for "a custom colour was picked" — swatch click and the
  // raw <input type=color> both funnel through here so recents stay in sync.
  function applyCustomAccent(hex: string) {
    setCustomHex(hex);
    setCustomAccent(hex, mode);
    setAccentId(CUSTOM_ACCENT_ID);
    setRecentAccents((prev) => [hex, ...prev.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, MAX_RECENT_ACCENTS));
  }

  function handleExportAllSettings() {
    const json = exportAllSettingsJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flightdeck-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function handleImportAllSettingsFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ok = importAllSettingsJson(String(reader.result));
      if (ok) {
        setAllSettingsImportError(null);
        useUI.getState().pushToast("success", "Settings imported — reloading.");
        window.setTimeout(() => window.location.reload(), 600);
      } else {
        setAllSettingsImportError("That file doesn’t look like a Flightdeck settings export.");
      }
    };
    reader.readAsText(file);
  }

  // UI-183: one honest reset. Deliberately scoped to PREFERENCES — it must
  // never touch session state (workspaces/board/worktrees), which is why the
  // key list is explicit rather than a localStorage.clear().
  function resetEverything() {
    useUI.getState().requestConfirm({
      title: "Reset all settings?",
      body: "Theme, accent, terminal, shortcuts, agent and startup preferences go back to defaults. Your workspaces, board cards and worktrees are not affected.",
      confirmLabel: "Reset settings",
      danger: true,
      onConfirm: () => {
        // Single source of truth in storageKeys.ts, enforced by
        // storageKeys.test.ts — this list drifted twice before.
        clearPreferences();
        useUI.getState().pushToast("success", "Settings reset — reloading.");
        window.setTimeout(() => window.location.reload(), 600);
      },
    });
  }

  function updateTerm(patch: Partial<TerminalSettings>) {
    setTerm(saveTerminalSettings(patch));
  }
  function updateAgents(next: AgentSettings) {
    saveAgentSettings(next);
    setAgents(next);
  }
  function updateStartup(v: StartupBehavior) {
    saveStartupBehavior(v);
    setStartup(v);
  }
  function updateEditor(next: EditorSettings) {
    saveEditorSettings(next);
    setEditor(next);
  }

  // UX-599: per-section reset. Same confirm weight as the other destructive
  // actions in this file; restores just that section's own keys, never the
  // others and never session state.
  function resetSection(title: string, body: string, apply: () => void) {
    useUI.getState().requestConfirm({ title, body, confirmLabel: "Reset section", danger: true, onConfirm: apply });
  }
  function resetAppearanceSection() {
    resetSection(
      "Reset appearance?",
      "Theme, appearance mode, accent colour, colour-blind-safe and reduced-motion go back to defaults.",
      () => {
        selectTheme(DEFAULT_THEME_ID);
        selectAccent(DEFAULT_ACCENT_ID);
        if (cbSafe) toggleCbSafe();
        if (reducedMotion) toggleReducedMotion();
        try { localStorage.removeItem("flightdeck-accent-custom"); } catch { /* non-persistent */ }
        // QL-784: drop the remembered light/dark pair and stop following
        // Windows — back to the plain "one saved theme" behaviour. After
        // selectTheme above, so it doesn't re-seed the keys it just cleared.
        try { localStorage.removeItem("flightdeck-theme-dark"); } catch { /* non-persistent */ }
        try { localStorage.removeItem("flightdeck-theme-light"); } catch { /* non-persistent */ }
        try { localStorage.removeItem("flightdeck-appearance-mode"); } catch { /* non-persistent */ }
        setAppearance(findTheme(DEFAULT_THEME_ID).mode);
        useUI.getState().pushToast("success", "Appearance reset.");
      }
    );
  }
  function resetTerminalSection() {
    resetSection(
      "Reset terminal settings?",
      "Font, size, cursor style and scrollback go back to defaults.",
      () => {
        try { localStorage.removeItem("flightdeck-terminal-settings"); } catch { /* non-persistent */ }
        window.dispatchEvent(new CustomEvent("flightdeck-terminal-settings-changed", { detail: DEFAULT_TERMINAL_SETTINGS }));
        setTerm(DEFAULT_TERMINAL_SETTINGS);
        useUI.getState().pushToast("success", "Terminal settings reset.");
      }
    );
  }
  function resetShortcutsSection() {
    resetSection(
      "Reset shortcuts?",
      "Rebound keys go back to their defaults.",
      () => {
        resetShortcuts();
        setShortcuts(getShortcuts());
        useUI.getState().pushToast("success", "Shortcuts reset.");
      }
    );
  }
  function resetAgentsSection() {
    resetSection(
      "Reset agent settings?",
      "Default vendor, extra flags, binary path overrides and per-agent colours go back to defaults.",
      () => {
        saveAgentSettings(DEFAULT_AGENT_SETTINGS);
        setAgents(DEFAULT_AGENT_SETTINGS);
        try { localStorage.removeItem("flightdeck-vendor-accents"); } catch { /* non-persistent */ }
        useUI.getState().pushToast("success", "Agent settings reset.");
      }
    );
  }
  function resetStartupSection() {
    resetSection("Reset startup behaviour?", "Goes back to showing the launcher on start.", () => {
      updateStartup("launcher");
      useUI.getState().pushToast("success", "Startup behaviour reset.");
    });
  }
  function resetEditorSection() {
    resetSection("Reset editor settings?", "Goes back to VS Code.", () => {
      updateEditor(DEFAULT_EDITOR_SETTINGS);
      useUI.getState().pushToast("success", "Editor settings reset.");
    });
  }

  // UX-588: light first-run checklist — reuses the same throwaway-pane probe
  // as the existing "test launch" chip, but now watches the pane's own state
  // and turns the click into a pass/fail result instead of a fire-and-forget.
  function testLaunch(vendorId: string, short: string) {
    const st = useApp.getState();
    const ws = st.workspaces.find((w) => w.id === st.activeId);
    if (!ws) {
      useUI.getState().pushToast("info", "Open a workspace first — the test pane opens inside it.");
      return;
    }
    setLaunchCheck((r) => ({ ...r, [vendorId]: "testing" }));
    const startedAt = Date.now();
    void spawnPane(ws.id, vendorId, ws.root, false).then((paneId) => {
      if (paneId == null) {
        setLaunchCheck((r) => ({ ...r, [vendorId]: "error" }));
        return;
      }
      const poll = () => {
        const pane = useApp.getState().workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId);
        if (!pane) return; // closed before resolving — leave the last known result showing
        if (pane.state === "error") { setLaunchCheck((r) => ({ ...r, [vendorId]: "error" })); return; }
        if (pane.state === "running" || pane.state === "waiting" || pane.state === "permission") {
          setLaunchCheck((r) => ({ ...r, [vendorId]: "ok" }));
          return;
        }
        if (Date.now() - startedAt < 8000) window.setTimeout(poll, 400);
        else setLaunchCheck((r) => ({ ...r, [vendorId]: "error" }));
      };
      window.setTimeout(poll, 400);
    });
    useUI.getState().setSettingsOpen(false);
    useUI.getState().pushToast("info", `Test pane opened for ${short}. Close it when you’re done.`);
  }

  return (
    <div className="ov-scrim" onMouseDown={() => setOpen(false)}>
      <div className="set-modal" ref={modalRef} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <div className="set-head">
          <h2>Settings</h2>
          {/* UI-180: eleven sections is too many to scan — filter them. */}
          <input
            className="set-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search settings…"
            spellCheck={false}
            aria-label="Search settings"
          />
          <button className="ov-x" onClick={() => setOpen(false)} title="Close"><IconClose size={16} /></button>
        </div>
        <div className="set-body" ref={bodyRef}>

          <section className="set-section">
            <SectionHead label="Appearance" onReset={resetAppearanceSection} />

            {/* QL-784: mode first, then the theme within it — picking a theme
                below also sets which mode it's remembered as. */}
            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">Mode</span>
                <span className="set-row-sub">
                  {appearance === "system"
                    ? "Following Windows — switches between your last light and dark themes"
                    : "Each mode remembers the theme you last used in it"}
                </span>
              </div>
              <div className="seg" role="group" aria-label="Appearance mode">
                {([["light", "Light"], ["dark", "Dark"], ["system", "Follow Windows"]] as const).map(([id, label]) => (
                  <button
                    key={id}
                    className={appearance === id ? "on" : ""}
                    aria-pressed={appearance === id}
                    onClick={() => selectAppearance(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="theme-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={"theme-tile" + (themeId === t.id ? " on" : "")}
                  onClick={() => selectTheme(t.id)}
                  title={t.label}
                >
                  {/* UI-193: a tiny mock of the app's own layout (side panel +
                      main + accent) reads faster than three bare dots. */}
                  <span className="theme-thumb" style={{ background: t.swatch[0] }}>
                    <i className="theme-thumb-panel" style={{ background: t.swatch[1] }} />
                    <i className="theme-thumb-accent" style={{ background: t.swatch[2] }} />
                  </span>
                  <span className="theme-tile-label">{t.label}</span>
                </button>
              ))}
              {themeId === "custom" && (
                <div className="theme-tile on custom" title="Imported theme">
                  <span className="theme-thumb custom" />
                  <span className="theme-tile-label">Custom (imported)</span>
                </div>
              )}
            </div>

            {/* A theme that fixes its accent (High Contrast for accessibility,
                Graphite for its steel chrome) hides the picker: letting it
                override silently defeats the whole theme. */}
            {!fixedAccentNote && (
              <>
                <div className="set-row">
                  <div className="set-row-t"><span className="set-row-name">Accent colour</span><span className="set-row-sub">Auto-adjusts for dark or light</span></div>
                  <div className="accent-row">
                    {ACCENTS.map((a) => (
                      <button
                        key={a.id}
                        className={"accent-swatch" + (accentId === a.id ? " on" : "")}
                        style={{ background: mode === "light" ? findAccent(a.id).light.accent : findAccent(a.id).dark.accent }}
                        onClick={() => selectAccent(a.id)}
                        title={a.label}
                        aria-label={`Accent: ${a.label}`}
                      />
                    ))}
                    {/* UI-50: any colour — dark/light variants + gradient derived
                        from the one picked hex. The swatch doubles as the input. */}
                    <label
                      className={"accent-swatch accent-custom" + (accentId === CUSTOM_ACCENT_ID ? " on" : "")}
                      style={{
                        background:
                          accentId === CUSTOM_ACCENT_ID
                            ? (mode === "light" ? findAccent(CUSTOM_ACCENT_ID).light.accent : findAccent(CUSTOM_ACCENT_ID).dark.accent)
                            : "conic-gradient(#f55 0deg, #fb0 70deg, #4d4 140deg, #2bd 210deg, #74f 280deg, #f55 360deg)",
                      }}
                      title="Custom — pick any colour"
                      aria-label="Accent: custom colour"
                    >
                      <input
                        type="color"
                        value={customHex}
                        onChange={(e) => applyCustomAccent(e.target.value)}
                      />
                    </label>
                  </div>
                </div>
                {/* UI-194: one-click Kove brand presets, plus whatever custom
                    colours were picked this session — the raw colour input
                    above still covers anything else. */}
                <div className="set-row">
                  <div className="set-row-t"><span className="set-row-name">Custom accent</span><span className="set-row-sub">Kove brand colours, and colours used recently</span></div>
                  <div className="accent-row">
                    {KOVE_PRESETS.map((hex) => (
                      <button
                        key={hex}
                        className={"accent-swatch" + (accentId === CUSTOM_ACCENT_ID && customHex.toLowerCase() === hex.toLowerCase() ? " on" : "")}
                        style={{ background: hex }}
                        onClick={() => applyCustomAccent(hex)}
                        title={hex}
                        aria-label={`Kove preset ${hex}`}
                      />
                    ))}
                    {recentAccents.length > 0 && <span className="accent-divider" aria-hidden="true" />}
                    {recentAccents.map((hex) => (
                      <button
                        key={hex}
                        className={"accent-swatch" + (accentId === CUSTOM_ACCENT_ID && customHex.toLowerCase() === hex.toLowerCase() ? " on" : "")}
                        style={{ background: hex }}
                        onClick={() => applyCustomAccent(hex)}
                        title={hex}
                        aria-label={`Recent accent ${hex}`}
                      />
                    ))}
                  </div>
                </div>
              </>
            )}
            {fixedAccentNote && (
              <div className="set-row">
                <div className="set-row-t">
                  <span className="set-row-name">Accent colour</span>
                  <span className="set-row-sub">{fixedAccentNote}</span>
                </div>
              </div>
            )}

            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Colour-blind-safe status colours</span><span className="set-row-sub">Blue / amber / vermillion instead of red / green</span></div>
              <button className={"toggle" + (cbSafe ? " on" : "")} role="switch" aria-checked={cbSafe} onClick={toggleCbSafe}><span /></button>
            </div>

            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Reduced motion</span><span className="set-row-sub">Minimise animations app-wide</span></div>
              <button className={"toggle" + (reducedMotion ? " on" : "")} role="switch" aria-checked={reducedMotion} onClick={toggleReducedMotion}><span /></button>
            </div>

            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Theme file</span><span className="set-row-sub">Export the active theme, or import one</span></div>
              <div className="seg">
                <button onClick={handleExport}>Export</button>
                <button onClick={() => fileRef.current?.click()}>Import</button>
              </div>
              <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={handleImportFile} />
            </div>
            {importError && <div className="set-error">{importError}</div>}

            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">UI size</span>
                <span className="set-row-sub">Scale the whole interface — same as <kbd>Ctrl</kbd>+<kbd>=</kbd>/<kbd>-</kbd>/<kbd>0</kbd></span>
              </div>
              <div className="zoom-stepper">
                <button
                  className="zoom-step-btn"
                  onClick={() => stepUiZoom(-1)}
                  disabled={uiZoom <= ZOOM_STEPS[0]}
                  title="Zoom out (Ctrl+-)"
                >
                  −
                </button>
                <span className="zoom-step-val">{Math.round(uiZoom * 100)}%</span>
                <button
                  className="zoom-step-btn"
                  onClick={() => stepUiZoom(1)}
                  disabled={uiZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                  title="Zoom in (Ctrl+=)"
                >
                  +
                </button>
                {uiZoom !== 1 && (
                  <button className="zoom-step-reset" onClick={() => setUiZoom(1)} title="Reset to 100% (Ctrl+0)">Reset</button>
                )}
              </div>
            </div>
          </section>

          <section className="set-section">
            <SectionHead label="Terminal" onReset={resetTerminalSection} />
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Font</span></div>
              {/* UI-138: each option renders in its own typeface — a name alone
                  doesn't tell you what Cascadia Code vs Consolas actually look like. */}
              <select className="set-select" value={term.fontFamily} onChange={(e) => updateTerm({ fontFamily: e.target.value })}>
                {TERMINAL_FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
              </select>
            </div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Font size</span></div>
              <input
                className="set-input set-input-num" type="number" min={9} max={22} step={0.5}
                value={term.fontSize}
                onChange={(e) => updateTerm({ fontSize: Number(e.target.value) || DEFAULT_TERMINAL_SETTINGS.fontSize })}
              />
            </div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Cursor style</span></div>
              <div className="seg">
                {(["block", "underline", "bar"] as const).map((c) => (
                  <button key={c} className={term.cursorStyle === c ? "on" : ""} onClick={() => updateTerm({ cursorStyle: c })}>
                    {c[0].toUpperCase() + c.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {/* UI-138/UI-139: font, size and cursor style together as they'll
                actually look in a pane, rather than three settings you have to
                imagine combined. */}
            <div className="term-preview" style={{ fontFamily: term.fontFamily, fontSize: term.fontSize }}>
              <span>$ npm run dev</span>
              <i className={"term-cursor term-cursor-" + term.cursorStyle} aria-hidden="true" />
            </div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Scrollback</span><span className="set-row-sub">Lines kept per pane</span></div>
              <input
                className="set-input set-input-num" type="number" min={200} max={100000} step={100}
                value={term.scrollback}
                onChange={(e) => updateTerm({ scrollback: Number(e.target.value) || DEFAULT_TERMINAL_SETTINGS.scrollback })}
              />
            </div>
          </section>

          {/* UX-517/UX-516: which editor "open in editor" / jump-to-file:line
              hands off to. Persisted key: flightdeck-editor-settings, shape
              { editor: EditorId, command: string } — `command` is always the
              FULL resolved template (presets copy their command in verbatim),
              so the consumer only ever needs to replaceAll "{file}"/"{line}". */}
          <section className="set-section">
            <SectionHead label="Editor" onReset={resetEditorSection} />
            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">Open files in</span>
                <span className="set-row-sub">Used by "open in editor" and jump-to-line actions</span>
              </div>
              <div className="seg">
                {(Object.keys(EDITOR_PRESETS) as Array<Exclude<EditorId, "custom">>).map((id) => (
                  <button
                    key={id}
                    className={editor.editor === id ? "on" : ""}
                    onClick={() => updateEditor({ editor: id, command: EDITOR_PRESETS[id].command })}
                  >
                    {EDITOR_PRESETS[id].label}
                  </button>
                ))}
                <button
                  className={editor.editor === "custom" ? "on" : ""}
                  onClick={() => updateEditor({ editor: "custom", command: editor.editor === "custom" ? editor.command : "" })}
                >
                  Custom
                </button>
              </div>
            </div>
            {editor.editor === "custom" && (
              <div className="set-row">
                <div className="set-row-t">
                  <span className="set-row-name">Command template</span>
                  <span className="set-row-sub">
                    Use <code>{"{file}"}</code> for the path and <code>{"{line}"}</code> for the line number
                  </span>
                </div>
                <input
                  className="set-input set-input-wide"
                  placeholder='e.g. subl "{file}:{line}"'
                  spellCheck={false}
                  value={editor.command}
                  onChange={(e) => updateEditor({ editor: "custom", command: e.target.value })}
                />
              </div>
            )}
            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">Preview</span>
                <span className="set-row-sub">What runs for a file at a line</span>
              </div>
            </div>
            <div className="term-preview editor-preview">
              <span>{resolveEditorCommand(editor.command || "—", "src\\App.tsx", 42) || "Enter a command template above"}</span>
            </div>
          </section>

          <section className="set-section">
            <SectionHead label="Shortcuts" onReset={resetShortcutsSection} />
            <div className="kbd-list">
              {shortcuts.map((s) => (
                <div className="kbd-row" key={s.id}>
                  <span>{s.label}</span>
                  {capturing === s.id ? (
                    <span className="kbd-capturing">Press keys… <button className="kbd-cancel" onClick={() => setCapturing(null)}>Esc</button></span>
                  ) : (
                    <span className="kbd-keys">
                      {s.combo.split("+").map((k) => <kbd key={k}>{k}</kbd>)}
                      <button className="kbd-edit" onClick={() => setCapturing(s.id)}>Change</button>
                    </span>
                  )}
                </div>
              ))}
              {FIXED_SHORTCUTS.map((s) => (
                <div className="kbd-row" key={s.id}>
                  <span>{s.label}</span>
                  <span className="kbd-keys">
                    {s.combo.split("+").map((k) => <kbd key={k}>{k}</kbd>)}
                  </span>
                </div>
              ))}
              <div className="kbd-row"><span>Close settings / dialog</span><span className="kbd-keys"><kbd>Esc</kbd></span></div>
            </div>
            {conflict && (
              <div className="kbd-conflict" role="alert">
                <span>
                  <kbd>{conflict.combo}</kbd> is already used by <b>{conflict.otherLabel}</b>.
                  {conflict.fixed
                    ? " That one is built in and can’t be moved — pick a different combination."
                    : " Reassigning leaves that action without a shortcut."}
                </span>
                <span className="kbd-conflict-actions">
                  {!conflict.fixed && conflict.otherId && (
                    <button
                      className="set-btn danger"
                      onClick={() => {
                        saveShortcut(conflict.otherId!, "");
                        saveShortcut(conflict.forId, conflict.combo);
                        setShortcuts(getShortcuts());
                        setConflict(null);
                      }}
                    >
                      Reassign
                    </button>
                  )}
                  <button className="set-btn" onClick={() => setConflict(null)}>
                    {conflict.fixed ? "OK" : "Keep as is"}
                  </button>
                </span>
              </div>
            )}
            <div className="set-row-sub">Only the shortcuts above with a Change button can be rebound.</div>
          </section>

          <section className="set-section">
            <SectionHead label="Agents" onReset={resetAgentsSection} />
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Default vendor</span><span className="set-row-sub">Pre-selected for new panes</span></div>
              <div className="seg">
                {vendors.map((v) => (
                  <button key={v.id} className={agents.defaultVendor === v.id ? "on" : ""} onClick={() => updateAgents({ ...agents, defaultVendor: v.id })}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="agent-list">
              {vendors.map((v) => (
                <div className="agent-row" key={v.id}>
                  <span className="agent-row-name">
                    {v.label}
                    {/* #219 install + auth state; sign-in opens a pane so the CLI runs its own login flow. */}
                    {/* UI-9 / UI-111: 'not installed' with no next step is a dead end — a
                        popover carries what's wrong plus the fix, rather than crammed
                        inline buttons on the chip itself. */}
                    {!v.installed && (
                      <button
                        type="button"
                        className="agent-chip warn agent-popover-trigger"
                        aria-haspopup="dialog"
                        aria-expanded={popover?.vendorId === v.id && popover.kind === "install"}
                        onClick={(e) => openAgentPopover(e, v.id, "install")}
                      >
                        not installed
                      </button>
                    )}
                    {v.installed && v.authState === "none" && (
                      <button
                        type="button"
                        className="agent-chip warn agent-popover-trigger"
                        aria-haspopup="dialog"
                        aria-expanded={popover?.vendorId === v.id && popover.kind === "auth"}
                        onClick={(e) => openAgentPopover(e, v.id, "auth")}
                      >
                        not signed in
                      </button>
                    )}
                    {v.installed && v.authState === "ok" && v.kind === "agent" && (
                      <span className="agent-chip ok" title="Stored sign-in found">signed in</span>
                    )}
                    {/* UI-239/UX-588: prove a vendor launches without committing
                        a workspace to it — one throwaway pane, isolation off,
                        so there's no worktree to clean up afterwards. The
                        result (launched cleanly / didn't) shows as a small
                        checklist badge once the probe resolves — the light
                        first-run "does each agent actually work" check. */}
                    {v.installed && (
                      <button
                        className="agent-chip agent-test"
                        title={`Open a throwaway ${v.short} pane to check it launches`}
                        onClick={() => testLaunch(v.id, v.short)}
                      >
                        {launchCheck[v.id] === "testing" ? "testing…" : "test launch"}
                      </button>
                    )}
                    {launchCheck[v.id] === "ok" && (
                      <span className="agent-chip ok" title="The last test pane started cleanly">✓ launches</span>
                    )}
                    {launchCheck[v.id] === "error" && (
                      <span className="agent-chip warn" title="The last test pane didn’t reach a running state">✗ didn’t start</span>
                    )}
                  </span>
                  <input
                    className="set-input" placeholder="extra CLI flags"
                    value={agents.flags[v.id] ?? ""}
                    onChange={(e) => updateAgents({ ...agents, flags: { ...agents.flags, [v.id]: e.target.value } })}
                  />
                  <input
                    className="set-input" placeholder="binary path override"
                    value={agents.binaryPaths[v.id] ?? ""}
                    onChange={(e) => updateAgents({ ...agents, binaryPaths: { ...agents.binaryPaths, [v.id]: e.target.value } })}
                  />
                  {/* UI-51: per-agent colour — chips/dots/cards follow. */}
                  <label className="agent-color" title={`Colour for ${v.label} — chips and status dots follow`}>
                    <span className="agent-color-dot" style={{ background: vendorColor(v.id) }} />
                    <input
                      type="color"
                      value={vendorAccentOverrides()[v.id] ?? "#43A6F5"}
                      onChange={(e) => setVendorAccentOverride(v.id, e.target.value)}
                    />
                  </label>
                  {vendorAccentOverrides()[v.id] && (
                    <button className="agent-color-reset" title="Reset to the default colour" onClick={() => setVendorAccentOverride(v.id, null)}>×</button>
                  )}
                </div>
              ))}
            </div>
            {manifestProblems.length > 0 && (
              <div className="manifest-problems" role="alert">
                <div className="manifest-problems-t">
                  {manifestProblems.length} vendor file{manifestProblems.length === 1 ? "" : "s"} couldn’t be loaded
                </div>
                {manifestProblems.map((m) => (
                  <div className="manifest-problem" key={m.file}>
                    <code>{m.file}</code> — {m.error}
                  </div>
                ))}
              </div>
            )}
            {/* K0a: the trust dialog promises this exists — so it has to. */}
            {trusted.length > 0 && (
              <div className="set-row set-row-block">
                <div className="set-row-t">
                  <span className="set-row-name">Trusted folders</span>
                  <span className="set-row-sub">
                    Folders you’ve let a trust-requiring agent (Antigravity) work in. Revoking means
                    you’ll be asked again next time.
                  </span>
                </div>
                <div className="trust-list">
                  {trusted.map((t) => (
                    <div className="trust-row" key={t}>
                      <span className="trust-path" title={t}>{t}</span>
                      <button
                        className="set-btn"
                        onClick={() => { untrustRepo(t); setTrusted(trustedRepos()); }}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">Add your own agent</span>
                <span className="set-row-sub">Drop a JSON manifest in the vendors folder — no rebuild. Start from _example-opencode.json.</span>
              </div>
              <button
                className="set-btn"
                onClick={() => {
                  invoke<string | null>("vendors_dir")
                    .then((dir) => { if (dir) return revealPath(dir); })
                    .catch(() => useUI.getState().pushToast("error", "Couldn’t open the vendors folder."));
                }}
              >
                Open vendors folder
              </button>
            </div>
          </section>

          <section className="set-section">
            <SectionHead label="Startup" onReset={resetStartupSection} />
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">On launch</span></div>
              <div className="seg">
                <button className={startup === "reopen" ? "on" : ""} onClick={() => updateStartup("reopen")}>Reopen last session</button>
                <button className={startup === "launcher" ? "on" : ""} onClick={() => updateStartup("launcher")}>Show launcher</button>
              </div>
            </div>
          </section>

          <DiagnosticsSection />

          <SessionSection />

          <section className="set-section">
            <div className="set-label">Reset</div>
            {/* UI-182: every preference in one file — theme export above only
                covers the visual tokens; this is flags, shortcuts, agent
                overrides, startup behaviour, everything else Settings holds. */}
            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">All settings</span>
                <span className="set-row-sub">Export every preference to one file, or import one back</span>
              </div>
              <div className="seg">
                <button onClick={handleExportAllSettings}>Export</button>
                <button onClick={() => allSettingsFileRef.current?.click()}>Import</button>
              </div>
              <input ref={allSettingsFileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={handleImportAllSettingsFile} />
            </div>
            {allSettingsImportError && <div className="set-error">{allSettingsImportError}</div>}
            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">Reset all settings</span>
                <span className="set-row-sub">
                  Theme, accent, terminal, shortcuts, agents and startup — back to defaults.
                  Your workspaces, board and worktrees are untouched.
                </span>
              </div>
              <button className="set-btn danger" onClick={resetEverything}>Reset</button>
            </div>
          </section>

          <section className="set-section">
            <div className="set-label">About</div>
            {/* UI-196: persistence is silent by design, but "is my session
                actually being saved?" deserves a visible answer. */}
            <div className="set-row-sub">
              {savedAgo === null
                ? "Session autosave is on — nothing saved yet this run."
                : `Session last saved ${savedAgo}.`}
            </div>
            <div className="set-about">Flightdeck v{APP_VERSION} — a multi-agent terminal cockpit. Deep Cove build.</div>
            {/* UX-600: the manifest's own notes for the version just installed,
                shown once. Distinct from the hand-kept CHANGELOG below it —
                this is always exactly what shipped, straight from the source
                that produced this build. */}
            {whatsNew && (
              <div className="set-whatsnew">
                <div className="set-whatsnew-t">New since your last version ({whatsNew.version})</div>
                <div className="set-whatsnew-body">{whatsNew.notes}</div>
              </div>
            )}
            <UpdatesBlock />
            {/* UI-42: a real "what's new" — the cheapest active-development signal. */}
            <details className="set-changelog">
              <summary>Full changelog</summary>
              <ul>
                {CHANGELOG.map((c) => (
                  <li key={c.date + c.text}><span className="set-cl-date">{c.date}</span> {c.text}</li>
                ))}
              </ul>
            </details>
          </section>
          <div className="set-noresults" style={{ display: "none" }}>
            Nothing matches that. Try a shorter word — sections are matched on their full text.
          </div>
        </div>
      </div>
      {/* UI-111: install/sign-in popover, portalled so the modal's own
          scroll/mask can't clip it. */}
      {popover && popoverPos && popoverVendor && createPortal(
        <div
          className="agent-popover"
          style={{ top: popoverPos.top, left: popoverPos.left }}
          role="dialog"
          aria-label={popover.kind === "install" ? `${popoverVendor.label} isn’t installed` : `${popoverVendor.label} isn’t signed in`}
        >
          {popover.kind === "install" ? (
            <>
              <div className="agent-pop-title">{popoverVendor.label} isn’t installed</div>
              <div className="agent-pop-body">{popoverVendor.detail || "Flightdeck couldn’t find this CLI on your PATH."}</div>
              {popoverVendor.installHint && (
                <div className="agent-pop-cmd">
                  <code>{popoverVendor.installHint}</code>
                  <button
                    className="agent-pop-btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(popoverVendor.installHint)
                        .then(() => useUI.getState().pushToast("success", "Install command copied — paste it in any pane."))
                        .catch(() => useUI.getState().pushToast("info", popoverVendor.installHint));
                    }}
                  >
                    Copy
                  </button>
                </div>
              )}
              {popoverVendor.installUrl && (
                <button className="agent-pop-link" onClick={() => void openUrl(popoverVendor.installUrl).catch(() => {})}>
                  Installation guide ↗
                </button>
              )}
            </>
          ) : (
            <>
              <div className="agent-pop-title">{popoverVendor.label} isn’t signed in</div>
              <div className="agent-pop-body">
                {popoverVendor.authDetail || "No stored sign-in found."} The CLI handles its own login — running it
                opens a pane in the current workspace so you can complete sign-in there.
              </div>
              <button
                className="agent-pop-btn"
                onClick={() => {
                  const s = useApp.getState();
                  const ws = s.workspaces.find((w) => w.id === s.activeId);
                  if (!ws) { useUI.getState().pushToast("info", "Open a workspace first — sign-in runs in a pane."); return; }
                  void spawnPane(ws.id, popoverVendor.id, ws.root, false);
                  setPopover(null);
                  useUI.getState().setSettingsOpen(false);
                }}
              >
                Run login
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
