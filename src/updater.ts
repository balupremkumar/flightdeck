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
  /** Machine-readable twin of `error` — see UpdateError::kind in updates.rs. */
  errorKind?: string;
  /** Set when the failure still leaves a runnable installer on disk. */
  manualPath?: string;
}

// Rust's UpdateCheckResult (updates.rs), camelCased by Tauri's arg/return mapping.
interface RawCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
  installerPath?: string;
  error?: string;
  errorKind?: string;
  manualPath?: string;
}

// Rust's UpdateError (updates.rs). install_update rejects with this OBJECT,
// not a string — String(e) on it would render "[object Object]", so every
// caller should go through asUpdateError() below.
export interface UpdateError {
  kind: string;
  message: string;
  detail?: string;
  manualPath?: string;
  exitCode?: number;
}

/** What installUpdate throws. An Error subclass (rather than the bare object
 *  Rust sends) purely so that an existing `String(e)` / `${e}` caller keeps
 *  rendering the sentence a human needs — including the manual fallback path,
 *  which is baked into `message` on the Rust side — instead of the
 *  "[object Object]" a plain serialised struct would give them. */
export class UpdateInstallError extends Error implements UpdateError {
  kind: string;
  detail?: string;
  manualPath?: string;
  exitCode?: number;
  constructor(e: UpdateError) {
    super(e.message);
    this.name = "UpdateInstallError";
    this.kind = e.kind;
    this.detail = e.detail;
    this.manualPath = e.manualPath;
    this.exitCode = e.exitCode;
  }
  override toString() { return this.message; }
}

/** Normalises anything invoke() can reject with into a renderable UpdateError:
 *  the typed object from Rust, a bare string from the bridge itself (e.g. the
 *  command not existing in a browser build), or a thrown JS Error. */
export function asUpdateError(e: unknown): UpdateError {
  if (e && typeof e === "object" && typeof (e as UpdateError).message === "string" && typeof (e as UpdateError).kind === "string") {
    return e as UpdateError;
  }
  return { kind: "unknown", message: String(e) };
}

// Rust's UpdateOutcome (updates.rs): what the detached watcher recorded about
// the last install attempt, evaluated against the version actually running.
export interface UpdateOutcome {
  ok: boolean;
  stage: string;
  attemptedVersion: string;
  currentVersion: string;
  exitCode?: number;
  message: string;
  detail?: string;
  manualPath?: string;
}

// UX-600: "what's new since your last version" reads the release manifest's
// own `notes`, not a hand-typed changelog. checkForUpdate is the only place
// that ever sees a newer version's notes (the app exits itself to install —
// see updates.rs — so nothing in memory survives the relaunch), so it's
// stashed here every time a newer version is seen. Settings compares its own
// APP_VERSION against this on mount: once they match, the just-installed
// version's real notes are shown once, then cleared.
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
  if (raw.error) return { available: false, error: raw.error, errorKind: raw.errorKind, manualPath: raw.manualPath };
  if (raw.available && raw.version && raw.installerPath) {
    const info: UpdateInfo = { version: raw.version, notes: raw.notes ?? "", installerPath: raw.installerPath };
    useUI.getState().setUpdateAvailable(info);
    savePendingReleaseNotes({ version: raw.version, notes: raw.notes ?? "" });
    return { available: true, info };
  }
  useUI.getState().setUpdateAvailable(null);
  return { available: false };
}

/** Validates + installs on the Rust side, reaps live panes, relaunches. On
 *  success the app exits itself (see updates.rs) — a caller that's still
 *  running after this resolves should treat it the same as a thrown error.
 *
 *  Rejects with an UpdateInstallError carrying the typed Rust error (kind,
 *  detail, exit code, manual installer path) and stringifying to the message.
 *  Every rejection here means nothing was installed and the app is still up;
 *  anything that goes wrong AFTER the exit is reported on the next boot by
 *  reportLastUpdate(). */
export async function installUpdate(installerPath: string): Promise<void> {
  const releasesDir = getReleasesDir();
  try {
    await invoke("install_update", { installerPath, ...(releasesDir ? { releasesDir } : {}) });
  } catch (e) {
    throw new UpdateInstallError(asUpdateError(e));
  }
}

// Rollback (deployment rework, phase 3): older stable installers still in the
// releases folder, newest first, already pre-flighted on the Rust side.
export interface RollbackCandidate { version: string; installerPath: string }
export async function listRollbackCandidates(): Promise<RollbackCandidate[]> {
  const releasesDir = getReleasesDir();
  try {
    return await invoke<RollbackCandidate[]>("list_rollback_candidates", releasesDir ? { releasesDir } : {});
  } catch {
    return []; // browser rig / no bridge — the row simply doesn't render
  }
}

// ---------------------------------------------------------------------------
// UPD-1: what happened to the LAST update attempt
// ---------------------------------------------------------------------------
// The app kills itself to let the silent installer overwrite its exe, so for
// the whole window in which an update can fail there is no UI alive to report
// anything. The detached watcher (updates.rs) writes a status file instead;
// this reads it exactly once on the next boot and turns it into a toast, and
// keeps a copy for Settings > About so a 3.5s toast isn't the only trace of
// "your update silently did nothing".

const LAST_FAILURE_KEY = "flightdeck-update-failure";

export interface StoredUpdateFailure {
  version: string;
  message: string;
  detail?: string;
  manualPath?: string;
  exitCode?: number;
  at: number;
}

/** The most recent failed update attempt, or null. Settings > About renders
 *  this as a persistent banner (a toast alone is too easy to miss), and
 *  clears it once the user has seen it. */
export function getUpdateFailure(): StoredUpdateFailure | null {
  try {
    const raw = localStorage.getItem(LAST_FAILURE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.version === "string" && typeof p.message === "string") return p;
    return null;
  } catch { return null; }
}
export function clearUpdateFailure() {
  try { localStorage.removeItem(LAST_FAILURE_KEY); } catch { /* non-persistent */ }
}
function saveUpdateFailure(f: StoredUpdateFailure) {
  try { localStorage.setItem(LAST_FAILURE_KEY, JSON.stringify(f)); } catch { /* non-persistent */ }
}

/** Reads (and clears, on the Rust side) the watcher's record of the last
 *  install attempt. Returns null when no update was attempted since the last
 *  boot, or when there's no Tauri bridge (browser/demo build). */
export async function takeUpdateStatus(): Promise<UpdateOutcome | null> {
  try {
    return (await invoke<UpdateOutcome | null>("take_update_status")) ?? null;
  } catch { return null; }
}

/** Boot-time hand-back. A failed update is loud twice over: an error toast
 *  now, and a stored record Settings can keep showing. A successful one gets
 *  a quiet confirmation so "install & restart" always ends in an answer. */
export async function reportLastUpdate(): Promise<UpdateOutcome | null> {
  const outcome = await takeUpdateStatus();
  if (!outcome) return null;
  if (outcome.ok) {
    clearUpdateFailure();
    useUI.getState().pushToast("success", outcome.message);
    return outcome;
  }
  saveUpdateFailure({
    version: outcome.attemptedVersion,
    message: outcome.message,
    detail: outcome.detail,
    manualPath: outcome.manualPath,
    exitCode: outcome.exitCode,
    at: Date.now(),
  });
  useUI.getState().pushToast("error", outcome.message, {
    detail: [
      outcome.detail,
      outcome.exitCode != null ? `Installer exit code: ${outcome.exitCode}` : undefined,
      outcome.manualPath ? `Installer: ${outcome.manualPath}` : undefined,
      `Stage: ${outcome.stage}`,
    ].filter(Boolean).join("\n"),
  });
  return outcome;
}

// Startup silent check (~10s after boot, so it never competes with session
// restore): once per app run, respects the toggle, never nags twice for the
// same version even if something re-triggers a check later in the session.
let toastedForVersion: string | null = null;
export function scheduleStartupCheck() {
  // Runs BEFORE the auto-check guard and on its own short delay: "your last
  // update failed" is not a preference, it's the answer to a button the user
  // already pressed. 2s is just enough to be after the session-restore
  // prompt's own toasts rather than under them.
  window.setTimeout(() => { void reportLastUpdate(); }, 2_000);

  if (!getAutoUpdateCheck()) return;
  window.setTimeout(() => {
    void checkForUpdate().then((res) => {
      if (res.available && res.info && toastedForVersion !== res.info.version) {
        toastedForVersion = res.info.version;
        useUI.getState().pushToast("info", `Flightdeck ${res.info.version} is available — Settings > About to install.`);
      }
      // A pre-flight failure (corrupt/half-copied installer, manifest pointing
      // at the wrong version) used to be visible only to whoever happened to
      // open Settings. It's a broken release; say so.
      if (res.error && res.errorKind && res.errorKind.startsWith("installer-")) {
        useUI.getState().pushToast("error", `Flightdeck update problem: ${res.error}`);
      }
    });
  }, 10_000);
}
