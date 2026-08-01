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
    // UX-592: never let a network git block on an interactive prompt. Offline,
    // or with expired credentials, a push otherwise waits forever on a
    // credential helper that has no terminal to prompt on — which hangs this
    // command thread and leaves the caller's button spinning with no way out.
    // Failing fast turns a hang into an ordinary nonzero exit the caller can
    // explain.
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = command.output().map_err(|e| {
        // UX-597: this is the "git not on PATH" case — the only way `git`
        // itself fails to launch. std::io::Error's Display is a raw OS
        // message ("The system cannot find the file specified") which reads
        // as a bug report, not an explanation; name the actual cause instead.
        format!("Git isn't installed (or not on PATH) — install Git for Windows to use this feature. ({e})")
    })?;
    Ok(GitOut {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// UX-597: turn a failing git command's raw stderr into a calm, specific
/// explanation the UI can render as-is, instead of git's own wording (which
/// varies by locale/version and often reads like an internal error). Falls
/// back to the raw detail, prefixed by `context`, when nothing is recognised —
/// never hides information, just leads with a plain-language reason when one
/// is identifiable.
fn explain_git_failure(context: &str, stderr: &str) -> String {
    let s = stderr.trim();
    if s.contains("not a git repository") {
        format!("{context}: this folder isn't a git repository.")
    } else if s.contains("Permission denied") || s.contains("Access is denied") {
        format!("{context}: permission denied — check the folder isn't read-only or locked by another process.")
    } else if s.is_empty() {
        format!("{context}: git reported no further detail.")
    } else {
        format!("{context}: {s}")
    }
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
        return Err(explain_git_failure("git diff failed", &out.stderr));
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
        return Err(explain_git_failure("git diff failed", &out.stderr));
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
// Branch context for the review drawer (UI-174/177)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCommit {
    pub hash: String,
    pub subject: String,
    /// Unix seconds — the UI formats it.
    pub at: i64,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchContext {
    /// Commits on this branch that the base doesn't have (what a merge brings).
    pub commits: Vec<BranchCommit>,
    /// Commits the BASE has gained since this worktree forked (drift) — the
    /// number that decides whether a merge is likely to conflict.
    pub base_ahead: u32,
    pub base_branch: String,
    pub branch: String,
}

pub fn branch_context(dir: &Path, base: Option<&str>) -> Result<BranchContext, String> {
    let branch = git_line(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?.unwrap_or_default();
    let Some(base) = base else {
        return Ok(BranchContext { branch, ..Default::default() });
    };
    let out = git(dir, &["log", "--format=%H%x1f%s%x1f%ct", &format!("{base}..HEAD")])?;
    let commits = out
        .stdout
        .lines()
        .filter_map(|l| {
            let mut parts = l.split('\u{1f}');
            Some(BranchCommit {
                hash: parts.next()?.chars().take(8).collect(),
                subject: parts.next()?.to_string(),
                at: parts.next()?.parse().unwrap_or(0),
            })
        })
        .collect();
    // How far the base has moved since the fork point.
    let base_ahead = git_line(dir, &["rev-list", "--count", &format!("HEAD..{base}")])?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(BranchContext { commits, base_ahead, base_branch: base.to_string(), branch })
}

/// UI-178: bring the base branch's new commits INTO the agent's branch, so a
/// drifted worktree can catch up (and hit conflicts here, in its own sandbox,
/// rather than at merge time against the user's checkout).
pub fn update_from_base(wt_root: &Path, worktree_path: &str) -> Result<MergeOutcome, String> {
    let dir = Path::new(worktree_path);
    ensure_under(wt_root, dir)?;
    let meta = read_meta(dir).ok_or("worktree metadata missing — cannot resolve base branch")?;
    let lock = repo_lock(&meta.repo);
    let _guard = lock.lock().unwrap();

    commit_outstanding(dir, &meta.branch)?;
    let m = git(dir, &["merge", "--no-edit", &meta.base_branch])?;
    if m.ok() {
        let already = m.stdout.contains("Already up to date");
        return Ok(MergeOutcome {
            status: if already { "nothing-to-merge".into() } else { "merged".into() },
            detail: String::new(),
            conflict_files: vec![],
            ..Default::default()
        });
    }
    let conflict_files: Vec<String> = git(dir, &["diff", "--name-only", "--diff-filter=U"])
        .map(|o| o.stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();
    let _ = git(dir, &["merge", "--abort"]);
    Ok(MergeOutcome {
        status: "conflict".into(),
        detail: format!("'{}' conflicts with '{}' — the worktree is unchanged", meta.base_branch, meta.branch),
        conflict_files,
        ..Default::default()
    })
}

// ---------------------------------------------------------------------------
// Merge-back (D7)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// "merged" | "nothing-to-merge" | "conflict" | "dirty-base" | "wrong-branch"
    pub status: String,
    pub detail: String,
    /// UI-5: on "conflict", the files that conflicted (captured before the
    /// abort restores the base). Empty for every other status.
    #[serde(default)]
    pub conflict_files: Vec<String>,
    /// UX-578: short hash of the merge commit landed in the base checkout.
    /// Set only on a "merged" status.
    #[serde(default)]
    pub merge_commit: Option<String>,
    /// UX-578: clickable host URL for `merge_commit`, when the origin remote
    /// is a recognised host (mirrors compare_url's host parsing). None when
    /// there's no merge_commit, no origin, or an unrecognised host.
    #[serde(default)]
    pub commit_url: Option<String>,
}

/// Commit whatever the agent left uncommitted (shared by merge-back and the
/// PR handoff — both land "everything the agent did", committed or not).
fn commit_outstanding(dir: &Path, branch: &str) -> Result<(), String> {
    let dirty = !git(dir, &["status", "--porcelain"])?.stdout.trim().is_empty();
    if dirty {
        let a = git(dir, &["add", "-A"])?;
        if !a.ok() {
            return Err(format!("git add failed: {}", a.stderr.trim()));
        }
        let c = git(dir, &["commit", "-m", &format!("flightdeck: agent work on {branch}")])?;
        if !c.ok() && !c.stdout.contains("nothing to commit") {
            return Err(format!("git commit failed: {}", c.stderr.trim()));
        }
    }
    Ok(())
}

/// UI-168 (partial merge-back): commit ONLY `paths`, leaving everything else
/// exactly as the agent left it — dirty, on disk, in the worktree.
///
/// Why this approach and not the alternatives:
///   - `git` has no "merge a subset of files" primitive; the merge unit is
///     always a commit. So the subset has to become a real commit on the
///     agent's branch before `merge_back`'s existing --no-ff merge runs —
///     everything downstream of this function (conflict detection, abort-
///     on-conflict, dirty-base / wrong-branch guards) is then reused unchanged.
///   - Cherry-picking a hand-built commit, or `checkout <rev> -- <paths>`
///     straight into the base checkout, were the other candidates. Both
///     still require SOME commit to exist for the selected paths (a cherry-
///     pick needs a source commit; a targeted checkout needs a tree to read
///     from) — they don't avoid this step, they just add one on top of it.
///     Committing directly on the agent's branch is simplest and keeps the
///     merge commit's parentage honest (it really did come from that branch).
///   - We `git reset` (unstage everything) before staging only `paths`. This
///     is defensive, not load-bearing for the common case: an agent worktree
///     normally has nothing staged going into a merge. But an agent can run
///     arbitrary shell commands, including its own `git add` — without the
///     reset, leftover staged content outside `paths` would ride along into
///     the commit and defeat the whole point of "only this subset". The
///     reset only touches the index; nothing on disk moves.
///
/// What this does NOT handle:
///   - A file created/changed AFTER the caller computed its file list but
///     BEFORE this runs (a race with the agent still working) is simply not
///     part of `paths` and stays uncommitted — correct, but the caller must
///     re-diff to select it in a later merge.
///   - A rename shows up as two independent paths (delete + add) because the
///     diff this UI is built on doesn't request `-M`; selecting only one side
///     partially applies the rename (e.g. lands the new file but leaves the
///     old one in place). That mirrors what the two checkboxes actually mean
///     to the user, so it isn't "wrong", but it's worth knowing.
///   - `paths` are trusted pathspecs from the caller (the review drawer's own
///     diff listing) — this is not a general-purpose sandboxed pathspec
///     filter for adversarial input.
fn commit_outstanding_selected(dir: &Path, branch: &str, paths: &[String]) -> Result<(), String> {
    // Never silently fall back to "everything" — an empty selection commits
    // nothing and the caller (merge_back) turns that into "nothing-to-merge".
    if paths.is_empty() {
        return Ok(());
    }
    let r = git(dir, &["reset"])?;
    if !r.ok() {
        return Err(format!("git reset failed: {}", r.stderr.trim()));
    }
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(|p| p.as_str()));
    let a = git(dir, &args)?;
    if !a.ok() {
        return Err(format!("git add failed: {}", a.stderr.trim()));
    }
    let staged = !git(dir, &["diff", "--cached", "--name-only"])?.stdout.trim().is_empty();
    if !staged {
        return Ok(()); // the selected paths matched nothing changed — nothing to commit
    }
    let c = git(
        dir,
        &["commit", "-m", &format!("flightdeck: agent work on {branch} (partial merge)")],
    )?;
    if !c.ok() && !c.stdout.contains("nothing to commit") {
        return Err(format!("git commit failed: {}", c.stderr.trim()));
    }
    Ok(())
}

/// Commits the branch is ahead of base by ("0" = nothing to land).
fn ahead_count(dir: &Path, base_branch: &str) -> Result<String, String> {
    Ok(git_line(dir, &["rev-list", "--count", &format!("{base_branch}..HEAD")])?.unwrap_or_default())
}

/// Auto-commit the worktree, then merge its branch into the base branch in the
/// main checkout. Conflicts abort cleanly (branch intact, base restored).
///
/// `selected`: `None` means "everything" and takes the exact code path this
/// function always has — the review drawer sends `None` whenever nothing is
/// deselected, so the all-files merge is byte-for-byte the pre-UI-168
/// behaviour, not a subset that happens to cover every file. `Some(paths)`
/// commits only `paths` (commit_outstanding_selected) and leaves the rest of
/// the worktree exactly as the agent left it, uncommitted.
pub fn merge_back(wt_root: &Path, worktree_path: &str, selected: Option<&[String]>) -> Result<MergeOutcome, String> {
    let dir = Path::new(worktree_path);
    ensure_under(wt_root, dir)?;
    let meta = read_meta(dir).ok_or("worktree metadata missing — cannot resolve base branch")?;
    let top_path = Path::new(&meta.repo);

    let lock = repo_lock(&meta.repo);
    let _guard = lock.lock().unwrap();

    // An explicit empty selection ("deselected everything") is a no-op, not
    // an error — same outcome as there being nothing to merge.
    if selected.is_some_and(|p| p.is_empty()) {
        return Ok(MergeOutcome { status: "nothing-to-merge".into(), detail: String::new(), ..Default::default() });
    }

    // 1. Commit whatever the agent left uncommitted (the common case) — or
    //    just the selected subset for a partial merge (UI-168).
    match selected {
        Some(paths) => commit_outstanding_selected(dir, &meta.branch, paths)?,
        None => commit_outstanding(dir, &meta.branch)?,
    }

    // 2. Anything to merge at all?
    if ahead_count(dir, &meta.base_branch)? == "0" {
        return Ok(MergeOutcome { status: "nothing-to-merge".into(), detail: String::new(), ..Default::default() });
    }

    // 3. The main checkout must be on the base branch and clean — we never
    //    switch the user's branch or merge over their uncommitted work.
    let head = git_line(top_path, &["rev-parse", "--abbrev-ref", "HEAD"])?.unwrap_or_default();
    if head != meta.base_branch {
        return Ok(MergeOutcome {
            status: "wrong-branch".into(),
            detail: format!("repo is on '{head}', worktree was forked from '{}'", meta.base_branch),
            conflict_files: vec![],
            ..Default::default()
        });
    }
    if !git(top_path, &["status", "--porcelain"])?.stdout.trim().is_empty() {
        return Ok(MergeOutcome {
            status: "dirty-base".into(),
            detail: "the main checkout has uncommitted changes".into(),
            conflict_files: vec![],
            ..Default::default()
        });
    }

    // 4. Merge; abort on conflict so the base is left exactly as found.
    let m = git(
        top_path,
        &["merge", "--no-ff", &meta.branch, "-m", &format!("flightdeck: merge {}", meta.branch)],
    )?;
    if m.ok() {
        // UX-578: name the merge commit that just landed, and a clickable
        // host URL for it when origin is a recognised host — the toast and
        // Review drawer can then link straight to it instead of just saying
        // "merged".
        let hash = git_line(top_path, &["rev-parse", "--short", "HEAD"])?;
        let commit_url = hash.as_deref().and_then(|h| match git(top_path, &["remote", "get-url", "origin"]) {
            Ok(o) if o.ok() => commit_url_for(o.stdout.trim(), h),
            _ => None,
        });
        return Ok(MergeOutcome {
            status: "merged".into(),
            detail: String::new(),
            conflict_files: vec![],
            merge_commit: hash,
            commit_url,
        });
    }
    // UI-5: capture WHICH files conflicted before the abort wipes the state.
    let conflict_files: Vec<String> = git(top_path, &["diff", "--name-only", "--diff-filter=U"])
        .map(|o| o.stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();
    let _ = git(top_path, &["merge", "--abort"]);
    Ok(MergeOutcome {
        status: "conflict".into(),
        detail: format!(
            "branch '{}' conflicts with '{}' — the branch is intact",
            meta.branch, meta.base_branch
        ),
        conflict_files,
        ..Default::default()
    })
}

// ---------------------------------------------------------------------------
// PR handoff (Tier 0 follow-up — the merge path most rivals ship; sidesteps
// the local conflict UI entirely by landing review on the git host)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrOutcome {
    /// "pushed" | "nothing-to-push" | "no-remote" | "push-failed"
    pub status: String,
    /// Host compare/new-PR URL when the remote is a recognised host.
    pub url: Option<String>,
    pub detail: String,
}

/// Build the host's "open a PR for this branch" URL from an origin remote.
/// Recognises GitHub, GitLab (incl. self-hosted *gitlab* hosts) and Bitbucket;
/// anything else returns None — the push still succeeded, the user opens the
/// PR on their host manually.
fn compare_url(remote: &str, base: &str, branch: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    // git@host:owner/repo | ssh://git@host/owner/repo | https://host/owner/repo
    let (host, path) = if let Some(rest) = r.strip_prefix("git@") {
        let (h, p) = rest.split_once(':')?;
        (h.to_string(), p.to_string())
    } else if let Some(rest) = r.strip_prefix("ssh://") {
        let rest = rest.strip_prefix("git@").unwrap_or(rest);
        let (h, p) = rest.split_once('/')?;
        (h.to_string(), p.to_string())
    } else if let Some(rest) = r.strip_prefix("https://").or_else(|| r.strip_prefix("http://")) {
        let (h, p) = rest.split_once('/')?;
        (h.to_string(), p.to_string())
    } else {
        return None; // local path remote, etc.
    };
    let path = path.trim_matches('/');
    if path.is_empty() {
        return None;
    }
    let enc = |s: &str| s.replace('/', "%2F");
    if host == "github.com" {
        Some(format!("https://github.com/{path}/compare/{base}...{branch}?expand=1"))
    } else if host == "gitlab.com" || host.contains("gitlab") {
        Some(format!(
            "https://{host}/{path}/-/merge_requests/new?merge_request%5Bsource_branch%5D={}&merge_request%5Btarget_branch%5D={}",
            enc(branch),
            enc(base)
        ))
    } else if host == "bitbucket.org" {
        Some(format!("https://bitbucket.org/{path}/pull-requests/new?source={}&dest={}", enc(branch), enc(base)))
    } else {
        None
    }
}

/// UX-578: build a host's "view this commit" URL, mirroring compare_url's
/// host parsing above (github `/commit/<hash>`, gitlab `/-/commit/<hash>`,
/// bitbucket `/commits/<hash>`). None for unrecognised hosts or local remotes.
fn commit_url_for(remote: &str, hash: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    let (host, path) = if let Some(rest) = r.strip_prefix("git@") {
        let (h, p) = rest.split_once(':')?;
        (h.to_string(), p.to_string())
    } else if let Some(rest) = r.strip_prefix("ssh://") {
        let rest = rest.strip_prefix("git@").unwrap_or(rest);
        let (h, p) = rest.split_once('/')?;
        (h.to_string(), p.to_string())
    } else if let Some(rest) = r.strip_prefix("https://").or_else(|| r.strip_prefix("http://")) {
        let (h, p) = rest.split_once('/')?;
        (h.to_string(), p.to_string())
    } else {
        return None; // local path remote, etc.
    };
    let path = path.trim_matches('/');
    if path.is_empty() {
        return None;
    }
    if host == "github.com" {
        Some(format!("https://github.com/{path}/commit/{hash}"))
    } else if host == "gitlab.com" || host.contains("gitlab") {
        Some(format!("https://{host}/{path}/-/commit/{hash}"))
    } else if host == "bitbucket.org" {
        Some(format!("https://bitbucket.org/{path}/commits/{hash}"))
    } else {
        None
    }
}

/// Auto-commit the worktree's outstanding work, push its branch to origin and
/// hand back the host's new-PR URL. Never touches the base branch — review and
/// conflict resolution happen on the host.
pub fn pr_handoff(wt_root: &Path, worktree_path: &str) -> Result<PrOutcome, String> {
    let dir = Path::new(worktree_path);
    ensure_under(wt_root, dir)?;
    let meta = read_meta(dir).ok_or("worktree metadata missing — cannot resolve base branch")?;

    let lock = repo_lock(&meta.repo);
    let _guard = lock.lock().unwrap();

    commit_outstanding(dir, &meta.branch)?;
    if ahead_count(dir, &meta.base_branch)? == "0" {
        return Ok(PrOutcome { status: "nothing-to-push".into(), url: None, detail: String::new() });
    }

    let remote = git(dir, &["remote", "get-url", "origin"])?;
    if !remote.ok() {
        return Ok(PrOutcome {
            status: "no-remote".into(),
            url: None,
            detail: "the repo has no 'origin' remote — add one (or use Merge back)".into(),
        });
    }
    let remote_url = remote.stdout.trim().to_string();

    let push = git(dir, &["push", "-u", "origin", &meta.branch])?;
    if !push.ok() {
        return Ok(PrOutcome {
            status: "push-failed".into(),
            url: None,
            detail: push.stderr.trim().to_string(),
        });
    }

    let url = compare_url(&remote_url, &meta.base_branch, &meta.branch);
    let detail = match &url {
        Some(_) => String::new(),
        None => format!("branch '{}' pushed to origin — open the PR on your git host", meta.branch),
    };
    Ok(PrOutcome { status: "pushed".into(), url, detail })
}

// ---------------------------------------------------------------------------
// Worktree inventory (UI-187/230) — what's on disk and how big it is
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub repo: String,
    pub branch: String,
    pub base_branch: String,
    pub bytes: u64,
    /// True when no live/persisted pane claims it (safe to reap).
    pub orphan: bool,
}

/// Recursive size, capped so a monorepo worktree can't stall the UI thread.
fn dir_size(dir: &Path, budget: &mut u32) -> u64 {
    if *budget == 0 {
        return 0;
    }
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for e in entries.filter_map(|e| e.ok()) {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        match e.file_type() {
            Ok(ft) if ft.is_dir() => total += dir_size(&e.path(), budget),
            Ok(ft) if ft.is_file() => total += e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => {}
        }
    }
    total
}

pub fn worktree_list(wt_root: &Path, claimed: &[String]) -> Vec<WorktreeEntry> {
    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    let claimed: Vec<String> = claimed.iter().map(|c| norm(c)).collect();
    let mut out = Vec::new();
    let Ok(repos) = std::fs::read_dir(wt_root) else { return out };
    for repo_dir in repos.filter_map(|e| e.ok()) {
        if !repo_dir.path().is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(repo_dir.path()) else { continue };
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let meta = read_meta(&p);
            let mut budget = 20_000u32; // plenty for a normal checkout, bounded for a monorepo
            let path_s = p.to_string_lossy().into_owned();
            out.push(WorktreeEntry {
                orphan: !claimed.iter().any(|c| c == &norm(&path_s)),
                bytes: dir_size(&p, &mut budget),
                repo: meta.as_ref().map(|m| m.repo.clone()).unwrap_or_default(),
                branch: meta.as_ref().map(|m| m.branch.clone()).unwrap_or_default(),
                base_branch: meta.as_ref().map(|m| m.base_branch.clone()).unwrap_or_default(),
                path: path_s,
            });
        }
    }
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    out
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

/// UI-168: `files` is `None` for "merge everything" (default, matches the
/// pre-UI-168 behaviour exactly) or `Some(paths)` to land only those paths.
#[tauri::command]
pub fn git_merge_back(app: AppHandle, worktree_path: String, files: Option<Vec<String>>) -> Result<MergeOutcome, String> {
    merge_back(&worktrees_root(&app)?, &worktree_path, files.as_deref())
}

#[tauri::command]
pub fn detect_setup_command(cwd: String) -> Option<String> {
    setup_suggestion(Path::new(&cwd))
}

#[tauri::command]
pub fn git_worktree_list(app: AppHandle, claimed: Vec<String>) -> Result<Vec<WorktreeEntry>, String> {
    Ok(worktree_list(&worktrees_root(&app)?, &claimed))
}

/// UI-154: the repo's browsable web URL, from its origin remote. Reuses
/// compare_url's host parsing so recognition stays consistent with PR handoff.
#[tauri::command]
pub fn git_repo_web_url(cwd: String) -> Option<String> {
    let dir = Path::new(&cwd);
    let remote = git(dir, &["remote", "get-url", "origin"]).ok()?;
    if !remote.ok() {
        return None;
    }
    // compare_url() gives ".../compare/base...branch?expand=1"; the repo root is
    // everything before the host-specific suffix.
    let url = compare_url(remote.stdout.trim(), "main", "main")?;
    for marker in ["/compare/", "/-/merge_requests/", "/pull-requests/"] {
        if let Some(i) = url.find(marker) {
            return Some(url[..i].to_string());
        }
    }
    None
}

#[tauri::command]
pub fn git_branch_context(cwd: String, base: Option<String>) -> Result<BranchContext, String> {
    branch_context(Path::new(&cwd), base.as_deref())
}

#[tauri::command]
pub fn git_update_from_base(app: AppHandle, worktree_path: String) -> Result<MergeOutcome, String> {
    update_from_base(&worktrees_root(&app)?, &worktree_path)
}

#[tauri::command]
pub fn git_pr_handoff(app: AppHandle, worktree_path: String) -> Result<PrOutcome, String> {
    pr_handoff(&worktrees_root(&app)?, &worktree_path)
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

    /// Init a repo + wt_root under an arbitrary base dir — factored out of
    /// `temp_repo` so the long-path/unicode tests (UX-593) can supply an
    /// unusual base (unicode, spaces, deeply nested) while exercising the
    /// exact same setup every other test relies on.
    fn temp_repo_with_base(base: PathBuf) -> TempDirs {
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

    fn temp_repo() -> TempDirs {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!("fd-wt-test-{}-{n}", std::process::id()));
        temp_repo_with_base(base)
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
    fn worktree_list_reports_size_and_orphan_state() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "wl-1").unwrap();
        let b = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "wl-2").unwrap();
        std::fs::write(Path::new(&a.path).join("big.txt"), vec![b'x'; 4096]).unwrap();

        let list = worktree_list(&t.wt_root, &[a.path.clone()]);
        assert_eq!(list.len(), 2);
        let claimed = list.iter().find(|e| e.path == a.path).unwrap();
        let orphan = list.iter().find(|e| e.path == b.path).unwrap();
        assert!(!claimed.orphan, "a claimed worktree is not an orphan");
        assert!(orphan.orphan, "an unclaimed worktree is reapable");
        assert!(claimed.bytes > 4096, "size includes the checkout + the 4KB file");
        assert_eq!(claimed.branch, "flightdeck/wl-1");
        assert!(list[0].bytes >= list[1].bytes, "sorted biggest first");
    }

    #[test]
    fn branch_context_lists_commits_and_base_drift() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "bc-1").unwrap();
        let wt = Path::new(&a.path);
        std::fs::write(wt.join("f1.txt"), "one
").unwrap();
        sh(wt, &["add", "-A"]);
        sh(wt, &["commit", "-m", "agent: first"]);
        std::fs::write(wt.join("f2.txt"), "two
").unwrap();
        sh(wt, &["add", "-A"]);
        sh(wt, &["commit", "-m", "agent: second"]);

        let ctx = branch_context(wt, Some("main")).unwrap();
        assert_eq!(ctx.commits.len(), 2, "both agent commits are ahead of base");
        assert_eq!(ctx.commits[0].subject, "agent: second", "newest first");
        assert_eq!(ctx.base_ahead, 0);
        assert_eq!(ctx.branch, "flightdeck/bc-1");

        // Base moves on -> drift is reported.
        std::fs::write(t.repo.join("main-only.txt"), "x
").unwrap();
        sh(&t.repo, &["add", "-A"]);
        sh(&t.repo, &["commit", "-m", "main moved"]);
        assert_eq!(branch_context(wt, Some("main")).unwrap().base_ahead, 1);
    }

    #[test]
    fn update_from_base_merges_then_reports_conflict() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "uf-1").unwrap();
        let wt = Path::new(&a.path);
        // Non-conflicting base commit merges in cleanly.
        std::fs::write(t.repo.join("newfile.txt"), "base
").unwrap();
        sh(&t.repo, &["add", "-A"]);
        sh(&t.repo, &["commit", "-m", "base work"]);
        let m = update_from_base(&t.wt_root, &a.path).unwrap();
        assert_eq!(m.status, "merged", "{}", m.detail);
        assert!(wt.join("newfile.txt").exists(), "base commit landed in the worktree");

        // Now make both sides touch the same file -> conflict, worktree intact.
        std::fs::write(wt.join("a.txt"), "agent version
").unwrap();
        sh(wt, &["commit", "-am", "agent edit"]);
        std::fs::write(t.repo.join("a.txt"), "base version
").unwrap();
        sh(&t.repo, &["commit", "-am", "base edit"]);
        let c = update_from_base(&t.wt_root, &a.path).unwrap();
        assert_eq!(c.status, "conflict");
        assert_eq!(c.conflict_files, vec!["a.txt".to_string()]);
        let st = git(wt, &["status", "--porcelain"]).unwrap();
        assert!(st.stdout.trim().is_empty(), "worktree left dirty after abort: {}", st.stdout);
    }

    #[test]
    fn repo_web_url_strips_the_compare_suffix() {
        // Exercises the same derivation git_repo_web_url performs.
        let cases = [
            ("git@github.com:balu/flightdeck.git", "https://github.com/balu/flightdeck"),
            ("https://gitlab.com/team/app.git", "https://gitlab.com/team/app"),
            ("https://bitbucket.org/team/app.git", "https://bitbucket.org/team/app"),
        ];
        for (remote, want) in cases {
            let url = compare_url(remote, "main", "main").unwrap();
            let root = ["/compare/", "/-/merge_requests/", "/pull-requests/"]
                .iter()
                .find_map(|m| url.find(m).map(|i| url[..i].to_string()))
                .unwrap();
            assert_eq!(root, want);
        }
        assert!(compare_url("D:/local/bare", "main", "main").is_none());
    }

    #[test]
    fn compare_url_recognises_hosts_and_encodes_branches() {
        assert_eq!(
            compare_url("git@github.com:balu/flightdeck.git", "main", "flightdeck/p1").as_deref(),
            Some("https://github.com/balu/flightdeck/compare/main...flightdeck/p1?expand=1")
        );
        assert_eq!(
            compare_url("https://github.com/balu/flightdeck", "main", "fd/x").as_deref(),
            Some("https://github.com/balu/flightdeck/compare/main...fd/x?expand=1")
        );
        let gl = compare_url("ssh://git@gitlab.example.com/team/app.git", "main", "flightdeck/p1").unwrap();
        assert!(gl.starts_with("https://gitlab.example.com/team/app/-/merge_requests/new?"));
        assert!(gl.contains("source_branch%5D=flightdeck%2Fp1"), "{gl}");
        let bb = compare_url("https://bitbucket.org/team/app.git", "dev", "fd/y").unwrap();
        assert!(bb.contains("pull-requests/new?source=fd%2Fy&dest=dev"));
        assert_eq!(compare_url("D:\\some\\local\\bare", "main", "b"), None);
        assert_eq!(compare_url("https://example.com/owner/repo", "main", "b"), None);
    }

    #[test]
    fn commit_url_for_recognises_hosts() {
        assert_eq!(
            commit_url_for("git@github.com:balu/flightdeck.git", "abc1234").as_deref(),
            Some("https://github.com/balu/flightdeck/commit/abc1234")
        );
        assert_eq!(
            commit_url_for("https://gitlab.example.com/team/app.git", "deadbee").as_deref(),
            Some("https://gitlab.example.com/team/app/-/commit/deadbee")
        );
        assert_eq!(
            commit_url_for("https://bitbucket.org/team/app.git", "f00ba12").as_deref(),
            Some("https://bitbucket.org/team/app/commits/f00ba12")
        );
        assert_eq!(commit_url_for("D:/local/bare", "abc1234"), None);
        assert_eq!(commit_url_for("https://example.com/owner/repo", "abc1234"), None);
    }

    #[test]
    fn pr_handoff_pushes_branch_to_origin() {
        let t = temp_repo();
        // Local bare origin — push works, URL is None (unrecognised remote).
        let bare = t.wt_root.join("origin.git");
        sh(&t.repo, &["init", "--bare", &bare.to_string_lossy()]);
        sh(&t.repo, &["remote", "add", "origin", &bare.to_string_lossy()]);

        let wt = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "pr1").unwrap();
        std::fs::write(Path::new(&wt.path).join("new.txt"), "agent work\n").unwrap();

        let out = pr_handoff(&t.wt_root, &wt.path).unwrap();
        assert_eq!(out.status, "pushed", "{}", out.detail);
        assert!(out.url.is_none());
        // The branch (with the auto-commit) must exist on the origin.
        let ls = git(&t.repo, &["ls-remote", "--heads", "origin", &wt.branch]).unwrap();
        assert!(ls.stdout.contains(&wt.branch), "branch not on origin: {}", ls.stdout);

        // Second run with nothing new: still "pushed" (idempotent) or nothing-to-push
        // after the first landed? Nothing further committed, branch already ahead —
        // handoff pushes an up-to-date branch fine.
        let again = pr_handoff(&t.wt_root, &wt.path).unwrap();
        assert_eq!(again.status, "pushed");
    }

    #[test]
    fn pr_handoff_without_remote_reports_no_remote() {
        let t = temp_repo();
        let wt = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "pr2").unwrap();
        std::fs::write(Path::new(&wt.path).join("w.txt"), "x\n").unwrap();
        let out = pr_handoff(&t.wt_root, &wt.path).unwrap();
        assert_eq!(out.status, "no-remote");
    }

    // --- UX-597: graceful degradation when the folder isn't a repo ---------

    #[test]
    fn explain_git_failure_recognises_not_a_repo() {
        let msg = explain_git_failure(
            "git diff failed",
            "fatal: not a git repository (or any of the parent directories): .git",
        );
        assert_eq!(msg, "git diff failed: this folder isn't a git repository.");
    }

    #[test]
    fn explain_git_failure_falls_back_to_raw_detail() {
        let msg = explain_git_failure("git commit failed", "some unrecognised git stderr");
        assert_eq!(msg, "git commit failed: some unrecognised git stderr");
    }

    #[test]
    fn explain_git_failure_handles_empty_stderr_without_a_blank_message() {
        let msg = explain_git_failure("git push failed", "");
        assert_eq!(msg, "git push failed: git reported no further detail.");
    }

    #[test]
    fn diff_summary_on_non_repo_dir_is_a_typed_error_not_a_panic() {
        let non_repo = std::env::temp_dir().join(format!("fd-not-a-repo-{}", std::process::id()));
        std::fs::create_dir_all(&non_repo).unwrap();
        let err = diff_summary(&non_repo, None, false);
        match err {
            Err(msg) => assert!(msg.contains("git"), "the message must still say something about git: {msg}"),
            Ok(_) => panic!("a non-repo dir must be a typed error, not Ok garbage"),
        }
        let _ = std::fs::remove_dir_all(&non_repo);
    }

    #[test]
    fn file_diff_on_non_repo_dir_is_a_typed_error_not_a_panic() {
        let non_repo = std::env::temp_dir().join(format!("fd-not-a-repo-fd-{}", std::process::id()));
        std::fs::create_dir_all(&non_repo).unwrap();
        let err = file_diff(&non_repo, None, "whatever.txt", false);
        assert!(err.is_err());
        let _ = std::fs::remove_dir_all(&non_repo);
    }

    #[test]
    fn worktree_add_on_non_repo_dir_is_a_typed_error_not_a_panic() {
        let t = temp_repo(); // only its wt_root is used
        let non_repo = std::env::temp_dir().join(format!("fd-not-a-repo-wt-{}", std::process::id()));
        std::fs::create_dir_all(&non_repo).unwrap();
        let err = worktree_add(&t.wt_root, &non_repo.to_string_lossy(), "nope");
        match err {
            Err(msg) => assert!(msg.contains("not inside a git work tree"), "{msg}"),
            Ok(_) => panic!("a non-repo dir must be a typed error, not Ok garbage"),
        }
        let _ = std::fs::remove_dir_all(&non_repo);
    }

    #[test]
    fn branch_context_on_non_repo_dir_degrades_gracefully_not_a_panic() {
        let non_repo = std::env::temp_dir().join(format!("fd-not-a-repo-bc-{}", std::process::id()));
        std::fs::create_dir_all(&non_repo).unwrap();
        // No base: just resolves HEAD (empty), no error — a non-repo dir isn't
        // exceptional here, it just has nothing to report.
        let ctx = branch_context(&non_repo, None).unwrap();
        assert_eq!(ctx.branch, "");
        assert!(ctx.commits.is_empty());
        let _ = std::fs::remove_dir_all(&non_repo);
    }

    #[test]
    fn git_repo_web_url_on_non_repo_dir_returns_none_not_a_panic() {
        let non_repo = std::env::temp_dir().join(format!("fd-not-a-repo-url-{}", std::process::id()));
        std::fs::create_dir_all(&non_repo).unwrap();
        assert!(git_repo_web_url(non_repo.to_string_lossy().into_owned()).is_none());
        let _ = std::fs::remove_dir_all(&non_repo);
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
        let none = merge_back(&t.wt_root, &a.path, None).unwrap();
        assert_eq!(none.status, "nothing-to-merge");
        // Agent leaves uncommitted work (the common case) → auto-commit + merge:
        std::fs::write(Path::new(&a.path).join("feature.txt"), "done\n").unwrap();
        let m = merge_back(&t.wt_root, &a.path, None).unwrap();
        assert_eq!(m.status, "merged", "{}", m.detail);
        assert!(t.repo.join("feature.txt").exists(), "merge must land in the main checkout");
        // UX-578: the merge commit's hash is reported (no origin remote here,
        // so commit_url stays None — covered separately by commit_url_for's
        // own host-parsing tests below).
        let hash = m.merge_commit.expect("merged outcome must carry the merge commit hash");
        assert!(!hash.is_empty());
        let head = git_line(&t.repo, &["rev-parse", "--short", "HEAD"]).unwrap().unwrap();
        assert_eq!(hash, head);
        assert!(m.commit_url.is_none(), "no origin remote — no commit_url to derive");
    }

    #[test]
    fn merge_back_partial_selection_lands_subset_and_preserves_rest() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "pm-1").unwrap();
        let wt = Path::new(&a.path);
        // Selected: a modification to a tracked file + a brand new untracked file.
        std::fs::write(wt.join("a.txt"), "changed\n").unwrap();
        std::fs::write(wt.join("landed.txt"), "land me\n").unwrap();
        // Unselected: another untracked file the agent is still mid-way through.
        std::fs::write(wt.join("wip.txt"), "still cooking\n").unwrap();

        let m = merge_back(&t.wt_root, &a.path, Some(&["a.txt".to_string(), "landed.txt".to_string()])).unwrap();
        assert_eq!(m.status, "merged", "{}", m.detail);

        // Only the selected paths reached the base branch. (Windows core.autocrlf
        // may translate LF to CRLF on checkout, so compare trimmed.)
        assert_eq!(std::fs::read_to_string(t.repo.join("a.txt")).unwrap().trim_end(), "changed");
        assert!(t.repo.join("landed.txt").exists());
        assert!(!t.repo.join("wip.txt").exists(), "unselected file must not land in the base branch");

        // The unselected work SURVIVES, uncommitted, in the worktree — the
        // agent can pick straight back up on it.
        assert_eq!(std::fs::read_to_string(wt.join("wip.txt")).unwrap().trim_end(), "still cooking");
        let st = git(wt, &["status", "--porcelain"]).unwrap();
        assert!(st.stdout.contains("wip.txt"), "unselected file must remain uncommitted: {}", st.stdout);
    }

    #[test]
    fn merge_back_partial_selection_handles_deletions() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "pm-2").unwrap();
        let wt = Path::new(&a.path);
        std::fs::remove_file(wt.join("a.txt")).unwrap(); // selected deletion
        std::fs::write(wt.join("also.txt"), "leave me\n").unwrap(); // unselected addition

        let m = merge_back(&t.wt_root, &a.path, Some(&["a.txt".to_string()])).unwrap();
        assert_eq!(m.status, "merged", "{}", m.detail);
        assert!(!t.repo.join("a.txt").exists(), "the deletion must land in the base branch");
        assert!(!t.repo.join("also.txt").exists(), "unselected addition must not land");
        assert!(wt.join("also.txt").exists(), "unselected file must survive in the worktree");
    }

    #[test]
    fn merge_back_partial_selection_conflict_aborts_cleanly() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "pm-3").unwrap();
        let wt = Path::new(&a.path);
        std::fs::write(wt.join("a.txt"), "worktree version\n").unwrap(); // selected, will conflict
        std::fs::write(wt.join("safe.txt"), "unselected work\n").unwrap(); // unselected
        std::fs::write(t.repo.join("a.txt"), "main version\n").unwrap();
        sh(&t.repo, &["commit", "-am", "diverge"]);

        let m = merge_back(&t.wt_root, &a.path, Some(&["a.txt".to_string()])).unwrap();
        assert_eq!(m.status, "conflict");
        assert_eq!(m.conflict_files, vec!["a.txt".to_string()]);
        let st = git(&t.repo, &["status", "--porcelain"]).unwrap();
        assert!(st.stdout.trim().is_empty(), "base left dirty after abort: {}", st.stdout);
        // Branch intact and the unselected file is still sitting, uncommitted,
        // in the worktree — a conflict on the selected subset must not touch it.
        let ok = git(&t.repo, &["rev-parse", "--verify", "flightdeck/pm-3"]).unwrap();
        assert!(ok.ok());
        assert_eq!(std::fs::read_to_string(wt.join("safe.txt")).unwrap(), "unselected work\n");
    }

    #[test]
    fn merge_back_empty_selection_is_nothing_to_merge() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "pm-4").unwrap();
        std::fs::write(Path::new(&a.path).join("x.txt"), "x\n").unwrap();
        let m = merge_back(&t.wt_root, &a.path, Some(&[])).unwrap();
        assert_eq!(m.status, "nothing-to-merge");
        assert!(!t.repo.join("x.txt").exists());
        // Nothing was committed — the file is still sitting there uncommitted.
        let st = git(Path::new(&a.path), &["status", "--porcelain"]).unwrap();
        assert!(st.stdout.contains("x.txt"));
    }

    #[test]
    fn merge_conflict_aborts_cleanly() {
        let t = temp_repo();
        let a = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "mc-1").unwrap();
        std::fs::write(Path::new(&a.path).join("a.txt"), "worktree version\n").unwrap();
        std::fs::write(t.repo.join("a.txt"), "main version\n").unwrap();
        sh(&t.repo, &["commit", "-am", "diverge"]);
        let m = merge_back(&t.wt_root, &a.path, None).unwrap();
        assert_eq!(m.status, "conflict");
        // UI-5: the conflicted file is reported by name.
        assert_eq!(m.conflict_files, vec!["a.txt".to_string()]);
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
        let m = merge_back(&t.wt_root, &a.path, None).unwrap();
        assert_eq!(m.status, "dirty-base");
        sh(&t.repo, &["checkout", "--", "a.txt"]);
        sh(&t.repo, &["checkout", "-b", "elsewhere"]);
        let m2 = merge_back(&t.wt_root, &a.path, None).unwrap();
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

    // --- UX-593: long-path and unicode-path handling ------------------------
    //
    // Our OWN generated paths (worktree dirs under <app-data>/worktrees) are
    // already kept short by design (D1, repo_hash truncated to 12 hex chars +
    // a slug capped at 32 chars) — that's the real mitigation for MAX_PATH.
    // What we don't control is the REPO path the user hands us: it can be
    // arbitrarily deep (OneDrive sync trees, nested monorepos) and can contain
    // unicode/spaces (a user's actual display name, a project named in their
    // own language). These tests exercise both against the real toolchain.

    #[test]
    fn unicode_and_spaced_repo_path_works_end_to_end() {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!("fd wt tëst 日本語 ключ {}-{n}", std::process::id()));
        let t = temp_repo_with_base(base);

        let top = toplevel(&t.repo).expect("unicode/spaced repo path must resolve");
        assert_eq!(Path::new(&top).canonicalize().unwrap(), t.repo.canonicalize().unwrap());

        let wt = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), "unicode-1").unwrap();
        std::fs::write(Path::new(&wt.path).join("f.txt"), "hello\n").unwrap();
        let sum = diff_summary(Path::new(&wt.path), Some(&wt.base_branch), true).unwrap();
        let paths: Vec<&str> = sum.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"f.txt"), "diff must see the new file: {paths:?}");

        let m = merge_back(&t.wt_root, &wt.path, None).unwrap();
        assert_eq!(m.status, "merged", "{}", m.detail);
        assert!(t.repo.join("f.txt").exists(), "merge must land in a unicode/spaced base repo");
    }

    /// Windows' classic Win32 MAX_PATH (260 chars) is a genuine OS-level
    /// constraint: without the machine-wide "Enable Win32 long paths" policy
    /// AND (for some APIs) an app manifest that opts in, a path this deep can
    /// fail to even be created by ordinary (non `\\?\`-prefixed) calls — which
    /// is exactly what `std::fs::create_dir_all` and `git`/PowerShell/cmd use.
    /// This is NOT something Flightdeck can paper over from inside a single
    /// repo-path helper; it's characterised here rather than "fixed", per the
    /// backlog note to document what Windows genuinely cannot do. Confirmed
    /// against this exact toolchain (git-bash and PowerShell both refuse to
    /// even `cd`/`Set-Location` into an equivalently deep path on this
    /// machine) — the assertion below is deliberately permissive: whichever
    /// way it goes, it must be a clean Option/Result, never a panic.
    #[test]
    fn deep_path_near_win32_max_path_fails_cleanly_not_a_panic() {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let mut base = std::env::temp_dir().join(format!("fd-deep-{}-{n}", std::process::id()));
        while base.as_os_str().len() < 280 {
            base = base.join("nested-segment-abcdefgh-0123456789");
        }
        if std::fs::create_dir_all(&base).is_err() {
            // Couldn't even create the dir on this machine — also a
            // documented limitation, also nothing further to prove here.
            return;
        }
        // PROVEN on this machine (not assumed): std::fs::create_dir_all
        // handles a path this deep, but spawning git.exe as a CHILD PROCESS
        // with that dir as its cwd hits Win32's CreateProcessW, whose
        // lpCurrentDirectory does NOT get the same `\\?\` long-path treatment
        // file APIs get — it fails with "the directory name is invalid" (os
        // error 267). That's a real Windows limitation this codebase cannot
        // paper over: a deeply-nested repo (an aggressive OneDrive sync tree,
        // say) will fail to launch git on an unpatched Windows install, full
        // stop. The obligation is that the failure is CLEAN — a typed Err
        // with an actionable message — never a panic. Tested against `git()`
        // directly, not the `sh()` test helper (which `.unwrap()`s and would
        // turn this exact, expected failure into a false test panic).
        match git(&base, &["init", "-b", "main"]) {
            Ok(_) => {
                // Long paths are enabled on this machine: fine, just confirm
                // the rest of the chain doesn't panic either.
                let _ = toplevel(&base);
            }
            Err(msg) => assert!(!msg.is_empty(), "a failure must still carry a message the UI can show"),
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn worktree_dirs_we_generate_stay_short_regardless_of_repo_depth() {
        // D1's actual mitigation: OUR worktree path is always
        // <wt_root>/<12-hex-hash>/<slug≤32>, independent of how deep the
        // user's own repo lives — so this is the piece we can and do
        // guarantee, verified directly rather than just asserted in a comment.
        let t = temp_repo();
        let long_slug = "a".repeat(32); // slug isn't length-capped by worktree_add itself,
        // but callers (worktrees.ts newSlug) cap it at 32 — verify our own
        // generated segment count/shape stays short even at that cap.
        let wt = worktree_add(&t.wt_root, &t.repo.to_string_lossy(), &long_slug).unwrap();
        let rel = Path::new(&wt.path).strip_prefix(&t.wt_root).unwrap();
        let mut components = rel.components();
        let hash_component = components.next().unwrap().as_os_str().to_string_lossy().into_owned();
        let slug_component = components.next().unwrap().as_os_str().to_string_lossy().into_owned();
        assert_eq!(hash_component.len(), 12, "repo hash segment must stay fixed-width");
        assert!(slug_component.len() <= 32, "slug segment must not balloon the path");
        assert!(components.next().is_none(), "no extra nesting beyond hash/slug");
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
