// updater.ts — typed client for the Rust `updates` module's check_update.
//
// Notify-only by design (brain ruling 2026-10-04): Flightdeck never installs
// itself. "Check for updates" reads latest.json in the releases folder and
// reports whether a newer version exists; the user then closes Flightdeck and
// runs the installer by hand (installing from inside the app kills every pane
// through the job object). Nothing here runs at startup or on a timer.
//
// invoke() is an `async` function on the Rust->JS bridge (@tauri-apps/api/core),
// so calling it outside a real Tauri window rejects rather than throwing
// synchronously — a plain try/catch around the await is enough of a guard for
// the demo/browser build.
import { invoke } from "@tauri-apps/api/core";
import { useUI, type UpdateInfo } from "./ui";

const RELEASES_DIR_KEY = "flightdeck-releases-dir";

export function getReleasesDir(): string {
  try { return localStorage.getItem(RELEASES_DIR_KEY) ?? ""; } catch { return ""; }
}
export function setReleasesDir(dir: string) {
  try {
    const v = dir.trim();
    if (v) localStorage.setItem(RELEASES_DIR_KEY, v);
    else localStorage.removeItem(RELEASES_DIR_KEY);
  } catch { /* non-persistent */ }
}

/** The folder to actually use: the user's saved choice, else whatever Rust
 *  suggests (FLIGHTDECK_RELEASES_DIR, or the repo's releases\ in a dev build),
 *  else "" meaning "ask the user to pick one". No dev path is baked in here. */
export async function resolveReleasesDir(): Promise<string> {
  const saved = getReleasesDir();
  if (saved) return saved;
  try { return (await invoke<string>("default_releases_dir")) ?? ""; } catch { return ""; }
}

export interface UpdateCheckResult {
  available: boolean;
  info?: UpdateInfo;
  error?: string;
  /** Machine-readable twin of `error` — see UpdateError::kind in updates.rs. */
  errorKind?: string;
}

// Rust's UpdateCheckResult (updates.rs), camelCased by Tauri's arg/return mapping.
interface RawCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
  installerPath?: string;
  error?: string;
  errorKind?: string;
}

// UX-600: "what's new since your last version" reads the release manifest's
// own `notes`, not a hand-typed changelog. checkForUpdate is the only place
// that ever sees a newer version's notes, so it's stashed here every time a
// newer version is seen. Settings compares its own APP_VERSION against this
// on mount: once they match, the just-installed version's real notes are
// shown once, then cleared.
const PENDING_NOTES_KEY = "flightdeck-pending-release-notes";
export interface PendingRelease { version: string; notes: string; }
function savePendingReleaseNotes(v: PendingRelease) {
  try { localStorage.setItem(PENDING_NOTES_KEY, JSON.stringify(v)); } catch { /* non-persistent */ }
}
export function getPendingReleaseNotes(): PendingRelease | null {
  try {
    const raw = localStorage.getItem(PENDING_NOTES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === "string" && typeof parsed.notes === "string") return parsed;
    return null;
  } catch { return null; }
}
export function clearPendingReleaseNotes() {
  try { localStorage.removeItem(PENDING_NOTES_KEY); } catch { /* non-persistent */ }
}

/** Runs the local-file check and mirrors the outcome into the UI store (topbar
 *  gear dot + Settings > About both read `updateAvailable` from there). Only
 *  ever called from a user action (Settings button, command palette). */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const releasesDir = await resolveReleasesDir();
  if (!releasesDir) {
    return { available: false, error: "No releases folder is set. Pick the folder that contains latest.json.", errorKind: "releases-dir-unset" };
  }
  let raw: RawCheckResult;
  try {
    raw = await invoke<RawCheckResult>("check_update", { releasesDir });
  } catch (e) {
    return { available: false, error: String(e) };
  }
  if (raw.error) return { available: false, error: raw.error, errorKind: raw.errorKind };
  if (raw.available && raw.version && raw.installerPath) {
    const info: UpdateInfo = { version: raw.version, notes: raw.notes ?? "", installerPath: raw.installerPath };
    useUI.getState().setUpdateAvailable(info);
    savePendingReleaseNotes({ version: raw.version, notes: raw.notes ?? "" });
    return { available: true, info };
  }
  useUI.getState().setUpdateAvailable(null);
  return { available: false };
}

/** The sentence Settings offers for copying next to an available update. */
export function installNote(version: string, installerPath: string): string {
  return `Flightdeck ${version} is available. Close Flightdeck, then run the installer: ${installerPath}`;
}

/** The revert command shown (copyable) in Settings. Run it from the Flightdeck
 *  repo folder, in PowerShell 7, with Flightdeck closed. */
export const REVERT_COMMAND = String.raw`pwsh .\tools\revert.ps1 -To <version>`;
