// updates.rs — in-app self-update, local-file only. The installed app and the
// release output (built by tools/release.ps1) live on the same machine, so
// "checking for updates" means reading releases\latest.json next to the
// installer rather than hitting a server. No network, no signing/updater
// plugin.
//
// check_update: reads latest.json, PRE-FLIGHTS the installer it names (exists,
// is a real non-truncated PE, version in its filename agrees with the
// manifest), compares its version against this build's CARGO_PKG_VERSION.
// install_update: validates the installer path is INSIDE the configured
// releases dir (never launch an arbitrary exe on the webview's say-so — same
// D11 discipline as worktree.rs's ensure_under), reaps every live pane the
// same way ExitRequested does, spawns a detached watcher, then exits.
// take_update_status: read once, on the next boot, whatever the watcher
// recorded about how that install actually went.
//
// ---------------------------------------------------------------------------
// Why this file is paranoid (UPD-1, 2026-08-01)
// ---------------------------------------------------------------------------
// The installer is an UNSIGNED NSIS exe run with /S (silent) by a detached
// process, after which this app kills itself. That means the app is NOT ALIVE
// to report anything for the entire window in which the update can fail — and
// an unsigned installer is exactly the kind of thing Defender quarantines with
// no visible error. The pre-2026-08-01 version of this file had six ways to
// fail in total silence:
//
//   1. The installer started BEFORE the app had exited (the watcher fired
//      immediately), so NSIS could be overwriting a running exe.
//   2. Start-Process throwing (file quarantined/blocked, UAC cancelled) killed
//      the watcher script mid-way, so the relaunch never ran either: the app
//      vanished and never came back.
//   3. A non-zero installer exit code was discarded entirely.
//   4. An installer that exited 0 without doing anything (a quarantine
//      mid-install looks like this) was indistinguishable from success.
//   5. A relaunch that failed had no channel at all — no app, no message.
//   6. A truncated/half-copied installer was offered as a valid update
//      because only `.exists()` was checked.
//
// Every one of those now lands somewhere the user can see: a status file the
// watcher writes at each stage, read and cleared on the next boot
// (take_update_status), plus a native MessageBox from the watcher itself for
// the cases where the app is never coming back to show a toast. Every failure
// message names the installer's full path so the manual fallback (run it by
// hand from releases\) is always one sentence away.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::canary;
use crate::{live_pane_ids, reap_pane, Registry};

/// Balu's single-machine setup: build output and the running install share
/// this box, so there's one sane default. Overridable from Settings for the
/// rare case it moves (persisted on the frontend, passed in on every call).
const DEFAULT_RELEASES_DIR: &str = r"D:\Dev\ai\projects\active\flightdeck\releases";

/// Written by the detached watcher at every stage of the install, read once on
/// the next boot by take_update_status. Lives in app_data_dir (alongside the
/// session file) because the app is the only reader and the releases dir may
/// be on a different volume.
const UPDATE_STATUS_FILE: &str = "update-status.json";

/// Floor for "this file is not a real installer". Real builds are ~2.6 MB and
/// only grow; anything under half a meg is a half-finished copy, a truncated
/// download, or a placeholder — never something worth running with /S.
const MIN_INSTALLER_BYTES: u64 = 512 * 1024;

/// How long the watcher waits for this process to actually exit before giving
/// up. Installing over a running copy is the one thing worse than not
/// installing at all, so a timeout ABORTS the install rather than racing it.
const APP_EXIT_WAIT_SECS: u32 = 45;

#[derive(Deserialize)]
struct LatestManifest {
    version: String,
    notes: String,
    #[serde(default)]
    #[allow(dead_code)] // round-tripped for humans reading latest.json, not used here
    pub_date: String,
    installer: String,
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/// One machine-readable failure the frontend can branch on, plus the human
/// text and — always, for anything the user could fix by hand — the exact
/// installer path to run themselves.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateError {
    /// Stable identifier: "manifest-unreadable", "manifest-malformed",
    /// "installer-name-unsafe", "installer-missing", "installer-empty",
    /// "installer-truncated", "installer-not-executable",
    /// "installer-version-mismatch", "installer-outside-releases",
    /// "watcher-spawn-failed", "unsupported-platform".
    pub kind: String,
    pub message: String,
    pub detail: Option<String>,
    /// Full path of the installer the user can run by hand, when there is one.
    pub manual_path: Option<String>,
    pub exit_code: Option<i32>,
}

impl UpdateError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into(), detail: None, manual_path: None, exit_code: None }
    }
    fn with_manual(mut self, installer: &Path) -> Self {
        self.manual_path = Some(installer.display().to_string());
        self.message = format!("{} {}", self.message, manual_hint(installer));
        self
    }
    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// The manual fallback, spelled out with the full path every single time. This
/// string is the whole point of the feature: whatever went wrong, the user's
/// next move is "go run that file yourself".
fn manual_hint(installer: &Path) -> String {
    format!(
        "You can still update by hand: run {} directly (double-click it). If Windows Security blocks it, open Windows Security > Virus & threat protection > Protection history and allow it, then run it again.",
        installer.display()
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub installer_path: Option<String>,
    /// Human text (kept a plain string so existing UI keeps rendering it).
    pub error: Option<String>,
    /// Machine-readable twin of `error` — see UpdateError::kind.
    pub error_kind: Option<String>,
    /// Set whenever the failure still leaves a runnable installer on disk.
    pub manual_path: Option<String>,
}

impl UpdateCheckResult {
    fn none() -> Self {
        Self {
            available: false,
            version: None,
            notes: None,
            installer_path: None,
            error: None,
            error_kind: None,
            manual_path: None,
        }
    }
    fn err(e: UpdateError) -> Self {
        Self {
            available: false,
            version: None,
            notes: None,
            installer_path: None,
            error: Some(e.message),
            error_kind: Some(e.kind),
            manual_path: e.manual_path,
        }
    }
}

fn releases_path(dir: Option<&str>) -> PathBuf {
    match dir.map(str::trim) {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => PathBuf::from(DEFAULT_RELEASES_DIR),
    }
}

/// Plain X.Y.Z compare (this project's only version shape). Missing/unparsable
/// components read as 0 rather than failing the check — a malformed remote
/// version should read as "not newer", not crash the check.
fn version_gt(a: &str, b: &str) -> bool {
    fn parts(s: &str) -> Vec<u64> {
        s.trim().split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect()
    }
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/// `installer` in latest.json must be a bare file name in the releases dir.
/// A path with separators (or `..`, or a drive) would make `dir.join(...)`
/// point anywhere on disk; ensure_under_releases_dir catches that at install
/// time, but an update should never be OFFERED on the back of one either.
fn safe_installer_name(name: &str) -> Result<(), UpdateError> {
    let bad = name.trim().is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':');
    if bad {
        return Err(UpdateError::new(
            "installer-name-unsafe",
            format!("latest.json's \"installer\" must be a bare file name inside the releases folder, got: {name}"),
        ));
    }
    Ok(())
}

/// Tauri names the NSIS artifact `Flightdeck_<version>_x64-setup.exe` and
/// release.ps1 hard-codes that name, so the version is readable straight off
/// the file name. Returns None for any other shape (a hand-renamed file), in
/// which case the mismatch check is skipped rather than failing a legitimate
/// file.
fn version_from_installer_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("Flightdeck_")?;
    let (ver, _) = rest.split_once('_')?;
    if ver.is_empty() || !ver.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    Some(ver)
}

/// Everything that must be true before an installer is worth offering, let
/// alone running: it exists, it is a file, it is not empty, it is not a
/// half-finished copy, it starts with the DOS `MZ` header of a real Windows
/// executable, and (when the name carries a version) that version is the one
/// the manifest is promising.
///
/// The AUTHORITATIVE binary-version check is the one in tools/release.ps1,
/// which reads the exe's VERSIONINFO resource at cut time. Doing that here
/// would mean hand-rolling GetFileVersionInfoW; the filename check catches the
/// realistic failure (a manifest edited to point at an older installer)
/// without any FFI.
fn preflight_installer(installer: &Path, expected_version: Option<&str>) -> Result<(), UpdateError> {
    let meta = match std::fs::metadata(installer) {
        Ok(m) => m,
        Err(e) => {
            return Err(UpdateError::new(
                "installer-missing",
                format!("The installer for this update is not there: {}.", installer.display()),
            )
            .with_detail(e.to_string()))
        }
    };
    if !meta.is_file() {
        return Err(UpdateError::new(
            "installer-missing",
            format!("{} is not a file.", installer.display()),
        ));
    }
    if meta.len() == 0 {
        return Err(UpdateError::new(
            "installer-empty",
            format!("The installer {} is 0 bytes — the release copy did not finish. Re-run tools/release.ps1.", installer.display()),
        ));
    }
    if meta.len() < MIN_INSTALLER_BYTES {
        return Err(UpdateError::new(
            "installer-truncated",
            format!(
                "The installer {} is only {} bytes, far smaller than a real Flightdeck installer (~2.6 MB) — it is truncated or half-copied. Re-run tools/release.ps1.",
                installer.display(),
                meta.len()
            ),
        ));
    }
    // Cheap corruption probe: any real .exe starts "MZ". A quarantined file
    // replaced by a stub, or a copy interrupted at byte 0, fails here.
    let mut head = [0u8; 2];
    match std::fs::File::open(installer).and_then(|mut f| {
        use std::io::Read;
        f.read_exact(&mut head)
    }) {
        Ok(()) => {}
        Err(e) => {
            return Err(UpdateError::new(
                "installer-not-executable",
                format!("The installer {} could not be read: {e}", installer.display()),
            ))
        }
    }
    if &head != b"MZ" {
        return Err(UpdateError::new(
            "installer-not-executable",
            format!(
                "The installer {} is not a Windows executable (bad header) — it is corrupt or was replaced. Re-run tools/release.ps1.",
                installer.display()
            ),
        ));
    }
    if let (Some(expected), Some(name)) =
        (expected_version, installer.file_name().and_then(|n| n.to_str()))
    {
        if let Some(found) = version_from_installer_name(name) {
            if found != expected {
                return Err(UpdateError::new(
                    "installer-version-mismatch",
                    format!(
                        "latest.json offers {expected} but points at {name}, which is {found}. The release is inconsistent — re-run tools/release.ps1."
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// True for the Canary flavour (tauri.canary.conf.json). Canary never
/// self-updates: its whole job is to be the disposable side-by-side trial, and
/// the only installer latest.json ever names is the STABLE one — offering it
/// here would overwrite the user's working stable install from inside canary.
fn is_canary(app: &AppHandle) -> bool {
    canary::is_canary_identifier(&app.config().identifier)
}

#[tauri::command]
pub fn check_update(app: AppHandle, releases_dir: Option<String>) -> UpdateCheckResult {
    if is_canary(&app) {
        return UpdateCheckResult::none();
    }
    check_update_inner(releases_dir)
}

pub(crate) fn check_update_inner(releases_dir: Option<String>) -> UpdateCheckResult {
    let dir = releases_path(releases_dir.as_deref());
    let manifest_path = dir.join("latest.json");
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => {
            return UpdateCheckResult::err(UpdateError::new(
                "manifest-unreadable",
                format!("Couldn't read {}: {e}", manifest_path.display()),
            ))
        }
    };
    let manifest: LatestManifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            return UpdateCheckResult::err(UpdateError::new(
                "manifest-malformed",
                format!("{} is malformed: {e}", manifest_path.display()),
            ))
        }
    };
    if let Err(e) = safe_installer_name(&manifest.installer) {
        return UpdateCheckResult::err(e);
    }
    let installer_path = dir.join(&manifest.installer);
    let current = env!("CARGO_PKG_VERSION");
    if !version_gt(&manifest.version, current) {
        return UpdateCheckResult::none();
    }
    // Pre-flight BEFORE offering, not after clicking install: a corrupt or
    // half-copied installer must never reach the "Install & restart" button.
    if let Err(e) = preflight_installer(&installer_path, Some(&manifest.version)) {
        return UpdateCheckResult::err(e);
    }
    UpdateCheckResult {
        available: true,
        version: Some(manifest.version),
        notes: Some(manifest.notes),
        installer_path: Some(installer_path.to_string_lossy().into_owned()),
        error: None,
        error_kind: None,
        manual_path: None,
    }
}

// ---------------------------------------------------------------------------
// Rollback (deployment rework, phase 3). Every release cut leaves its
// installer in the releases dir, which makes "go back to the version that
// worked" a first-class action instead of the uninstall/hunt/reinstall loop
// the v0.5.3 failure forced. Installing an older NSIS build over a newer one
// is the same watcher path as an upgrade; evaluate_status already judges
// success by "running version == attempted version", which holds for a
// downgrade too.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RollbackCandidate {
    pub version: String,
    pub installer_path: String,
}

#[tauri::command]
pub fn list_rollback_candidates(app: AppHandle, releases_dir: Option<String>) -> Vec<RollbackCandidate> {
    if is_canary(&app) {
        return Vec::new(); // canary never installs anything (see is_canary)
    }
    list_rollback_candidates_inner(releases_dir)
}

/// Every STABLE installer in the releases dir strictly older than the running
/// version, newest first, pre-flighted so the UI never offers a corrupt file.
/// Canary artifacts don't parse as `Flightdeck_<ver>_` and drop out naturally.
pub(crate) fn list_rollback_candidates_inner(releases_dir: Option<String>) -> Vec<RollbackCandidate> {
    let dir = releases_path(releases_dir.as_deref());
    let current = env!("CARGO_PKG_VERSION");
    let mut out: Vec<RollbackCandidate> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(ver) = version_from_installer_name(&name) else { continue };
        if !version_gt(current, ver) {
            continue; // running version or newer — not a rollback
        }
        if preflight_installer(&entry.path(), Some(ver)).is_err() {
            continue;
        }
        out.push(RollbackCandidate {
            version: ver.to_string(),
            installer_path: entry.path().to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| {
        if version_gt(&a.version, &b.version) {
            std::cmp::Ordering::Less
        } else if version_gt(&b.version, &a.version) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    out
}

/// D11-style guard (mirrors worktree.rs's ensure_under): only ever launch an
/// installer that resolves to inside the configured releases dir — never an
/// arbitrary path the webview hands back to us.
fn ensure_under_releases_dir(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let cand = candidate
        .canonicalize()
        .map_err(|e| format!("installer not found: {e}"))?;
    if cand.starts_with(&root) {
        Ok(cand)
    } else {
        Err("installer is outside the releases folder".into())
    }
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

/// The detached watcher, as a PowerShell script. Placeholders are substituted
/// (not format!'d — the script is full of braces) and the whole thing is
/// handed over as a single -EncodedCommand (UTF-16LE, then base64) rather than
/// a `cmd /C "a" && "b"` string: cmd's re-parsing of a quoted /C argument is a
/// well-known footgun with paths that contain spaces, and both the installer
/// and install-dir paths here can.
///
/// Three things it does that the old one-liner did not:
///   - waits for THIS process to actually exit before running the installer;
///   - records every stage to the status file, including the exit code;
///   - relaunches even after a failed install, and if it cannot relaunch,
///     puts a native MessageBox on screen — the only channel left when the
///     app is never coming back on its own.
const WATCHER_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$statusPath = '@@STATUS@@'
$installer  = '@@INSTALLER@@'
$exePath    = '@@EXE@@'
$appPid     = @@PID@@
$version    = '@@VERSION@@'

function Save-Status([string]$stage, $code, [string]$msg) {
  try {
    $o = [ordered]@{
      stage     = $stage
      exitCode  = $code
      message   = $msg
      version   = $version
      installer = $installer
      at        = (Get-Date).ToUniversalTime().ToString('o')
    }
    Set-Content -LiteralPath $statusPath -Value ($o | ConvertTo-Json -Compress) -Encoding UTF8 -Force
  } catch { }
}

function Show-Box([string]$text) {
  try {
    Add-Type -Name FdUpd -Namespace Flightdeck -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);'
    [Flightdeck.FdUpd]::MessageBoxW([IntPtr]::Zero, $text, 'Flightdeck update', 0x30) | Out-Null
  } catch { }
}

# 1. Wait for Flightdeck to actually exit. NSIS overwriting a running exe is
#    how you get a half-installed app, so a timeout aborts instead of racing.
$deadline = (Get-Date).AddSeconds(@@WAIT@@)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $appPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $appPid -ErrorAction SilentlyContinue) {
  Save-Status 'app-exit-timeout' $null 'Flightdeck was still running when the installer was due to start, so it was not run.'
  Show-Box "Flightdeck could not update to $version.`r`n`r`nThe running copy never shut down, so the installer was not started (installing over a running copy breaks it).`r`n`r`nClose every Flightdeck window, then run this installer yourself:`r`n`r`n$installer"
  exit 1
}
Start-Sleep -Milliseconds 400

# 2. Silent install. Every outcome is recorded, including the exit code.
$stage = 'launch-failed'
$code = $null
$msg = ''
try {
  $proc = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait -ErrorAction Stop
  $code = $proc.ExitCode
  if ($null -eq $code) { $code = -1 }
  if ($code -eq 0) {
    $stage = 'installed'
  } else {
    $stage = 'installer-failed'
    $msg = "The installer exited with code $code."
  }
} catch {
  $stage = 'launch-failed'
  $msg = $_.Exception.Message
}
Save-Status $stage $code $msg

# 3. Relaunch ALWAYS. After a failed install the old exe is still on disk, and
#    the app itself is the only thing that can show the user what happened.
Start-Sleep -Milliseconds 600
$relaunched = $false
try {
  Start-Process -FilePath $exePath -ErrorAction Stop
  $relaunched = $true
} catch {
  $msg = ($msg + ' Relaunch failed: ' + $_.Exception.Message).Trim()
}
if (-not $relaunched) {
  Save-Status 'relaunch-failed' $code $msg
  if ($stage -eq 'installed') {
    Show-Box "Flightdeck $version installed, but it could not be restarted automatically.`r`n`r`nStart Flightdeck again from the Start menu.`r`n`r`nDetails: $msg"
  } else {
    Show-Box "Flightdeck could not update to $version, and could not be restarted either.`r`n`r`n$msg`r`n`r`nThis is what an unsigned installer being blocked by antivirus looks like. Run this installer yourself:`r`n`r`n$installer`r`n`r`nIf Windows Security blocks it, allow it under Virus & threat protection > Protection history."
  }
}
"#;

fn build_watcher_script(status: &Path, installer: &Path, exe: &Path, pid: u32, version: &str) -> String {
    fn q(s: &str) -> String {
        s.replace('\'', "''")
    }
    WATCHER_SCRIPT
        .replace("@@STATUS@@", &q(&status.display().to_string()))
        .replace("@@INSTALLER@@", &q(&installer.display().to_string()))
        .replace("@@EXE@@", &q(&exe.display().to_string()))
        .replace("@@PID@@", &pid.to_string())
        .replace("@@VERSION@@", &q(version))
        .replace("@@WAIT@@", &APP_EXIT_WAIT_SECS.to_string())
}

fn spawn_relaunch_watcher(script: &str) -> std::io::Result<()> {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = STANDARD.encode(utf16);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // NEVER add DETACHED_PROCESS here. powershell.exe dies on startup under
        // it, before executing a single statement — reproduced 100% on the real
        // machine (v0.5.4, 2026-08-13), even for a trivial one-line
        // -EncodedCommand, and CreateProcess documents that CREATE_NO_WINDOW is
        // IGNORED when combined with DETACHED_PROCESS, so the old
        // CREATE_NO_WINDOW | DETACHED_PROCESS combo always ran the deadly
        // variant: every in-app update ended at stage "started" with no watcher.
        // CREATE_NO_WINDOW alone gives the watcher a hidden console and works.
        //
        // CREATE_BREAKAWAY_FROM_JOB: if this process is inside a job object
        // with KILL_ON_JOB_CLOSE (e.g. Flightdeck launched from another
        // Flightdeck's pane), the watcher would die the moment we exit — the
        // exact window it exists to cover. Breakaway needs the job's
        // permission, so a refusal (ERROR_ACCESS_DENIED) falls back to a plain
        // spawn rather than failing the update.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let spawn = |flags: u32| {
            std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", &encoded])
                .creation_flags(flags)
                .spawn()
        };
        spawn(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| spawn(CREATE_NO_WINDOW))?;
    }
    #[cfg(not(windows))]
    {
        let _ = &encoded;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Status hand-back (what the watcher recorded, read on the next boot)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct StatusRecord {
    stage: String,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    message: Option<String>,
    version: String,
    #[serde(default)]
    installer: Option<String>,
    #[serde(default)]
    at: Option<String>,
}

/// What the frontend renders on the boot after an update attempt. `ok` is
/// deliberately NOT "the installer said 0" — it is "we are actually running
/// the version we tried to install", which is the only claim that can't lie.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub ok: bool,
    pub stage: String,
    pub attempted_version: String,
    pub current_version: String,
    pub exit_code: Option<i32>,
    pub message: String,
    pub detail: Option<String>,
    pub manual_path: Option<String>,
}

/// Pure so it can be tested without a filesystem or an AppHandle.
fn evaluate_status(rec: &StatusRecord, current_version: &str) -> UpdateOutcome {
    let installed = current_version == rec.version;
    let manual = rec.installer.clone();
    let manual_line = match rec.installer.as_deref() {
        Some(p) => format!(" {}", manual_hint(Path::new(p))),
        None => String::new(),
    };
    let v = &rec.version;

    // Running the attempted version IS the update having happened, no matter
    // what the watcher managed to record on the way. The record can be stale:
    // a watcher that died at stage "started" leaves that record behind, the
    // user runs the installer by hand, and the NEW version's first boot is
    // what reads it — reporting "0.5.4 never got started" from inside a
    // working 0.5.4 (the real v0.5.4 install, 2026-08-13). The version check
    // is the only claim that can't lie, in both directions.
    if installed {
        let message = match rec.stage.as_str() {
            "installed" => format!("Flightdeck updated to {v}."),
            "relaunch-failed" => format!("Flightdeck updated to {v}, but it had to be restarted by hand."),
            // Any failure stage while running the attempted version means the
            // user finished the job themselves (typically the manual installer
            // after the background updater died).
            _ => format!("Flightdeck updated to {v} (the background updater failed, but the update was completed by hand)."),
        };
        return UpdateOutcome {
            ok: true,
            stage: rec.stage.clone(),
            attempted_version: rec.version.clone(),
            current_version: current_version.to_string(),
            exit_code: rec.exit_code,
            message,
            detail: rec.message.clone().filter(|m| !m.trim().is_empty()),
            manual_path: None,
        };
    }

    let (ok, message) = match rec.stage.as_str() {

        // Past the early return, the running version is NOT the attempted one.
        // The loudest case there is: exit code 0, nothing actually changed.
        // A quarantine part-way through a silent install looks exactly like
        // this, which is why the version is checked and not the exit code.
        "installed" => (
            false,
            format!(
                "The Flightdeck {v} installer reported success, but this is still {current_version} — the update did not take effect. That usually means antivirus removed or blocked the installer while it ran.{manual_line}"
            ),
        ),

        "installer-failed" => (
            false,
            format!(
                "Flightdeck {v} did not install: the installer exited with code {}. Nothing was changed, you are still on {current_version}.{manual_line}",
                rec.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
            ),
        ),

        "launch-failed" => (
            false,
            format!(
                "Windows would not start the Flightdeck {v} installer, so nothing was installed. This is what antivirus or SmartScreen blocking an unsigned installer looks like.{manual_line}"
            ),
        ),

        "relaunch-failed" => (
            false,
            format!(
                "Flightdeck {v} failed to install and the app had to be restarted by hand.{manual_line}"
            ),
        ),

        "app-exit-timeout" => (
            false,
            format!(
                "Flightdeck {v} was not installed: the old copy was still running when the installer was due to start, and installing over a running copy would break it.{manual_line}"
            ),
        ),

        // Rust wrote "started" and the watcher never got far enough to
        // overwrite it: PowerShell blocked, killed, or crashed.
        "started" => (
            false,
            format!(
                "The Flightdeck {v} update never got started — the background updater stopped before it could run the installer (PowerShell blocked by policy or antivirus is the usual cause).{manual_line}"
            ),
        ),

        other => (
            false,
            format!("Flightdeck {v} update finished in an unexpected state ({other}); this is {current_version}.{manual_line}"),
        ),
    };

    UpdateOutcome {
        ok,
        stage: rec.stage.clone(),
        attempted_version: rec.version.clone(),
        current_version: current_version.to_string(),
        exit_code: rec.exit_code,
        message,
        detail: rec.message.clone().filter(|m| !m.trim().is_empty()),
        manual_path: if ok { None } else { manual },
    }
}

/// Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a UTF-8 BOM
/// (there is no utf8NoBOM before PowerShell 6), and serde_json refuses a
/// leading U+FEFF. Without this strip, take_update_status silently returned
/// None and the entire failure-reporting path did nothing at all — caught by
/// actually running the generated watcher, not by reading it.
fn parse_status(raw: &str) -> Result<StatusRecord, serde_json::Error> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}').trim())
}

fn status_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(UPDATE_STATUS_FILE))
}

/// Read-and-clear. Returns None when no update was attempted since the last
/// boot. Clearing on read is what keeps a one-off failure from nagging
/// forever; the frontend persists what it needs to show in Settings.
#[tauri::command]
pub fn take_update_status(app: AppHandle) -> Option<UpdateOutcome> {
    let path = status_path(&app).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let rec: StatusRecord = parse_status(&raw).ok()?;
    Some(evaluate_status(&rec, env!("CARGO_PKG_VERSION")))
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// Installs the update and exits Flightdeck so the silent installer can
/// overwrite the running exe. Every live pane is reaped first (same taskkill
/// path `RunEvent::ExitRequested` already uses) — an agent process holding
/// files open under the install dir would otherwise make the silent install
/// fail partway through.
///
/// Anything that fails BEFORE the exit is returned as a typed UpdateError and
/// the app stays up. Anything that fails after is recorded by the watcher and
/// surfaced by take_update_status on the next boot.
#[tauri::command]
pub fn install_update(
    app: AppHandle,
    reg: State<Registry>,
    installer_path: String,
    releases_dir: Option<String>,
) -> Result<(), UpdateError> {
    if is_canary(&app) {
        return Err(UpdateError::new(
            "canary-channel",
            "This is the Canary build — it never self-updates. When this version proves out, install the stable Flightdeck build of it; your stable install is untouched until then.",
        ));
    }
    let dir = releases_path(releases_dir.as_deref());
    let installer = ensure_under_releases_dir(&dir, Path::new(&installer_path)).map_err(|e| {
        UpdateError::new("installer-outside-releases", format!("Refusing to run this installer: {e}."))
            .with_detail(installer_path.clone())
    })?;

    // Re-run the same pre-flight the check did: the file could have been
    // quarantined, replaced or truncated in the seconds between "an update is
    // available" and the user clicking install.
    let expected = installer
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(version_from_installer_name)
        .map(str::to_string);
    preflight_installer(&installer, expected.as_deref())?;

    #[cfg(not(windows))]
    {
        let _ = (app, reg, expected);
        return Err(UpdateError::new(
            "unsupported-platform",
            "Installing an update from inside the app is only supported on Windows.",
        )
        .with_manual(&installer));
    }

    #[cfg(windows)]
    {
        let exe_path = std::env::current_exe().map_err(|e| {
            UpdateError::new("watcher-spawn-failed", "Couldn't work out where Flightdeck is installed, so the update was not started.")
                .with_detail(e.to_string())
                .with_manual(&installer)
        })?;
        let version = expected.unwrap_or_else(|| "the new version".to_string());

        // Write "started" BEFORE spawning anything: if the watcher never runs
        // at all, the next boot still knows an update was attempted and says
        // so, rather than the user staring at an unchanged version number.
        if let Ok(sp) = status_path(&app) {
            let rec = StatusRecord {
                stage: "started".into(),
                exit_code: None,
                message: None,
                version: version.clone(),
                installer: Some(installer.display().to_string()),
                at: None,
            };
            if let Ok(json) = serde_json::to_string(&rec) {
                let _ = std::fs::write(&sp, json);
            }
            let script = build_watcher_script(&sp, &installer, &exe_path, std::process::id(), &version);
            spawn_relaunch_watcher(&script).map_err(|e| {
                let _ = std::fs::remove_file(&sp);
                UpdateError::new(
                    "watcher-spawn-failed",
                    "Couldn't start the background updater, so nothing was installed and Flightdeck is still running.",
                )
                .with_detail(e.to_string())
                .with_manual(&installer)
            })?;
        } else {
            return Err(UpdateError::new(
                "watcher-spawn-failed",
                "Couldn't reach Flightdeck's data folder to track the update, so the update was not started.",
            )
            .with_manual(&installer));
        }

        for id in live_pane_ids(reg.inner()) {
            reap_pane(reg.inner(), id);
        }
        app.exit(0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(stage: &str, version: &str, exit_code: Option<i32>) -> StatusRecord {
        StatusRecord {
            stage: stage.into(),
            exit_code,
            message: None,
            version: version.into(),
            installer: Some(r"D:\releases\Flightdeck_9.9.9_x64-setup.exe".into()),
            at: None,
        }
    }

    #[test]
    fn version_gt_basic() {
        assert!(version_gt("0.3.0", "0.2.0"));
        assert!(!version_gt("0.2.0", "0.3.0"));
        assert!(!version_gt("0.2.0", "0.2.0"));
        assert!(version_gt("0.2.1", "0.2.0"));
        assert!(version_gt("1.0.0", "0.9.9"));
    }

    #[test]
    fn version_gt_ragged_lengths() {
        assert!(version_gt("0.3", "0.2.9"));
        assert!(!version_gt("0.2", "0.2.0"));
    }

    #[test]
    fn version_gt_unparsable_reads_as_zero() {
        assert!(!version_gt("not-a-version", "0.0.1"));
    }

    #[test]
    fn rollback_candidates_are_older_valid_stable_installers_newest_first() {
        let dir = std::env::temp_dir().join("flightdeck-rollback-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let real = |name: &str| {
            // Passes pre-flight: MZ header + past the 512KB floor.
            let mut bytes = vec![0x4D, 0x5A];
            bytes.resize(600 * 1024, 0);
            std::fs::write(dir.join(name), bytes).unwrap();
        };
        real("Flightdeck_0.1.0_x64-setup.exe");
        real("Flightdeck_0.4.0_x64-setup.exe");
        real("Flightdeck_9.9.9_x64-setup.exe"); // newer than running — excluded
        real("Flightdeck Canary_0.1.0_x64-setup.exe"); // canary name — excluded
        std::fs::write(dir.join("Flightdeck_0.2.0_x64-setup.exe"), b"not an exe").unwrap(); // fails pre-flight

        let got = list_rollback_candidates_inner(Some(dir.to_string_lossy().into_owned()));
        let versions: Vec<&str> = got.iter().map(|c| c.version.as_str()).collect();
        assert_eq!(versions, vec!["0.4.0", "0.1.0"]);
    }

    #[test]
    fn check_update_missing_manifest_errs_cleanly() {
        let res = check_update_inner(Some("D:\\this-dir-should-not-exist-flightdeck-test".to_string()));
        assert!(!res.available);
        assert!(res.error.is_some());
        assert_eq!(res.error_kind.as_deref(), Some("manifest-unreadable"));
    }

    #[test]
    fn ensure_under_releases_dir_rejects_outside_path() {
        let tmp = std::env::temp_dir();
        let outside = tmp.join("flightdeck-updates-test-outside.exe");
        std::fs::write(&outside, b"x").ok();
        let releases = tmp.join("flightdeck-updates-test-releases");
        std::fs::create_dir_all(&releases).ok();
        let result = ensure_under_releases_dir(&releases, &outside);
        assert!(result.is_err());
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&releases);
    }

    #[test]
    fn ensure_under_releases_dir_accepts_inside_path() {
        let tmp = std::env::temp_dir();
        let releases = tmp.join("flightdeck-updates-test-releases-ok");
        std::fs::create_dir_all(&releases).ok();
        let inside = releases.join("setup.exe");
        std::fs::write(&inside, b"x").ok();
        let result = ensure_under_releases_dir(&releases, &inside);
        assert!(result.is_ok());
        let _ = std::fs::remove_dir_all(&releases);
    }

    // --- pre-flight ---------------------------------------------------------

    fn tmp_installer(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join("flightdeck-preflight-tests");
        std::fs::create_dir_all(&dir).ok();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn fake_exe(len: usize) -> Vec<u8> {
        let mut v = vec![0u8; len];
        v[0] = b'M';
        v[1] = b'Z';
        v
    }

    #[test]
    fn preflight_rejects_missing_file() {
        let p = std::env::temp_dir().join("flightdeck-preflight-nope.exe");
        let _ = std::fs::remove_file(&p);
        let e = preflight_installer(&p, None).unwrap_err();
        assert_eq!(e.kind, "installer-missing");
    }

    #[test]
    fn preflight_rejects_empty_file() {
        let p = tmp_installer("Flightdeck_1.0.0_x64-setup.exe", b"");
        let e = preflight_installer(&p, None).unwrap_err();
        assert_eq!(e.kind, "installer-empty");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn preflight_rejects_half_copied_file() {
        let p = tmp_installer("Flightdeck_1.0.1_x64-setup.exe", &fake_exe(4096));
        let e = preflight_installer(&p, None).unwrap_err();
        assert_eq!(e.kind, "installer-truncated");
        assert!(e.message.contains("truncated"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn preflight_rejects_non_executable() {
        let mut junk = vec![b'x'; MIN_INSTALLER_BYTES as usize + 10];
        junk[0] = b'P';
        let p = tmp_installer("Flightdeck_1.0.2_x64-setup.exe", &junk);
        let e = preflight_installer(&p, None).unwrap_err();
        assert_eq!(e.kind, "installer-not-executable");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn preflight_rejects_version_mismatch() {
        let p = tmp_installer(
            "Flightdeck_0.3.0_x64-setup.exe",
            &fake_exe(MIN_INSTALLER_BYTES as usize + 10),
        );
        let e = preflight_installer(&p, Some("0.4.1")).unwrap_err();
        assert_eq!(e.kind, "installer-version-mismatch");
        assert!(e.message.contains("0.3.0") && e.message.contains("0.4.1"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn preflight_accepts_a_sane_installer() {
        let p = tmp_installer(
            "Flightdeck_0.4.1_x64-setup.exe",
            &fake_exe(MIN_INSTALLER_BYTES as usize + 10),
        );
        assert!(preflight_installer(&p, Some("0.4.1")).is_ok());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn preflight_skips_version_check_for_renamed_files() {
        let p = tmp_installer("my-copy.exe", &fake_exe(MIN_INSTALLER_BYTES as usize + 10));
        assert!(preflight_installer(&p, Some("0.4.1")).is_ok());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn version_from_installer_name_parses_and_rejects() {
        assert_eq!(version_from_installer_name("Flightdeck_0.4.1_x64-setup.exe"), Some("0.4.1"));
        assert_eq!(version_from_installer_name("something-else.exe"), None);
        assert_eq!(version_from_installer_name("Flightdeck_beta_x64-setup.exe"), None);
    }

    #[test]
    fn installer_name_must_be_bare() {
        assert!(safe_installer_name("Flightdeck_0.4.1_x64-setup.exe").is_ok());
        assert!(safe_installer_name("..\\..\\evil.exe").is_err());
        assert!(safe_installer_name("C:\\Windows\\System32\\calc.exe").is_err());
        assert!(safe_installer_name("sub/dir/setup.exe").is_err());
        assert!(safe_installer_name("  ").is_err());
    }

    // --- outcome evaluation -------------------------------------------------

    #[test]
    fn outcome_success_only_when_version_actually_changed() {
        let o = evaluate_status(&rec("installed", "9.9.9", Some(0)), "9.9.9");
        assert!(o.ok);
        assert!(o.message.contains("updated to 9.9.9"));
    }

    #[test]
    fn outcome_exit_zero_but_same_version_is_a_failure() {
        // The quiet killer: NSIS returns 0, Defender ate the payload, the app
        // comes back on the old version.
        let o = evaluate_status(&rec("installed", "9.9.9", Some(0)), "0.4.1");
        assert!(!o.ok);
        assert!(o.message.contains("did not take effect"));
        assert!(o.manual_path.is_some());
        assert!(o.message.contains("Flightdeck_9.9.9_x64-setup.exe"));
    }

    #[test]
    fn outcome_reports_the_installer_exit_code() {
        let o = evaluate_status(&rec("installer-failed", "9.9.9", Some(2)), "0.4.1");
        assert!(!o.ok);
        assert_eq!(o.exit_code, Some(2));
        assert!(o.message.contains("code 2"));
        assert!(o.message.contains("Flightdeck_9.9.9_x64-setup.exe"));
    }

    #[test]
    fn outcome_launch_failure_names_antivirus_and_the_manual_path() {
        let o = evaluate_status(&rec("launch-failed", "9.9.9", None), "0.4.1");
        assert!(!o.ok);
        assert!(o.message.contains("antivirus"));
        assert!(o.manual_path.as_deref() == Some(r"D:\releases\Flightdeck_9.9.9_x64-setup.exe"));
    }

    #[test]
    fn outcome_watcher_never_ran() {
        let o = evaluate_status(&rec("started", "9.9.9", None), "0.4.1");
        assert!(!o.ok);
        assert!(o.message.contains("never got started"));
    }

    #[test]
    fn outcome_app_exit_timeout_is_a_failure_with_a_reason() {
        let o = evaluate_status(&rec("app-exit-timeout", "9.9.9", None), "0.4.1");
        assert!(!o.ok);
        assert!(o.message.contains("still running"));
    }

    #[test]
    fn outcome_relaunch_failure_after_a_good_install_is_still_success() {
        let o = evaluate_status(&rec("relaunch-failed", "9.9.9", Some(0)), "9.9.9");
        assert!(o.ok);
    }

    // The real v0.5.4 install (2026-08-13): the watcher died at "started", the
    // user ran the installer by hand, and the NEW version's first boot read the
    // stale record — and told a working 0.5.4 that 0.5.4 never got started.
    // Running the attempted version is success no matter what stage the record
    // froze at.
    #[test]
    fn outcome_stale_failure_record_read_by_the_attempted_version_is_success() {
        for stage in ["started", "launch-failed", "installer-failed", "app-exit-timeout", "installed"] {
            let o = evaluate_status(&rec(stage, "9.9.9", None), "9.9.9");
            assert!(o.ok, "stage {stage} with matching version must be success");
            assert!(o.message.contains("updated to 9.9.9"), "stage {stage}: {}", o.message);
            assert!(o.manual_path.is_none(), "stage {stage} must not offer a manual path");
        }
    }

    #[test]
    fn outcome_carries_the_watcher_detail_when_there_is_one() {
        let mut r = rec("launch-failed", "9.9.9", None);
        r.message = Some("Operation did not complete successfully because the file contains a virus".into());
        let o = evaluate_status(&r, "0.4.1");
        assert!(o.detail.unwrap().contains("virus"));
    }

    #[test]
    fn status_written_by_powershell_51_parses_bom_and_all() {
        // Byte-for-byte what the real watcher wrote during an end-to-end run
        // (`Set-Content -Encoding UTF8` on Windows PowerShell 5.1 = BOM).
        let raw = "\u{feff}{\"stage\":\"installer-failed\",\"exitCode\":2,\"message\":\"The installer exited with code 2.\",\"version\":\"9.9.9\",\"installer\":\"C:\\\\Windows\\\\System32\\\\where.exe\",\"at\":\"2026-08-01T07:35:23.9070329Z\"}\r\n";
        let rec = parse_status(raw).expect("BOM-prefixed status must still parse");
        assert_eq!(rec.stage, "installer-failed");
        assert_eq!(rec.exit_code, Some(2));
        let out = evaluate_status(&rec, "0.4.1");
        assert!(!out.ok);
        assert!(out.message.contains("code 2"));
    }

    // --- watcher script -----------------------------------------------------

    #[test]
    fn watcher_script_substitutes_every_placeholder() {
        let s = build_watcher_script(
            Path::new(r"C:\data\update-status.json"),
            Path::new(r"D:\rel\Flightdeck_1.2.3_x64-setup.exe"),
            Path::new(r"C:\Program Files\Flightdeck\Flightdeck.exe"),
            4321,
            "1.2.3",
        );
        assert!(!s.contains("@@"), "unsubstituted placeholder left in the script");
        assert!(s.contains("4321"));
        assert!(s.contains(r"D:\rel\Flightdeck_1.2.3_x64-setup.exe"));
        assert!(s.contains(r"C:\Program Files\Flightdeck\Flightdeck.exe"));
    }

    #[test]
    fn watcher_script_escapes_quotes_in_paths() {
        let s = build_watcher_script(
            Path::new(r"C:\it's here\update-status.json"),
            Path::new(r"D:\rel\setup.exe"),
            Path::new(r"C:\app\Flightdeck.exe"),
            1,
            "1.0.0",
        );
        assert!(s.contains("C:\\it''s here\\update-status.json"));
    }

    // The gate for the v0.5.4 failure: the watcher powershell must ACTUALLY
    // RUN when spawned through the real spawn_relaunch_watcher (same binary,
    // same flags, same -EncodedCommand hand-off), not just be spawnable. Under
    // the old CREATE_NO_WINDOW | DETACHED_PROCESS flags, powershell.exe
    // spawned fine and then died before executing a single statement — every
    // release with that combo had a background updater that could never work,
    // and nothing short of running the real thing catches it. The script here
    // is the REAL WATCHER_SCRIPT (parse errors included in the coverage), with
    // where.exe standing in for the installer (exits fast and nonzero, so the
    // recorded stage is "installer-failed") and for the relaunch target (so
    // Show-Box never fires — a MessageBox would hang the test).
    #[cfg(windows)]
    #[test]
    fn watcher_script_really_runs_end_to_end() {
        let dir = std::env::temp_dir().join("flightdeck-watcher-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        let status = dir.join("status.json");
        let _ = std::fs::remove_file(&status);

        // A pid that is already gone, so the wait loop falls through at once.
        let dead = std::process::Command::new("cmd")
            .args(["/C", "exit"])
            .spawn()
            .and_then(|mut c| {
                let pid = c.id();
                c.wait().map(|_| pid)
            })
            .expect("spawning cmd /C exit");

        let where_exe = r"C:\Windows\System32\where.exe";
        let script = build_watcher_script(&status, Path::new(where_exe), Path::new(where_exe), dead, "9.9.9");
        spawn_relaunch_watcher(&script).expect("watcher spawn");

        // Cold-starting Windows PowerShell takes seconds; give it a generous
        // window and fail with the diagnosis this test exists to give.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let raw = loop {
            if let Ok(raw) = std::fs::read_to_string(&status) {
                if !raw.trim().is_empty() {
                    break raw;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "watcher never wrote a status record — powershell died before executing the script \
                 (this is what DETACHED_PROCESS in the spawn flags looks like)"
            );
            std::thread::sleep(std::time::Duration::from_millis(250));
        };
        let rec = parse_status(&raw).expect("status record parses");
        assert_eq!(rec.stage, "installer-failed", "where.exe /S exits nonzero");
        assert_eq!(rec.version, "9.9.9");
        let _ = std::fs::remove_file(&status);
    }

    #[test]
    fn watcher_script_waits_relaunches_and_records() {
        let s = build_watcher_script(
            Path::new("s.json"),
            Path::new("i.exe"),
            Path::new("a.exe"),
            7,
            "1.0.0",
        );
        // The three properties that stop a silent failure.
        assert!(s.contains("Get-Process -Id $appPid"), "must wait for the app to exit");
        assert!(s.contains("app-exit-timeout"));
        assert!(s.contains("$proc.ExitCode"), "must capture the installer exit code");
        assert!(s.contains("MessageBoxW"), "must have a channel when the app can't come back");
        // definition + the timeout, install-outcome and relaunch-failed calls
        assert!(s.matches("Save-Status").count() >= 4);
    }
}
