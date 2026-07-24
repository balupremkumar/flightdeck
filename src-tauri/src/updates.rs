// updates.rs — in-app self-update, local-file only. The installed app and the
// release output (built by tools/release.ps1) live on the same machine, so
// "checking for updates" means reading releases\latest.json next to the
// installer rather than hitting a server. No network, no signing/updater
// plugin.
//
// check_update: reads latest.json, validates the installer it names actually
// exists, compares its version against this build's CARGO_PKG_VERSION.
// install_update: validates the installer path is INSIDE the configured
// releases dir (never launch an arbitrary exe on the webview's say-so — same
// D11 discipline as worktree.rs's ensure_under), reaps every live pane the
// same way ExitRequested does, spawns a detached watcher that silently
// installs and relaunches, then exits.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{live_pane_ids, reap_pane, Registry};

/// Balu's single-machine setup: build output and the running install share
/// this box, so there's one sane default. Overridable from Settings for the
/// rare case it moves (persisted on the frontend, passed in on every call).
const DEFAULT_RELEASES_DIR: &str = r"D:\Dev\ai\projects\active\flightdeck\releases";

#[derive(Deserialize)]
struct LatestManifest {
    version: String,
    notes: String,
    #[serde(default)]
    #[allow(dead_code)] // round-tripped for humans reading latest.json, not used here
    pub_date: String,
    installer: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub installer_path: Option<String>,
    pub error: Option<String>,
}

impl UpdateCheckResult {
    fn none() -> Self {
        Self { available: false, version: None, notes: None, installer_path: None, error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { available: false, version: None, notes: None, installer_path: None, error: Some(msg.into()) }
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

#[tauri::command]
pub fn check_update(releases_dir: Option<String>) -> UpdateCheckResult {
    let dir = releases_path(releases_dir.as_deref());
    let manifest_path = dir.join("latest.json");
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => return UpdateCheckResult::err(format!("Couldn't read {}: {e}", manifest_path.display())),
    };
    let manifest: LatestManifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => return UpdateCheckResult::err(format!("{} is malformed: {e}", manifest_path.display())),
    };
    let installer_path = dir.join(&manifest.installer);
    if !installer_path.exists() {
        return UpdateCheckResult::err(format!(
            "latest.json points at a missing installer: {}",
            installer_path.display()
        ));
    }
    let current = env!("CARGO_PKG_VERSION");
    if !version_gt(&manifest.version, current) {
        return UpdateCheckResult::none();
    }
    UpdateCheckResult {
        available: true,
        version: Some(manifest.version),
        notes: Some(manifest.notes),
        installer_path: Some(installer_path.to_string_lossy().into_owned()),
        error: None,
    }
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

/// Spawns one detached watcher process that: waits for the silent NSIS
/// install to finish, then relaunches the app from the path it's already
/// running from. Tauri's NSIS bundle doesn't auto-relaunch after a silent
/// (/S) install, so this is what brings Flightdeck back up after the upgrade.
///
/// Built as a single -EncodedCommand PowerShell invocation (UTF-16LE, then
/// base64) rather than a `cmd /C "a" && "b"` string — cmd's re-parsing of a
/// quoted /C argument is a well-known footgun with paths that contain spaces,
/// and both the installer and install-dir paths here can.
fn spawn_relaunch_watcher(installer: &Path, exe_path: &Path) -> std::io::Result<()> {
    let script = format!(
        "Start-Process -FilePath '{}' -ArgumentList '/S' -Wait; Start-Sleep -Milliseconds 500; Start-Process -FilePath '{}'",
        installer.display().to_string().replace('\'', "''"),
        exe_path.display().to_string().replace('\'', "''"),
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = STANDARD.encode(utf16);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", &encoded])
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()?;
    }
    #[cfg(not(windows))]
    {
        let _ = &encoded;
    }
    Ok(())
}

/// Installs the update and exits Flightdeck so the silent installer can
/// overwrite the running exe. Every live pane is reaped first (same taskkill
/// path `RunEvent::ExitRequested` already uses) — an agent process holding
/// files open under the install dir would otherwise make the silent install
/// fail partway through.
#[tauri::command]
pub fn install_update(app: AppHandle, reg: State<Registry>, installer_path: String, releases_dir: Option<String>) -> Result<(), String> {
    let dir = releases_path(releases_dir.as_deref());
    let installer = ensure_under_releases_dir(&dir, Path::new(&installer_path))?;

    #[cfg(not(windows))]
    {
        let _ = installer;
        return Err("install_update is only supported on Windows".to_string());
    }

    #[cfg(windows)]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        spawn_relaunch_watcher(&installer, &exe_path).map_err(|e| e.to_string())?;

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
    fn check_update_missing_manifest_errs_cleanly() {
        let res = check_update(Some("D:\\this-dir-should-not-exist-flightdeck-test".to_string()));
        assert!(!res.available);
        assert!(res.error.is_some());
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
}
