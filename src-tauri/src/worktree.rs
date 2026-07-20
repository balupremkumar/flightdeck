// worktree.rs — per-agent git worktree isolation + diff/review/merge backend
// (Tier 0 of the market plan; BACKLOG table-stake). Each isolated pane gets its
// own worktree + branch under the app-data dir, so parallel agents never write
// into the same checkout. Design decisions D1-D12 in the plan:
//
//  - Worktrees live OUTSIDE the repo (`<app-data>/worktrees/<repo-hash>/<slug>`)
//    so sibling checkouts / the Explorer never see them as dirt (D1). Dir names
//    stay short to soften MAX_PATH on Windows.
//  - `worktree_add` is IDEMPOTENT: an existing path+branch is returned, never
//    re-created — StrictMode's dev double-spawn and pane restarts reuse (D2).
//  - Mutations are serialized per repo root behind a lock (D4): the launcher can
//    fire up to 9 creates at once and `git` would trip over index.lock.
//  - Diffs include UNTRACKED files via `git add -N` intent-to-add (D8) — new
//    files are the most common agent output and plain `git diff` hides them.
//  - Merge-back (D7) auto-commits the worktree, then merges into the base
//    branch; a conflict aborts cleanly and reports, leaving the branch intact.
//  - Removal is two-mode (D6): "keep" commits outstanding work to the branch
//    first; "discard" force-removes. `gc` reaps worktrees no live pane owns.
//  - Command wrappers validate paths against the app worktrees root (D11).
//
// Unlike gitstatus::run_git, the helper here returns {code, stdout, stderr}
// untrimmed — patch text must not be trimmed, and a conflict must be
// distinguishable from "not a repo".

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// Cap a single file diff's IPC payload; a runaway generated file shouldn't ship
// multi-MB strings through the webview bridge.
const MAX_FILE_DIFF_BYTES: usize = 400_000;

// ---------------------------------------------------------------------------
// Git process helper
// ---------------------------------------------------------------------------

pub struct GitOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl GitOut {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
}

/// Run git in `cwd`. Err only when git itself can't be launched (not installed);
/// a failing git command comes back as Ok with a nonzero code + stderr so
/// callers can tell conflict / lock / not-a-repo apart.
pub fn git(cwd: &Path, args: &[&str]) -> Result<GitOut, String> {
    let mut command = std::process::Command::new("git");
    command.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = command
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    Ok(GitOut {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn git_line(cwd: &Path, args: &[&str]) -> Result<Option<String>, String> {
    let out = git(cwd, args)?;
    if out.ok() {
        Ok(Some(out.stdout.trim().to_string()))
    } else {
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// Per-repo serialization (D4)
// ---------------------------------------------------------------------------

fn repo_lock(repo_root: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap();
    map.entry(repo_root.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

// ---------------------------------------------------------------------------
// Paths & metadata
// ---------------------------------------------------------------------------

fn repo_hash(toplevel: &str) -> String {
    // DefaultHasher::new() is fixed-key SipHash — deterministic across runs.
    let mut h = DefaultHasher::new();
    // Normalize case: Windows paths compare case-insensitively.
    toplevel.to_lowercase().hash(&mut h);
    format!("{:012x}", h.finish() & 0xffff_ffff_ffff)
}

fn worktrees_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("worktrees");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A worktree's sidecar metadata, written next to the worktree dir so restore /
/// gc / merge can recover repo + base without a live pane. (Deliberately NOT
/// inside the worktree — an untracked file there would pollute every diff.)
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMeta {
    pub repo: String,
    pub branch: String,
    pub base_branch: String,
}

fn meta_path(worktree_dir: &Path) -> PathBuf {
    // "<dir>.meta.json" — sibling file, same name + suffix.
    let mut os = worktree_dir.as_os_str().to_owned();
    os.push(".meta.json");
    PathBuf::from(os)
}

fn read_meta(worktree_dir: &Path) -> Option<WorktreeMeta> {
    let s = std::fs::read_to_string(meta_path(worktree_dir)).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_meta(worktree_dir: &Path, meta: &WorktreeMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(meta_path(worktree_dir), json).map_err(|e| e.to_string())
}

/// D11: a path the frontend hands us for remove/gc must live under our own
/// worktrees root — never delete arbitrary directories on webview say-so.
fn ensure_under(root: &Path, candidate: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let cand = candidate
        .canonicalize()
        .map_err(|e| format!("no such worktree: {e}"))?;
    if cand.starts_with(&root) {
        Ok(())
    } else {
        Err("path is outside the Flightdeck worktrees dir".into())
    }
}

// ---------------------------------------------------------------------------
// Core operations (testable: explicit worktrees root, no AppHandle)
// ---------------------------------------------------------------------------

/// `git rev-parse --show-toplevel` for a dir; None when it isn't in a work tree
/// (non-repo, bare repo) or git is missing entirely.
pub fn toplevel(dir: &Path) -> Option<String> {
    git_line(dir, &["rev-parse", "--show-toplevel"]).ok().flatten()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub base_branch: String,
    /// false = an existing worktree was reused (idempotent add).
    pub created: bool,
}

/// Create (or reuse) the worktree for `slug` off the repo containing
/// `repo_dir`. Branch = `flightdeck/<slug>`. Idempotent per D2.
pub fn worktree_add(wt_root: &Path, repo_dir: &str, slug: &str) -> Result<WorktreeInfo, String> {
    if slug.is_empty() || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid worktree slug: {slug:?}"));
    }
    let top = toplevel(Path::new(repo_dir))
        .ok_or_else(|| format!("{repo_dir} is not inside a git work tree"))?;
    let top_path = Path::new(&top);

    let lock = repo_lock(&top);
    let _guard = lock.lock().unwrap();

    let branch = format!("flightdeck/{slug}");
    let dir = wt_root.join(repo_hash(&top)).join(slug);
    std::fs::create_dir_all(dir.parent().unwrap()).map_err(|e| e.to_string())?;

    // Reuse path: the dir already is a working worktree on our branch.
    if dir.is_dir() {
        if let Ok(Some(head)) = git_line(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]) {
            if head == branch {
                let base = read_meta(&dir)
                    .map(|m| m.base_branch)
                    .unwrap_or_else(|| "HEAD".into());
                return Ok(WorktreeInfo {
                    path: dir.to_string_lossy().into_owned(),
                    branch,
                    base_branch: base,
                    created: false,
                });
            }
        }
        // A stale/broken dir (crash mid-create): clear it and its registration.
        let _ = git(top_path, &["worktree", "remove", "--force", &dir.to_string_lossy()]);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = git(top_path, &["worktree", "prune"]);
    }

    // Base = whatever the main checkout has out right now (detached → sha).
    let base = git_line(top_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .ok_or("cannot resolve repo HEAD")?;
    let base = if base == "HEAD" {
        git_line(top_path, &["rev-parse", "HEAD"])?.ok_or("cannot resolve repo HEAD")?
    } else {
        base
    };

    let dir_s = dir.to_string_lossy().into_owned();
    let branch_exists = git(top_path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])?.ok();
    let out = if branch_exists {
        // Branch survives from an earlier session (worktree dir was removed):
        // reattach rather than fail on `-b`.
        git(top_path, &["worktree", "add", &dir_s, &branch])?
    } else {
        git(top_path, &["worktree", "add", &dir_s, "-b", &branch])?
    };
    if !out.ok() {
        return Err(format!("git worktree add failed: {}", out.stderr.trim()));
    }

    let meta = WorktreeMeta { repo: top.clone(), branch: branch.clone(), base_branch: base.clone() };
    write_meta(&dir, &meta)?;

    Ok(WorktreeInfo { path: dir_s, branch, base_branch: base, created: !branch_exists })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    /// "removed" | "dirty" (mode "ask" only: outstanding work, nothing done)
    pub status: String,
    pub detail: String,
}

/// Remove a worktree. `mode`:
///  - "ask":     refuse (status "dirty") if there's uncommitted work, so the UI
///               can prompt keep/discard; removes when clean.
///  - "keep":    commit outstanding work to the branch first, then remove —
///               the branch keeps everything.
///  - "discard": force-remove, uncommitted work is dropped.
pub fn worktree_remove(wt_root: &Path, worktree_path: &str, mode: &str) -> Result<RemoveOutcome, String> {
    let dir = Path::new(worktree_path);
    ensure_under(wt_root, dir)?;
    let meta = read_meta(dir);
    let top = meta
        .as_ref()
        .map(|m| m.repo.clone())
        .or_else(|| {
            // Fallback: resolve the main repo through the worktree's common dir.
            git_line(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"])
                .ok()
                .flatten()
                .and_then(|g| Path::new(&g).parent().map(|p| p.to_string_lossy().into_owned()))
        })
        .ok_or("cannot resolve the worktree's repo")?;
    let top_path = Path::new(&top);

    let lock = repo_lock(&top);
    let _guard = lock.lock().unwrap();

    let dirty = git(dir, &["status", "--porcelain"])?
        .stdout
        .trim()
        .to_string();

    match mode {
        "ask" if !dirty.is_empty() => {
            return Ok(RemoveOutcome {
                status: "dirty".into(),
                detail: format!("{} changed file(s) not committed", dirty.lines().count()),
            });
        }
        "keep" if !dirty.is_empty() => {
            let a = git(dir, &["add", "-A"])?;
            if !a.ok() {
                return Err(format!("git add failed: {}", a.stderr.trim()));
            }
            let branch = meta.as_ref().map(|m| m.branch.as_str()).unwrap_or("worktree branch");
            let c = git(dir, &["commit", "-m", &format!("flightdeck: keep agent work from {branch}")])?;
            if !c.ok() && !c.stdout.contains("nothing to commit") {
                return Err(format!("git commit failed: {}", c.stderr.trim()));
            }
        }
        _ => {}
    }

    let force = mode == "discard";
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    let dir_s = dir.to_string_lossy().into_owned();
    args.push(&dir_s);
    let out = git(top_path, &args)?;
    if !out.ok() {
        // Windows: the dir can linger while process handles release — one
        // forced retry after a short wait covers the common close race.
        std::thread::sleep(std::time::Duration::from_millis(400));
        let retry = git(top_path, &["worktree", "remove", "--force", &dir_s])?;
        if !retry.ok() {
            return Err(format!("git worktree remove failed: {}", retry.stderr.trim()));
        }
    }
    let _ = std::fs::remove_file(meta_path(dir));
    let _ = git(top_path, &["worktree", "prune"]);
    // K0a: the worktree may have been agy-trusted at spawn — drop the entry so
    // per-session paths don't accumulate in the user's agy settings.
    crate::vendors::prune_agy_trust(&[dir_s]);
    Ok(RemoveOutcome { status: "removed".into(), detail: String::new() })
}

/// Launch-time GC (D6): remove every worktree under our root that no live /
/// persisted pane claims (`keep` = canonical-ish paths to preserve). Returns
/// the removed paths. Dirty strays get their work committed to their branch
/// first ("keep" mode) — a crashed session must never cost uncommitted agent
/// work; only a broken worktree falls back to force-removal.
pub fn worktree_gc(wt_root: &Path, keep: &[String]) -> Vec<String> {
    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    let keep: Vec<String> = keep.iter().map(|k| norm(k)).collect();
    let mut removed = Vec::new();
    let Ok(repos) = std::fs::read_dir(wt_root) else { return removed };
    for repo_dir in repos.filter_map(|e| e.ok()) {
        if !repo_dir.path().is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(repo_dir.path()) else { continue };
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if !p.is_dir() {
                continue; // .meta.json sidecars handled with their dir
            }
            if keep.iter().any(|k| k == &norm(&p.to_string_lossy())) {
                continue;
            }
            let path_s = p.to_string_lossy().into_owned();
            let reaped = worktree_remove(wt_root, &path_s, "keep").is_ok()
                || worktree_remove(wt_root, &path_s, "discard").is_ok();
            if reaped {
                removed.push(path_s);
            }
        }
    }
    removed
}

// ---------------------------------------------------------------------------
// Worktree setup command (Tier 0 follow-up)
// ---------------------------------------------------------------------------

/// Suggest a setup command for a repo from its lockfile — what a fresh
/// worktree needs before an agent can build/test in it. Conservative: only
/// suggests when the ecosystem is unambiguous; the user can always type
/// their own in New Workspace.
pub fn setup_suggestion(dir: &Path) -> Option<String> {
    let top = toplevel(dir)?;
    let top = Path::new(&top);
    let candidates: &[(&str, &str)] = &[
        ("package-lock.json", "npm ci"),
        ("pnpm-lock.yaml", "pnpm install --frozen-lockfile"),
        ("yarn.lock", "yarn install --frozen-lockfile"),
        ("bun.lockb", "bun install"),
        ("bun.lock", "bun install"),
        ("package.json", "npm install"),
    ];
    candidates
        .iter()
        .find(|(f, _)| top.join(f).is_file())
        .map(|(_, cmd)| cmd.to_string())
}

// ---------------------------------------------------------------------------
// Diff (review surface)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub added: i64,
    pub deleted: i64,
    pub binary: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    /// The commit actually diffed against (merge-base of base and HEAD).
    pub base: String,
    pub files: Vec<DiffFile>,
    pub total_added: i64,
    pub total_deleted: i64,
}

/// Resolve what to diff against: merge-base(base, HEAD) so base-branch drift
/// after the fork doesn't show up as reverse changes; plain HEAD when no base.
fn diff_anchor(dir: &Path, base: Option<&str>) -> Result<String, String> {
    if let Some(b) = base {
        if let Ok(Some(mb)) = git_line(dir, &["merge-base", b, "HEAD"]) {
            return Ok(mb);
        }
        return Ok(b.to_string());
    }
    Ok("HEAD".into())
}

/// D8: intent-to-add so untracked (non-ignored) files participate in git diff.
/// Idempotent and .gitignore-aware; the merge flow `add -A`s anyway. Only ever
/// applied to Flightdeck-owned worktrees — mutating the index of the user's own
/// main checkout (a plain non-isolated pane) is not ours to do.
fn stage_intent(dir: &Path) {
    let _ = git(dir, &["add", "-N", "."]);
}

pub fn diff_summary(dir: &Path, base: Option<&str>, include_untracked: bool) -> Result<DiffSummary, String> {
    let anchor = diff_anchor(dir, base)?;
    if include_untracked {
        stage_intent(dir);
    }
    let out = git(dir, &["diff", "--numstat", &anchor])?;
    if !out.ok() {
        return Err(format!("git diff failed: {}", out.stderr.trim()));
    }
    let mut files = Vec::new();
    let (mut ta, mut td) = (0i64, 0i64);
    for line in out.stdout.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let binary = a == "-";
        let added = a.parse::<i64>().unwrap_or(0);
        let deleted = d.parse::<i64>().unwrap_or(0);
        ta += added;
        td += deleted;
        files.push(DiffFile { path: p.to_string(), added, deleted, binary });
    }
    Ok(DiffSummary { base: anchor, files, total_added: ta, total_deleted: td })
}

/// One file's patch text, untrimmed, capped at MAX_FILE_DIFF_BYTES.
pub fn file_diff(dir: &Path, base: Option<&str>, file: &str, include_untracked: bool) -> Result<String, String> {
    let anchor = diff_anchor(dir, base)?;
    if include_untracked {
        stage_intent(dir);
    }
    let out = git(dir, &["diff", &anchor, "--", file])?;
    if !out.ok() {
        return Err(format!("git diff failed: {}", out.stderr.trim()));
    }
    let mut s = out.stdout;
    if s.len() > MAX_FILE_DIFF_BYTES {
        let mut cut = MAX_FILE_DIFF_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… [diff truncated]");
    }
    Ok(s)
}

// ---------------------------------------------------------------------------
// Merge-back (D7)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// "merged" | "nothing-to-merge" | "conflict" | "dirty-base" | "wrong-branch"
    pub status: String,
    pub detail: String,
}

/// Auto-commit the worktree, then merge its branch into the base branch in the
/// main checkout. Conflicts abort cleanly (branch intact, base restored).
pub fn merge_back(wt_root: &Path, worktree_path: &str) -> Result<MergeOutcome, String> {
    let dir = Path::new(worktree_path);
    ensure_under(wt_root, dir)?;
    let meta = read_meta(dir).ok_or("worktree metadata missing — cannot resolve base branch")?;
    let top_path = Path::new(&meta.repo);

    let lock = repo_lock(&meta.repo);
    let _guard = lock.lock().unwrap();

    // 1. Commit whatever the agent left uncommitted (the common case).
    let dirty = !git(dir, &["status", "--porcelain"])?.stdout.trim().is_empty();
    if dirty {
        let a = git(dir, &["add", "-A"])?;
        if !a.ok() {
            return Err(format!("git add failed: {}", a.stderr.trim()));
        }
        let c = git(dir, &["commit", "-m", &format!("flightdeck: agent work on {}", meta.branch)])?;
        if !c.ok() && !c.stdout.contains("nothing to commit") {
            return Err(format!("git commit failed: {}", c.stderr.trim()));
        }
    }

    // 2. Anything to merge at all?
    let ahead = git_line(dir, &["rev-list", "--count", &format!("{}..HEAD", meta.base_branch)])?
        .unwrap_or_default();
    if ahead == "0" {
        return Ok(MergeOutcome { status: "nothing-to-merge".into(), detail: String::new() });
    }

    // 3. The main checkout must be on the base branch and clean — we never
    //    switch the user's branch or merge over their uncommitted work.
    let head = git_line(top_path, &["rev-parse", "--abbrev-ref", "HEAD"])?.unwrap_or_default();
    if head != meta.base_branch {
        return Ok(MergeOutcome {
            status: "wrong-branch".into(),
            detail: format!("repo is on '{head}', worktree was forked from '{}'", meta.base_branch),
        });
    }
    if !git(top_path, &["status", "--porcelain"])?.stdout.trim().is_empty() {
        return Ok(MergeOutcome {
            status: "dirty-base".into(),
            detail: "the main checkout has uncommitted changes".into(),
        });
    }

    // 4. Merge; abort on conflict so the base is left exactly as found.
    let m = git(
        top_path,
        &["merge", "--no-ff", &meta.branch, "-m", &format!("flightdeck: merge {}", meta.branch)],
    )?;
    if m.ok() {
        return Ok(MergeOutcome { status: "merged".into(), detail: String::new() });
    }
    let _ = git(top_path, &["merge", "--abort"]);
    Ok(MergeOutcome {
        status: "conflict".into(),
        detail: format!(
            "branch '{}' conflicts with '{}' — resolve in your editor or merge via PR; the branch is intact",
            meta.branch, meta.base_branch
        ),
    })
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn git_repo_toplevel(cwd: String) -> Option<String> {
    toplevel(Path::new(&cwd))
}

// NB (STATE.md watch-list): Tauri v2 maps JS camelCase args onto these
// snake_case params — the frontend invokes with { repoDir }, { worktreePath }.
#[tauri::command]
pub fn git_worktree_add(app: AppHandle, repo_dir: String, slug: String) -> Result<WorktreeInfo, String> {
    worktree_add(&worktrees_root(&app)?, &repo_dir, &slug)
}

#[tauri::command]
pub fn git_worktree_remove(app: AppHandle, worktree_path: String, mode: String) -> Result<RemoveOutcome, String> {
    worktree_remove(&worktrees_root(&app)?, &worktree_path, &mode)
}

#[tauri::command]
pub fn git_worktree_gc(app: AppHandle, keep: Vec<String>) -> Result<Vec<String>, String> {
    Ok(worktree_gc(&worktrees_root(&app)?, &keep))
}

/// True when `cwd` is inside our own worktrees dir — those indexes are ours to
/// intent-to-add; a user's main checkout is not.
fn is_flightdeck_worktree(app: &AppHandle, cwd: &str) -> bool {
    match (worktrees_root(app), Path::new(cwd).canonicalize()) {
        (Ok(root), Ok(c)) => root.canonicalize().map(|r| c.starts_with(r)).unwrap_or(false),
        _ => false,
    }
}

#[tauri::command]
pub fn git_diff_summary(app: AppHandle, cwd: String, base: Option<String>) -> Result<DiffSummary, String> {
    let untracked = is_flightdeck_worktree(&app, &cwd);
    diff_summary(Path::new(&cwd), base.as_deref(), untracked)
}

#[tauri::command]
pub fn git_file_diff(app: AppHandle, cwd: String, base: Option<String>, file: String) -> Result<String, String> {
    let untracked = is_flightdeck_worktree(&app, &cwd);
    file_diff(Path::new(&cwd), base.as_deref(), &file, untracked)
}

#[tauri::command]
pub fn git_merge_back(app: AppHandle, worktree_path: String) -> Result<MergeOutcome, String> {
    merge_back(&worktrees_root(&app)?, &worktree_path)
}

#[tauri::command]
pub fn detect_setup_command(cwd: String) -> Option<String> {
    setup_suggestion(Path::new(&cwd))
}

// ---------------------------------------------------------------------------
// Tests — real git against throwaway repos in the OS temp dir.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDirs {
        repo: PathBuf,
        wt_root: PathBuf,
    }

    impl Drop for TempDirs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.repo);
            let _ = std::fs::remove_dir_all(&self.wt_root);
        }
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = git(dir, args).unwrap();
        assert!(out.ok(), "git {args:?} failed: {}", out.stderr);
    }

    fn temp_repo() -> TempDirs {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!("fd-wt-test-{}-{n}", std::process::id()));
        let repo = base.join("repo");
        let wt_root = base.join("wtroot");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&wt_root).unwrap();
        sh(&repo, &["init", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-m", "init"]);
        TempDirs { repo, wt_root }
    }

    #[test]
    fn setup_suggestion_prefers_lockfile_and_needs_a_repo() {
        let t = temp_repo();
        assert_eq!(setup_suggestion(&t.repo), None, "no manifest — no suggestion");
        std::fs::write(t.repo.join("package.json"), "{}").unwrap();
        assert_eq!(setup_suggestion(&t.repo).as_deref(), Some("npm install"));
        std::fs::write(t.repo.join("package-lock.json"), "{}").unwrap();
        assert_eq!(setup_suggestion(&t.repo).as_deref(), Some("npm ci"));
        assert_eq!(setup_suggestion(&std::env::temp_dir()), None, "non-repo — no suggestion");
    }

    #[test]
    fn toplevel_detects_repo_and_non_repo() {
        let t = temp_repo();
        let top = toplevel(&t.repo).unwrap();
        assert_eq!(
            Path::new(&top).canonicalize().unwrap(),
            t.repo.canonicalize().unwrap()
        );
        assert!(toplevel(&std::env::temp_dir()).is_none());
    }

    #[test]
    fn add_is_idempotent() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "ws1-p1").unwrap();
        assert!(a.created);
        assert_eq!(a.branch, "flightdeck/ws1-p1");
        assert_eq!(a.base_branch, "main");
        let b = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "ws1-p1").unwrap();
        assert!(!b.created, "second add must reuse (StrictMode double-spawn)");
        assert_eq!(a.path, b.path);
    }

    #[test]
    fn add_reattaches_existing_branch() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "ws1-p2").unwrap();
        // Simulate a removed dir with a surviving branch (restore after close).
        worktree_remove(&t.wt_root, &a.path, "discard").unwrap();
        assert!(!Path::new(&a.path).exists());
        let b = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "ws1-p2").unwrap();
        assert!(!b.created, "branch survived, so this is a reattach");
        assert_eq!(b.branch, "flightdeck/ws1-p2");
    }

    #[test]
    fn concurrent_adds_all_succeed() {
        let t = temp_repo();
        let repo = t.repo.to_string_lossy().into_owned();
        let handles: Vec<_> = (0..6)
            .map(|i| {
                let (repo, root) = (repo.clone(), t.wt_root.clone());
                std::thread::spawn(move || worktree_add(&root, &repo, &format!("cc-{i}")))
            })
            .collect();
        for h in handles {
            let info = h.join().unwrap().expect("concurrent add failed");
            assert!(Path::new(&info.path).is_dir());
        }
    }

    #[test]
    fn diff_includes_untracked_files() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "diff-1").unwrap();
        let wt = Path::new(&a.path);
        std::fs::write(wt.join("a.txt"), "one\ntwo\n").unwrap(); // modified
        std::fs::write(wt.join("new.txt"), "brand new\n").unwrap(); // untracked
        let sum = diff_summary(wt, Some(&a.base_branch), true).unwrap();
        let paths: Vec<_> = sum.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"), "modified file missing: {paths:?}");
        assert!(paths.contains(&"new.txt"), "untracked file missing from diff (D8): {paths:?}");
        let patch = file_diff(wt, Some(&a.base_branch), "new.txt", true).unwrap();
        assert!(patch.contains("brand new"));
    }

    #[test]
    fn merge_back_clean_and_nothing_cases() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "mb-1").unwrap();
        // Nothing yet:
        let none = merge_back(&t.wt_root, &a.path).unwrap();
        assert_eq!(none.status, "nothing-to-merge");
        // Agent leaves uncommitted work (the common case) → auto-commit + merge:
        std::fs::write(Path::new(&a.path).join("feature.txt"), "done\n").unwrap();
        let m = merge_back(&t.wt_root, &a.path).unwrap();
        assert_eq!(m.status, "merged", "{}", m.detail);
        assert!(t.repo.join("feature.txt").exists(), "merge must land in the main checkout");
    }

    #[test]
    fn merge_conflict_aborts_cleanly() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "mc-1").unwrap();
        std::fs::write(Path::new(&a.path).join("a.txt"), "worktree version\n").unwrap();
        std::fs::write(t.repo.join("a.txt"), "main version\n").unwrap();
        sh(&t.repo, &["commit", "-am", "diverge"]);
        let m = merge_back(&t.wt_root, &a.path).unwrap();
        assert_eq!(m.status, "conflict");
        // Base restored — no merge in progress, no conflict markers:
        let st = git(&t.repo, &["status", "--porcelain"]).unwrap();
        assert!(st.stdout.trim().is_empty(), "base left dirty after abort: {}", st.stdout);
        // Branch intact:
        let ok = git(&t.repo, &["rev-parse", "--verify", "flightdeck/mc-1"]).unwrap();
        assert!(ok.ok());
    }

    #[test]
    fn merge_refuses_dirty_base_and_wrong_branch() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "md-1").unwrap();
        std::fs::write(Path::new(&a.path).join("x.txt"), "x\n").unwrap();
        std::fs::write(t.repo.join("a.txt"), "local edit\n").unwrap(); // dirty base
        let m = merge_back(&t.wt_root, &a.path).unwrap();
        assert_eq!(m.status, "dirty-base");
        sh(&t.repo, &["checkout", "--", "a.txt"]);
        sh(&t.repo, &["checkout", "-b", "elsewhere"]);
        let m2 = merge_back(&t.wt_root, &a.path).unwrap();
        assert_eq!(m2.status, "wrong-branch");
    }

    #[test]
    fn remove_modes_ask_keep_discard() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "rm-1").unwrap();
        std::fs::write(Path::new(&a.path).join("wip.txt"), "wip\n").unwrap();
        // ask + dirty → prompt, nothing removed:
        let ask = worktree_remove(&t.wt_root, &a.path, "ask").unwrap();
        assert_eq!(ask.status, "dirty");
        assert!(Path::new(&a.path).exists());
        // keep → work committed to the branch, worktree gone:
        let keep = worktree_remove(&t.wt_root, &a.path, "keep").unwrap();
        assert_eq!(keep.status, "removed");
        assert!(!Path::new(&a.path).exists());
        let show = git(&t.repo, &["show", "flightdeck/rm-1:wip.txt"]).unwrap();
        assert!(show.ok(), "kept work must be on the branch");
        // discard on a fresh dirty worktree:
        let b = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "rm-2").unwrap();
        std::fs::write(Path::new(&b.path).join("junk.txt"), "junk\n").unwrap();
        let disc = worktree_remove(&t.wt_root, &b.path, "discard").unwrap();
        assert_eq!(disc.status, "removed");
        assert!(!Path::new(&b.path).exists());
    }

    #[test]
    fn remove_rejects_paths_outside_root() {
        let t = temp_repo();
        let err = worktree_remove(&t.wt_root, &t.repo.to_string_lossy(), "discard");
        assert!(err.is_err(), "must not remove dirs outside the worktrees root");
        assert!(t.repo.exists());
    }

    #[test]
    fn gc_reaps_unclaimed_worktrees() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "gc-keep").unwrap();
        let b = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "gc-stray").unwrap();
        std::fs::write(Path::new(&b.path).join("stray.txt"), "s\n").unwrap(); // dirty stray
        let removed = worktree_gc(&t.wt_root, &[a.path.clone()]);
        assert_eq!(removed.len(), 1);
        assert!(removed[0].contains("gc-stray"));
        assert!(Path::new(&a.path).exists(), "claimed worktree must survive GC");
        assert!(!Path::new(&b.path).exists());
        // Data safety: the stray's uncommitted work must survive on its branch.
        let show = git(&t.repo, &["show", "flightdeck/gc-stray:stray.txt"]).unwrap();
        assert!(show.ok(), "GC must commit stray work to the branch, not destroy it");
    }
}
