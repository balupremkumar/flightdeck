// updater.ts — typed client for the Rust `updates` module (local-file
// self-update: no network, reads releases\latest.json next to the app). See
// src-tauri/src/updates.rs for the check/install commands themselves.
//
// invoke() is an `async` function on the Rust->JS bridge (@tauri-apps/api/core),
// so calling it outside a real Tauri window rejects rather than throwing
// synchronously — a plain try/catch around the await is enough of a guard for
// the demo/browser build, matching how persist.ts/session.ts already call
// invoke without the special sync-throw guard `getCurrentWebview()` needs.
import { invoke } from "@tauri-apps/api/core";
import { useUI, type UpdateInfo } from "./ui";

export const DEFAULT_RELEASES_DIR = String.raw`D:\Dev\ai\projects\active\flightdeck\releases`;

const RELEASES_DIR_KEY = "flightdeck-releases-dir";
const AUTO_CHECK_KEY = "flightdeck-auto-update-check";

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

/** Default ON — matches the brief; a first-run user gets checked without having to find the toggle. */
export function getAutoUpdateCheck(): boolean {
  try { return localStorage.getItem(AUTO_CHECK_KEY) !== "0"; } catch { return true; }
}
export function setAutoUpdateCheck(on: boolean) {
  try { localStorage.setItem(AUTO_CHECK_KEY, on ? "1" : "0"); } catch { /* non-persistent */ }
}

export interface UpdateCheckResult {
  available: boolean;
  info?: UpdateInfo;
  error?: string;
}

// Rust's UpdateCheckResult (updates.rs), camelCased by Tauri's arg/return mapping.
interface RawCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
  installerPath?: string;
  error?: string;
}

/** Runs the local-file check and mirrors the outcome into the UI store (topbar
 *  gear dot + Settings > About both read `updateAvailable` from there, so
 *  every trigger — startup, the command palette, the Settings button — stays
 *  in agreement). */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const releasesDir = getReleasesDir();
  let raw: RawCheckResult;
  try {
    raw = await invoke<RawCheckResult>("check_update", releasesDir ? { releasesDir } : {});
  } catch (e) {
    return { available: false, error: String(e) };
  }
  if (raw.error) return { available: false, error: raw.error };
  if (raw.available && raw.version && raw.installerPath) {
    const info: UpdateInfo = { version: raw.version, notes: raw.notes ?? "", installerPath: raw.installerPath };
    useUI.getState().setUpdateAvailable(info);
    return { available: true, info };
  }
  useUI.getState().setUpdateAvailable(null);
  return { available: false };
}

/** Validates + installs on the Rust side, reaps live panes, relaunches. On
 *  success the app exits itself (see updates.rs) — a caller that's still
 *  running after this resolves should treat it the same as a thrown error. */
export async function installUpdate(installerPath: string): Promise<void> {
  const releasesDir = getReleasesDir();
  await invoke("install_update", { installerPath, ...(releasesDir ? { releasesDir } : {}) });
}

// Startup silent check (~10s after boot, so it never competes with session
// restore): once per app run, respects the toggle, never nags twice for the
// same version even if something re-triggers a check later in the session.
let toastedForVersion: string | null = null;
export function scheduleStartupCheck() {
  if (!getAutoUpdateCheck()) return;
  window.setTimeout(() => {
    void checkForUpdate().then((res) => {
      if (res.available && res.info && toastedForVersion !== res.info.version) {
        toastedForVersion = res.info.version;
        useUI.getState().pushToast("info", `Flightdeck ${res.info.version} is available — Settings > About to install.`);
      }
    });
  }, 10_000);
}
