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
    /// Codex only: the model's context window as the rollout states it
    /// (`model_context_window`), so the chip need not guess from a model table.
    pub context_window: Option<u64>,
    /// Codex only: plan rate-limit usage, straight from `rate_limits`. None when
    /// the rollout has no such block. Percent is 0-100, `resets` epoch seconds.
    pub plan_used_percent_5h: Option<f64>,
    pub plan_resets_5h: Option<u64>,
    pub plan_used_percent_week: Option<f64>,
    pub plan_resets_week: Option<u64>,
    /// API-equivalent cost of the session in USD, from `price_for`. Flightdeck
    /// drives subscription CLIs, so this is what the same tokens would cost on
    /// the API, not anything billed.
    pub api_equiv_usd: f64,
}

/// Claude Code's project-dir slug: every non-alphanumeric byte becomes '-'
/// ("D:\Dev\ai" -> "D--Dev-ai").
pub(crate) fn slugify(cwd: &str) -> String {
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

/// Phase D: one Codex rollout line. `turn_context` sets the model;
/// `event_msg` `token_count` sets the token figures and rate limits. Anything of
/// an unknown shape is skipped untouched, so an upstream schema change yields
/// no chip (turns stays 0) rather than a wrong number.
///
/// Context size is `last_token_usage.total_tokens`, which is what Codex's own
/// status line counts against the window. `input_tokens` already INCLUDES the
/// cached part, so the split below is input minus cached (fresh), cached read,
/// and `cache_write_input_tokens` (written).
fn apply_codex_line(line: &str, u: &mut PaneUsage) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    let Some(p) = v.get("payload") else { return };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("turn_context") => {
            if let Some(m) = p.get("model").and_then(|m| m.as_str()).filter(|m| !m.is_empty()) {
                u.model = Some(m.to_string());
            }
        }
        Some("event_msg") if p.get("type").and_then(|t| t.as_str()) == Some("token_count") => {
            apply_codex_token_count(p, u);
        }
        _ => {}
    }
}

fn apply_codex_token_count(p: &serde_json::Value, u: &mut PaneUsage) {
    // Rate limits ride on the same event and may arrive with `info: null`.
    if let Some(rl) = p.get("rate_limits").filter(|r| r.is_object()) {
        apply_codex_rate_limits(rl, u);
    }
    let Some(info) = p.get("info").filter(|i| i.is_object()) else { return };
    let Some(last) = info.get("last_token_usage").filter(|l| l.is_object()) else { return };
    let get = |k: &str| last.get(k).and_then(|x| x.as_u64());
    // Require the fields we sum; a renamed schema must not read as zeros.
    let (Some(input), Some(output)) = (get("input_tokens"), get("output_tokens")) else { return };
    let cached = get("cached_input_tokens").unwrap_or(0).min(input);
    let context = get("total_tokens").unwrap_or(input + output);
    if context == 0 {
        return;
    }
    u.context_tokens = context;
    u.output_tokens += output;
    u.turns += 1;
    u.last_input_tokens = input - cached;
    u.last_cache_read_tokens = cached;
    u.last_cache_creation_tokens = get("cache_write_input_tokens").unwrap_or(0);
    u.last_output_tokens = output;
    if let Some(w) = info.get("model_context_window").and_then(|w| w.as_u64()).filter(|w| *w > 0) {
        u.context_window = Some(w);
    }
}

/// `primary`/`secondary` are keyed by `window_minutes` when present (300 = the
/// 5h window, 10080 = weekly), else by position. Unknown windows are ignored.
fn apply_codex_rate_limits(rl: &serde_json::Value, u: &mut PaneUsage) {
    for (key, positional_week) in [("primary", false), ("secondary", true)] {
        let Some(w) = rl.get(key).filter(|w| w.is_object()) else { continue };
        let Some(pct) = w.get("used_percent").and_then(|x| x.as_f64()).filter(|x| x.is_finite() && *x >= 0.0) else { continue };
        let resets = w.get("resets_at").and_then(|x| x.as_u64());
        let week = match w.get("window_minutes").and_then(|x| x.as_u64()) {
            Some(m) if m <= 360 => false,
            Some(m) if m >= 10_000 => true,
            Some(_) => continue,
            None => positional_week,
        };
        if week {
            u.plan_used_percent_week = Some(pct);
            u.plan_resets_week = resets;
        } else {
            u.plan_used_percent_5h = Some(pct);
            u.plan_resets_5h = resets;
        }
    }
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
    // Cost: priced on this line's own model, else the last one seen.
    let line_model = v.get("message").and_then(|m| m.get("model")).and_then(|m| m.as_str());
    if let Some(p) = line_model.or(u.model.as_deref()).and_then(price_for) {
        let w1h = usage
            .get("cache_creation")
            .and_then(|c| c.get("ephemeral_1h_input_tokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0)
            .min(n("cache_creation_input_tokens"));
        let w5m = n("cache_creation_input_tokens") - w1h;
        u.api_equiv_usd += (n("input_tokens") as f64 * p.input
            + n("output_tokens") as f64 * p.output
            + w5m as f64 * p.cache_write_5m
            + w1h as f64 * p.cache_write_1h
            + n("cache_read_input_tokens") as f64 * p.cache_read)
            / 1_000_000.0;
    }
    // QL-766: last-seen model. Only overwritten when the line carries one, so a
    // usage block without a model can't blank an already-known value.
    if let Some(m) = v.get("message").and_then(|m| m.get("model")).and_then(|m| m.as_str()) {
        u.model = Some(m.to_string());
    }
}

fn scan(path: &Path) -> Option<PaneUsage> {
    scan_with(path, apply_line)
}

fn scan_with(path: &Path, apply: fn(&str, &mut PaneUsage)) -> Option<PaneUsage> {
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
            apply(line, &mut st.usage);
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

/// Phase D: usage for a Codex pane, from the newest rollout recorded for `cwd`.
pub fn codex_usage_for(sessions_root: &Path, cwd: &str) -> Option<PaneUsage> {
    let newest = crate::codexsessions::newest_rollout(sessions_root, cwd)?;
    scan_with(&newest, apply_codex_line).filter(|u| u.turns > 0)
}

/// `vendor` is optional so older callers (and the Claude default) keep working.
/// Any other vendor has no transcript to read and gets no chip.
#[tauri::command(async)]
pub fn pane_usage(vendor: Option<String>, cwd: String) -> Option<PaneUsage> {
    match vendor.as_deref().unwrap_or("claude") {
        "claude" => {
            let home = std::env::var("USERPROFILE").ok()?;
            let root = Path::new(&home).join(".claude").join("projects");
            usage_for(&root, &cwd)
        }
        "codex" => codex_usage_for(&crate::codexsessions::codex_home()?.join("sessions"), &cwd),
        _ => None,
    }
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
pub(crate) const LIST_CAP: usize = 50;
/// Sample size per end. Sized so an ordinary session (well under 1 MB) is read
/// whole — and so gets an exact turn count — while the multi-megabyte monsters
/// still cost two seeks. Measured at ~90 ms for a 22-session folder totalling
/// 60 MB, which is inside a picker's opening animation.
const HEAD_BYTES: u64 = 512 * 1024;
const TAIL_BYTES: u64 = 512 * 1024;
/// Prompt/summary line shown in the picker.
pub(crate) const TITLE_CHARS: usize = 120;

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
pub(crate) fn clip(s: &str, chars: usize) -> String {
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

pub(crate) fn modified_ms(path: &Path) -> u64 {
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

#[tauri::command(async)]
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
///
/// Codex args end up inside a `pwsh -Command` line, so they are held to the one
/// shape ever needed, `resume <uuid>`; anything else is refused rather than
/// pasted into a shell command.
#[tauri::command]
pub fn stage_launch_args(vendor: String, cwd: String, args: Vec<String>) -> Result<(), String> {
    check_staged(&vendor, &args)?;
    stage_at(&vendor, &cwd, args, now_ms());
    Ok(())
}

fn check_staged(vendor: &str, args: &[String]) -> Result<(), String> {
    if vendor == "codex" {
        match args {
            [a, id] if a == "resume" && crate::codexsessions::is_uuid(id) => {}
            [] => {}
            _ => return Err("codex accepts only `resume <session-uuid>`".into()),
        }
    }
    Ok(())
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

/// TN3: tool_use counts by class, kept beside the QL-769 state so one pass over
/// the appended bytes feeds both the popover and the transcript's subagent links.
#[derive(Clone, Default)]
struct ToolCounts {
    edits: u64,
    commands: u64,
    reads: u64,
    searches: u64,
    other: u64,
}

struct SubState {
    offset: u64,
    carry: String,
    usage: PaneUsage,
    info: SubagentInfo,
    counts: ToolCounts,
    tool_use_id: Option<String>,
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

fn apply_sub_line(line: &str, usage: &mut PaneUsage, info: &mut SubagentInfo, counts: &mut ToolCounts) {
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
                        match name {
                            "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => counts.edits += 1,
                            "Bash" | "PowerShell" => counts.commands += 1,
                            "Read" => counts.reads += 1,
                            "Grep" | "Glob" | "WebSearch" | "WebFetch" => counts.searches += 1,
                            _ => counts.other += 1,
                        }
                    } else {
                        counts.other += 1;
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
    scan_subagent_full(path, (meta.0, meta.1, None)).map(|r| r.0)
}

type SubMeta = (Option<String>, Option<String>, Option<String>);

fn scan_subagent_full(path: &Path, meta: SubMeta) -> Option<(SubagentInfo, ToolCounts, Option<String>)> {
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
            counts: ToolCounts::default(),
            tool_use_id: None,
        }
    });
    // The sidecar can land after the transcript's first poll; fill gaps late.
    if st.tool_use_id.is_none() {
        st.tool_use_id = meta.2;
    }
    if len < st.offset {
        st.offset = 0;
        st.carry = String::new();
        st.usage = PaneUsage::default();
        st.counts = ToolCounts::default();
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
            let (usage, info, counts) = (&mut st.usage, &mut st.info, &mut st.counts);
            apply_sub_line(line, usage, info, counts);
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
    Some((st.info.clone(), st.counts.clone(), st.tool_use_id.clone()))
}

fn read_agent_meta3(path: &Path) -> SubMeta {
    let meta_path = path.with_extension("meta.json");
    let Ok(text) = std::fs::read_to_string(&meta_path) else { return (None, None, None) };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return (None, None, None) };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string());
    (s("agentType"), s("description"), s("toolUseId"))
}

fn read_agent_meta(path: &Path) -> (Option<String>, Option<String>) {
    let m = read_agent_meta3(path);
    (m.0, m.1)
}

// ---------------------------------------------------------------------------
// TN3: subagent links for the chat transcript. Same files and cached scan as the
// popover above, keyed from the parent JSONL path the transcript view already
// holds, with tool counts by class and the parent's Agent tool_use id.
// ---------------------------------------------------------------------------

/// Links returned per session; the newest-modified win when more exist.
const SUBAGENT_LINK_CAP: usize = 50;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentLink {
    pub id: String,
    pub tool_use_id: Option<String>,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub jsonl_path: String,
    pub edits: u64,
    pub commands: u64,
    pub reads: u64,
    pub searches: u64,
    pub other: u64,
    pub finished: bool,
    pub last_activity_ms: u64,
}

/// `parent` is the already-validated parent transcript path (not canonicalised,
/// so the returned paths stay plain drive paths that session_tail accepts).
/// Oldest spawn first.
pub fn subagent_links_for(parent: &Path) -> Vec<SubagentLink> {
    let Ok(entries) = std::fs::read_dir(subagents_dir(parent)) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    files.sort_by_key(|p| std::cmp::Reverse(modified_ms(p)));
    files.truncate(SUBAGENT_LINK_CAP);
    let mut rows: Vec<(u64, SubagentLink)> = files
        .iter()
        .filter_map(|p| {
            let (info, c, tool_use_id) = scan_subagent_full(p, read_agent_meta3(p))?;
            Some((
                info.started_ms,
                SubagentLink {
                    id: info.id,
                    tool_use_id,
                    agent_type: info.agent_type,
                    description: info.description,
                    jsonl_path: p.to_string_lossy().into_owned(),
                    edits: c.edits,
                    commands: c.commands,
                    reads: c.reads,
                    searches: c.searches,
                    other: c.other,
                    finished: info.finished,
                    last_activity_ms: info.last_activity_ms,
                },
            ))
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    rows.into_iter().map(|r| r.1).collect()
}

#[tauri::command(async)]
pub fn session_subagents(jsonl_path: String) -> Result<Vec<SubagentLink>, String> {
    let root = crate::chatlog::projects_root().ok_or_else(|| "USERPROFILE not set".to_string())?;
    subagent_links_checked(&root, &jsonl_path)
}

fn subagent_links_checked(root: &Path, jsonl_path: &str) -> Result<Vec<SubagentLink>, String> {
    // Validate exactly like session_tail; then walk from the caller's own path
    // (check_under returns a \\?\ canonical form that pathguard rejects).
    crate::chatlog::check_under(root, jsonl_path)?;
    Ok(subagent_links_for(Path::new(jsonl_path)))
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

#[tauri::command(async)]
pub fn pane_subagents(cwd: String) -> Vec<SubagentInfo> {
    let Ok(home) = std::env::var("USERPROFILE") else { return Vec::new() };
    subagents_for(&Path::new(&home).join(".claude").join("projects"), &cwd)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn pane_plans(cwd: String) -> Vec<PlanEntry> {
    let Ok(home) = std::env::var("USERPROFILE") else { return Vec::new() };
    plans_for(&Path::new(&home).join(".claude").join("projects"), &cwd)
}

// ---------------------------------------------------------------------------
// QL-771: full-text search across a project's transcripts.
//
// The listing above indexes what a session IS; this searches what was SAID in
// it. Same files, same newest-first order, but every line is looked at, so the
// rules are all about not paying for the 25 MB monsters:
//
//   - streamed line by line (BufReader::read_until), never read whole;
//   - a raw byte-level, case-insensitive pre-filter on each line, so serde only
//     ever sees a line that could match — that's the difference between a scan
//     of ~110 MB in a couple of seconds and one in a couple of minutes;
//   - only the TEXT of user/assistant messages counts as a hit. tool_use inputs
//     and tool_result payloads (file contents, diffs, command output) are the
//     bulk of a transcript and are noise in a "what did we talk about" search;
//   - sidechain (sub-agent) lines are skipped for the same reason;
//   - SEARCH_FILE_CAP hits per file and SEARCH_CAP overall, both reported back
//     as `truncated` rather than silently trimming.
//
// Results are cached per (file, query) and invalidated by mtime+size, so
// retyping the same query, or searching again after only the live session grew,
// re-reads just the files that actually changed.
//
// Case-insensitivity is ASCII-folded (the same fold `contains` on a lowercased
// ASCII string would give). A non-ASCII query still matches its exact bytes.
// ---------------------------------------------------------------------------

/// Hits returned across all sessions in one search.
const SEARCH_CAP: usize = 200;
/// Hits taken from any one transcript before moving on — twenty rows of one
/// session is already more than a picker can show.
const SEARCH_FILE_CAP: usize = 20;
/// Characters of context each side of the match in a snippet.
const SNIPPET_RADIUS: usize = 120;
/// Below this a query matches nearly every line, which is a folder-wide read
/// for no signal. The UI asks for more characters instead.
const MIN_QUERY_CHARS: usize = 2;
/// (file, query) results kept warm. Twenty-odd sessions times a few queries.
const SEARCH_CACHE_CAP: usize = 128;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Session id = the transcript's file stem, so a hit resumes exactly the
    /// way a row from `list_claude_sessions` does.
    pub session_id: String,
    /// The line's own timestamp, epoch ms; 0 when the line carried none.
    pub timestamp_ms: u64,
    /// "user" or "assistant".
    pub role: String,
    /// ±SNIPPET_RADIUS characters around the match, whitespace collapsed, with
    /// an ellipsis on whichever end was cut.
    pub snippet: String,
    /// Matching lines found in this session — never more than SEARCH_FILE_CAP,
    /// which is what `truncated` warns about.
    pub session_hits: u64,
    /// Project folder the transcript belongs to (the line's own `cwd`), so an
    /// all-projects hit can open a pane in the right place. Empty if unknown.
    pub cwd: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// The time budget or file cap stopped the scan before every transcript was
    /// looked at; the UI says "partial results".
    pub partial: bool,
    /// Set when `regex` was requested and the pattern did not compile.
    pub error: Option<String>,
    pub hits: Vec<SearchHit>,
    /// A cap stopped the scan — the UI says "first N" rather than implying this
    /// is everything.
    pub truncated: bool,
    /// Transcripts actually opened (or served from cache) for this query.
    pub sessions_searched: u64,
}

struct SearchEntry {
    modified_ms: u64,
    len: u64,
    hits: Vec<SearchHit>,
    /// Monotonic stamp for the LRU eviction below.
    used: u64,
}

fn search_cache() -> &'static Mutex<HashMap<(PathBuf, String), SearchEntry>> {
    static S: OnceLock<Mutex<HashMap<(PathBuf, String), SearchEntry>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn search_tick() -> u64 {
    static T: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    T.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Byte offset of `needle` (already ASCII-lowercased) in `hay`, ASCII-folded.
/// Deliberately allocation-free: it runs on every line of every transcript.
fn find_ci(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    // Skipping ahead on the first byte with `position` (rather than testing
    // every offset) is what keeps a 110 MB folder scan sub-second.
    let (lo, up) = (needle[0], needle[0].to_ascii_uppercase());
    let last = hay.len() - needle.len();
    let mut i = 0usize;
    while i <= last {
        let Some(off) = hay[i..=last].iter().position(|&b| b == lo || b == up) else { return None };
        i += off;
        if hay[i..i + needle.len()]
            .iter()
            .zip(needle)
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
        {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// The spoken text of a user/assistant line, with its role — None for anything
/// that isn't a person or the agent talking (tool blocks, sidechains, meta
/// lines, the `<command-name>` wrappers slash-commands leave behind).
fn message_text(v: &serde_json::Value) -> Option<(String, String)> {
    let kind = v.get("type").and_then(|t| t.as_str())?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false)
        || v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false)
    {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        // Only `text` blocks: tool_use inputs and tool_result payloads are
        // skipped here, which is what keeps the results readable.
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
    Some((kind.to_string(), t.to_string()))
}

/// The match with SNIPPET_RADIUS characters of context each side, whitespace
/// collapsed to single spaces so a multi-line message still reads as one row.
fn snippet_around(text: &str, at: usize, needle_len: usize) -> String {
    let at = floor_boundary(text, at.min(text.len()));
    let after = ceil_boundary(text, (at + needle_len).min(text.len()));
    let start = text[..at]
        .char_indices()
        .rev()
        .nth(SNIPPET_RADIUS - 1)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let end = text[after..]
        .char_indices()
        .nth(SNIPPET_RADIUS)
        .map(|(i, _)| after + i)
        .unwrap_or(text.len());
    let flat = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        flat,
        if end < text.len() { "…" } else { "" }
    )
}

/// Bytes of one transcript a search will read at most (the newest part).
const SEARCH_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Transcripts looked at in an all-projects search.
const SEARCH_ALL_FILES: usize = 300;
/// Wall-clock budget for one search.
const SEARCH_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);
/// Largest compiled regex a user pattern may build.
const SEARCH_REGEX_SIZE: usize = 1 << 20;

#[derive(Clone)]
pub struct SearchOpts {
    pub all_projects: bool,
    pub regex: bool,
    pub budget: std::time::Duration,
    pub max_files: usize,
    pub max_bytes_per_file: u64,
}

impl Default for SearchOpts {
    fn default() -> Self {
        SearchOpts {
            all_projects: false,
            regex: false,
            budget: SEARCH_BUDGET,
            max_files: SEARCH_ALL_FILES,
            max_bytes_per_file: SEARCH_FILE_BYTES,
        }
    }
}

enum Matcher {
    /// ASCII-lowercased literal.
    Lit(String),
    Re(regex::Regex),
}

impl Matcher {
    /// Cheap raw-line test: could this JSON line contain a hit?
    fn prefilter(&self, raw: &[u8]) -> bool {
        match self {
            Matcher::Lit(n) => find_ci(raw, n.as_bytes()).is_some(),
            // A regex can't be run on JSON-escaped bytes reliably, so only
            // spoken lines are worth parsing.
            Matcher::Re(_) => find_ci(raw, b"\"type\":\"user\"").is_some() || find_ci(raw, b"\"type\":\"assistant\"").is_some(),
        }
    }
    /// (byte offset, byte length) of the first match in `text`.
    fn find(&self, text: &str) -> Option<(usize, usize)> {
        match self {
            Matcher::Lit(n) => find_ci(text.as_bytes(), n.as_bytes()).map(|i| (i, n.len())),
            Matcher::Re(r) => r.find(text).map(|m| (m.start(), m.end() - m.start())),
        }
    }
    fn key(&self) -> String {
        match self {
            Matcher::Lit(n) => n.clone(),
            Matcher::Re(r) => format!("re:{}", r.as_str()),
        }
    }
}

/// One transcript, streamed. Returns (hits, complete). `complete` is false when
/// the deadline stopped the scan, in which case the result must not be cached.
fn scan_file_for(path: &Path, m: &Matcher, deadline: std::time::Instant, max_bytes: u64) -> (Vec<SearchHit>, bool) {
    let Ok(mut f) = std::fs::File::open(path) else { return (Vec::new(), true) };
    let session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Over the cap: read only the newest max_bytes and drop the cut first line.
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let skip_first = len > max_bytes;
    if skip_first && f.seek(SeekFrom::Start(len - max_bytes)).is_err() {
        return (Vec::new(), true);
    }
    let mut reader = std::io::BufReader::with_capacity(256 * 1024, f);
    let mut buf: Vec<u8> = Vec::new();
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut complete = true;
    let mut first = true;
    let mut lines = 0u32;
    loop {
        buf.clear();
        match std::io::BufRead::read_until(&mut reader, b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        lines = lines.wrapping_add(1);
        if lines % 128 == 0 && std::time::Instant::now() >= deadline {
            complete = false;
            break;
        }
        if first {
            first = false;
            if skip_first {
                continue;
            }
        }
        // Pre-filter on the raw line: no match in the bytes means no match in
        // any field, so serde never runs. (A literal containing characters JSON
        // escapes, a quote, a backslash, a newline, won't match; that's the
        // price of not parsing 110 MB.)
        if !m.prefilter(&buf) {
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        let Some((role, text)) = message_text(&v) else { continue };
        // The raw line matched, but maybe only inside a tool payload.
        let Some((at, n)) = m.find(&text) else { continue };
        hits.push(SearchHit {
            session_id: session_id.clone(),
            timestamp_ms: v.get("timestamp").and_then(|t| t.as_str()).and_then(iso_ms).unwrap_or(0),
            role,
            snippet: snippet_around(&text, at, n),
            session_hits: 0, // filled in below, once the file's total is known
            cwd: v.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string(),
        });
        if hits.len() >= SEARCH_FILE_CAP {
            break;
        }
    }
    // One hit per matching line, however many times the term appears on it.
    let n = hits.len() as u64;
    for h in &mut hits {
        h.session_hits = n;
    }
    (hits, complete)
}

/// `scan_file_for` behind the mtime+size cache. The scan itself runs outside
/// the lock so a slow file can't block another pane's search.
fn search_file(path: &Path, m: &Matcher, deadline: std::time::Instant, max_bytes: u64) -> (Vec<SearchHit>, bool) {
    let Ok(meta) = std::fs::metadata(path) else { return (Vec::new(), true) };
    let (len, mtime) = (meta.len(), modified_ms(path));
    let key = (path.to_path_buf(), m.key());
    {
        let mut cache = search_cache().lock().unwrap();
        if let Some(e) = cache.get_mut(&key) {
            if e.modified_ms == mtime && e.len == len {
                e.used = search_tick();
                return (e.hits.clone(), true);
            }
        }
    }
    let (hits, complete) = scan_file_for(path, m, deadline, max_bytes);
    if !complete {
        return (hits, false);
    }
    let mut cache = search_cache().lock().unwrap();
    if cache.len() >= SEARCH_CACHE_CAP && !cache.contains_key(&key) {
        if let Some(oldest) = cache.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) {
            cache.remove(&oldest);
        }
    }
    cache.insert(key, SearchEntry { modified_ms: mtime, len, hits: hits.clone(), used: search_tick() });
    (hits, true)
}

fn jsonl_in(dir: &Path, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for p in entries.filter_map(|e| e.ok()).map(|e| e.path()) {
        if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
            let ms = modified_ms(&p);
            out.push((p, ms));
        }
    }
}

/// Sessions searched for `query`, newest session first: `cwd`'s project dir, or
/// every project under `projects_root` with `opts.all_projects`. Empty (never an
/// error) for no transcript dir or a query too short to mean anything; a bad
/// regex comes back in `error`.
pub fn search_sessions_with(projects_root: &Path, cwd: &str, query: &str, opts: &SearchOpts) -> SearchResults {
    let q = query.trim();
    if q.chars().count() < MIN_QUERY_CHARS {
        return SearchResults::default();
    }
    let matcher = if opts.regex {
        match regex::RegexBuilder::new(q).case_insensitive(true).size_limit(SEARCH_REGEX_SIZE).build() {
            Ok(r) => Matcher::Re(r),
            Err(e) => {
                let msg = e.to_string().lines().last().unwrap_or("invalid regex").trim().to_string();
                return SearchResults { error: Some(msg), ..Default::default() };
            }
        }
    } else {
        Matcher::Lit(q.to_ascii_lowercase())
    };
    let deadline = std::time::Instant::now() + opts.budget;
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    if opts.all_projects {
        if let Ok(dirs) = std::fs::read_dir(projects_root) {
            for d in dirs.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()) {
                jsonl_in(&d, &mut files);
            }
        }
    } else {
        jsonl_in(&projects_root.join(slugify(cwd)), &mut files);
    }
    // Same order and same window as the picker's list, so every hit belongs to
    // a session the launcher can also show a row for.
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let cap = if opts.all_projects { opts.max_files } else { LIST_CAP };
    let mut out = SearchResults::default();
    if files.len() > cap {
        files.truncate(cap);
        if opts.all_projects {
            out.partial = true;
        }
    }

    for (p, _) in &files {
        if out.hits.len() >= SEARCH_CAP {
            out.truncated = true;
            break;
        }
        if std::time::Instant::now() >= deadline {
            out.partial = true;
            break;
        }
        out.sessions_searched += 1;
        let (mut hits, complete) = search_file(p, &matcher, deadline, opts.max_bytes_per_file);
        if !complete {
            out.partial = true;
        }
        if hits.len() >= SEARCH_FILE_CAP {
            out.truncated = true;
        }
        let room = SEARCH_CAP - out.hits.len();
        if hits.len() > room {
            hits.truncate(room);
            out.truncated = true;
        }
        for h in &mut hits {
            if h.cwd.is_empty() && !opts.all_projects {
                h.cwd = cwd.to_string();
            }
        }
        out.hits.append(&mut hits);
    }
    out
}

pub fn search_sessions(projects_root: &Path, cwd: &str, query: &str) -> SearchResults {
    search_sessions_with(projects_root, cwd, query, &SearchOpts::default())
}

#[tauri::command]
pub async fn search_claude_sessions(cwd: String, query: String, all_projects: bool, regex: bool) -> SearchResults {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(home) = std::env::var("USERPROFILE") else { return SearchResults::default() };
        let opts = SearchOpts { all_projects, regex, ..Default::default() };
        search_sessions_with(&Path::new(&home).join(".claude").join("projects"), &cwd, &query, &opts)
    })
    .await
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Pricing (API-equivalent cost).
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing and
// https://platform.claude.com/docs/en/models/overview, checked 2026-10-04.
// USD per million tokens. Context: Opus 5.5 / Sonnet 5.5 / Fable are 1M,
// Opus and Sonnet 4.6+ are 1M at standard price, Haiku 4.5 and earlier 200K
// (the window lives in SessionLauncher.tsx's contextWindowFor).
// Opus 5.5 and Fable 5.1 cache reads are 0.05x / 0.025x input, not 0.1x.
// Haiku 3 and Opus 3 are no longer on the page (old list prices, kept so old
// transcripts still price).
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
}

const fn price(input: f64, output: f64, cache_read: f64) -> Price {
    Price { input, output, cache_write_5m: input * 1.25, cache_write_1h: input * 2.0, cache_read }
}

/// (family, major, minor) from a model id: "claude-opus-5-5" -> ("opus", 5, 5),
/// "claude-3-5-haiku-20241022" -> ("haiku", 3, 5), "claude-opus-4-1-20250805"
/// -> ("opus", 4, 1). A trailing "[1m]" or "-1m" is ignored.
fn model_key(model: &str) -> Option<(String, u32, u32)> {
    let lower = model.to_lowercase();
    let parts: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let fam = parts.iter().position(|p| matches!(*p, "opus" | "sonnet" | "haiku" | "fable" | "mythos"))?;
    // A date stamp is 8 digits and "1m" is not all digits, so neither lands here.
    let is_gen = |t: &&&str| t.chars().all(|c| c.is_ascii_digit()) && t.len() <= 2;
    let after: Vec<u32> = parts[fam + 1..].iter().filter(is_gen).filter_map(|t| t.parse().ok()).collect();
    let before: Vec<u32> = parts[..fam].iter().filter(is_gen).filter_map(|t| t.parse().ok()).collect();
    let gen = if !after.is_empty() { after } else { before };
    Some((parts[fam].to_string(), *gen.first()?, gen.get(1).copied().unwrap_or(0)))
}

/// Per-model price, None for ids this table does not know (shown without cost).
pub fn price_for(model: &str) -> Option<Price> {
    let (fam, major, minor) = model_key(model)?;
    let at_least = |a: u32, b: u32| (major, minor) >= (a, b);
    Some(match fam.as_str() {
        "fable" | "mythos" => price(10.0, 50.0, if at_least(5, 1) { 0.25 } else { 1.0 }),
        "opus" if at_least(5, 5) => price(4.0, 20.0, 0.20),
        "opus" if at_least(4, 5) => price(5.0, 25.0, 0.50),
        "opus" => price(15.0, 75.0, 1.50), // Opus 4, 4.1, 3
        "sonnet" if at_least(5, 0) => price(2.0, 10.0, 0.20),
        "sonnet" => price(3.0, 15.0, 0.30), // 4.x, 3.7, 3.5
        "haiku" if at_least(4, 5) => price(1.0, 5.0, 0.10),
        "haiku" if at_least(3, 5) => price(0.80, 4.0, 0.08),
        "haiku" => price(0.25, 1.25, 0.03),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Plan quota gauge: the subscription's 5-hour and weekly windows.
//
// Data source, in order of truthfulness:
//  1. Claude Code writes a `quotaLimits` object on the synthetic assistant line
//     it records when a request is rejected ("You've hit your session limit"):
//     status, rateLimitType ("five_hour" / "seven_day"), resetsAt (epoch s).
//     That is Claude's own reset time, so when one is still in the future it
//     is used and the source is "claude-reported". It only exists after a hit.
//  2. Otherwise tokens are summed from every session transcript (parents and
//     subagents, deduplicated by message+request id): the 5-hour window is the
//     block that began at the hour of the first message after the previous
//     block ended (the same rule ccusage uses), the weekly window the last
//     7 days. source = "estimated". Anthropic publishes no token caps, so pct
//     exists only for the 5-hour window, and only once a past rejection shows
//     what that account actually hit (largest token total at a rejection).
//
// Transcripts are read by offset per file (new bytes only). The first sight of
// a file reads it whole, once, off the UI thread.
// ---------------------------------------------------------------------------

const FIVE_H_MS: u64 = 5 * 3_600_000;
const WEEK_MS: u64 = 7 * 24 * 3_600_000;
const HOUR_MS: u64 = 3_600_000;
/// Per-file first read ceiling (tail), so one monster transcript can't stall a poll.
const QUOTA_FIRST_READ_CAP: u64 = 64 * 1024 * 1024;
/// Only transcripts touched this recently are scanned: the weekly window plus a
/// day of margin.
const QUOTA_SCAN_MS: u64 = 8 * 24 * 3_600_000;

#[derive(Clone, Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub used_tokens: u64,
    /// Epoch ms.
    pub window_start: u64,
    pub resets_at: Option<u64>,
    /// 0.0..=1.0+, None when no cap is known.
    pub pct: Option<f64>,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub five_hour: QuotaWindow,
    pub weekly: QuotaWindow,
    /// "claude-reported" | "estimated"
    pub source: &'static str,
}

/// A rejection record: when it was written, the window it names, its reset (ms).
#[derive(Clone, Debug, PartialEq)]
pub struct LimitHit {
    pub at_ms: u64,
    pub five_hour: bool,
    pub resets_at_ms: u64,
}

/// Counted tokens of one turn: input + output + cache writes. Cache reads are
/// excluded (they are what makes a long session cheap, and counting them
/// would swamp the number).
fn quota_tokens(usage: &serde_json::Value) -> u64 {
    let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens")
}

/// Start of the 5-hour block that `events` (sorted by time) place `t` in.
fn block_start_for(events: &[(u64, u64)], t: u64) -> u64 {
    let mut start: Option<u64> = None;
    for &(ts, _) in events {
        if ts > t {
            break;
        }
        match start {
            Some(s) if ts < s + FIVE_H_MS => {}
            _ => start = Some(ts - ts % HOUR_MS),
        }
    }
    start.unwrap_or(t - t % HOUR_MS)
}

/// Pure window computation. `events` = (timestamp ms, tokens), any order.
/// None when there is nothing in the last 7 days (the gauge hides itself).
pub fn compute_plan_usage(events: &[(u64, u64)], hits: &[LimitHit], now: u64) -> Option<PlanUsage> {
    let mut ev: Vec<(u64, u64)> = events.iter().copied().filter(|e| e.0 <= now).collect();
    ev.sort_unstable();
    let week_start = now.saturating_sub(WEEK_MS);
    let weekly_tokens: u64 = ev.iter().filter(|e| e.0 > week_start).map(|e| e.1).sum();
    let reported_5h = hits.iter().filter(|h| h.five_hour && h.resets_at_ms > now).map(|h| h.resets_at_ms).max();
    let reported_wk = hits.iter().filter(|h| !h.five_hour && h.resets_at_ms > now).map(|h| h.resets_at_ms).max();
    if weekly_tokens == 0 && reported_5h.is_none() && reported_wk.is_none() {
        return None;
    }

    // Active 5h block: the block `now` falls in, if any turn started it.
    let block = block_start_for(&ev, now);
    let in_block = now < block + FIVE_H_MS && ev.iter().any(|e| e.0 >= block);
    let (b_start, b_used, b_reset) = if in_block {
        let used = ev.iter().filter(|e| e.0 >= block && e.0 < block + FIVE_H_MS).map(|e| e.1).sum();
        (block, used, Some(block + FIVE_H_MS))
    } else {
        (now - now % HOUR_MS, 0, None)
    };

    // Cap: largest token total seen at a past 5h rejection.
    let cap = hits
        .iter()
        .filter(|h| h.five_hour)
        .map(|h| {
            let s = block_start_for(&ev, h.at_ms);
            ev.iter().filter(|e| e.0 >= s && e.0 <= h.at_ms).map(|e| e.1).sum::<u64>()
        })
        .max()
        .filter(|c| *c > 0);

    let mut five = QuotaWindow {
        used_tokens: b_used,
        window_start: b_start,
        resets_at: b_reset,
        pct: cap.map(|c| b_used as f64 / c as f64),
    };
    let mut weekly = QuotaWindow { used_tokens: weekly_tokens, window_start: week_start, resets_at: None, pct: None };
    if let Some(r) = reported_5h {
        five.resets_at = Some(r);
        five.window_start = r.saturating_sub(FIVE_H_MS);
        five.pct = Some(1.0); // rejected: the window is full
    }
    if let Some(r) = reported_wk {
        weekly.resets_at = Some(r);
        weekly.window_start = r.saturating_sub(WEEK_MS);
        weekly.pct = Some(1.0);
    }
    let source = if reported_5h.is_some() || reported_wk.is_some() { "claude-reported" } else { "estimated" };
    Some(PlanUsage { five_hour: five, weekly, source })
}

#[derive(Default)]
struct QuotaFile {
    offset: u64,
    carry: String,
}

#[derive(Default)]
struct QuotaState {
    files: HashMap<PathBuf, QuotaFile>,
    events: Vec<(u64, u64)>,
    seen: std::collections::HashSet<u64>,
    hits: Vec<LimitHit>,
}

fn quota_state() -> &'static Mutex<QuotaState> {
    static S: OnceLock<Mutex<QuotaState>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(QuotaState::default()))
}

fn hash_ids(a: &str, b: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    a.hash(&mut h);
    b.hash(&mut h);
    h.finish()
}

fn quota_line(line: &str, st: &mut QuotaState, cutoff: u64) {
    if !line.contains("\"usage\"") && !line.contains("quotaLimits") {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()).and_then(iso_ms) else { return };
    if ts < cutoff {
        return;
    }
    if let Some(q) = v.get("quotaLimits").filter(|q| q.is_object()) {
        if q.get("status").and_then(|s| s.as_str()) == Some("rejected") {
            if let Some(r) = q.get("resetsAt").and_then(|r| r.as_u64()) {
                let five = q.get("rateLimitType").and_then(|t| t.as_str()) == Some("five_hour");
                let h = LimitHit { at_ms: ts, five_hour: five, resets_at_ms: r * 1000 };
                if !st.hits.contains(&h) {
                    st.hits.push(h);
                }
            }
        }
    }
    let Some(msg) = v.get("message") else { return };
    let Some(usage) = msg.get("usage").filter(|u| u.is_object()) else { return };
    let tokens = quota_tokens(usage);
    if tokens == 0 {
        return;
    }
    // Resumed/forked sessions replay history; the same turn must count once.
    let id = msg.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let req = v.get("requestId").and_then(|x| x.as_str()).unwrap_or("");
    if !id.is_empty() && !st.seen.insert(hash_ids(id, req)) {
        return;
    }
    st.events.push((ts, tokens));
}

fn quota_scan_file(path: &Path, st: &mut QuotaState, cutoff: u64) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    let len = meta.len();
    let mut f = st.files.remove(path).unwrap_or_else(|| QuotaFile {
        offset: len.saturating_sub(QUOTA_FIRST_READ_CAP),
        carry: String::new(),
    });
    if len < f.offset {
        f = QuotaFile::default();
    }
    if len > f.offset {
        if let Ok(mut file) = std::fs::File::open(path) {
            if file.seek(SeekFrom::Start(f.offset)).is_ok() {
                let mut buf = Vec::new();
                if file.read_to_end(&mut buf).is_ok() {
                    f.offset = f.offset + buf.len() as u64;
                    let chunk = std::mem::take(&mut f.carry) + &String::from_utf8_lossy(&buf);
                    let upto = chunk.rfind('\n').map(|i| i + 1).unwrap_or(0);
                    for line in chunk[..upto].lines() {
                        quota_line(line, st, cutoff);
                    }
                    f.carry = chunk[upto..].to_string();
                }
            }
        }
    }
    st.files.insert(path.to_path_buf(), f);
}

/// Every *.jsonl under the projects root (parents, and <session>/subagents/*)
/// modified inside the weekly window. Depth-bounded.
fn quota_files(dir: &Path, depth: u32, min_mtime: std::time::SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if depth < 4 {
                quota_files(&p, depth + 1, min_mtime, out);
            }
        } else if p.extension().map(|x| x == "jsonl").unwrap_or(false)
            && std::fs::metadata(&p).and_then(|m| m.modified()).map(|m| m >= min_mtime).unwrap_or(false)
        {
            out.push(p);
        }
    }
}

fn plan_usage_with(st: &mut QuotaState, projects_root: &Path, now: u64) -> Option<PlanUsage> {
    let cutoff = now.saturating_sub(WEEK_MS);
    let min_mtime = std::time::UNIX_EPOCH + std::time::Duration::from_millis(now.saturating_sub(QUOTA_SCAN_MS));
    let mut files = Vec::new();
    quota_files(projects_root, 0, min_mtime, &mut files);
    for f in &files {
        quota_scan_file(f, st, cutoff);
    }
    // Prune what has left the weekly window.
    st.events.retain(|e| e.0 >= cutoff);
    st.hits.retain(|h| h.at_ms >= cutoff);
    compute_plan_usage(&st.events, &st.hits, now)
}

pub fn plan_usage_at(projects_root: &Path, now: u64) -> Option<PlanUsage> {
    plan_usage_with(&mut quota_state().lock().unwrap(), projects_root, now)
}

#[tauri::command]
pub async fn plan_usage() -> Option<PlanUsage> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = std::env::var("USERPROFILE").ok()?;
        plan_usage_at(&Path::new(&home).join(".claude").join("projects"), now_ms())
    })
    .await
    .ok()
    .flatten()
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

    // --- TN3: session_subagents ------------------------------------------

    /// Parent transcript path (string) for the session `session_with_subagents` wrote.
    fn parent_of(root: &Path, cwd: &str) -> String {
        root.join(slugify(cwd)).join("sess.jsonl").to_string_lossy().into_owned()
    }

    fn write_meta_tool_use(root: &Path, cwd: &str, id: &str, tool_use_id: &str) {
        let subs = root.join(slugify(cwd)).join("sess").join("subagents");
        std::fs::write(
            subs.join(format!("agent-{id}.meta.json")),
            format!(r#"{{"agentType":"Explore","description":"d","toolUseId":"{tool_use_id}","spawnDepth":1}}"#),
        )
        .unwrap();
    }

    #[test]
    fn links_count_tools_by_class_and_read_tool_use_id() {
        let cwd = "D:\\proj\\links";
        let lines = vec![
            sub_tool("2026-10-01T10:00:00.000Z", "Edit", 1),
            sub_tool("2026-10-01T10:00:01.000Z", "MultiEdit", 1),
            sub_tool("2026-10-01T10:00:02.000Z", "Write", 1),
            sub_tool("2026-10-01T10:00:03.000Z", "NotebookEdit", 1),
            sub_tool("2026-10-01T10:00:04.000Z", "Bash", 1),
            sub_tool("2026-10-01T10:00:05.000Z", "PowerShell", 1),
            sub_tool("2026-10-01T10:00:06.000Z", "Read", 1),
            sub_tool("2026-10-01T10:00:07.000Z", "Grep", 1),
            sub_tool("2026-10-01T10:00:08.000Z", "Glob", 1),
            sub_tool("2026-10-01T10:00:09.000Z", "WebSearch", 1),
            sub_tool("2026-10-01T10:00:10.000Z", "WebFetch", 1),
            sub_tool("2026-10-01T10:00:11.000Z", "Agent", 1),
            sub_tool("2026-10-01T10:00:12.000Z", "mcp__x__y", 1),
            sub_text("2026-10-01T10:00:13.000Z", 5),
        ];
        let root = session_with_subagents(cwd, &[("aaa", "Explore", lines)]);
        write_meta_tool_use(&root, cwd, "aaa", "toolu_01");
        let links = subagent_links_checked(&root, &parent_of(&root, cwd)).unwrap();
        assert_eq!(links.len(), 1);
        let l = &links[0];
        assert_eq!(l.id, "aaa");
        assert_eq!(l.tool_use_id.as_deref(), Some("toolu_01"));
        assert_eq!(l.agent_type.as_deref(), Some("Explore"));
        assert_eq!((l.edits, l.commands, l.reads, l.searches, l.other), (4, 2, 1, 4, 2));
        assert!(l.finished);
        assert!(l.jsonl_path.ends_with("agent-aaa.jsonl"));
        // The frontend tails this path with session_tail, so its guard must accept it.
        assert_eq!(crate::chatlog::check_under(&root, &l.jsonl_path).is_ok(), true);
        let v = serde_json::to_value(l).unwrap();
        assert!(v.get("toolUseId").is_some() && v.get("lastActivityMs").is_some());
    }

    #[test]
    fn links_missing_meta_gives_nulls() {
        let cwd = "D:\\proj\\links-nometa";
        let root = session_with_subagents(cwd, &[("bbb", "Explore", vec![sub_tool("2026-10-01T10:00:00.000Z", "Read", 1)])]);
        let subs = root.join(slugify(cwd)).join("sess").join("subagents");
        std::fs::remove_file(subs.join("agent-bbb.meta.json")).unwrap();
        let links = subagent_links_checked(&root, &parent_of(&root, cwd)).unwrap();
        assert_eq!(links.len(), 1);
        assert!(links[0].tool_use_id.is_none() && links[0].agent_type.is_none() && links[0].description.is_none());
        assert!(!links[0].finished);
        assert_eq!(links[0].reads, 1);
    }

    #[test]
    fn links_finished_rule_and_incremental_append() {
        let cwd = "D:\\proj\\links-inc";
        let root = session_with_subagents(cwd, &[("ccc", "Explore", vec![sub_tool("2026-10-01T10:00:00.000Z", "Bash", 1)])]);
        let parent = parent_of(&root, cwd);
        let l = &subagent_links_checked(&root, &parent).unwrap()[0];
        assert_eq!((l.commands, l.finished), (1, false));
        let f = root.join(slugify(cwd)).join("sess").join("subagents").join("agent-ccc.jsonl");
        let mut body = std::fs::read_to_string(&f).unwrap();
        body += &(sub_result("2026-10-01T10:00:01.000Z") + "\n");
        body += &(sub_tool("2026-10-01T10:00:02.000Z", "Edit", 1) + "\n");
        std::fs::write(&f, &body).unwrap();
        let l = &subagent_links_checked(&root, &parent).unwrap()[0];
        assert_eq!((l.commands, l.edits, l.finished), (1, 1, false), "counts add, not recount");
        body += &(sub_text("2026-10-01T10:00:03.000Z", 5) + "\n");
        std::fs::write(&f, &body).unwrap();
        let l = &subagent_links_checked(&root, &parent).unwrap()[0];
        assert_eq!((l.commands, l.edits, l.finished), (1, 1, true));
    }

    #[test]
    fn links_oldest_spawn_first() {
        let cwd = "D:\\proj\\links-order";
        let root = session_with_subagents(
            cwd,
            &[
                ("new", "Explore", vec![sub_tool("2026-10-01T11:00:00.000Z", "Read", 1)]),
                ("old", "Explore", vec![sub_tool("2026-10-01T09:00:00.000Z", "Read", 1)]),
            ],
        );
        let links = subagent_links_checked(&root, &parent_of(&root, cwd)).unwrap();
        assert_eq!(links.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), vec!["old", "new"]);
    }

    #[test]
    fn links_reject_paths_outside_projects_root() {
        let cwd = "D:\\proj\\links-guard";
        let root = session_with_subagents(cwd, &[("ddd", "Explore", vec![sub_text("2026-10-01T10:00:00.000Z", 1)])]);
        let other = temp_root();
        let outside = other.join("sess.jsonl");
        std::fs::write(&outside, "{}\n").unwrap();
        assert!(subagent_links_checked(&root, &outside.to_string_lossy()).is_err());
        assert!(subagent_links_checked(&root, r"\\server\share\x.jsonl").is_err());
        let not_jsonl = root.join(slugify(cwd)).join("sess").join("subagents").join("agent-ddd.meta.json");
        assert!(subagent_links_checked(&root, &not_jsonl.to_string_lossy()).is_err());
    }

    #[test]
    fn links_cap_keeps_newest_fifty() {
        let cwd = "D:\\proj\\links-cap";
        let agents: Vec<(String, Vec<String>)> = (0..55)
            .map(|i| (format!("a{i:02}"), vec![sub_text(&format!("2026-10-01T10:{:02}:00.000Z", i % 60), 1)]))
            .collect();
        let borrowed: Vec<(&str, &str, Vec<String>)> =
            agents.iter().map(|(id, l)| (id.as_str(), "Explore", l.clone())).collect();
        let root = session_with_subagents(cwd, &borrowed);
        let links = subagent_links_checked(&root, &parent_of(&root, cwd)).unwrap();
        assert_eq!(links.len(), SUBAGENT_LINK_CAP);
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

    // --- QL-771: full-text search ----------------------------------------

    fn user_at(ts: &str, text: &str) -> String {
        format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":"{text}"}}}}"#
        )
    }

    fn asst_text(ts: &str, text: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"{text}"}}]}}}}"#
        )
    }

    #[test]
    fn searches_what_was_said_and_ignores_tool_traffic() {
        let root = temp_root();
        let cwd = "D:\\proj\\search";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            user_at("2026-08-11T01:00:00.000Z", "please fix the kraken chip"),
            asst_text("2026-08-11T01:01:00.000Z", "The KRAKEN chip is wired now."),
            // Tool traffic mentioning the term is not a conversation hit.
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"kraken.rs"}}]}}"#.to_string(),
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"kraken kraken kraken"}]}}"#.to_string(),
            // A sub-agent's turn is skipped too.
            r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"kraken from a sidechain"}}"#.to_string(),
            // And a slash-command wrapper.
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/kraken</command-name>"}}"#.to_string(),
        ];
        std::fs::write(dir.join("s1.jsonl"), lines.join("\n") + "\n").unwrap();

        let res = search_sessions(&root, cwd, "KrAkEn");
        assert_eq!(res.hits.len(), 2, "one user line, one assistant line, nothing else");
        assert!(!res.truncated);
        assert_eq!(res.sessions_searched, 1);
        assert_eq!(res.hits[0].session_id, "s1");
        assert_eq!(res.hits[0].role, "user");
        assert_eq!(res.hits[0].snippet, "please fix the kraken chip");
        assert_eq!(res.hits[0].timestamp_ms, iso_ms("2026-08-11T01:00:00.000Z").unwrap());
        assert_eq!(res.hits[1].role, "assistant");
        assert_eq!(res.hits[1].snippet, "The KRAKEN chip is wired now.");
        assert!(res.hits.iter().all(|h| h.session_hits == 2), "per-session count on every hit");

        // Too short to be a search, and a folder with no transcripts at all.
        assert!(search_sessions(&root, cwd, "k").hits.is_empty());
        assert!(search_sessions(&root, cwd, "   ").hits.is_empty());
        assert!(search_sessions(&root, "D:\\nope", "kraken").hits.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snippets_are_windowed_around_the_match() {
        let root = temp_root();
        let cwd = "D:\\proj\\snippet";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        // The term sits well inside a long message, with newlines around it.
        let filler = "padding ".repeat(80);
        std::fs::write(
            dir.join("s.jsonl"),
            user_at("2026-08-11T02:00:00.000Z", &format!("{filler}\\nneedle here\\n{filler}")) + "\n",
        )
        .unwrap();

        let hits = search_sessions(&root, cwd, "needle").hits;
        assert_eq!(hits.len(), 1);
        let s = &hits[0].snippet;
        assert!(s.contains("needle here"), "the match itself is in the snippet: {s}");
        assert!(s.starts_with('…') && s.ends_with('…'), "both ends were cut: {s}");
        assert!(!s.contains('\n'), "newlines collapsed for a one-line row");
        // ±120 chars of context plus the term, plus the two ellipses.
        assert!(s.chars().count() <= 2 * SNIPPET_RADIUS + 32, "snippet stays row-sized: {}", s.chars().count());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn caps_hits_per_file_and_overall_and_says_so() {
        let root = temp_root();
        let cwd = "D:\\proj\\caps";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        // Two sessions, each with far more matches than the per-file cap.
        for name in ["a", "b"] {
            let mut s = String::new();
            for i in 0..(SEARCH_FILE_CAP + 15) {
                s.push_str(&(user_at("2026-08-11T03:00:00.000Z", &format!("hit number {i} of many")) + "\n"));
            }
            std::fs::write(dir.join(format!("{name}.jsonl")), s).unwrap();
        }

        let res = search_sessions(&root, cwd, "hit number");
        assert_eq!(res.hits.len(), 2 * SEARCH_FILE_CAP, "early exit at the per-file cap");
        assert!(res.truncated, "the UI is told the list is not everything");
        assert!(res.hits.iter().all(|h| h.session_hits == SEARCH_FILE_CAP as u64));
        assert!(res.hits.len() <= SEARCH_CAP);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn newest_session_first_and_the_cache_follows_the_file() {
        let root = temp_root();
        let cwd = "D:\\proj\\order";
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("old.jsonl");
        let new = dir.join("new.jsonl");
        std::fs::write(&old, user_at("2026-08-11T01:00:00.000Z", "widget in the old session") + "\n").unwrap();
        std::fs::write(&new, user_at("2026-08-11T09:00:00.000Z", "widget in the new session") + "\n").unwrap();
        // mtimes are what the order is built from; make them unambiguous
        // (set_modified needs the handle opened for writing).
        let now = std::time::SystemTime::now();
        let touch = |p: &PathBuf, t: std::time::SystemTime| {
            std::fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(t).unwrap();
        };
        touch(&old, now - std::time::Duration::from_secs(3600));
        touch(&new, now);

        let first = search_sessions(&root, cwd, "widget");
        assert_eq!(
            first.hits.iter().map(|h| h.session_id.as_str()).collect::<Vec<_>>(),
            vec!["new", "old"],
            "newest session first"
        );

        // Repeat query, nothing changed: same answer (served from the cache).
        let again = search_sessions(&root, cwd, "widget");
        assert_eq!(again.hits.len(), first.hits.len());
        assert_eq!(again.hits[0].snippet, first.hits[0].snippet);

        // The live session grows: the cache is keyed on mtime+size, so the new
        // line shows up rather than the stale answer.
        let mut s = std::fs::read_to_string(&new).unwrap();
        s.push_str(&(user_at("2026-08-11T09:05:00.000Z", "another widget line") + "\n"));
        std::fs::write(&new, s).unwrap();
        let after = search_sessions(&root, cwd, "widget");
        assert_eq!(after.hits.len(), 3);
        assert_eq!(after.hits[0].session_hits, 2, "the grown session now has two");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Timing against the real transcript folder on this machine. Ignored by
    /// default (it depends on ~/.claude having content):
    /// `cargo test search_real_profile_timing -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn search_real_profile_timing() {
        let home = std::env::var("USERPROFILE").expect("USERPROFILE");
        let root = Path::new(&home).join(".claude").join("projects");
        let cwd = std::env::var("FD_SEARCH_CWD").unwrap_or_else(|_| "D:\\Dev\\ai".to_string());
        let cwd = cwd.as_str();
        // Set FD_SEARCH_QUERY to a term that matches nothing for the worst
        // case: no per-file early exit, so every byte is scanned.
        let q = std::env::var("FD_SEARCH_QUERY").unwrap_or_else(|_| "flightdeck".to_string());
        let t0 = std::time::Instant::now();
        let cold = search_sessions(&root, cwd, &q);
        let cold_ms = t0.elapsed().as_millis();
        let t1 = std::time::Instant::now();
        let warm = search_sessions(&root, cwd, &q);
        let warm_ms = t1.elapsed().as_millis();
        println!(
            "cold {cold_ms} ms / warm {warm_ms} ms — {} hits over {} sessions (truncated={})",
            cold.hits.len(),
            cold.sessions_searched,
            cold.truncated
        );
        assert_eq!(cold.hits.len(), warm.hits.len());
    }

    // --- Phase D: Codex rollouts -----------------------------------------------

    use crate::codexsessions::tests as cx;

    fn tc_line(last: serde_json::Value, window: u64, rl: serde_json::Value) -> String {
        serde_json::json!({
            "timestamp": "2026-10-03T01:05:00.000Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "input_tokens": 99999, "total_tokens": 99999 },
                    "last_token_usage": last,
                    "model_context_window": window
                },
                "rate_limits": rl
            }
        })
        .to_string()
    }

    fn rl(p5: f64, pw: f64) -> serde_json::Value {
        serde_json::json!({
            "primary": { "used_percent": p5, "window_minutes": 300, "resets_at": 1790000000u64 },
            "secondary": { "used_percent": pw, "window_minutes": 10080, "resets_at": 1790500000u64 },
            "credits": null, "plan_type": "plus"
        })
    }

    #[test]
    fn codex_usage_reads_newest_rollout_incrementally() {
        let r = cx::root("usage");
        let ctx = serde_json::json!({"type":"turn_context","payload":{"cwd":"C:\\Dev\\Repo","model":"gpt-5-codex"}}).to_string();
        let t1 = tc_line(serde_json::json!({"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":1050}), 272000, rl(12.5, 3.0));
        let path = cx::write_rollout(&r, "2026/10/03", cx::ID_A, r"C:\Dev\Repo", &[cx::user_event("hi"), ctx, t1]);

        let u = codex_usage_for(&r, "c:/dev/repo").expect("usage");
        assert_eq!(u.turns, 1);
        assert_eq!(u.context_tokens, 1050);
        assert_eq!(u.output_tokens, 50);
        assert_eq!((u.last_input_tokens, u.last_cache_read_tokens, u.last_cache_creation_tokens, u.last_output_tokens), (400, 600, 0, 50));
        assert_eq!(u.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(u.context_window, Some(272000));
        assert_eq!((u.plan_used_percent_5h, u.plan_resets_5h), (Some(12.5), Some(1790000000)));
        assert_eq!((u.plan_used_percent_week, u.plan_resets_week), (Some(3.0), Some(1790500000)));

        // The file grows: only the new tail is applied, cumulative output sums.
        let t2 = tc_line(serde_json::json!({"input_tokens":2000,"cached_input_tokens":1500,"output_tokens":70,"total_tokens":2070}), 272000, rl(14.0, 3.5));
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write;
        writeln!(f, "{t2}").unwrap();
        let u = codex_usage_for(&r, r"C:\Dev\Repo").unwrap();
        assert_eq!((u.turns, u.context_tokens, u.output_tokens), (2, 2070, 120));
        assert_eq!(u.plan_used_percent_5h, Some(14.0));
    }

    #[test]
    fn codex_unknown_schema_yields_no_chip_not_a_wrong_number() {
        let r = cx::root("usage-drift");
        let renamed = serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{
            "last_token_usage":{"prompt":1000,"completion":50},"model_context_window":272000}}}).to_string();
        let null_info = serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":null}}).to_string();
        let string_numbers = tc_line(serde_json::json!({"input_tokens":"1000","output_tokens":"5"}), 1, serde_json::json!(null));
        let wrong_shape = serde_json::json!({"type":"event_msg","payload":["token_count"]}).to_string();
        cx::write_rollout(&r, "2026/10/03", cx::ID_A, r"C:\Dev\Drift", &[cx::user_event("hi"), renamed, null_info, string_numbers, wrong_shape, "garbage{".into()]);
        assert!(codex_usage_for(&r, r"C:\Dev\Drift").is_none());
        // No rollout for a folder at all.
        assert!(codex_usage_for(&r, r"C:\Dev\Elsewhere").is_none());
    }

    #[test]
    fn codex_rate_limits_without_window_minutes_go_by_position_and_odd_windows_are_ignored() {
        let mut u = PaneUsage::default();
        apply_codex_rate_limits(&serde_json::json!({"primary":{"used_percent":7.0},"secondary":{"used_percent":9.0}}), &mut u);
        assert_eq!((u.plan_used_percent_5h, u.plan_used_percent_week), (Some(7.0), Some(9.0)));
        let mut u = PaneUsage::default();
        apply_codex_rate_limits(&serde_json::json!({"primary":{"used_percent":7.0,"window_minutes":1000}, "secondary":{"used_percent":-1.0}}), &mut u);
        assert_eq!((u.plan_used_percent_5h, u.plan_used_percent_week), (None, None));
    }

    #[test]
    fn staged_codex_args_must_be_resume_uuid() {
        assert!(check_staged("codex", &["resume".into(), cx::ID_A.into()]).is_ok());
        assert!(check_staged("codex", &["resume".into(), "x; calc".into()]).is_err());
        assert!(check_staged("codex", &["resume".into(), cx::ID_A.into(), "--fork-session".into()]).is_err());
        assert!(check_staged("codex", &["--yolo".into()]).is_err());
        assert!(check_staged("claude", &["--resume".into(), "anything".into()]).is_ok());
    }

    // ---- pricing -----------------------------------------------------------

    #[test]
    fn prices_current_models_from_the_published_table() {
        let p = price_for("claude-opus-5-5").unwrap();
        assert_eq!((p.input, p.output, p.cache_read), (4.0, 20.0, 0.20));
        assert_eq!((p.cache_write_5m, p.cache_write_1h), (5.0, 8.0));
        let s = price_for("claude-sonnet-5-5").unwrap();
        assert_eq!((s.input, s.output), (2.0, 10.0));
        assert_eq!(price_for("claude-sonnet-5"), Some(s));
        let h = price_for("claude-haiku-4-5-20251001").unwrap();
        assert_eq!((h.input, h.output, h.cache_read), (1.0, 5.0, 0.10));
        assert_eq!(price_for("claude-fable-5-1").unwrap().cache_read, 0.25);
        assert_eq!(price_for("claude-fable-5").unwrap().cache_read, 1.0);
    }

    #[test]
    fn prices_older_models_and_ignores_dates_and_1m_suffixes() {
        assert_eq!(price_for("claude-opus-4-1-20250805").unwrap().input, 15.0);
        assert_eq!(price_for("claude-opus-4-20250514").unwrap().output, 75.0);
        assert_eq!(price_for("claude-opus-4-5-20251101").unwrap().input, 5.0);
        assert_eq!(price_for("claude-opus-4-8").unwrap().output, 25.0);
        assert_eq!(price_for("claude-sonnet-4-5-20250929[1m]").unwrap().input, 3.0);
        assert_eq!(price_for("claude-sonnet-4-1m").unwrap().output, 15.0);
        assert_eq!(price_for("claude-3-5-haiku-20241022").unwrap().input, 0.80);
        assert_eq!(price_for("claude-3-opus-20240229").unwrap().input, 15.0);
        assert_eq!(price_for("<synthetic>"), None);
        assert_eq!(price_for("gpt-9"), None);
    }

    #[test]
    fn accumulates_api_equivalent_cost_per_turn() {
        let mut u = PaneUsage::default();
        let line = r#"{"message":{"model":"claude-opus-5-5","usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":1000000,"cache_creation_input_tokens":1000000,"cache_creation":{"ephemeral_1h_input_tokens":400000}}}}"#;
        apply_line(line, &mut u);
        // 4 + 20 + 0.2 + 0.6M*5 + 0.4M*8 = 4 + 20 + 0.2 + 3 + 3.2
        assert!((u.api_equiv_usd - 30.4).abs() < 1e-9, "{}", u.api_equiv_usd);
    }

    // ---- plan quota --------------------------------------------------------

    const H: u64 = 3_600_000;
    // 2026-10-05 00:00:00 UTC, an exact hour boundary.
    const T0: u64 = 1_791_158_400_000;

    #[test]
    fn five_hour_block_starts_at_the_first_message_hour_and_rolls_over() {
        // First turn at T0+0:20, another at +4:50 (same block), one at +5:10 (new block).
        let ev = [(T0 + 20 * 60_000, 100), (T0 + 4 * H + 50 * 60_000, 50), (T0 + 5 * H + 10 * 60_000, 7)];
        let mid = compute_plan_usage(&ev, &[], T0 + 4 * H + 55 * 60_000).unwrap();
        assert_eq!(mid.five_hour.window_start, T0);
        assert_eq!(mid.five_hour.used_tokens, 150);
        assert_eq!(mid.five_hour.resets_at, Some(T0 + 5 * H));
        assert_eq!(mid.source, "estimated");
        assert_eq!(mid.five_hour.pct, None);
        let next = compute_plan_usage(&ev, &[], T0 + 5 * H + 30 * 60_000).unwrap();
        assert_eq!(next.five_hour.window_start, T0 + 5 * H);
        assert_eq!(next.five_hour.used_tokens, 7);
        assert_eq!(next.weekly.used_tokens, 157);
    }

    #[test]
    fn idle_past_the_block_reports_an_empty_five_hour_window() {
        let ev = [(T0 + 10 * 60_000, 100)];
        let p = compute_plan_usage(&ev, &[], T0 + 6 * H).unwrap();
        assert_eq!(p.five_hour.used_tokens, 0);
        assert_eq!(p.five_hour.resets_at, None);
        assert_eq!(p.weekly.used_tokens, 100);
    }

    #[test]
    fn weekly_window_is_exactly_seven_days() {
        let now = T0 + 10 * 24 * H;
        let ev = [(now - 7 * 24 * H, 1000), (now - 7 * 24 * H + 1, 10), (now - H, 5)];
        let p = compute_plan_usage(&ev, &[], now).unwrap();
        assert_eq!(p.weekly.used_tokens, 15, "the turn exactly 7 days old has aged out");
        assert_eq!(p.weekly.window_start, now - 7 * 24 * H);
        assert!(compute_plan_usage(&[(now - 8 * 24 * H, 5)], &[], now).is_none(), "nothing recent hides the gauge");
    }

    #[test]
    fn a_future_rejection_is_claudes_own_reset_and_a_past_one_calibrates_the_cap() {
        let ev = [(T0 + 10 * 60_000, 600), (T0 + 2 * H, 400)];
        let past = LimitHit { at_ms: T0 + 2 * H, five_hour: true, resets_at_ms: T0 + 5 * H };
        // After the reset: estimated, with a cap of 1000 learned from the hit.
        let later = [(T0 + 6 * H, 250)];
        let all: Vec<_> = ev.iter().chain(later.iter()).copied().collect();
        let p = compute_plan_usage(&all, &[past.clone()], T0 + 6 * H + 60_000).unwrap();
        assert_eq!(p.source, "estimated");
        assert_eq!(p.five_hour.pct, Some(0.25));
        // While the rejection is still in force: reported, full.
        let q = compute_plan_usage(&ev, &[past], T0 + 3 * H).unwrap();
        assert_eq!(q.source, "claude-reported");
        assert_eq!(q.five_hour.resets_at, Some(T0 + 5 * H));
        assert_eq!(q.five_hour.pct, Some(1.0));
    }

    fn quota_asst(ts: &str, id: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","requestId":"r-{id}","message":{{"id":"{id}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":99999}}}}}}"#
        )
    }

    #[test]
    fn scans_incrementally_dedupes_replays_and_reads_subagents() {
        let root = temp_root();
        let proj = root.join("D--x");
        std::fs::create_dir_all(proj.join("s1").join("subagents")).unwrap();
        let main = proj.join("s1.jsonl");
        let now = iso_ms("2026-10-05T01:00:00.000Z").unwrap();
        std::fs::write(&main, format!("{}\n{}\n", quota_asst("2026-10-05T00:10:00.000Z", "a", 10, 5), "not json")).unwrap();
        let mut st = QuotaState::default();
        let p = plan_usage_with(&mut st, &root, now).unwrap();
        assert_eq!(p.five_hour.used_tokens, 15, "cache reads are not counted");
        let off1 = st.files[&main].offset;

        // Append a partial line, then finish it: only complete lines count.
        let b = quota_asst("2026-10-05T00:20:00.000Z", "b", 100, 0);
        let (head, tail) = b.split_at(40);
        let mut f = std::fs::OpenOptions::new().append(true).open(&main).unwrap();
        use std::io::Write;
        write!(f, "{head}").unwrap();
        assert_eq!(plan_usage_with(&mut st, &root, now).unwrap().five_hour.used_tokens, 15);
        writeln!(f, "{tail}").unwrap();
        writeln!(f, "{}", quota_asst("2026-10-05T00:10:00.000Z", "a", 10, 5)).unwrap(); // replayed turn
        assert_eq!(plan_usage_with(&mut st, &root, now).unwrap().five_hour.used_tokens, 115);
        assert!(st.files[&main].offset > off1, "continued from the offset, not from zero");

        // A subagent transcript counts toward the same window.
        std::fs::write(proj.join("s1").join("subagents").join("agent-1.jsonl"), format!("{}\n", quota_asst("2026-10-05T00:30:00.000Z", "c", 1, 1))).unwrap();
        assert_eq!(plan_usage_with(&mut st, &root, now).unwrap().five_hour.used_tokens, 117);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- session search: scope, regex, caps -------------------------------

    fn user_cwd(cwd: &str, text: &str) -> String {
        let c = cwd.replace('\\', "\\\\");
        format!(r#"{{"type":"user","cwd":"{c}","timestamp":"2026-08-11T01:00:00.000Z","message":{{"role":"user","content":"{text}"}}}}"#)
    }

    fn write_session(root: &Path, cwd: &str, name: &str, lines: &[String]) -> PathBuf {
        let dir = root.join(slugify(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!("{name}.jsonl"));
        std::fs::write(&f, lines.join("\n") + "\n").unwrap();
        f
    }

    #[test]
    fn all_projects_scope_finds_other_folders_and_reports_their_cwd() {
        let root = temp_root();
        let (a, b) = ("D:\\proj\\a", "D:\\proj\\b");
        write_session(&root, a, "sa", &[user_cwd(a, "the zanzibar plan")]);
        write_session(&root, b, "sb", &[user_cwd(b, "zanzibar elsewhere")]);

        let here = search_sessions(&root, a, "zanzibar");
        assert_eq!(here.hits.len(), 1);
        assert_eq!(here.hits[0].cwd, a);

        let all = search_sessions_with(&root, a, "zanzibar", &SearchOpts { all_projects: true, ..Default::default() });
        assert_eq!(all.hits.len(), 2);
        assert!(!all.partial);
        let mut cwds: Vec<_> = all.hits.iter().map(|h| h.cwd.clone()).collect();
        cwds.sort();
        assert_eq!(cwds, vec![a.to_string(), b.to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn regex_mode_matches_patterns_and_reports_bad_ones() {
        let root = temp_root();
        let cwd = "D:\\proj\\re";
        write_session(&root, cwd, "s1", &[
            user_cwd(cwd, "ticket QL-771 is open"),
            user_cwd(cwd, "ticket QL-nope is open"),
            user_cwd(cwd, "nothing here"),
        ]);
        let re = SearchOpts { regex: true, ..Default::default() };
        let res = search_sessions_with(&root, cwd, r"QL-\d+", &re);
        assert_eq!(res.hits.len(), 1);
        assert_eq!(res.hits[0].snippet, "ticket QL-771 is open");
        // The same text as a literal does not match.
        assert!(search_sessions(&root, cwd, r"QL-\d+").hits.is_empty());

        let bad = search_sessions_with(&root, cwd, "(unclosed", &re);
        assert!(bad.hits.is_empty());
        assert!(bad.error.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_caps_flag_partial_results() {
        let root = temp_root();
        for i in 0..3 {
            let cwd = format!("D:\\proj\\cap{i}");
            write_session(&root, &cwd, &format!("s{i}"), &[user_cwd(&cwd, "capword here")]);
        }
        // File cap.
        let capped = search_sessions_with(&root, "", "capword", &SearchOpts { all_projects: true, max_files: 2, ..Default::default() });
        assert!(capped.partial);
        assert_eq!(capped.sessions_searched, 2);
        // Time budget already spent.
        let timed = search_sessions_with(&root, "", "capword", &SearchOpts { all_projects: true, budget: std::time::Duration::ZERO, ..Default::default() });
        assert!(timed.partial);
        assert!(timed.hits.is_empty());
        // Unbounded run is complete.
        let full = search_sessions_with(&root, "", "capword", &SearchOpts { all_projects: true, ..Default::default() });
        assert!(!full.partial);
        assert_eq!(full.hits.len(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_transcript_is_read_from_its_tail_only() {
        let root = temp_root();
        let cwd = "D:\\proj\\big";
        let late = user_cwd(cwd, "bigword late");
        write_session(&root, cwd, "s1", &[
            user_cwd(cwd, "bigword early"),
            user_cwd(cwd, "filler filler filler filler filler filler"),
            late.clone(),
        ]);
        let opts = SearchOpts { max_bytes_per_file: late.len() as u64 + 10, ..Default::default() };
        let res = search_sessions_with(&root, cwd, "bigword", &opts);
        assert_eq!(res.hits.len(), 1);
        assert_eq!(res.hits[0].snippet, "bigword late");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn first_scan_skips_transcripts_older_than_eight_days() {
        let root = temp_root();
        let proj = root.join(slugify("D:\\proj\\q"));
        std::fs::create_dir_all(&proj).unwrap();
        let now = iso_ms("2026-10-05T01:00:00.000Z").unwrap();
        let line = format!("{}\n", quota_asst("2026-10-05T00:10:00.000Z", "a", 10, 5));
        let at = |ms: u64| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        let day = 24 * 3_600_000u64;
        let stale = proj.join("stale.jsonl");
        let edge = proj.join("edge.jsonl");
        std::fs::write(&stale, &line).unwrap();
        std::fs::write(&edge, &line).unwrap();
        std::fs::File::options().write(true).open(&stale).unwrap().set_modified(at(now - 9 * day)).unwrap();
        std::fs::File::options().write(true).open(&edge).unwrap().set_modified(at(now - 7 * day - day / 2)).unwrap();

        let mut st = QuotaState::default();
        plan_usage_with(&mut st, &root, now);
        assert!(!st.files.contains_key(&stale), "9-day-old file is never opened");
        assert!(st.files.contains_key(&edge), "inside the 8-day margin it is scanned");

        // Incremental cache still works: a second pass reads nothing new.
        let off = st.files[&edge].offset;
        plan_usage_with(&mut st, &root, now);
        assert_eq!(st.files[&edge].offset, off);
        assert_eq!(st.events.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_the_rejection_record_claude_code_writes() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-05T00:30:00.000Z","message":{"id":"m","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}},"quotaLimits":{"status":"rejected","resetsAt":1790999999,"rateLimitType":"five_hour"}}"#;
        let mut st = QuotaState::default();
        quota_line(line, &mut st, 0);
        assert_eq!(st.hits, vec![LimitHit { at_ms: iso_ms("2026-10-05T00:30:00.000Z").unwrap(), five_hour: true, resets_at_ms: 1_790_999_999_000 }]);
    }
}
