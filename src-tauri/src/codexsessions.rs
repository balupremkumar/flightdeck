// codexsessions.rs: Codex CLI's past sessions (resume launcher, Phase C) and the
// "newest rollout for this folder" lookup the usage chip shares (Phase D).
//
// Codex writes one rollout per session at
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
// (default CODEX_HOME = ~/.codex). Unlike Claude's transcripts they are NOT
// slugged by cwd, so the folder is matched by the `cwd` in each file's first
// line (`session_meta`). Files older than about a week are compressed to
// `.jsonl.zst`; those are skipped (no zstd crate), so only recent sessions list.
//
// Sessions made in a worktree that has since been removed are listed under the
// cwd they were made in, so there is nothing to prune here (C4).
//
// The rollout format is Codex's internal one, not a documented contract. Every
// parse here is defensive: a line of unknown shape is skipped, never guessed at.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::usage::{clip, modified_ms, SessionSummary, LIST_CAP, TITLE_CHARS};

/// Most rollout files looked at per lookup (newest by file name first). Bounds
/// the walk for a user with a long history; the first line of each is cached.
const SCAN_CAP: usize = 400;
/// `session_meta` carries the full base instructions, so its line is long.
/// Anything beyond this is not a line we want to hold in memory.
const META_LINE_CAP: usize = 512 * 1024;
/// Lines read from the head of a rollout when looking for the first prompt.
const TITLE_LINES: usize = 400;

/// `$CODEX_HOME`, else `~/.codex`. Read only; Flightdeck never sets it.
pub fn codex_home() -> Option<PathBuf> {
    match std::env::var("CODEX_HOME") {
        Ok(h) if !h.trim().is_empty() => Some(PathBuf::from(h)),
        _ => std::env::var("USERPROFILE").ok().map(|h| PathBuf::from(h).join(".codex")),
    }
}

/// Canonical 8-4-4-4-12 hex UUID. The only shape ever staged as a resume id, so
/// it is safe to put in a pwsh -Command line unquoted.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Folder identity for comparing a pane cwd with a rollout's: case-insensitive,
/// slash-agnostic, no `\\?\` prefix, no trailing separator.
fn norm(p: &str) -> String {
    let s = p.trim().trim_start_matches(r"\\?\").replace('\\', "/").to_lowercase();
    s.trim_end_matches('/').to_string()
}

#[derive(Clone)]
struct Meta {
    id: String,
    cwd: String,
    branch: Option<String>,
}

fn meta_cache() -> &'static Mutex<HashMap<PathBuf, Option<Meta>>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, Option<Meta>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Id from `rollout-<timestamp>-<uuid>.jsonl`, the fallback when the meta line
/// has no usable id.
fn id_from_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    let tail = stem.get(stem.len().checked_sub(36)?..)?;
    is_uuid(tail).then(|| tail.to_string())
}

fn read_meta_uncached(path: &Path) -> Option<Meta> {
    let f = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(f).take(META_LINE_CAP as u64).read_line(&mut line).ok()?;
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let p = v.get("payload")?;
    let cwd = p.get("cwd").and_then(|c| c.as_str()).filter(|c| !c.is_empty())?.to_string();
    let id = p
        .get("id")
        .and_then(|i| i.as_str())
        .filter(|i| is_uuid(i))
        .map(str::to_string)
        .or_else(|| id_from_name(path))?;
    let branch = p
        .get("git")
        .and_then(|g| g.get("branch"))
        .and_then(|b| b.as_str())
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    Some(Meta { id, cwd, branch })
}

/// A rollout's first-line facts. Cached for good when readable (the first line
/// of a rollout never changes); a file that is still empty is retried next time.
fn read_meta(path: &Path) -> Option<Meta> {
    if let Some(hit) = meta_cache().lock().unwrap().get(path) {
        return hit.clone();
    }
    let m = read_meta_uncached(path);
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if m.is_some() || len > 0 {
        meta_cache().lock().unwrap().insert(path.to_path_buf(), m.clone());
    }
    m
}

fn numeric_dirs_desc(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<(u32, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_string_lossy().parse::<u32>().ok().map(|n| (n, e.path())))
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|(_, p)| p).collect()
}

/// Uncompressed rollout files, newest first by walk order (YYYY/MM/DD desc, then
/// file name desc, which embeds the start time). `.zst` and strays are skipped.
fn rollout_files(sessions_root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    'walk: for y in numeric_dirs_desc(sessions_root) {
        for m in numeric_dirs_desc(&y) {
            for d in numeric_dirs_desc(&m) {
                let Ok(rd) = std::fs::read_dir(&d) else { continue };
                let mut files: Vec<PathBuf> = rd
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| {
                        p.extension().map(|x| x == "jsonl").unwrap_or(false)
                            && p.file_name().map(|n| n.to_string_lossy().starts_with("rollout-")).unwrap_or(false)
                    })
                    .collect();
                files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for f in files {
                    out.push(f);
                    if out.len() >= SCAN_CAP {
                        break 'walk;
                    }
                }
            }
        }
    }
    out
}

/// Rollouts whose session_meta cwd is `cwd`, with their meta and mtime, most
/// recently written first. A resumed session appends to its original file, so
/// mtime (not the dated folder) decides which is newest.
fn matching(sessions_root: &Path, cwd: &str) -> Vec<(PathBuf, Meta, u64)> {
    let want = norm(cwd);
    let mut v: Vec<(PathBuf, Meta, u64)> = rollout_files(sessions_root)
        .into_iter()
        .filter_map(|p| {
            let m = read_meta(&p)?;
            (norm(&m.cwd) == want).then(|| {
                let ms = modified_ms(&p);
                (p, m, ms)
            })
        })
        .collect();
    v.sort_by(|a, b| b.2.cmp(&a.2));
    v
}

/// The rollout of the session this pane is (most likely) in. Shared with the
/// usage chip so the chip and the launcher agree on "newest".
pub fn newest_rollout(sessions_root: &Path, cwd: &str) -> Option<PathBuf> {
    matching(sessions_root, cwd).into_iter().next().map(|(p, _, _)| p)
}

/// Text of a user turn worth a title: not Codex's injected environment/AGENTS
/// context blocks, which arrive as user messages too.
fn real_prompt(t: &str) -> Option<String> {
    let t = t.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("# AGENTS.md") || t.starts_with("Caveat:") {
        return None;
    }
    Some(t.to_string())
}

/// First user message plus the latest model seen in the head of the file.
fn head_facts(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(f) = std::fs::File::open(path) else { return (None, None) };
    let mut prompt: Option<String> = None;
    let mut model: Option<String> = None;
    for line in BufReader::new(f).lines().take(TITLE_LINES).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let p = v.get("payload");
        match v.get("type").and_then(|t| t.as_str()) {
            Some("turn_context") => {
                if let Some(m) = p.and_then(|p| p.get("model")).and_then(|m| m.as_str()) {
                    model = Some(m.to_string());
                }
            }
            Some("event_msg") if prompt.is_none() => {
                let p = p;
                if p.and_then(|p| p.get("type")).and_then(|t| t.as_str()) == Some("user_message") {
                    prompt = p.and_then(|p| p.get("message")).and_then(|m| m.as_str()).and_then(real_prompt);
                }
            }
            Some("response_item") if prompt.is_none() => {
                if let Some(p) = p.filter(|p| {
                    p.get("type").and_then(|t| t.as_str()) == Some("message")
                        && p.get("role").and_then(|r| r.as_str()) == Some("user")
                }) {
                    let text = p
                        .get("content")
                        .and_then(|c| c.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    prompt = real_prompt(&text);
                }
            }
            _ => {}
        }
        if prompt.is_some() && model.is_some() {
            break;
        }
    }
    (prompt, model)
}

/// Past Codex sessions for `cwd`, newest first, capped at LIST_CAP. Empty (never
/// an error) when there is no sessions folder. Sessions with no user prompt yet
/// are not worth a row (and `codex resume` has nothing to resume there).
pub fn list_sessions(sessions_root: &Path, cwd: &str) -> Vec<SessionSummary> {
    let mut out = Vec::new();
    for (path, meta, ms) in matching(sessions_root, cwd) {
        let (prompt, model) = head_facts(&path);
        let Some(prompt) = prompt else { continue };
        out.push(SessionSummary {
            id: meta.id,
            modified_ms: ms,
            title: clip(&prompt, TITLE_CHARS),
            git_branch: meta.branch,
            model,
            turns: None,
            size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        });
        if out.len() >= LIST_CAP {
            break;
        }
    }
    out
}

#[tauri::command(async)]
pub fn list_codex_sessions(cwd: String) -> Vec<SessionSummary> {
    let Some(home) = codex_home() else { return Vec::new() };
    list_sessions(&home.join("sessions"), &cwd)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const ID_A: &str = "0199aaaa-1111-7222-8333-444455556666";
    pub const ID_B: &str = "0199bbbb-1111-7222-8333-444455556666";
    pub const ID_C: &str = "0199cccc-1111-7222-8333-444455556666";

    pub fn root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fd-codexsess-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    pub fn meta_line(id: &str, cwd: &str) -> String {
        serde_json::json!({
            "timestamp": "2026-10-03T01:02:03.000Z",
            "type": "session_meta",
            "payload": {
                "id": id, "timestamp": "2026-10-03T01:02:03.000Z", "cwd": cwd,
                "originator": "codex_cli_rs", "cli_version": "0.160.0", "source": "cli",
                "base_instructions": { "text": "x".repeat(20_000) },
                "git": { "commit_hash": "abc", "branch": "feat/x" }
            }
        })
        .to_string()
    }

    pub fn write_rollout(root: &Path, day: &str, id: &str, cwd: &str, body: &[String]) -> PathBuf {
        let dir = root.join(day);
        std::fs::create_dir_all(&dir).unwrap();
        let name = format!("rollout-{}T10-00-00-{}.jsonl", day.replace('/', "-"), id);
        let p = dir.join(name);
        let mut s = meta_line(id, cwd) + "\n";
        for l in body {
            s.push_str(l);
            s.push('\n');
        }
        std::fs::write(&p, s).unwrap();
        p
    }

    pub fn user_event(text: &str) -> String {
        serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":text}}).to_string()
    }

    #[test]
    fn uuid_validation() {
        assert!(is_uuid(ID_A));
        assert!(is_uuid("0199AAAA-1111-7222-8333-444455556666"));
        assert!(!is_uuid("0199aaaa-1111-7222-8333-44445555666"));
        assert!(!is_uuid("0199aaaa-1111-7222-8333-44445555666; calc"));
        assert!(!is_uuid("my session name"));
        assert!(!is_uuid(""));
    }

    #[test]
    fn lists_cwd_matches_newest_first_case_insensitive_and_skips_zst() {
        let r = root("list");
        let env_ctx = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user",
            "content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}).to_string();
        let real = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user",
            "content":[{"type":"input_text","text":"fix   the\nlogin bug"}]}}).to_string();
        let tc = serde_json::json!({"type":"turn_context","payload":{"model":"gpt-5-codex"}}).to_string();
        let old = write_rollout(&r, "2026/10/01", ID_A, r"C:\Dev\Repo", &[env_ctx, real, tc]);
        write_rollout(&r, "2026/10/03", ID_B, r"c:\dev\repo\", &[user_event("newer prompt")]);
        write_rollout(&r, "2026/10/03", ID_C, r"C:\Dev\Other", &[user_event("other folder")]);
        std::fs::write(r.join("2026/10/03").join(format!("rollout-2026-10-03T09-00-00-{ID_C}.jsonl.zst")), b"zst").unwrap();
        // Make the older file the most recently written: resumed sessions append in place.
        let f = std::fs::OpenOptions::new().append(true).open(&old).unwrap();
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60)).unwrap();

        let got = list_sessions(&r, r"C:\Dev\Repo");
        assert_eq!(got.len(), 2, "other folder and .zst excluded");
        assert_eq!(got[0].id, ID_A, "mtime decides newest");
        assert_eq!(got[0].title, "fix the login bug", "injected <environment_context> skipped, whitespace flattened");
        assert_eq!(got[0].model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(got[0].git_branch.as_deref(), Some("feat/x"));
        assert_eq!(got[1].id, ID_B);
        assert_eq!(got[1].title, "newer prompt");
        assert_eq!(newest_rollout(&r, "C:/dev/repo").unwrap(), old);
    }

    #[test]
    fn promptless_and_malformed_rollouts_are_skipped_and_missing_root_is_empty() {
        let r = root("skip");
        write_rollout(&r, "2026/10/02", ID_A, r"C:\Dev\Repo", &[]);
        let dir = r.join("2026/10/02");
        std::fs::write(dir.join(format!("rollout-2026-10-02T11-00-00-{ID_B}.jsonl")), "not json\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        assert!(list_sessions(&r, r"C:\Dev\Repo").is_empty());
        assert!(list_sessions(&r.join("nope"), r"C:\Dev\Repo").is_empty());
        assert!(newest_rollout(&r.join("nope"), "x").is_none());
    }
}
