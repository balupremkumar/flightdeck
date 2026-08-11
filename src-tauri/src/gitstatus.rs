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
    /// QL-740: commits this branch has that its upstream doesn't (unpushed).
    /// `None` means "no upstream to compare against" (a local-only branch, a
    /// detached HEAD, a deleted remote) — deliberately not `0`, so the header
    /// can stay silent instead of claiming the branch is in sync.
    pub ahead: Option<u32>,
    /// Commits the upstream has that this branch doesn't (unpulled). Same
    /// `None` meaning as `ahead`.
    pub behind: Option<u32>,
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

/// Parse `git rev-list --left-right --count @{upstream}...HEAD` output
/// ("<behind>\t<ahead>" — left is upstream-only, right is HEAD-only) into
/// `(ahead, behind)`. Anything unexpected is `None` rather than a panic.
fn parse_ahead_behind(out: &str) -> Option<(u32, u32)> {
    let mut parts = out.split_whitespace();
    let behind: u32 = parts.next()?.parse().ok()?;
    let ahead: u32 = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

#[tauri::command]
pub fn git_status(cwd: String) -> GitStatus {
    let branch = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let Some(branch) = branch else {
        return GitStatus { is_repo: false, branch: None, dirty: false, ahead: None, behind: None };
    };

    let dirty = run_git(&cwd, &["status", "--porcelain"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    // QL-740: ahead/behind vs the tracking branch. Purely local (no fetch), so
    // it stays as cheap as the two calls above. A branch with no upstream makes
    // `git` exit nonzero, which `run_git` already collapses to `None` — that is
    // the no-upstream case, not an error.
    let (ahead, behind) = run_git(&cwd, &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
        .and_then(|s| parse_ahead_behind(&s))
        .map_or((None, None), |(a, b)| (Some(a), Some(b)));

    GitStatus { is_repo: true, branch: Some(branch), dirty, ahead, behind }
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
        assert!(status.ahead.is_none() && status.behind.is_none());
    }

    // ---- QL-740: ahead/behind vs upstream ---------------------------------

    #[test]
    fn parses_left_right_counts_as_behind_then_ahead() {
        assert_eq!(parse_ahead_behind("2\t1"), Some((1, 2)));
        assert_eq!(parse_ahead_behind("0\t0"), Some((0, 0)));
        assert_eq!(parse_ahead_behind("0       3"), Some((3, 0)));
    }

    #[test]
    fn unparseable_counts_are_none_not_zero() {
        assert_eq!(parse_ahead_behind(""), None);
        assert_eq!(parse_ahead_behind("1"), None, "one number is not a pair");
        assert_eq!(parse_ahead_behind("fatal: no upstream configured"), None);
    }

    /// Runs git in `dir`; returns false if git can't be launched at all, so the
    /// repo-backed test below skips instead of failing on a machine without git.
    fn sh(dir: &std::path::Path, args: &[&str]) -> bool {
        match std::process::Command::new("git").args(args).current_dir(dir).output() {
            Ok(out) => {
                assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
                true
            }
            Err(_) => false,
        }
    }

    #[test]
    fn reports_ahead_and_behind_against_a_real_upstream() {
        let base = std::env::temp_dir().join(format!("fd-gitstatus-ab-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let origin = base.join("origin");
        let clone = base.join("clone");
        std::fs::create_dir_all(&origin).unwrap();
        if !sh(&origin, &["init", "-b", "main"]) {
            return; // git isn't installed — the degrade-gracefully tests above cover that
        }
        sh(&origin, &["config", "user.email", "t@t"]);
        sh(&origin, &["config", "user.name", "t"]);
        std::fs::write(origin.join("a.txt"), "one\n").unwrap();
        sh(&origin, &["add", "-A"]);
        sh(&origin, &["commit", "-m", "init"]);

        // A branch with no upstream: in a repo, but nothing to compare against.
        let local_only = git_status(origin.to_string_lossy().into_owned());
        assert!(local_only.is_repo);
        assert!(local_only.ahead.is_none() && local_only.behind.is_none(), "no upstream is None, not 0");

        sh(&base, &["clone", &origin.to_string_lossy(), &clone.to_string_lossy()]);
        sh(&clone, &["config", "user.email", "t@t"]);
        sh(&clone, &["config", "user.name", "t"]);

        let synced = git_status(clone.to_string_lossy().into_owned());
        assert_eq!((synced.ahead, synced.behind), (Some(0), Some(0)), "fresh clone is in sync");

        sh(&clone, &["commit", "--allow-empty", "-m", "local work"]);
        let ahead = git_status(clone.to_string_lossy().into_owned());
        assert_eq!((ahead.ahead, ahead.behind), (Some(1), Some(0)), "one unpushed commit");

        sh(&origin, &["commit", "--allow-empty", "-m", "upstream work"]);
        sh(&clone, &["fetch", "origin"]);
        let both = git_status(clone.to_string_lossy().into_owned());
        assert_eq!((both.ahead, both.behind), (Some(1), Some(1)), "diverged after fetch");

        let _ = std::fs::remove_dir_all(&base);
    }
}
