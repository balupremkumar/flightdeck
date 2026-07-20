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
    let Some(usage) = v.get("message").and_then(|m| m.get("usage")).filter(|u| u.is_object()) else { return };
    let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let context = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    if context == 0 && n("output_tokens") == 0 {
        return; // e.g. a synthetic/empty usage block
    }
    u.context_tokens = context;
    u.output_tokens += n("output_tokens");
    u.turns += 1;
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

/// Usage for the pane rooted at `cwd`, from the most recently written session
/// transcript in that cwd's project dir. None = no transcript (not a Claude
/// pane, or no session yet).
pub fn usage_for(projects_root: &Path, cwd: &str) -> Option<PaneUsage> {
    let dir = projects_root.join(slugify(cwd));
    let newest = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())?;
    scan(&newest).filter(|u| u.turns > 0)
}

#[tauri::command]
pub fn pane_usage(cwd: String) -> Option<PaneUsage> {
    let home = std::env::var("USERPROFILE").ok()?;
    let root = Path::new(&home).join(".claude").join("projects");
    usage_for(&root, &cwd)
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
}
