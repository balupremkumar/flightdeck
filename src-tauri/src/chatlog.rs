// Phase 3 chat view backend (C2b env, C3a session pinning, C3b incremental reader).
//
// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<cwd-slug>/<session-id>.jsonl. This module:
//   * decides the per-spawn session args/env (pure, unit-tested),
//   * tells the frontend which session a pane is running (pinned via
//     `--session-id`, or resolved by watching the slug dir),
//   * tails that file incrementally and reduces each line to compact
//     `ChatRecord`s. Every command is async + spawn_blocking so a big file can
//     never stall the main thread (and with it every pane).
//
// `ChatRecord.index` is the BYTE OFFSET of the source line. It is stable across
// incremental reads (no line counting needed) and lets `session_record` seek
// straight to the line for on-demand expansion.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::Registry;

const MAX_RECORDS_CAP: u32 = 500;
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
const TEXT_CAP: usize = 8 * 1024;
const RESULT_SUMMARY_CAP: usize = 300;
const SUMMARY_CAP: usize = 300;

// ---------------------------------------------------------------------------
// C2b: env for the claude vendor.
// ---------------------------------------------------------------------------

/// Env vars set on a claude spawn. Default keeps Claude in the normal screen
/// buffer (so xterm scrollback works); focus mode opts in to its fullscreen
/// renderer instead.
pub fn claude_env(focus_mode: bool) -> &'static [(&'static str, &'static str)] {
    if focus_mode {
        &[("CLAUDE_CODE_NO_FLICKER", "1"), ("CLAUDE_CODE_DISABLE_MOUSE", "1")]
    } else {
        &[("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1")]
    }
}

// ---------------------------------------------------------------------------
// C3a: session pinning.
// ---------------------------------------------------------------------------

/// Per-pane session knowledge, held on `Pane`.
#[derive(Clone, Debug, Default)]
pub struct SessionState {
    pub session_id: Option<String>,
    pub pinned: bool,
    /// Resolve by watching the slug dir for a JSONL created after spawn.
    pub needs_resolve: bool,
    pub spawn_ms: u64,
    pub cwd: String,
}

/// What `plan_session` decided for one spawn.
#[derive(Debug, PartialEq)]
pub struct SessionPlan {
    pub extra_args: Vec<String>,
    pub session_id: Option<String>,
    pub pinned: bool,
    pub needs_resolve: bool,
}

/// `staged` = the resume/fork args from usage.rs take_launch_args (empty for a
/// fresh launch). Non-claude vendors get no session at all.
pub fn plan_session(vendor: &str, staged: &[String], new_id: &str) -> SessionPlan {
    if vendor != "claude" {
        return SessionPlan { extra_args: staged.to_vec(), session_id: None, pinned: false, needs_resolve: false };
    }
    let fork = staged.iter().any(|a| a == "--fork-session");
    let resume = staged
        .iter()
        .position(|a| a == "--resume" || a == "-r")
        .and_then(|i| staged.get(i + 1))
        .filter(|v| !v.starts_with('-'))
        .cloned();
    match (resume, fork) {
        // Fork: the new id is unknown until its JSONL appears.
        (Some(_), true) => SessionPlan { extra_args: staged.to_vec(), session_id: None, pinned: false, needs_resolve: true },
        (Some(id), false) => SessionPlan { extra_args: staged.to_vec(), session_id: Some(id), pinned: true, needs_resolve: false },
        // Some other staged shape (--continue, bare --resume): do not guess.
        _ if !staged.is_empty() => SessionPlan { extra_args: staged.to_vec(), session_id: None, pinned: false, needs_resolve: true },
        _ => SessionPlan {
            extra_args: vec!["--session-id".into(), new_id.into()],
            session_id: Some(new_id.into()),
            pinned: true,
            needs_resolve: false,
        },
    }
}

/// Random v4 UUID without a new dependency: std's RandomState is OS-seeded per
/// instance, so hashing a counter+time through two fresh states gives 128 bits.
pub fn new_uuid_v4() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
    let mut b = [0u8; 16];
    for (i, chunk) in b.chunks_mut(8).enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(t ^ (i as u64));
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

pub fn projects_root() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").ok()?;
    Some(Path::new(&home).join(".claude").join("projects"))
}

fn file_birth_ms(p: &Path) -> Option<u64> {
    let m = std::fs::metadata(p).ok()?;
    let t = m.created().or_else(|_| m.modified()).ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Newest JSONL in the cwd's slug dir created at/after `since_ms`.
pub fn newest_jsonl_since(projects_root: &Path, cwd: &str, since_ms: u64) -> Option<PathBuf> {
    let dir = projects_root.join(crate::usage::slugify(cwd));
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .filter_map(|p| file_birth_ms(&p).map(|t| (t, p)))
        .filter(|(t, _)| *t >= since_ms)
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SessionInfo {
    pub session_id: Option<String>,
    pub pinned: bool,
    pub jsonl_path: Option<String>,
}

fn info_from(state: &SessionState, root: &Path) -> SessionInfo {
    let jsonl_path = state.session_id.as_ref().and_then(|id| {
        let p = root.join(crate::usage::slugify(&state.cwd)).join(format!("{id}.jsonl"));
        p.is_file().then(|| p.to_string_lossy().into_owned())
    });
    SessionInfo { session_id: state.session_id.clone(), pinned: state.pinned, jsonl_path }
}

/// Resolve an unknown session (fork / fallback) by polling, bounded.
fn resolve_blocking(state: &mut SessionState, root: &Path, budget: Duration) {
    let start = std::time::Instant::now();
    loop {
        if let Some(p) = newest_jsonl_since(root, &state.cwd, state.spawn_ms) {
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if is_uuid(stem) {
                    state.session_id = Some(stem.to_string());
                    state.needs_resolve = false;
                    return;
                }
            }
        }
        if start.elapsed() >= budget {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[tauri::command]
pub async fn pane_session_info(app: AppHandle, pty_id: u32) -> Result<SessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let reg = app.state::<Registry>();
        let mut state = {
            let panes = reg.panes.lock().unwrap();
            let st = panes.get(&pty_id).ok_or_else(|| "no such pane".to_string())?.session.lock().unwrap().clone();
            st
        };
        let root = projects_root().ok_or_else(|| "USERPROFILE not set".to_string())?;
        if state.needs_resolve && state.session_id.is_none() {
            resolve_blocking(&mut state, &root, Duration::from_secs(3));
            if let Some(p) = reg.panes.lock().unwrap().get(&pty_id) {
                *p.session.lock().unwrap() = state.clone();
            }
        }
        Ok(info_from(&state, &root))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// C3b: incremental reader.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ToolInfo {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub paths: Vec<String>,
    pub added: u32,
    pub removed: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ToolResultInfo {
    pub tool_use_id: String,
    pub is_error: bool,
    pub summary: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ChatRecord {
    /// Byte offset of the source JSONL line (pass to `session_record`).
    pub index: u64,
    /// Content block within that line (one line can yield several records).
    pub block: u32,
    pub uuid: Option<String>,
    pub parent_uuid: Option<String>,
    pub timestamp: Option<String>,
    /// "user" | "assistant_text" | "tool_use" | "tool_result" | "system" | "other"
    pub kind: &'static str,
    pub sidechain: bool,
    pub text: Option<String>,
    pub tool: Option<ToolInfo>,
    pub result: Option<ToolResultInfo>,
}

#[derive(Serialize, Debug)]
pub struct TailResult {
    pub records: Vec<ChatRecord>,
    pub next_offset: u64,
    pub truncated: bool,
}

fn trunc(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    s[..i].to_string()
}

fn first_line(s: &str, max: usize) -> String {
    trunc(s.lines().next().unwrap_or("").trim_end(), max)
}

fn line_count(s: &str) -> u32 {
    s.lines().count() as u32
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

fn tool_info(block: &Value) -> ToolInfo {
    let name = str_of(block, "name").unwrap_or("").to_string();
    let id = str_of(block, "id").unwrap_or("").to_string();
    let input = block.get("input").cloned().unwrap_or(Value::Null);
    let s = |k: &str| str_of(&input, k).map(String::from);
    let mut paths: Vec<String> = Vec::new();
    for k in ["file_path", "notebook_path", "path"] {
        if let Some(p) = s(k).filter(|p| !p.is_empty()) {
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
    }
    let (mut added, mut removed) = (0u32, 0u32);
    match name.as_str() {
        "Edit" => {
            removed = line_count(str_of(&input, "old_string").unwrap_or(""));
            added = line_count(str_of(&input, "new_string").unwrap_or(""));
        }
        "MultiEdit" => {
            for e in input.get("edits").and_then(|e| e.as_array()).into_iter().flatten() {
                removed += line_count(str_of(e, "old_string").unwrap_or(""));
                added += line_count(str_of(e, "new_string").unwrap_or(""));
            }
        }
        "Write" => added = line_count(str_of(&input, "content").unwrap_or("")),
        _ => {}
    }
    let summary = match name.as_str() {
        "Bash" => s("command"),
        "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => s("file_path").or_else(|| s("notebook_path")),
        "Grep" | "Glob" => s("pattern"),
        "WebFetch" => s("url"),
        "Task" | "Agent" => s("description"),
        _ => None,
    }
    .or_else(|| s("description"))
    .or_else(|| s("file_path"))
    .or_else(|| s("command"))
    .or_else(|| s("pattern"))
    .or_else(|| s("url"))
    .map(|x| first_line(&x, SUMMARY_CAP))
    .unwrap_or_default();
    ToolInfo { id, name, summary, paths, added, removed }
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| if str_of(b, "type") == Some("text") { str_of(b, "text") } else { None })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Reduce one parsed JSONL line to records. Pure.
pub fn reduce_line(index: u64, v: &Value) -> Vec<ChatRecord> {
    let ty = str_of(v, "type").unwrap_or("");
    let base = |kind: &'static str| ChatRecord {
        index,
        block: 0,
        uuid: str_of(v, "uuid").map(String::from),
        parent_uuid: str_of(v, "parentUuid").map(String::from),
        timestamp: str_of(v, "timestamp").map(String::from),
        kind,
        sidechain: v.get("isSidechain").and_then(|x| x.as_bool()).unwrap_or(false),
        text: None,
        tool: None,
        result: None,
    };
    let mut out: Vec<ChatRecord> = Vec::new();
    match ty {
        "user" | "assistant" => {
            let content = v.get("message").and_then(|m| m.get("content"));
            let text_kind = if ty == "user" { "user" } else { "assistant_text" };
            match content {
                Some(Value::String(s)) => {
                    let mut r = base(text_kind);
                    r.text = Some(trunc(s, TEXT_CAP));
                    out.push(r);
                }
                Some(Value::Array(blocks)) => {
                    for b in blocks {
                        let mut r = match str_of(b, "type") {
                            Some("text") => {
                                let mut r = base(text_kind);
                                r.text = Some(trunc(str_of(b, "text").unwrap_or(""), TEXT_CAP));
                                r
                            }
                            Some("tool_use") => {
                                let mut r = base("tool_use");
                                r.tool = Some(tool_info(b));
                                r
                            }
                            Some("tool_result") => {
                                let mut r = base("tool_result");
                                r.result = Some(ToolResultInfo {
                                    tool_use_id: str_of(b, "tool_use_id").unwrap_or("").to_string(),
                                    is_error: b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false),
                                    summary: first_line(
                                        &result_text(b.get("content").unwrap_or(&Value::Null)),
                                        RESULT_SUMMARY_CAP,
                                    ),
                                });
                                r
                            }
                            // thinking, images, etc: nothing worth a chip.
                            _ => continue,
                        };
                        r.block = out.len() as u32;
                        out.push(r);
                    }
                }
                _ => {}
            }
            if out.is_empty() {
                out.push(base("other"));
            }
        }
        "system" => {
            let mut r = base("system");
            r.text = v.get("content").and_then(|c| c.as_str()).map(|s| trunc(s, TEXT_CAP));
            out.push(r);
        }
        _ => out.push(base("other")),
    }
    out
}

/// Core reader. `from_offset` must be a line start (as returned by a previous
/// call's `next_offset`, or 0).
pub fn tail_file(path: &Path, from_offset: u64, max_records: u32) -> Result<TailResult, String> {
    let max_records = max_records.clamp(1, MAX_RECORDS_CAP) as usize;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if from_offset > len {
        // File was replaced/truncated under us: nothing to read, resync to end.
        return Ok(TailResult { records: Vec::new(), next_offset: len, truncated: false });
    }
    f.seek(SeekFrom::Start(from_offset)).map_err(|e| e.to_string())?;
    let mut rd = BufReader::new(f);
    let mut records: Vec<ChatRecord> = Vec::new();
    let mut offset = from_offset;
    let mut truncated = false;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if offset - from_offset >= MAX_READ_BYTES || records.len() >= max_records {
            truncated = offset < len;
            break;
        }
        buf.clear();
        let n = (&mut rd).take(MAX_READ_BYTES + 1).read_until(b'\n', &mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let mut consumed = n as u64;
        let oversize = buf.len() as u64 > MAX_READ_BYTES;
        if oversize {
            // A line bigger than the read cap (inline screenshots): skip it
            // without parsing, still never consuming a partial line.
            let mut complete = buf.last() == Some(&b'\n');
            let mut sink: Vec<u8> = Vec::new();
            while !complete {
                sink.clear();
                let m = (&mut rd).take(MAX_READ_BYTES).read_until(b'\n', &mut sink).map_err(|e| e.to_string())?;
                if m == 0 {
                    break;
                }
                consumed += m as u64;
                complete = sink.last() == Some(&b'\n');
            }
            if !complete {
                break;
            }
            records.push(ChatRecord {
                index: offset,
                block: 0,
                uuid: None,
                parent_uuid: None,
                timestamp: None,
                kind: "other",
                sidechain: false,
                text: None,
                tool: None,
                result: None,
            });
            offset += consumed;
            continue;
        }
        if buf.last() != Some(&b'\n') {
            break; // partial trailing line: leave it for the next call
        }
        let produced = match serde_json::from_slice::<Value>(&buf) {
            Ok(v) => reduce_line(offset, &v),
            Err(_) => Vec::new(), // corrupt line: skip, keep going
        };
        if !records.is_empty() && records.len() + produced.len() > max_records {
            truncated = true;
            break;
        }
        records.extend(produced);
        offset += consumed;
    }
    Ok(TailResult { records, next_offset: offset, truncated })
}

/// Canonicalise and require the file to live under `root` and be a .jsonl.
pub fn check_under(root: &Path, path: &str) -> Result<PathBuf, String> {
    crate::pathguard::check(path)?;
    let p = Path::new(path);
    if p.extension().map(|x| x != "jsonl").unwrap_or(true) {
        return Err("not a session file".into());
    }
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("path outside the Claude projects directory".into());
    }
    Ok(canon)
}

fn guarded(path: &str) -> Result<PathBuf, String> {
    let root = projects_root().ok_or_else(|| "USERPROFILE not set".to_string())?;
    check_under(&root, path)
}

pub fn record_at(path: &Path, index: u64) -> Result<Value, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(index)).map_err(|e| e.to_string())?;
    let mut buf: Vec<u8> = Vec::new();
    BufReader::new(f).take(64 * 1024 * 1024).read_until(b'\n', &mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_tail(jsonl_path: String, from_offset: u64, max_records: u32) -> Result<TailResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = guarded(&jsonl_path)?;
        tail_file(&p, from_offset, max_records)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_record(jsonl_path: String, index: u64) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = guarded(&jsonl_path)?;
        record_at(&p, index)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fd-chatlog-{}-{}", name, new_uuid_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn line(v: Value) -> String {
        format!("{}\n", v)
    }

    fn user(text: &str) -> String {
        line(json!({"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00.000Z",
            "message":{"role":"user","content":[{"type":"text","text":text}]}}))
    }

    fn assistant_blocks(blocks: Value) -> String {
        line(json!({"parentUuid":"u1","isSidechain":false,"type":"assistant","uuid":"a1","timestamp":"2026-01-01T00:00:01.000Z",
            "message":{"role":"assistant","content":blocks}}))
    }

    #[test]
    fn env_per_focus_mode() {
        assert_eq!(claude_env(false), &[("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1")]);
        let f = claude_env(true);
        assert!(f.contains(&("CLAUDE_CODE_NO_FLICKER", "1")));
        assert!(f.contains(&("CLAUDE_CODE_DISABLE_MOUSE", "1")));
        assert!(!f.iter().any(|(k, _)| *k == "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"));
    }

    #[test]
    fn uuid_is_v4_shaped_and_unique() {
        let a = new_uuid_v4();
        let b = new_uuid_v4();
        assert!(is_uuid(&a));
        assert_eq!(a.as_bytes()[14], b'4');
        assert!(matches!(a.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(a, b);
    }

    #[test]
    fn fresh_claude_gets_session_id() {
        let p = plan_session("claude", &[], "11111111-1111-4111-8111-111111111111");
        assert_eq!(p.extra_args, vec!["--session-id", "11111111-1111-4111-8111-111111111111"]);
        assert_eq!(p.session_id.as_deref(), Some("11111111-1111-4111-8111-111111111111"));
        assert!(p.pinned && !p.needs_resolve);
    }

    #[test]
    fn resume_records_id_and_fork_resolves_later() {
        let resume: Vec<String> = vec!["--resume".into(), "abc".into()];
        let p = plan_session("claude", &resume, "new");
        assert_eq!(p.extra_args, resume);
        assert_eq!(p.session_id.as_deref(), Some("abc"));
        assert!(p.pinned);
        let fork: Vec<String> = vec!["--resume".into(), "abc".into(), "--fork-session".into()];
        let p = plan_session("claude", &fork, "new");
        assert_eq!(p.extra_args, fork);
        assert_eq!(p.session_id, None);
        assert!(!p.pinned && p.needs_resolve);
        assert!(!p.extra_args.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn non_claude_vendor_untouched() {
        let p = plan_session("pwsh", &[], "x");
        assert!(p.extra_args.is_empty() && p.session_id.is_none() && !p.pinned);
    }

    #[test]
    fn reduces_user_assistant_and_tools() {
        let mut s = String::new();
        s.push_str(&user("hello"));
        s.push_str(&assistant_blocks(json!([
            {"type":"thinking","thinking":""},
            {"type":"text","text":"on it"},
            {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la\nsecond"}},
            {"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"C:\\x\\a.ts"}},
        ])));
        s.push_str(&line(json!({"type":"user","uuid":"u2","isSidechain":true,"message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"boom\nmore"}]}]}})));
        s.push_str(&line(json!({"type":"mode","mode":"normal"})));
        let d = tmp("reduce");
        let f = d.join("s.jsonl");
        std::fs::write(&f, s).unwrap();
        let r = tail_file(&f, 0, 100).unwrap();
        let kinds: Vec<_> = r.records.iter().map(|x| x.kind).collect();
        assert_eq!(kinds, ["user", "assistant_text", "tool_use", "tool_use", "tool_result", "other"]);
        assert_eq!(r.records[2].tool.as_ref().unwrap().summary, "ls -la");
        assert_eq!(r.records[3].tool.as_ref().unwrap().paths, vec!["C:\\x\\a.ts"]);
        assert_eq!(r.records[1].block, 0);
        assert_eq!(r.records[2].block, 1);
        let res = r.records[4].result.as_ref().unwrap();
        assert!(res.is_error && res.summary == "boom" && res.tool_use_id == "t1");
        assert!(r.records[4].sidechain && !r.records[0].sidechain);
        assert_eq!(r.records[0].parent_uuid, None);
        assert_eq!(r.records[1].parent_uuid.as_deref(), Some("u1"));
        assert!(!r.truncated);
        assert_eq!(r.next_offset, std::fs::metadata(&f).unwrap().len());
    }

    #[test]
    fn diff_stats() {
        let t = |name: &str, input: Value| tool_info(&json!({"id":"i","name":name,"input":input}));
        let e = t("Edit", json!({"file_path":"f","old_string":"a\nb","new_string":"a\nb\nc\nd"}));
        assert_eq!((e.added, e.removed), (4, 2));
        let m = t("MultiEdit", json!({"file_path":"f","edits":[
            {"old_string":"x","new_string":"y\nz"},{"old_string":"p\nq","new_string":""}]}));
        assert_eq!((m.added, m.removed), (2, 3));
        let w = t("Write", json!({"file_path":"f","content":"1\n2\n3\n"}));
        assert_eq!((w.added, w.removed), (3, 0));
        let g = t("Grep", json!({"pattern":"foo.*","path":"src"}));
        assert_eq!((g.summary.as_str(), g.paths.clone()), ("foo.*", vec!["src".to_string()]));
        assert_eq!(t("WebFetch", json!({"url":"https://x.test"})).summary, "https://x.test");
        assert_eq!(t("Task", json!({"description":"scan repo","prompt":"long"})).summary, "scan repo");
    }

    #[test]
    fn text_truncated_to_8kb() {
        let long = "é".repeat(10_000);
        let r = reduce_line(0, &serde_json::from_str::<Value>(&user(&long)).unwrap());
        let t = r[0].text.as_ref().unwrap();
        assert!(t.len() <= TEXT_CAP && t.len() > TEXT_CAP - 4);
    }

    #[test]
    fn partial_trailing_line_waits_and_offsets_chain() {
        let d = tmp("partial");
        let f = d.join("s.jsonl");
        let l1 = user("one");
        let l2 = user("two");
        let mut file = std::fs::File::create(&f).unwrap();
        file.write_all(l1.as_bytes()).unwrap();
        file.write_all(&l2.as_bytes()[..10]).unwrap(); // partial
        file.flush().unwrap();
        let a = tail_file(&f, 0, 10).unwrap();
        assert_eq!(a.records.len(), 1);
        assert_eq!(a.next_offset, l1.len() as u64);
        // nothing new yet: same offset, no records
        let b = tail_file(&f, a.next_offset, 10).unwrap();
        assert!(b.records.is_empty());
        assert_eq!(b.next_offset, a.next_offset);
        file.write_all(&l2.as_bytes()[10..]).unwrap();
        file.flush().unwrap();
        let c = tail_file(&f, b.next_offset, 10).unwrap();
        assert_eq!(c.records.len(), 1);
        assert_eq!(c.records[0].index, l1.len() as u64);
        assert_eq!(c.next_offset, (l1.len() + l2.len()) as u64);
        // on-demand expansion by index
        let raw = record_at(&f, c.records[0].index).unwrap();
        assert_eq!(raw["message"]["content"][0]["text"], "two");
    }

    #[test]
    fn record_cap_and_truncated_flag() {
        let d = tmp("cap");
        let f = d.join("s.jsonl");
        std::fs::write(&f, (0..5).map(|i| user(&format!("m{i}"))).collect::<String>()).unwrap();
        let a = tail_file(&f, 0, 2).unwrap();
        assert_eq!(a.records.len(), 2);
        assert!(a.truncated);
        let b = tail_file(&f, a.next_offset, 2).unwrap();
        let c = tail_file(&f, b.next_offset, 2).unwrap();
        assert_eq!(c.records.len(), 1);
        assert!(!c.truncated);
        // max_records is clamped to 500, and 0 still makes progress.
        assert_eq!(tail_file(&f, 0, 0).unwrap().records.len(), 1);
        let big = tmp("cap500").join("s.jsonl");
        std::fs::write(&big, (0..600).map(|_| user("x")).collect::<String>()).unwrap();
        let r = tail_file(&big, 0, 10_000).unwrap();
        assert_eq!(r.records.len(), 500);
        assert!(r.truncated);
    }

    #[test]
    fn oversize_line_is_skipped_not_stuck() {
        let d = tmp("big");
        let f = d.join("s.jsonl");
        let huge = format!("{{\"type\":\"user\",\"pad\":\"{}\"}}\n", "z".repeat(MAX_READ_BYTES as usize + 100));
        std::fs::write(&f, format!("{}{}", huge, user("after"))).unwrap();
        // The skipped line spends the whole byte budget, so the next line
        // arrives on the following call (truncated tells the caller to loop).
        let r = tail_file(&f, 0, 10).unwrap();
        assert_eq!(r.records.len(), 1);
        assert_eq!(r.records[0].kind, "other");
        assert!(r.truncated);
        let r2 = tail_file(&f, r.next_offset, 10).unwrap();
        assert_eq!(r2.records[0].text.as_deref(), Some("after"));
        assert!(!r2.truncated);
    }

    #[test]
    fn corrupt_line_skipped_and_offset_past_eof_resyncs() {
        let d = tmp("corrupt");
        let f = d.join("s.jsonl");
        std::fs::write(&f, format!("not json\n{}", user("ok"))).unwrap();
        let r = tail_file(&f, 0, 10).unwrap();
        assert_eq!(r.records.len(), 1);
        let len = std::fs::metadata(&f).unwrap().len();
        let past = tail_file(&f, len + 50, 10).unwrap();
        assert!(past.records.is_empty());
        assert_eq!(past.next_offset, len);
    }

    #[test]
    fn path_must_be_under_projects_root() {
        let root = tmp("root");
        let inside = root.join("slug");
        std::fs::create_dir_all(&inside).unwrap();
        let ok = inside.join("a.jsonl");
        std::fs::write(&ok, "").unwrap();
        assert!(check_under(&root, ok.to_str().unwrap()).is_ok());
        let outside = tmp("outside").join("a.jsonl");
        std::fs::write(&outside, "").unwrap();
        assert!(check_under(&root, outside.to_str().unwrap()).is_err());
        // traversal out of the root
        let sneaky = format!("{}\\..\\..\\{}", inside.display(), outside.strip_prefix(outside.parent().unwrap().parent().unwrap()).unwrap().display());
        assert!(check_under(&root, &sneaky).is_err());
        // wrong extension, network path
        let txt = inside.join("a.txt");
        std::fs::write(&txt, "").unwrap();
        assert!(check_under(&root, txt.to_str().unwrap()).is_err());
        assert!(check_under(&root, r"\\server\share\a.jsonl").is_err());
    }

    #[test]
    fn newest_jsonl_since_ignores_older_files() {
        let root = tmp("since");
        let cwd = "D:\\proj";
        let dir = root.join(crate::usage::slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let old = "22222222-2222-4222-8222-222222222222";
        std::fs::write(dir.join(format!("{old}.jsonl")), "").unwrap();
        let after = file_birth_ms(&dir.join(format!("{old}.jsonl"))).unwrap() + 1;
        assert!(newest_jsonl_since(&root, cwd, after + 5_000).is_none());
        let mut st = SessionState { cwd: cwd.into(), spawn_ms: 0, needs_resolve: true, ..Default::default() };
        resolve_blocking(&mut st, &root, Duration::from_millis(0));
        assert_eq!(st.session_id.as_deref(), Some(old));
        assert!(!st.pinned);
        let info = info_from(&st, &root);
        assert!(info.jsonl_path.unwrap().ends_with(&format!("{old}.jsonl")));
    }
}
