//! Read scope for file CONTENT reads (fs_read_text_file, fs_read_file_base64).
//! A path must canonicalise to somewhere under a workspace root pushed by the
//! frontend, the vault, `%USERPROFILE%\.claude`, or the app data dir. The check
//! runs on the canonical path so `..` and junctions cannot escape.
//! Directory listing (fs_list_dir) is deliberately NOT scoped.

use crate::pathguard;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{OnceLock, RwLock};

pub const OUTSIDE_SCOPE_ERR: &str = "outside-read-scope";

/// Always-allowed vault. TODO: make this a setting.
const VAULT_ROOT: &str = r"D:\Dev\ai";

/// Per-window roots (window label -> roots). Reads are authorised against the
/// UNION of every label, so one window pushing never narrows another's scope.
static WORKSPACE_ROOTS: RwLock<Option<HashMap<String, Vec<PathBuf>>>> = RwLock::new(None);

fn union_roots(m: &Option<HashMap<String, Vec<PathBuf>>>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for r in m.iter().flat_map(|m| m.values()).flatten() {
        if !out.contains(r) {
            out.push(r.clone());
        }
    }
    out
}

fn set_label_roots(label: &str, roots: Vec<PathBuf>) -> Result<(), String> {
    WORKSPACE_ROOTS
        .write()
        .map_err(|e| e.to_string())?
        .get_or_insert_with(HashMap::new)
        .insert(label.to_string(), roots);
    Ok(())
}

/// Drops a destroyed window's roots; the other labels keep theirs.
pub fn drop_label(label: &str) {
    if let Ok(mut g) = WORKSPACE_ROOTS.write() {
        if let Some(m) = g.as_mut() {
            m.remove(label);
        }
    }
}
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called once from setup with `app_data_dir()`.
pub fn set_data_dir(p: PathBuf) {
    let _ = DATA_DIR.set(p);
}

/// Canonicalise and drop the `\\?\` verbatim prefix (comparison only).
fn canon(p: &Path) -> Option<PathBuf> {
    let c = std::fs::canonicalize(p).ok()?;
    let s = c.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if rest.starts_with("UNC\\") {
            return None;
        }
        return Some(PathBuf::from(rest));
    }
    Some(c)
}

fn norm_components(p: &Path) -> Vec<String> {
    p.components()
        .filter_map(|c| match c {
            Component::Prefix(x) => Some(x.as_os_str().to_string_lossy().into_owned()),
            Component::Normal(x) => Some(x.to_string_lossy().into_owned()),
            _ => None,
        })
        .map(|s| if cfg!(windows) { s.to_lowercase() } else { s })
        .collect()
}

/// Component-wise containment: equal to or under `root`.
fn is_under(path: &Path, root: &Path) -> bool {
    let (p, r) = (norm_components(path), norm_components(root));
    !r.is_empty() && p.len() >= r.len() && p[..r.len()] == r[..]
}

static FIXED_ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Canonicalised once (it hits the filesystem). Not cached until the data dir
/// is known, so an early call can't freeze a list missing it.
fn fixed_roots() -> Vec<PathBuf> {
    if DATA_DIR.get().is_none() {
        return compute_fixed_roots();
    }
    FIXED_ROOTS.get_or_init(compute_fixed_roots).clone()
}

fn compute_fixed_roots() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(c) = canon(Path::new(VAULT_ROOT)) {
        v.push(c);
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        if let Some(c) = canon(&Path::new(&home).join(".claude")) {
            v.push(c);
        }
    }
    if let Some(c) = DATA_DIR.get().and_then(|d| canon(d)) {
        v.push(c);
    }
    v
}

fn check_against(path: &Path, workspace: &[PathBuf], fixed: &[PathBuf]) -> Result<PathBuf, String> {
    pathguard::check(&path.to_string_lossy())?;
    let c = canon(path).ok_or_else(|| OUTSIDE_SCOPE_ERR.to_string())?;
    if workspace.iter().chain(fixed.iter()).any(|r| is_under(&c, r)) {
        Ok(c)
    } else {
        Err(OUTSIDE_SCOPE_ERR.to_string())
    }
}

/// Err(`outside-read-scope`) unless `path` canonicalises inside the allowed set.
/// A path that does not exist cannot be canonicalised and is reported as outside.
pub fn check_read(path: &Path) -> Result<PathBuf, String> {
    let ws = union_roots(&*WORKSPACE_ROOTS.read().map_err(|e| e.to_string())?);
    check_against(path, &ws, &fixed_roots())
}

fn sanitize_roots(roots: Vec<String>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for r in roots {
        if pathguard::check(&r).is_err() {
            continue;
        }
        if let Some(c) = canon(Path::new(&r)) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

/// Roots in `next` that are not already in `granted` (pure; unit-tested).
fn newly_granted(granted: &[PathBuf], next: &[PathBuf]) -> Vec<PathBuf> {
    next.iter().filter(|r| !granted.contains(r)).cloned().collect()
}

/// Everything ever granted to the asset protocol this run. Tauri's FsScope has
/// no revoke: `forbid_*` is permanent and beats allow, so a removed-then-re-added
/// root would stay blocked. We are therefore allow-only: a root dropped from
/// the workspace keeps its asset grant until restart (it was a root the user
/// opened this session). Reads via `check_read` DO revoke immediately.
static ASSET_GRANTED: RwLock<Vec<PathBuf>> = RwLock::new(Vec::new());

/// Grants the asset protocol the given (already canonical, non-UNC) roots.
/// Only local directories are ever pushed, so a `\\server\..` path can never
/// match an allowed pattern, and the handler canonicalises before matching.
pub fn grant_asset_roots<R: tauri::Runtime>(app: &tauri::AppHandle<R>, roots: &[PathBuf]) {
    use tauri::Manager;
    let Ok(mut granted) = ASSET_GRANTED.write() else { return };
    let scope = app.asset_protocol_scope();
    for r in newly_granted(&granted, roots) {
        if scope.allow_directory(&r, true).is_ok() {
            granted.push(r);
        }
    }
}

/// Grants the always-allowed roots (vault, ~/.claude, app data). Call from setup.
pub fn grant_fixed_asset_roots<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    grant_asset_roots(app, &fixed_roots());
}

/// Replaces the CALLING window's roots (the label comes from the IPC caller,
/// never from JS). Unsafe or non-existent entries are dropped.
#[tauri::command(async)]
pub fn set_read_roots(app: tauri::AppHandle, window: tauri::Window, roots: Vec<String>) -> Result<(), String> {
    let clean = sanitize_roots(roots);
    grant_asset_roots(&app, &clean);
    set_label_roots(window.label(), clean)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fd-readscope-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn roots(p: &Path) -> Vec<PathBuf> {
        vec![canon(p).unwrap()]
    }

    #[test]
    fn inside_root_ok_and_unset_roots_deny() {
        let d = tmp("inside");
        let f = d.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(check_against(&f, &roots(&d), &[]).is_ok());
        assert!(check_against(&d, &roots(&d), &[]).is_ok(), "root itself");
        assert_eq!(check_against(&f, &[], &[]).unwrap_err(), OUTSIDE_SCOPE_ERR);
    }

    #[test]
    fn sibling_prefix_trick_denied() {
        let base = tmp("prefix");
        let a = base.join("ai");
        let a2 = base.join("ai2");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&a2).unwrap();
        let f = a2.join("s.txt");
        std::fs::write(&f, "x").unwrap();
        assert_eq!(check_against(&f, &roots(&a), &[]).unwrap_err(), OUTSIDE_SCOPE_ERR);
    }

    #[test]
    fn dotdot_escape_denied() {
        let base = tmp("dotdot");
        let root = base.join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(base.join("secret.txt"), "x").unwrap();
        let sneaky = root.join("..").join("secret.txt");
        assert_eq!(check_against(&sneaky, &roots(&root), &[]).unwrap_err(), OUTSIDE_SCOPE_ERR);
    }

    #[cfg(windows)]
    #[test]
    fn case_insensitive_on_windows() {
        let d = tmp("Case");
        let f = d.join("A.txt");
        std::fs::write(&f, "x").unwrap();
        let upper = PathBuf::from(f.to_string_lossy().to_uppercase());
        assert!(check_against(&upper, &roots(&d), &[]).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn junction_escape_denied() {
        let base = tmp("junction");
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("s.txt"), "x").unwrap();
        let link = root.join("link");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "mklink /J failed");
        let f = link.join("s.txt");
        assert_eq!(check_against(&f, &roots(&root), &[]).unwrap_err(), OUTSIDE_SCOPE_ERR);
    }

    #[test]
    fn verbatim_prefix_is_stripped_for_comparison() {
        let d = tmp("verbatim");
        let f = d.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let c = canon(&f).unwrap();
        assert!(!c.to_string_lossy().starts_with(r"\\?\"));
        assert!(is_under(&c, &canon(&d).unwrap()));
    }

    #[test]
    fn unc_and_device_paths_rejected_by_guard() {
        let d = tmp("unc");
        for p in [r"\\server\share\x", r"\\?\C:\Windows\win.ini", r"\\.\pipe\x", r"/\server\x"] {
            assert_eq!(
                check_against(Path::new(p), &roots(&d), &[]).unwrap_err(),
                pathguard::NETWORK_PATH_ERR,
                "{p}"
            );
        }
    }

    #[test]
    fn sanitize_drops_nonexistent_unc_and_dupes() {
        let d = tmp("sanitize");
        let out = sanitize_roots(vec![
            d.to_string_lossy().into_owned(),
            d.to_string_lossy().into_owned(),
            r"\\server\share".into(),
            d.join("missing").to_string_lossy().into_owned(),
        ]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn newly_granted_adds_only_unseen_roots() {
        let (a, b, c) = (PathBuf::from(r"C:\a"), PathBuf::from(r"C:\b"), PathBuf::from(r"C:\c"));
        assert_eq!(newly_granted(&[], &[a.clone(), b.clone()]), vec![a.clone(), b.clone()]);
        assert_eq!(newly_granted(&[a.clone(), b.clone()], &[b.clone(), c.clone()]), vec![c]);
        // removed root: nothing new, nothing revoked (allow-only)
        assert!(newly_granted(&[a.clone(), b], &[a]).is_empty());
    }

    #[test]
    fn unc_roots_never_reach_the_grant_list() {
        let d = tmp("uncgrant");
        let out = sanitize_roots(vec![
            r"\\server\share".into(),
            "//server/share".into(),
            d.to_string_lossy().into_owned(),
        ]);
        assert_eq!(out, vec![canon(&d).unwrap()]);
    }

    #[test]
    fn union_across_labels_and_drop_restores_only_the_other() {
        let (a, b, outside) = (tmp("union-a"), tmp("union-b"), tmp("union-out"));
        let (fa, fb, fo) = (a.join("x.txt"), b.join("x.txt"), outside.join("x.txt"));
        for f in [&fa, &fb, &fo] {
            std::fs::write(f, "x").unwrap();
        }
        // local map so parallel tests never touch the global
        let mut m: Option<HashMap<String, Vec<PathBuf>>> = Some(HashMap::new());
        m.as_mut().unwrap().insert("main".into(), roots(&a));
        m.as_mut().unwrap().insert("fw-1".into(), roots(&b));
        let u = union_roots(&m);
        assert!(check_against(&fa, &u, &[]).is_ok());
        assert!(check_against(&fb, &u, &[]).is_ok());
        assert_eq!(check_against(&fo, &u, &[]).unwrap_err(), OUTSIDE_SCOPE_ERR);
        // re-pushing one label replaces only that label
        m.as_mut().unwrap().insert("fw-1".into(), vec![]);
        let u = union_roots(&m);
        assert!(check_against(&fa, &u, &[]).is_ok());
        assert_eq!(check_against(&fb, &u, &[]).unwrap_err(), OUTSIDE_SCOPE_ERR);
        // removing main leaves nothing
        m.as_mut().unwrap().remove("main");
        assert_eq!(check_against(&fa, &union_roots(&m), &[]).unwrap_err(), OUTSIDE_SCOPE_ERR);
    }

    #[test]
    fn global_map_set_and_drop_label() {
        let (a, b) = (tmp("glob-a"), tmp("glob-b"));
        let (fa, fb) = (a.join("x.txt"), b.join("x.txt"));
        std::fs::write(&fa, "x").unwrap();
        std::fs::write(&fb, "x").unwrap();
        set_label_roots("t-main", roots(&a)).unwrap();
        set_label_roots("t-fw-9", roots(&b)).unwrap();
        assert!(check_read(&fa).is_ok() && check_read(&fb).is_ok());
        drop_label("t-fw-9");
        assert!(check_read(&fa).is_ok());
        assert_eq!(check_read(&fb).unwrap_err(), OUTSIDE_SCOPE_ERR);
        drop_label("t-main");
        assert_eq!(check_read(&fa).unwrap_err(), OUTSIDE_SCOPE_ERR);
    }

    #[test]
    fn nonexistent_file_is_outside() {
        let d = tmp("missing");
        assert_eq!(
            check_against(&d.join("nope.txt"), &roots(&d), &[]).unwrap_err(),
            OUTSIDE_SCOPE_ERR
        );
    }
}
