// usage.rs — per-pane token usage (UI-3), read from Claude Code's own session
// transcripts: ~/.claude/projects/<cwd-slug>/<session>.jsonl, where assistant
// lines carry message.usage. Honest numbers only — an agent that writes no
// transcript (agy, shells) simply reports None and gets no chip. Files are
// read incrementally (offset per file) so polling a growing session is cheap.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PaneUsage {
    /// Prompt tokens of the latest turn (input + cache read + cache creation)
    /// — the live context size.
    pub context_tokens: u64,
    /// Cumulative output tokens across the session file.
    pub output_tokens: u64,
    /// Assistant turns seen.
    pub turns: u64,
    /// QL-766: model id of the most recent assistant message (`message.model`),
    /// e.g. "claude-opus-4-1-20250805". None until one has been seen.
    pub model: Option<String>,
    /// QL-765: the latest turn's usage split, straight from the same block the
    /// context total is summed from — no extra parsing, no estimates.
    pub last_input_tokens: u64,
    pub last_cache_read_tokens: u64,
    pub last_cache_creation_tokens: u64,
    pub last_output_tokens: u64,
}

/// Claude Code's project-dir slug: every non-alphanumeric byte becomes '-'
/// ("D:\Dev\ai" -> "D--Dev-ai").
fn slugify(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// First read of an already-huge transcript starts this far from the end —
/// cumulative counters undercount in that (rare) case, context stays exact.
const FIRST_READ_CAP: u64 = 8 * 1024 * 1024;

struct FileState {
    offset: u64,
    usage: PaneUsage,
    carry: String, // partial trailing line from the previous read
}

fn states() -> &'static Mutex<HashMap<PathBuf, FileState>> {
    static S: OnceLock<Mutex<HashMap<PathBuf, FileState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn apply_line(line: &str, u: &mut PaneUsage) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    apply_usage(&v, u);
}

/// The usage half of a transcript line, split out of `apply_line` so the
/// subagent scan (QL-769) can sum tokens from a line it has already parsed
/// instead of parsing it a second time. Behaviour is unchanged.
fn apply_usage(v: &serde_json::Value, u: &mut PaneUsage) {
    let Some(usage) = v.get("message").and_then(|m| m.get("usage")).filter(|u| u.is_object()) else { return };
    let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let context = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    if context == 0 && n("output_tokens") == 0 {
        return; // e.g. a synthetic/empty usage block
    }
    u.context_tokens = context;
    u.output_tokens += n("output_tokens");
    u.turns += 1;
    // QL-765: keep the latest turn's split for the chip's tooltip.
    u.last_input_tokens = n("input_tokens");
    u.last_cache_read_tokens = n("cache_read_input_tokens");
    u.last_cache_creation_tokens = n("cache_creation_input_tokens");
    u.last_output_tokens = n("output_tokens");
    // QL-766: last-seen model. Only overwritten when the line carries one, so a
    // usage block without a model can't blank an already-known value.
    if let Some(m) = v.get("message").and_then(|m| m.get("model")).and_then(|m| m.as_str()) {
        u.model = Some(m.to_string());
    }
}

fn scan(path: &Path) -> Option<PaneUsage> {
    let len = std::fs::metadata(path).ok()?.len();
    let mut map = states().lock().unwrap();
    let st = map.entry(path.to_path_buf()).or_insert_with(|| FileState {
        offset: if len > FIRST_READ_CAP { len - FIRST_READ_CAP } else { 0 },
        usage: PaneUsage::default(),
        carry: String::new(),
    });
    if len < st.offset {
        // Truncated/replaced — start over.
        *st = FileState { offset: 0, usage: PaneUsage::default(), carry: String::new() };
    }
    if len > st.offset {
        let mut f = std::fs::File::open(path).ok()?;
        f.seek(SeekFrom::Start(st.offset)).ok()?;
        let mut buf = Vec::with_capacity((len - st.offset) as usize);
        f.read_to_end(&mut buf).ok()?;
        st.offset = len;
        let chunk = st.carry.clone() + &String::from_utf8_lossy(&buf);
        let complete_up_to = chunk.rfind('\n').map(|i| i + 1).unwrap_or(0);
        for line in chunk[..complete_up_to].lines() {
            apply_line(line, &mut st.usage);
        }
        st.carry = chunk[complete_up_to..].to_string();
    }
    Some(st.usage.clone())
}

/// The transcript of the session this pane is (most likely) in: the most
/// recently written *.jsonl in the cwd's project dir. Shared by the token chip,
/// the subagent tree (QL-769) and the plan panel (QL-770) so all three always
/// describe the same session.
fn newest_transcript(projects_root: &Path, cwd: &str) -> Option<PathBuf> {
    let dir = projects_root.join(slugify(cwd));
    std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

/// Usage for the pane rooted at `cwd`, from the most recently written session
/// transcript in that cwd's project dir. None = no transcript (not a Claude
/// pane, or no session yet).
pub fn usage_for(projects_root: &Path, cwd: &str) -> Option<PaneUsage> {
    let newest = newest_transcript(projects_root, cwd)?;
    scan(&newest).filter(|u| u.turns > 0)
}

#[tauri::command]
pub fn pane_usage(cwd: String) -> Option<PaneUsage> {
    let home = std::env::var("USERPROFILE").ok()?;
    let root = Path::new(&home).join(".claude").join("projects");
    usage_for(&root, &cwd)
}

// ---------------------------------------------------------------------------
// QL-764: past-session index for the resume/fork launcher.
//
// Same transcripts the chip above reads, listed instead of summed: one row per
// ~/.claude/projects/<slug>/<session>.jsonl, newest first. The file stem IS the
// session id `claude --resume <id>` wants.
//
// Transcripts run to tens of megabytes, and the launcher opens on a keystroke,
// so a session is SAMPLED, never read whole: a head slice (where the title and
// first prompt live) and a tail slice (where the newest model + branch live).
//
// Turn count is therefore only reported for a file small enough to be read
// whole. Scaling the sample by bytes was tried and thrown out: a mature
// session's lines are an order of magnitude longer than its opening ones, so a
// 25 MB transcript with 547 turns estimated at ~3,800. The size is returned
// instead, and the UI says "25 MB transcript" rather than inventing a number.
// ---------------------------------------------------------------------------

/// Newest N sessions listed; older ones are noise in a picker.
const LIST_CAP: usize = 50;
/// Sample size per end. Sized so an ordinary session (well under 1 MB) is read
/// whole — and so gets an exact turn count — while the multi-megabyte monsters
/// still cost two seeks. Measured at ~90 ms for a 22-session folder totalling
/// 60 MB, which is inside a picker's opening animation.
const HEAD_BYTES: u64 = 512 * 1024;
const TAIL_BYTES: u64 = 512 * 1024;
/// Prompt/summary line shown in the picker.
const TITLE_CHARS: usize = 120;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    /// Session id = the transcript's file stem.
    pub id: String,
    /// Last-written time, epoch milliseconds.
    pub modified_ms: u64,
    /// Row label: Claude Code's own "ai-title" for the session if it has one,
    /// else a compaction summary, else the first real user prompt. Truncated.
    pub title: String,
    pub git_branch: Option<String>,
    pub model: Option<String>,
    /// Assistant turns, or None when the transcript was too big to read whole
    /// (see the note above — an estimate here would be fiction).
    pub turns: Option<u64>,
    /// Transcript size on disk, the honest stand-in for "how long is this one".
    pub size_bytes: u64,
}

fn read_slice(path: &Path, start: u64, len: usize) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0u8; len];
    let mut filled = 0usize;
    while filled < len {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    buf.truncate(filled);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Text of a user turn worth showing, or None for the entries that aren't a
/// person typing: meta/system lines, sidechain (sub-agent) turns, tool results,
/// and the `<command-name>`/`<local-command-stdout>` wrappers slash-commands
/// leave behind.
fn user_prompt_text(v: &serde_json::Value) -> Option<String> {
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
        return None;
    }
    if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
        return None;
    }
    Some(t.to_string())
}

/// One line, collapsed and clipped for a picker row.
fn clip(s: &str, chars: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= chars {
        return flat;
    }
    let cut: String = flat.chars().take(chars).collect();
    format!("{}…", cut.trim_end())
}

fn summarise(path: &Path, modified_ms: u64) -> Option<SessionSummary> {
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let len = std::fs::metadata(path).ok()?.len();
    if len == 0 {
        return None;
    }
    let whole = len <= HEAD_BYTES + TAIL_BYTES;
    let head = read_slice(path, 0, HEAD_BYTES.min(len) as usize)?;
    let tail = if whole {
        String::new()
    } else {
        read_slice(path, len - TAIL_BYTES, TAIL_BYTES as usize).unwrap_or_default()
    };
    // Drop the partial line each slice ends/begins with, so no half-object is parsed.
    let head_lines: Vec<&str> = if whole {
        head.lines().collect()
    } else {
        head[..head.rfind('\n').map(|i| i + 1).unwrap_or(0)].lines().collect()
    };
    let tail_lines: Vec<&str> = match tail.find('\n') {
        Some(i) => tail[i + 1..].lines().collect(),
        None => Vec::new(),
    };

    let mut ai_title: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut prompt: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut model: Option<String> = None;
    let mut assistant_lines: u64 = 0;

    for (i, line) in head_lines.iter().chain(tail_lines.iter()).enumerate() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind == "assistant" {
            assistant_lines += 1;
        }
        // Claude Code names its own sessions as they go ("ai-title" entries,
        // rewritten as the work moves on) — that's the title its own /resume
        // picker shows, so it's the best row label available. Latest wins.
        if kind == "ai-title" {
            if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()).filter(|t| !t.is_empty()) {
                ai_title = Some(t.to_string());
            }
        }
        if summary.is_none() && kind == "summary" {
            if let Some(s) = v.get("summary").and_then(|s| s.as_str()) {
                summary = Some(s.to_string());
            }
        }
        if prompt.is_none() && i < head_lines.len() {
            prompt = user_prompt_text(&v);
        }
        if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()).filter(|b| !b.is_empty()) {
            git_branch = Some(b.to_string()); // last one wins — the branch it's on NOW
        }
        if let Some(m) = v.get("message").and_then(|m| m.get("model")).and_then(|m| m.as_str()) {
            model = Some(m.to_string());
        }
    }

    // Title preference: the session's own AI title, else a compaction summary,
    // else the first thing the user actually typed.
    let title = clip(
        ai_title.as_deref().or(summary.as_deref()).or(prompt.as_deref()).unwrap_or(""),
        TITLE_CHARS,
    );
    if title.is_empty() && assistant_lines == 0 {
        return None; // an empty/aborted session is not worth a row
    }
    Some(SessionSummary {
        id,
        modified_ms,
        title,
        git_branch,
        model,
        turns: if whole { Some(assistant_lines) } else { None },
        size_bytes: len,
    })
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Past sessions for `cwd`'s project dir, newest first, capped at LIST_CAP.
/// Empty (never an error) when there's no transcript dir — the launcher shows
/// its own "nothing here yet" state.
pub fn list_sessions(projects_root: &Path, cwd: &str) -> Vec<SessionSummary> {
    let dir = projects_root.join(slugify(cwd));
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<(PathBuf, u64)> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .map(|p| {
            let ms = modified_ms(&p);
            (p, ms)
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(LIST_CAP);
    files.iter().filter_map(|(p, ms)| summarise(p, *ms)).collect()
}

#[tauri::command]
pub fn list_claude_sessions(cwd: String) -> Vec<SessionSummary> {
    let Ok(home) = std::env::var("USERPROFILE") else { return Vec::new() };
    list_sessions(&Path::new(&home).join(".claude").join("projects"), &cwd)
}

// ---------------------------------------------------------------------------
// QL-764: one-shot launch args for the next spawn.
//
// A pane's PTY is spawned by Terminal.tsx with (vendor, cwd) only — there is no
// per-spawn argv channel through the frontend, and the launcher needs to add
// `--resume <id>` (plus optionally `--fork-session`) to exactly one launch.
// So the args are STAGED here immediately before the new pane is created, and
// build_command (lib.rs) takes them for the first matching spawn.
//
// Deliberately narrow: matched on vendor + cwd, consumed once, and expired
// after PENDING_TTL_MS so a staging whose pane never spawned can't attach
// itself to an unrelated restart minutes later.
// ---------------------------------------------------------------------------

const PENDING_TTL_MS: u64 = 20_000;

struct Pending {
    vendor: String,
    cwd: String,
    args: Vec<String>,
    staged_ms: u64,
}

fn pending() -> &'static Mutex<Vec<Pending>> {
    static P: OnceLock<Mutex<Vec<Pending>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(Vec::new()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn stage_at(vendor: &str, cwd: &str, args: Vec<String>, now: u64) {
    let mut p = pending().lock().unwrap();
    // Expire stale entries, and let a fresh staging REPLACE an unclaimed one for
    // the same pane target — two clicks in the launcher mean the second one.
    p.retain(|x| {
        now.saturating_sub(x.staged_ms) < PENDING_TTL_MS
            && !(x.vendor == vendor && x.cwd.eq_ignore_ascii_case(cwd))
    });
    p.push(Pending { vendor: vendor.to_string(), cwd: cwd.to_string(), args, staged_ms: now });
}

fn take_at(vendor: &str, cwd: &str, now: u64) -> Vec<String> {
    let mut p = pending().lock().unwrap();
    p.retain(|x| now.saturating_sub(x.staged_ms) < PENDING_TTL_MS);
    // Newest match first: a second staging supersedes an earlier unclaimed one.
    let hit = p
        .iter()
        .rposition(|x| x.vendor == vendor && x.cwd.eq_ignore_ascii_case(cwd));
    match hit {
        Some(i) => p.remove(i).args,
        None => Vec::new(),
    }
}

/// Stage extra CLI args for the next spawn of `vendor` in `cwd` (QL-764).
#[tauri::command]
pub fn stage_launch_args(vendor: String, cwd: String, args: Vec<String>) {
    stage_at(&vendor, &cwd, args, now_ms());
}

/// Take (and clear) any staged args for this spawn. Empty is the normal case.
pub fn take_launch_args(vendor: &str, cwd: &str) -> Vec<String> {
    take_at(vendor, cwd, now_ms())
}

// ---------------------------------------------------------------------------
// Timestamps.
//
// Transcript lines carry `"timestamp":"2026-07-30T02:45:29.535Z"` — UTC,
// RFC3339, millisecond precision. There's no date crate in this build (see
// Cargo.toml) and one isn't worth pulling in for a fixed-shape string, so it's
// parsed here. Anything that doesn't match that exact shape returns None and
// the caller falls back to the file's own mtime rather than inventing a time.
// ---------------------------------------------------------------------------

fn iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (h, mi, sec) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    // Optional fractional seconds, clipped to milliseconds.
    let ms = if b.len() > 20 && b[19] == b'.' {
        let digits: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        let scaled: i64 = digits.parse().unwrap_or(0);
        match digits.len() {
            1 => scaled * 100,
            2 => scaled * 10,
            _ => scaled,
        }
    } else {
        0
    };
    // days-from-civil (Howard Hinnant's civil_from_days inverse) — exact, no
    // table, no leap-second fiction.
    let y2 = y - if mo <= 2 { 1 } else { 0 };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = days * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms;
    if total < 0 { None } else { Some(total as u64) }
}

// ---------------------------------------------------------------------------
// QL-769: live subagent tree.
//
// A Task/subagent turn writes its own transcript beside the parent session's:
//   ~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.jsonl
// with a sibling agent-<id>.meta.json holding {agentType, description,
// toolUseId, spawnDepth}. The lines are the same shape as the parent's, with
// isSidechain:true, so token totals come out of the same usage blocks the chip
// already reads — and the files are read the same way (offset per file), so
// polling a running fan-out costs only the bytes that were just appended.
//
// "finished" is NOT invented. These files have no result/exit line: a subagent
// is still working while its newest assistant line carries a tool_use (or its
// newest line is a tool result), and has handed back once its newest assistant
// line is text only — that final text IS the report the parent receives. A row
// that is unfinished but has gone quiet is reported as exactly that (the UI
// calls it "possibly stuck"); it is never guessed dead here.
// ---------------------------------------------------------------------------

/// Rows in one popover. A long session accumulates finished agents; the newest
/// spawns are the ones worth showing.
const SUBAGENT_CAP: usize = 20;
/// Count-probe window: a transcript written to this recently is being worked in
/// right now. Metadata only — no file is opened for the count.
const SUBAGENT_RECENT_MS: u64 = 120_000;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    /// Agent id — the file stem minus its `agent-` prefix, i.e. the `agentId`
    /// the lines themselves carry.
    pub id: String,
    /// From the sidecar meta file: which agent definition this is ("explore",
    /// "backend", …). None when the meta file is missing or unreadable.
    pub agent_type: Option<String>,
    /// The one-line task description the parent gave it, if recorded.
    pub description: Option<String>,
    /// Newest tool this agent called. None until it has called one.
    pub tool: Option<String>,
    /// First line's timestamp (epoch ms), else the file's creation time.
    pub started_ms: u64,
    /// Newest line's timestamp (epoch ms), else the file's mtime.
    pub last_activity_ms: u64,
    /// Latest prompt size and cumulative output, same maths as the pane chip.
    pub context_tokens: u64,
    pub output_tokens: u64,
    pub turns: u64,
    /// Newest assistant line was text only — it has reported back.
    pub finished: bool,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubagentCount {
    /// Subagent transcripts this session has, ever.
    pub total: u64,
    /// Of those, written to within the last SUBAGENT_RECENT_MS.
    pub recent: u64,
}

struct SubState {
    offset: u64,
    carry: String,
    usage: PaneUsage,
    info: SubagentInfo,
}

fn sub_states() -> &'static Mutex<HashMap<PathBuf, SubState>> {
    static S: OnceLock<Mutex<HashMap<PathBuf, SubState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The per-session directory that holds `subagents/` and `tool-results/`:
/// the transcript path with its `.jsonl` extension dropped.
fn subagents_dir(transcript: &Path) -> PathBuf {
    transcript.with_extension("").join("subagents")
}

fn apply_sub_line(line: &str, usage: &mut PaneUsage, info: &mut SubagentInfo) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    apply_usage(&v, usage);
    if let Some(ms) = v.get("timestamp").and_then(|t| t.as_str()).and_then(iso_ms) {
        if info.started_ms == 0 {
            info.started_ms = ms;
        }
        info.last_activity_ms = ms;
    }
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let blocks = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array());
    match kind {
        "assistant" => {
            let mut called_a_tool = false;
            for b in blocks.into_iter().flatten() {
                if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    called_a_tool = true;
                    if let Some(name) = b.get("name").and_then(|n| n.as_str()) {
                        info.tool = Some(name.to_string());
                    }
                }
            }
            // Text-only = its closing report; a tool_use = still working.
            info.finished = !called_a_tool;
        }
        // A tool result came back, so there is more to come.
        "user" => info.finished = false,
        // attachment/system/meta lines say nothing about progress.
        _ => {}
    }
}

fn scan_subagent(path: &Path, meta: (Option<String>, Option<String>)) -> Option<SubagentInfo> {
    let fsmeta = std::fs::metadata(path).ok()?;
    let len = fsmeta.len();
    let mut map = sub_states().lock().unwrap();
    let st = map.entry(path.to_path_buf()).or_insert_with(|| {
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        SubState {
            offset: 0,
            carry: String::new(),
            usage: PaneUsage::default(),
            info: SubagentInfo {
                id: id.strip_prefix("agent-").unwrap_or(&id).to_string(),
                agent_type: meta.0,
                description: meta.1,
                ..SubagentInfo::default()
            },
        }
    });
    if len < st.offset {
        st.offset = 0;
        st.carry = String::new();
        st.usage = PaneUsage::default();
    }
    if len > st.offset {
        let mut f = std::fs::File::open(path).ok()?;
        f.seek(SeekFrom::Start(st.offset)).ok()?;
        let mut buf = Vec::with_capacity((len - st.offset) as usize);
        f.read_to_end(&mut buf).ok()?;
        st.offset = len;
        let chunk = st.carry.clone() + &String::from_utf8_lossy(&buf);
        let complete_up_to = chunk.rfind('\n').map(|i| i + 1).unwrap_or(0);
        for line in chunk[..complete_up_to].lines() {
            let (usage, info) = (&mut st.usage, &mut st.info);
            apply_sub_line(line, usage, info);
        }
        st.carry = chunk[complete_up_to..].to_string();
        st.info.context_tokens = st.usage.context_tokens;
        st.info.output_tokens = st.usage.output_tokens;
        st.info.turns = st.usage.turns;
    }
    // Timestamps missing from the lines fall back to the file's own times —
    // never to "now", which would make a stalled agent look alive.
    if st.info.last_activity_ms == 0 {
        st.info.last_activity_ms = modified_ms(path);
    }
    if st.info.started_ms == 0 {
        st.info.started_ms = fsmeta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(st.info.last_activity_ms);
    }
    Some(st.info.clone())
}

fn read_agent_meta(path: &Path) -> (Option<String>, Option<String>) {
    let meta_path = path.with_extension("meta.json");
    let Ok(text) = std::fs::read_to_string(&meta_path) else { return (None, None) };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return (None, None) };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string());
    (s("agentType"), s("description"))
}

fn subagent_files(projects_root: &Path, cwd: &str) -> Vec<PathBuf> {
    let Some(transcript) = newest_transcript(projects_root, cwd) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(subagents_dir(&transcript)) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        // agent-<id>.meta.json also ends in .json, not .jsonl — extension alone
        // is enough to keep the sidecars out.
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect()
}

/// Every subagent of this pane's current session: unfinished ones first (that's
/// what the popover is for), then newest spawn first. Empty for a pane whose
/// agent doesn't write these files at all.
pub fn subagents_for(projects_root: &Path, cwd: &str) -> Vec<SubagentInfo> {
    let mut files = subagent_files(projects_root, cwd);
    // Newest-first by mtime, so the cap drops the oldest finished agents.
    files.sort_by_key(|p| std::cmp::Reverse(modified_ms(p)));
    files.truncate(SUBAGENT_CAP);
    let mut rows: Vec<SubagentInfo> = files
        .iter()
        .filter_map(|p| scan_subagent(p, read_agent_meta(p)))
        .collect();
    rows.sort_by(|a, b| {
        a.finished
            .cmp(&b.finished)
            .then(b.started_ms.cmp(&a.started_ms))
    });
    rows
}

/// The cheap probe behind the header chip's count: directory metadata only, no
/// transcript is opened. `recent` is honestly just "written to lately" — the
/// popover's rows are where finished/stuck is actually decided.
pub fn subagent_count_for(projects_root: &Path, cwd: &str, now: u64) -> SubagentCount {
    let files = subagent_files(projects_root, cwd);
    let recent = files
        .iter()
        .filter(|p| now.saturating_sub(modified_ms(p)) < SUBAGENT_RECENT_MS)
        .count() as u64;
    SubagentCount { total: files.len() as u64, recent }
}

#[tauri::command]
pub fn pane_subagents(cwd: String) -> Vec<SubagentInfo> {
    let Ok(home) = std::env::var("USERPROFILE") else { return Vec::new() };
    subagents_for(&Path::new(&home).join(".claude").join("projects"), &cwd)
}

#[tauri::command]
pub fn pane_subagent_count(cwd: String) -> SubagentCount {
    let Ok(home) = std::env::var("USERPROFILE") else { return SubagentCount::default() };
    subagent_count_for(&Path::new(&home).join(".claude").join("projects"), &cwd, now_ms())
}

// ---------------------------------------------------------------------------
// QL-770: plan-mode documents.
//
// Leaving plan mode is a tool call like any other: an assistant line with a
// `tool_use` named ExitPlanMode whose `input.plan` IS the plan document
// (markdown, verbatim). The user's answer arrives as the matching `tool_result`
// on a later user line — "User has approved your plan…" when accepted, an
// is_error result saying the tool use was rejected when not.
//
// So approval is read, not inferred: approved stays None until that result
// line exists, and the UI shows no approval state rather than a guess.
//
// The parent transcript runs to tens of megabytes, so it's read incrementally
// (offset per file, same as the token chip) and only the newest PLAN_CAP plans
// are kept.
// ---------------------------------------------------------------------------

/// Plans kept per session — the current one plus a short archive.
const PLAN_CAP: usize = 10;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    /// The ExitPlanMode tool_use id — also what the answering result matches on.
    pub id: String,
    /// The plan document, markdown, exactly as the agent wrote it.
    pub plan: String,
    /// When the agent proposed it (epoch ms), 0 if the line carried no timestamp.
    pub at_ms: u64,
    /// true = approved, false = rejected, None = no answer recorded yet.
    pub approved: Option<bool>,
}

struct PlanState {
    offset: u64,
    carry: String,
    plans: Vec<PlanEntry>, // oldest first while accumulating
}

fn plan_states() -> &'static Mutex<HashMap<PathBuf, PlanState>> {
    static S: OnceLock<Mutex<HashMap<PathBuf, PlanState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A tool_result's content is a string on some lines and a block array on
/// others; both are flattened to text so the approval phrase can be matched.
fn result_text(block: &serde_json::Value) -> String {
    match block.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn apply_plan_line(line: &str, plans: &mut Vec<PlanEntry>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    let Some(blocks) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { return };
    let at_ms = v.get("timestamp").and_then(|t| t.as_str()).and_then(iso_ms).unwrap_or(0);
    for b in blocks {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("tool_use") if b.get("name").and_then(|n| n.as_str()) == Some("ExitPlanMode") => {
                let Some(plan) = b.get("input").and_then(|i| i.get("plan")).and_then(|p| p.as_str()) else { continue };
                let id = b.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                plans.push(PlanEntry { id, plan: plan.to_string(), at_ms, approved: None });
                if plans.len() > PLAN_CAP {
                    plans.remove(0);
                }
            }
            Some("tool_result") => {
                let Some(id) = b.get("tool_use_id").and_then(|i| i.as_str()) else { continue };
                let Some(entry) = plans.iter_mut().find(|p| p.id == id) else { continue };
                let text = result_text(b);
                let rejected = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false)
                    || text.contains("doesn't want to proceed")
                    || text.contains("The tool use was rejected");
                entry.approved = Some(!rejected);
            }
            _ => {}
        }
    }
}

fn scan_plans(path: &Path) -> Vec<PlanEntry> {
    let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else { return Vec::new() };
    let mut map = plan_states().lock().unwrap();
    let st = map.entry(path.to_path_buf()).or_insert_with(|| PlanState {
        // Same first-read cap as the token chip: an already-huge transcript is
        // read from near its end, so only plans older than that slice are
        // missed — and the archive is capped at ten anyway.
        offset: if len > FIRST_READ_CAP { len - FIRST_READ_CAP } else { 0 },
        carry: String::new(),
        plans: Vec::new(),
    });
    if len < st.offset {
        *st = PlanState { offset: 0, carry: String::new(), plans: Vec::new() };
    }
    if len > st.offset {
        let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
        if f.seek(SeekFrom::Start(st.offset)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::with_capacity((len - st.offset) as usize);
        if f.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        st.offset = len;
        let chunk = st.carry.clone() + &String::from_utf8_lossy(&buf);
        let complete_up_to = chunk.rfind('\n').map(|i| i + 1).unwrap_or(0);
        for line in chunk[..complete_up_to].lines() {
            // Cheap pre-filter: the plan lines are a handful in a file of tens
            // of thousands, and this keeps serde off the rest of them.
            if line.contains("ExitPlanMode") || line.contains("tool_result") {
                apply_plan_line(line, &mut st.plans);
            }
        }
        st.carry = chunk[complete_up_to..].to_string();
    }
    let mut out = st.plans.clone();
    out.reverse(); // newest first
    out
}

/// This pane's session's plans, newest first, capped at PLAN_CAP. Empty when
/// the session has never left plan mode (or isn't a Claude session at all).
pub fn plans_for(projects_root: &Path, cwd: &str) -> Vec<PlanEntry> {
    match newest_transcript(projects_root, cwd) {
        Some(p) => scan_plans(&p),
        None => Vec::new(),
    }
}

#[tauri::command]
pub fn pane_plans(cwd: String) -> Vec<PlanEntry> {
    let Ok(home) = std::env::var("USERPROFILE") else { return Vec::new() };
    plans_for(&Path::new(&home).join(".claude").join("projects"), &cwd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn temp_root() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fd-usage-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn asst(input: u64, cache_read: u64, cache_create: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","usage":{{"input_tokens":{input},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":{cache_create},"output_tokens":{output}}}}}}}"#
        )
    }

    #[test]
    fn slugify_matches_claude_code_layout() {
        assert_eq!(slugify("D:\\Dev\\ai"), "D--Dev-ai");
        assert_eq!(slugify("D:\\Dev\\ai\\projects\\active\\kove-site"), "D--Dev-ai-projects-active-kove-site");
    }

    #[test]
    fn sums_incrementally_and_tracks_latest_context() {
        let root = temp_root();
        let cwd = "D:\\proj\\x";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s1.jsonl");
        let lines = [
            r#"{"type":"user","message":{"role":"user"}}"#.to_string(),
            asst(10, 1000, 500, 200),
            asst(2, 1700, 0, 100),
        ];
        std::fs::write(&file, lines.join("\n") + "\n").unwrap();

        let u = usage_for(&root, cwd).unwrap();
        assert_eq!(u.turns, 2);
        assert_eq!(u.output_tokens, 300);
        assert_eq!(u.context_tokens, 1702, "context = latest turn's prompt incl. cache");

        // Append a turn — only the new bytes are parsed, totals accumulate.
        let mut s = std::fs::read_to_string(&file).unwrap();
        s.push_str(&(asst(5, 2000, 100, 50) + "\n"));
        std::fs::write(&file, s).unwrap();
        let u2 = usage_for(&root, cwd).unwrap();
        assert_eq!(u2.turns, 3);
        assert_eq!(u2.output_tokens, 350);
        assert_eq!(u2.context_tokens, 2105);

        // No transcript dir -> None (agy/shell panes).
        assert!(usage_for(&root, "D:\\other").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- QL-765/766 -------------------------------------------------------

    fn asst_model(model: &str, input: u64, cache_read: u64, cache_create: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","model":"{model}","usage":{{"input_tokens":{input},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":{cache_create},"output_tokens":{output}}}}}}}"#
        )
    }

    #[test]
    fn keeps_last_model_and_last_turn_split() {
        let root = temp_root();
        let cwd = "D:\\proj\\model";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            asst_model("claude-sonnet-4-5-20250929", 10, 1000, 500, 200),
            asst_model("claude-opus-4-1-20250805", 7, 1700, 40, 90),
            // A usage block with no model must not blank the known one.
            asst(3, 1800, 0, 20),
        ];
        std::fs::write(dir.join("s1.jsonl"), lines.join("\n") + "\n").unwrap();

        let u = usage_for(&root, cwd).unwrap();
        assert_eq!(u.model.as_deref(), Some("claude-opus-4-1-20250805"));
        assert_eq!(u.last_input_tokens, 3);
        assert_eq!(u.last_cache_read_tokens, 1800);
        assert_eq!(u.last_cache_creation_tokens, 0);
        assert_eq!(u.last_output_tokens, 20);
        assert_eq!(u.context_tokens, 1803);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- QL-764: session listing -----------------------------------------

    fn user(text: &str) -> String {
        format!(
            r#"{{"type":"user","gitBranch":"main","message":{{"role":"user","content":"{text}"}}}}"#
        )
    }

    #[test]
    fn lists_sessions_with_prompt_branch_and_model() {
        let root = temp_root();
        let cwd = "D:\\proj\\list";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            // The wrappers a slash-command leaves behind are not the prompt.
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"session hook"}}"#.to_string(),
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#.to_string(),
            user("fix the token chip"),
            asst_model("claude-opus-4-1-20250805", 10, 100, 0, 20),
            r#"{"type":"user","gitBranch":"feature/x","message":{"role":"user","content":"and again"}}"#.to_string(),
        ];
        std::fs::write(dir.join("abc-123.jsonl"), lines.join("\n") + "\n").unwrap();

        let list = list_sessions(&root, cwd);
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.id, "abc-123", "session id is the file stem");
        assert_eq!(s.title, "fix the token chip");
        assert_eq!(s.git_branch.as_deref(), Some("feature/x"), "latest branch wins");
        assert_eq!(s.model.as_deref(), Some("claude-opus-4-1-20250805"));
        assert_eq!(s.turns, Some(1), "a small file is read whole, so the count is exact");
        assert!(s.size_bytes > 0);
        assert!(s.modified_ms > 0);

        // A cwd with no transcript dir lists nothing rather than failing.
        assert!(list_sessions(&root, "D:\\nope").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prefers_a_summary_line_over_the_first_prompt() {
        let root = temp_root();
        let cwd = "D:\\proj\\summary";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            r#"{"type":"summary","summary":"Wave 4: resume launcher and model chip"}"#.to_string(),
            user("carry on"),
            asst(5, 10, 0, 5),
        ];
        std::fs::write(dir.join("s.jsonl"), lines.join("\n") + "\n").unwrap();
        assert_eq!(list_sessions(&root, cwd)[0].title, "Wave 4: resume launcher and model chip");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prefers_claude_codes_own_session_title_and_takes_the_latest() {
        let root = temp_root();
        let cwd = "D:\\proj\\aititle";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            user("start something"),
            r#"{"type":"ai-title","aiTitle":"First guess at the job"}"#.to_string(),
            r#"{"type":"summary","summary":"a compaction summary"}"#.to_string(),
            asst(5, 10, 0, 5),
            r#"{"type":"ai-title","aiTitle":"What the session actually became"}"#.to_string(),
        ];
        std::fs::write(dir.join("s.jsonl"), lines.join("\n") + "\n").unwrap();
        assert_eq!(list_sessions(&root, cwd)[0].title, "What the session actually became");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_sampled_transcript_reports_no_turn_count_but_still_titles_itself() {
        let root = temp_root();
        let cwd = "D:\\proj\\big";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = String::new();
        s.push_str(&(user("the very first thing I asked") + "\n"));
        s.push_str(&(r#"{"type":"ai-title","aiTitle":"A long session"}"#.to_string() + "\n"));
        // Padding lines, valid JSON but of no interest, until the file is well
        // past HEAD_BYTES + TAIL_BYTES.
        let filler = format!(r#"{{"type":"noise","pad":"{}"}}"#, "x".repeat(2000));
        while s.len() < (HEAD_BYTES + TAIL_BYTES + 200 * 1024) as usize {
            s.push_str(&filler);
            s.push('\n');
        }
        s.push_str(&(r#"{"type":"user","gitBranch":"late-branch","message":{"role":"user","content":"latest"}}"#.to_string() + "\n"));
        s.push_str(&(asst_model("claude-opus-5", 1, 1, 0, 1) + "\n"));
        std::fs::write(dir.join("big.jsonl"), &s).unwrap();

        let list = list_sessions(&root, cwd);
        assert_eq!(list.len(), 1);
        let got = &list[0];
        assert_eq!(got.title, "A long session", "title comes out of the head slice");
        assert_eq!(got.git_branch.as_deref(), Some("late-branch"), "branch comes out of the tail slice");
        assert_eq!(got.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(got.turns, None, "no invented turn count for a file we didn’t read whole");
        assert_eq!(got.size_bytes, s.len() as u64);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clips_long_titles_and_flattens_newlines() {
        let long = "word ".repeat(60);
        let out = clip(&format!("first\nsecond {long}"), TITLE_CHARS);
        assert!(out.chars().count() <= TITLE_CHARS + 1, "clipped to the cap plus the ellipsis");
        assert!(out.starts_with("first second"), "collapsed onto one line");
        assert!(out.ends_with('…'));
        assert_eq!(clip("short one", TITLE_CHARS), "short one");
    }

    #[test]
    fn caps_the_list_and_sorts_newest_first() {
        let root = temp_root();
        let cwd = "D:\\proj\\many";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..60 {
            std::fs::write(
                dir.join(format!("s{i:02}.jsonl")),
                user(&format!("prompt {i}")) + "\n" + &asst(1, 1, 0, 1) + "\n",
            )
            .unwrap();
        }
        // A stray non-transcript file is ignored.
        std::fs::write(dir.join("notes.txt"), "ignore me").unwrap();

        let list = list_sessions(&root, cwd);
        assert_eq!(list.len(), LIST_CAP);
        for w in list.windows(2) {
            assert!(w[0].modified_ms >= w[1].modified_ms, "newest first");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_an_empty_transcript() {
        let root = temp_root();
        let cwd = "D:\\proj\\empty";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("blank.jsonl"), "").unwrap();
        std::fs::write(dir.join("noise.jsonl"), "{\"type\":\"system\"}\n").unwrap();
        assert!(list_sessions(&root, cwd).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- QL-769: subagent tree -------------------------------------------

    /// Writes a session transcript plus `subagents/agent-<id>.jsonl` files, and
    /// returns the project root the commands read from.
    fn session_with_subagents(cwd: &str, agents: &[(&str, &str, Vec<String>)]) -> PathBuf {
        let root = temp_root();
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sess.jsonl"), asst(1, 1, 0, 1) + "\n").unwrap();
        let subs = dir.join("sess").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        for (id, agent_type, lines) in agents {
            std::fs::write(subs.join(format!("agent-{id}.jsonl")), lines.join("\n") + "\n").unwrap();
            std::fs::write(
                subs.join(format!("agent-{id}.meta.json")),
                format!(r#"{{"agentType":"{agent_type}","description":"do a thing","spawnDepth":1}}"#),
            )
            .unwrap();
        }
        root
    }

    fn sub_tool(ts: &str, tool: &str, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":true,"timestamp":"{ts}","message":{{"role":"assistant","usage":{{"input_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":0,"output_tokens":{out}}},"content":[{{"type":"tool_use","name":"{tool}","id":"t1","input":{{}}}}]}}}}"#
        )
    }

    fn sub_text(ts: &str, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":true,"timestamp":"{ts}","message":{{"role":"assistant","usage":{{"input_tokens":9,"cache_read_input_tokens":200,"cache_creation_input_tokens":0,"output_tokens":{out}}},"content":[{{"type":"text","text":"here is the report"}}]}}}}"#
        )
    }

    fn sub_result(ts: &str) -> String {
        format!(
            r#"{{"type":"user","isSidechain":true,"timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t1","content":"ok"}}]}}}}"#
        )
    }

    #[test]
    fn parses_claude_codes_timestamps() {
        // 2026-07-30T02:45:29.535Z — checked against the epoch by hand.
        assert_eq!(iso_ms("2026-07-30T02:45:29.535Z"), Some(1785379529535));
        assert_eq!(iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_ms("2026-07-30T02:45:29Z"), Some(1785379529000));
        // Fractions shorter than three digits are still milliseconds.
        assert_eq!(iso_ms("1970-01-01T00:00:00.5Z"), Some(500));
        // Anything not of that shape is refused rather than guessed.
        assert!(iso_ms("").is_none());
        assert!(iso_ms("yesterday").is_none());
        assert!(iso_ms("2026-13-01T00:00:00.000Z").is_none());
    }

    #[test]
    fn reads_running_and_finished_subagents() {
        let cwd = "D:\\proj\\agents";
        let root = session_with_subagents(
            cwd,
            &[
                // Still working: its newest assistant line called a tool.
                ("aaa1".into(), "explore", vec![
                    sub_tool("2026-08-11T01:00:00.000Z", "Glob", 10),
                    sub_result("2026-08-11T01:00:05.000Z"),
                    sub_tool("2026-08-11T01:00:09.000Z", "Grep", 20),
                ]),
                // Handed back: its newest assistant line is text only.
                ("bbb2".into(), "backend", vec![
                    sub_tool("2026-08-11T00:50:00.000Z", "Read", 5),
                    sub_text("2026-08-11T00:52:00.000Z", 7),
                ]),
            ],
        );

        let rows = subagents_for(&root, cwd);
        assert_eq!(rows.len(), 2);
        // Unfinished first — that's what the popover is for.
        let running = &rows[0];
        assert_eq!(running.id, "aaa1", "id is the stem without its agent- prefix");
        assert_eq!(running.agent_type.as_deref(), Some("explore"));
        assert_eq!(running.description.as_deref(), Some("do a thing"));
        assert_eq!(running.tool.as_deref(), Some("Grep"), "newest tool wins");
        assert!(!running.finished);
        assert_eq!(running.started_ms, iso_ms("2026-08-11T01:00:00.000Z").unwrap());
        assert_eq!(running.last_activity_ms, iso_ms("2026-08-11T01:00:09.000Z").unwrap());
        assert_eq!(running.output_tokens, 30, "cumulative across its turns");
        assert_eq!(running.context_tokens, 105, "latest prompt incl. cache");
        assert_eq!(running.turns, 2);

        let done = &rows[1];
        assert_eq!(done.id, "bbb2");
        assert!(done.finished, "text-only final assistant line = reported back");
        assert_eq!(done.tool.as_deref(), Some("Read"));

        // A pane whose agent writes none of this gets an empty list, not an error.
        assert!(subagents_for(&root, "D:\\proj\\nothing").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_finished_subagent_that_gets_more_work_is_running_again() {
        let cwd = "D:\\proj\\resumed-agent";
        let root = session_with_subagents(
            cwd,
            &[("ccc3".into(), "reviewer", vec![sub_text("2026-08-11T02:00:00.000Z", 4)])],
        );
        let file = root.join(slugify(cwd)).join("sess").join("subagents").join("agent-ccc3.jsonl");
        assert!(subagents_for(&root, cwd)[0].finished);

        // Append a fresh tool call — the incremental read must flip it back.
        let mut s = std::fs::read_to_string(&file).unwrap();
        s.push_str(&(sub_tool("2026-08-11T02:00:30.000Z", "Bash", 6) + "\n"));
        std::fs::write(&file, s).unwrap();

        let rows = subagents_for(&root, cwd);
        assert!(!rows[0].finished);
        assert_eq!(rows[0].tool.as_deref(), Some("Bash"));
        assert_eq!(rows[0].turns, 2, "the appended turn is counted once");
        assert_eq!(rows[0].output_tokens, 10);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn counts_subagents_without_opening_them() {
        let cwd = "D:\\proj\\count";
        let root = session_with_subagents(
            cwd,
            &[
                ("d1".into(), "explore", vec![sub_tool("2026-08-11T03:00:00.000Z", "Glob", 1)]),
                ("d2".into(), "explore", vec![sub_text("2026-08-11T03:00:00.000Z", 1)]),
            ],
        );
        // The files were just written, so "now" sees both as recent...
        let now = now_ms();
        let c = subagent_count_for(&root, cwd, now);
        assert_eq!(c.total, 2);
        assert_eq!(c.recent, 2);
        // ...and an hour later, neither.
        let later = subagent_count_for(&root, cwd, now + 3_600_000);
        assert_eq!(later.total, 2);
        assert_eq!(later.recent, 0);

        let none = subagent_count_for(&root, "D:\\proj\\nothing", now);
        assert_eq!(none.total, 0);
        assert_eq!(none.recent, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- QL-770: plan mode ------------------------------------------------

    fn exit_plan(ts: &str, id: &str, plan: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"{id}","name":"ExitPlanMode","input":{{"plan":"{plan}"}}}}]}}}}"#
        )
    }

    fn plan_answer(ts: &str, id: &str, approved: bool) -> String {
        let (text, err) = if approved {
            ("User has approved your plan. You can now start coding.", "false")
        } else {
            ("The user doesn't want to proceed with this tool use. The tool use was rejected", "true")
        };
        format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"{id}","is_error":{err},"content":"{text}"}}]}}}}"#
        )
    }

    #[test]
    fn reads_plans_newest_first_with_the_answer_that_was_actually_given() {
        let root = temp_root();
        let cwd = "D:\\proj\\plans";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        let lines = [
            user("plan something"),
            exit_plan("2026-08-11T04:00:00.000Z", "toolu_1", "# First plan\\n\\nstep one"),
            plan_answer("2026-08-11T04:05:00.000Z", "toolu_1", false),
            exit_plan("2026-08-11T04:10:00.000Z", "toolu_2", "# Second plan\\n\\nstep two"),
            plan_answer("2026-08-11T04:12:00.000Z", "toolu_2", true),
            exit_plan("2026-08-11T04:20:00.000Z", "toolu_3", "# Third plan\\n\\nstep three"),
        ];
        std::fs::write(&file, lines.join("\n") + "\n").unwrap();

        let plans = plans_for(&root, cwd);
        assert_eq!(plans.len(), 3);
        assert_eq!(plans[0].id, "toolu_3", "newest first");
        assert_eq!(plans[0].plan, "# Third plan\n\nstep three", "markdown verbatim");
        assert_eq!(plans[0].at_ms, iso_ms("2026-08-11T04:20:00.000Z").unwrap());
        assert_eq!(plans[0].approved, None, "unanswered = no approval state at all");
        assert_eq!(plans[1].approved, Some(true));
        assert_eq!(plans[2].approved, Some(false), "a rejection is recorded as one");

        // The answer to the pending plan arrives later — the incremental read
        // picks it up without re-reading the file.
        let mut s = std::fs::read_to_string(&file).unwrap();
        s.push_str(&(plan_answer("2026-08-11T04:25:00.000Z", "toolu_3", true) + "\n"));
        std::fs::write(&file, s).unwrap();
        assert_eq!(plans_for(&root, cwd)[0].approved, Some(true));

        // No transcript at all -> no plans, no error.
        assert!(plans_for(&root, "D:\\proj\\nowhere").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_only_the_newest_ten_plans() {
        let root = temp_root();
        let cwd = "D:\\proj\\manyplans";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = String::new();
        for i in 0..14 {
            s.push_str(&(exit_plan("2026-08-11T05:00:00.000Z", &format!("toolu_{i}"), &format!("# Plan {i}")) + "\n"));
        }
        std::fs::write(dir.join("s.jsonl"), s).unwrap();

        let plans = plans_for(&root, cwd);
        assert_eq!(plans.len(), PLAN_CAP);
        assert_eq!(plans[0].id, "toolu_13");
        assert_eq!(plans[PLAN_CAP - 1].id, "toolu_4");
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- QL-764: staged launch args --------------------------------------
    // One test, on purpose: the pending list is process-global, and the
    // expiry assertions below would prune a sibling test's entries if these
    // ran in parallel with them.
    #[test]
    fn staged_launch_args_are_one_shot_matched_and_expiring() {
        let t0 = now_ms();
        let cwd = "D:\\proj\\resume";
        stage_at("claude", cwd, vec!["--resume".into(), "abc".into()], t0);

        // Another vendor / another folder never claims them.
        assert!(take_at("agy", cwd, t0).is_empty());
        assert!(take_at("claude", "D:\\proj\\other", t0).is_empty());

        // Windows paths differ in case between call sites; the match doesn't care.
        assert_eq!(take_at("claude", "d:\\PROJ\\resume", t0), vec!["--resume", "abc"]);
        // Consumed — a restart of that pane does NOT resume again.
        assert!(take_at("claude", cwd, t0).is_empty());

        // A second staging supersedes an earlier unclaimed one.
        stage_at("claude", cwd, vec!["--resume".into(), "one".into()], t0);
        stage_at("claude", cwd, vec!["--resume".into(), "two".into(), "--fork-session".into()], t0);
        assert_eq!(take_at("claude", cwd, t0), vec!["--resume", "two", "--fork-session"]);
        assert!(take_at("claude", cwd, t0).is_empty());

        // Staged but never spawned: it expires instead of attaching to a much
        // later, unrelated launch in the same folder.
        stage_at("claude", cwd, vec!["--resume".into(), "stale".into()], t0);
        assert!(take_at("claude", cwd, t0 + PENDING_TTL_MS + 1).is_empty());
    }
}
