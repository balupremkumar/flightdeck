// canary.rs — the parallel-install channel (deployment rework, phase 2).
//
// A release is now cut twice: the stable "Flightdeck" (identifier
// ai.flightdeck.app) and "Flightdeck Canary" (ai.flightdeck.canary, see
// tauri.canary.conf.json). Different identifier + productName means NSIS
// installs them side by side with separate app data and separate WebView2
// profiles — trialling a new version can no longer overwrite the working
// install (the v0.5.3 install/revert/reinstall loop this replaces).
//
// On its FIRST boot, canary clones a copy of stable's state so it exercises
// the real upgrade path — real session doc, real localStorage — against real
// data that it cannot corrupt, because it is a copy. One clone ever, marked by
// a sentinel; after that canary's state is its own.
//
// THE ONE DANGEROUS FIELD: a cloned session doc lists panes whose
// worktreePath points into STABLE's app data. If canary restored those, its
// pane-close/GC paths would delete stable's live worktrees. So the clone
// rewrites the doc: every isolated pane is remapped to its repo root (from the
// worktree's sidecar meta) and the worktree fields are dropped — the pane
// comes back as a plain, non-isolated pane, which no canary code path will
// ever remove. Canary work started fresh gets worktrees under canary's OWN
// app data, which never collide with stable's.
//
// The clone runs BEFORE tauri::Builder::build() because that is what creates
// the webview and locks the EBWebView profile dir. No path resolver exists
// yet at that point, so directories are derived from %APPDATA%/%LOCALAPPDATA%
// — the same folders Tauri resolves on Windows. The webview-profile copy is
// all-or-nothing: if any file fails (stable running holds LevelDB locks), the
// partial copy is deleted and canary starts with default UI prefs, stated in
// the returned summary rather than silently.

use std::fs;
use std::path::{Path, PathBuf};

const SENTINEL: &str = ".cloned-from-stable.json";
const STABLE_IDENTIFIER: &str = "ai.flightdeck.app";
/// Roaming app-data entries worth cloning. Whitelist, not "everything":
/// logs/ stays per-flavour, update-status.json is one-shot updater state, and
/// worktrees/ is git-linked to stable's absolute paths (see module comment).
const CLONE_DIRS: &[&str] = &["snapshots", "vendors", "shell", "hooks"];
const CLONE_FILES: &[&str] = &[".window-state.json"];

pub fn is_canary_identifier(identifier: &str) -> bool {
    identifier.ends_with(".canary")
}

/// First-boot state clone. Returns a human-readable summary to put in the
/// flight recorder once applog is up (this runs before it), or None when
/// there was nothing to do (stable flavour, or already cloned).
pub fn prepare(identifier: &str) -> Option<String> {
    if !is_canary_identifier(identifier) {
        return None;
    }
    let roaming = PathBuf::from(std::env::var_os("APPDATA")?);
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    clone_stable_state(
        &roaming.join(STABLE_IDENTIFIER),
        &roaming.join(identifier),
        &local.join(STABLE_IDENTIFIER),
        &local.join(identifier),
    )
}

/// Path-parameterised core, one clone ever (sentinel-guarded), testable
/// against temp dirs.
pub fn clone_stable_state(
    stable_roaming: &Path,
    canary_roaming: &Path,
    stable_local: &Path,
    canary_local: &Path,
) -> Option<String> {
    if canary_roaming.join(SENTINEL).exists() {
        return None;
    }
    if fs::create_dir_all(canary_roaming).is_err() {
        return Some("canary: couldn't create app data dir; no state cloned".into());
    }

    let mut notes: Vec<String> = Vec::new();

    if !stable_roaming.exists() {
        notes.push("no stable install found; starting fresh".into());
        write_sentinel(canary_roaming, &notes, 0, false);
        return Some(format!("canary first boot: {}", notes.join("; ")));
    }

    // Session doc, with the worktree remap. A doc that doesn't parse is copied
    // verbatim — reproducing stable's exact on-disk state is the whole point.
    let mut remapped = 0usize;
    let session_src = stable_roaming.join("session.json");
    if session_src.exists() {
        match fs::read_to_string(&session_src) {
            Ok(raw) => match rewrite_session_doc(&raw) {
                Some((rewritten, n)) => {
                    remapped = n;
                    if fs::write(canary_roaming.join("session.json"), rewritten).is_ok() {
                        notes.push(format!("session cloned ({n} isolated pane(s) remapped to repo root)"));
                    } else {
                        notes.push("session clone FAILED to write".into());
                    }
                }
                None => {
                    let _ = fs::copy(&session_src, canary_roaming.join("session.json"));
                    notes.push("session.json didn't parse; copied verbatim".into());
                }
            },
            Err(e) => notes.push(format!("session.json unreadable: {e}")),
        }
    } else {
        notes.push("stable has no session.json".into());
    }

    for name in CLONE_DIRS {
        let src = stable_roaming.join(name);
        if src.is_dir() {
            if let Err(e) = copy_dir_all(&src, &canary_roaming.join(name)) {
                notes.push(format!("{name}/ copy incomplete: {e}"));
            }
        }
    }
    for name in CLONE_FILES {
        let src = stable_roaming.join(name);
        if src.is_file() {
            let _ = fs::copy(&src, canary_roaming.join(name));
        }
    }

    // WebView2 profile (localStorage lives here). All-or-nothing.
    let mut webview_cloned = false;
    let wv_src = stable_local.join("EBWebView");
    if wv_src.is_dir() {
        let wv_dst = canary_local.join("EBWebView");
        match copy_dir_all(&wv_src, &wv_dst) {
            Ok(()) => {
                webview_cloned = true;
                notes.push("webview profile (localStorage) cloned".into());
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&wv_dst);
                notes.push(format!(
                    "webview profile locked or unreadable ({e}) — is stable Flightdeck running? Canary starts with default UI prefs"
                ));
            }
        }
    }

    write_sentinel(canary_roaming, &notes, remapped, webview_cloned);
    Some(format!("canary first boot: {}", notes.join("; ")))
}

fn write_sentinel(canary_roaming: &Path, notes: &[String], remapped: usize, webview_cloned: bool) {
    let doc = serde_json::json!({
        "clonedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        "from": STABLE_IDENTIFIER,
        "panesRemapped": remapped,
        "webviewCloned": webview_cloned,
        "notes": notes,
    });
    let _ = fs::write(
        canary_roaming.join(SENTINEL),
        serde_json::to_string_pretty(&doc).unwrap_or_default(),
    );
}

/// Strip worktree identity from every pane, remapping cwd to the pane's repo
/// root when the worktree's sidecar meta (\<dir\>.meta.json, WorktreeMeta) can
/// still name it. Returns None when the doc isn't the JSON shape we know —
/// caller copies verbatim in that case.
fn rewrite_session_doc(raw: &str) -> Option<(String, usize)> {
    let mut doc: serde_json::Value = serde_json::from_str(raw).ok()?;
    let mut remapped = 0usize;
    if let Some(workspaces) = doc.get_mut("workspaces").and_then(|w| w.as_array_mut()) {
        for ws in workspaces {
            let Some(panes) = ws.get_mut("panes").and_then(|p| p.as_array_mut()) else { continue };
            for pane in panes {
                let Some(obj) = pane.as_object_mut() else { continue };
                let wt = obj.get("worktreePath").and_then(|v| v.as_str()).map(str::to_string);
                let Some(wt) = wt else { continue };
                if let Some(repo) = repo_from_meta(Path::new(&wt)) {
                    obj.insert("cwd".into(), serde_json::Value::String(repo));
                }
                // Fields gone = plain pane. No canary code path can now touch
                // stable's worktree dir through this pane.
                obj.remove("worktreePath");
                obj.remove("branch");
                obj.remove("baseBranch");
                remapped += 1;
            }
        }
    }
    Some((doc.to_string(), remapped))
}

/// The `repo` field of the worktree's sidecar (worktree.rs writes
/// "\<dir\>.meta.json" beside every worktree it creates), but only when that
/// repo path still exists — a vanished repo keeps the pane's old cwd, and the
/// restore path's usual missing-dir fallback handles it.
fn repo_from_meta(worktree_dir: &Path) -> Option<String> {
    let mut os = worktree_dir.as_os_str().to_owned();
    os.push(".meta.json");
    let raw = fs::read_to_string(PathBuf::from(os)).ok()?;
    let meta: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let repo = meta.get("repo")?.as_str()?.to_string();
    if repo.is_empty() || !Path::new(&repo).exists() {
        return None;
    }
    Some(repo)
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("flightdeck-canary-tests").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn session_with_worktree(wt: &str) -> String {
        serde_json::json!({
            "version": 1,
            "workspaces": [{
                "id": 1, "name": "ws", "root": "D:/repo",
                "panes": [
                    { "id": 1, "vendor": "claude", "cwd": wt,
                      "worktreePath": wt, "branch": "flightdeck/p1", "baseBranch": "main" },
                    { "id": 2, "vendor": "pwsh", "cwd": "D:/repo" }
                ]
            }]
        })
        .to_string()
    }

    #[test]
    fn identifier_detection() {
        assert!(is_canary_identifier("ai.flightdeck.canary"));
        assert!(!is_canary_identifier("ai.flightdeck.app"));
    }

    #[test]
    fn rewrite_strips_worktree_fields_and_remaps_cwd_via_meta() {
        let root = fresh("rewrite");
        let wt = root.join("wt-1");
        fs::create_dir_all(&wt).unwrap();
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let mut meta_os = wt.as_os_str().to_owned();
        meta_os.push(".meta.json");
        fs::write(
            PathBuf::from(meta_os),
            serde_json::json!({ "repo": repo.to_string_lossy(), "branch": "flightdeck/p1", "baseBranch": "main" }).to_string(),
        )
        .unwrap();

        let (out, n) = rewrite_session_doc(&session_with_worktree(&wt.to_string_lossy())).unwrap();
        assert_eq!(n, 1);
        let doc: serde_json::Value = serde_json::from_str(&out).unwrap();
        let pane = &doc["workspaces"][0]["panes"][0];
        assert!(pane.get("worktreePath").is_none());
        assert!(pane.get("branch").is_none());
        assert!(pane.get("baseBranch").is_none());
        assert_eq!(pane["cwd"], repo.to_string_lossy().as_ref());
        // Non-isolated pane untouched.
        assert_eq!(doc["workspaces"][0]["panes"][1]["cwd"], "D:/repo");
    }

    #[test]
    fn rewrite_without_meta_still_strips_fields_and_keeps_cwd() {
        let (out, n) = rewrite_session_doc(&session_with_worktree("Z:/gone/wt")).unwrap();
        assert_eq!(n, 1);
        let doc: serde_json::Value = serde_json::from_str(&out).unwrap();
        let pane = &doc["workspaces"][0]["panes"][0];
        assert!(pane.get("worktreePath").is_none());
        assert_eq!(pane["cwd"], "Z:/gone/wt");
    }

    #[test]
    fn malformed_session_doc_is_reported_not_rewritten() {
        assert!(rewrite_session_doc("not json {").is_none());
    }

    #[test]
    fn clone_is_one_shot_and_writes_sentinel() {
        let root = fresh("clone");
        let (sr, cr) = (root.join("stable-roaming"), root.join("canary-roaming"));
        let (sl, cl) = (root.join("stable-local"), root.join("canary-local"));
        fs::create_dir_all(&sr).unwrap();
        fs::write(sr.join("session.json"), session_with_worktree("Z:/gone/wt")).unwrap();
        fs::create_dir_all(sr.join("vendors")).unwrap();
        fs::write(sr.join("vendors").join("x.json"), "{}").unwrap();
        fs::create_dir_all(sl.join("EBWebView").join("Default")).unwrap();
        fs::write(sl.join("EBWebView").join("Default").join("Prefs"), "p").unwrap();

        let summary = clone_stable_state(&sr, &cr, &sl, &cl).expect("first clone runs");
        assert!(summary.contains("session cloned"));
        assert!(cr.join(SENTINEL).exists());
        assert!(cr.join("vendors").join("x.json").exists());
        assert!(cl.join("EBWebView").join("Default").join("Prefs").exists());
        let cloned: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(cr.join("session.json")).unwrap()).unwrap();
        assert!(cloned["workspaces"][0]["panes"][0].get("worktreePath").is_none());

        // Second boot: sentinel wins, nothing re-cloned.
        assert!(clone_stable_state(&sr, &cr, &sl, &cl).is_none());
    }

    #[test]
    fn clone_without_stable_install_notes_fresh_start() {
        let root = fresh("no-stable");
        let summary = clone_stable_state(
            &root.join("stable-roaming"),
            &root.join("canary-roaming"),
            &root.join("stable-local"),
            &root.join("canary-local"),
        )
        .unwrap();
        assert!(summary.contains("no stable install"));
        assert!(root.join("canary-roaming").join(SENTINEL).exists());
    }
}
