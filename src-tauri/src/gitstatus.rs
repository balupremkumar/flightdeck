// gitstatus.rs — real git branch/dirty status per pane cwd (replaces the
// hardcoded "main" branch pill noted in BACKLOG item 108). Shells out to
// `git`; degrades gracefully (is_repo: false) if the cwd isn't a repo or git
// isn't installed — a failed/missing `git` command just falls through to
// `None` rather than erroring the command.

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub dirty: bool,
}

fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new("git");
    command.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = command.output().ok()?; // Err covers "git not installed"
    if !out.status.success() {
        return None; // not a repo, detached weirdness, etc.
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
pub fn git_status(cwd: String) -> GitStatus {
    let branch = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let Some(branch) = branch else {
        return GitStatus { is_repo: false, branch: None, dirty: false };
    };

    let dirty = run_git(&cwd, &["status", "--porcelain"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    GitStatus { is_repo: true, branch: Some(branch), dirty }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// UX-597: a non-repo folder (or git missing entirely — `run_git`'s
    /// `.ok()?` collapses both to the same None) must degrade to a calm
    /// default, never an error the caller has to unwrap.
    #[test]
    fn non_repo_dir_reports_not_a_repo_never_panics() {
        let dir = std::env::temp_dir().join(format!("fd-gitstatus-not-a-repo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let status = git_status(dir.to_string_lossy().into_owned());
        assert!(!status.is_repo);
        assert!(status.branch.is_none());
        assert!(!status.dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nonexistent_dir_reports_not_a_repo_never_panics() {
        let status = git_status("D:\\this-path-should-not-exist-flightdeck-gitstatus".to_string());
        assert!(!status.is_repo);
    }
}
