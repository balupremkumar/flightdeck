//! Config doctor backend (ledger G4): which instruction/memory files an agent
//! will read for a cwd (stat only, never content), and a bounded runner for
//! `claude plugin validate`. Read-only: nothing here writes.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::pathguard;

const VALIDATE_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Cap on captured output per stream, so a runaway validator can't balloon IPC.
const OUTPUT_CAP: usize = 256 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InstructionFile {
    pub path: String,
    pub exists: bool,
    pub size: u64,
    pub mtime_ms: Option<u64>,
    /// "user" | "project" | "parent" | "local" | "memory"
    pub scope: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Family {
    Claude,
    Codex,
    Agy,
    /// opencode and any other agent: AGENTS.md convention.
    Agents,
}

fn family(vendor: &str) -> Family {
    let v = vendor.to_ascii_lowercase();
    if v == "claude" || v.starts_with("claude-") {
        Family::Claude
    } else if v.contains("codex") {
        Family::Codex
    } else if v == "agy" || v.contains("gemini") || v.contains("antigravity") {
        Family::Agy
    } else {
        Family::Agents
    }
}

/// Claude Code's project memory dir name: every non-alphanumeric char becomes '-'.
pub(crate) fn project_slug(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// cwd and its ancestors, root first (so more specific files come later, which
/// is the order agents load them in).
fn ancestors_root_first(cwd: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = cwd.ancestors().map(Path::to_path_buf).collect();
    v.reverse();
    v.retain(|p| !p.as_os_str().is_empty());
    v
}

fn managed_dir() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\ClaudeCode")
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    }
}

/// The ordered candidate list. Returns (path, scope, only_if_present).
fn plan(cwd: &Path, vendor: &str, home: Option<&Path>, managed: &Path) -> Vec<(PathBuf, &'static str, bool)> {
    let mut out: Vec<(PathBuf, &'static str, bool)> = Vec::new();
    let dirs = ancestors_root_first(cwd);
    let scope_for = |d: &Path| if d == cwd { "project" } else { "parent" };
    match family(vendor) {
        Family::Claude => {
            out.push((managed.join("CLAUDE.md"), "user", true));
            if let Some(h) = home {
                out.push((h.join(".claude").join("CLAUDE.md"), "user", false));
            }
            for d in &dirs {
                out.push((d.join("CLAUDE.md"), scope_for(d), false));
                out.push((d.join("CLAUDE.local.md"), "local", false));
            }
            if let Some(h) = home {
                out.push((h.join(".claude").join("settings.json"), "user", false));
            }
            out.push((cwd.join(".claude").join("settings.json"), "project", false));
            out.push((cwd.join(".claude").join("settings.local.json"), "local", false));
            if let Some(h) = home {
                let mem = h.join(".claude").join("projects").join(project_slug(cwd)).join("memory").join("MEMORY.md");
                out.push((mem, "memory", true));
            }
        }
        Family::Codex => {
            if let Some(h) = home {
                // Codex reads the override if present, else AGENTS.md.
                let o = h.join(".codex").join("AGENTS.override.md");
                out.push((if o.is_file() { o } else { h.join(".codex").join("AGENTS.md") }, "user", false));
            }
            for d in &dirs {
                out.push((d.join("AGENTS.override.md"), scope_for(d), true));
                out.push((d.join("AGENTS.md"), scope_for(d), false));
            }
        }
        Family::Agy => {
            if let Some(h) = home {
                out.push((h.join(".gemini").join("GEMINI.md"), "user", false));
            }
            for d in &dirs {
                out.push((d.join("GEMINI.md"), scope_for(d), false));
                out.push((d.join("AGENTS.md"), scope_for(d), false));
            }
        }
        Family::Agents => {
            for d in &dirs {
                out.push((d.join("AGENTS.md"), scope_for(d), false));
            }
        }
    }
    out
}

/// Stat only. Never opens a file.
fn stat(path: &Path, scope: &'static str) -> InstructionFile {
    let (exists, size, mtime_ms) = match std::fs::metadata(path) {
        Ok(m) if m.is_file() => {
            let ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            (true, m.len(), ms)
        }
        _ => (false, 0, None),
    };
    InstructionFile { path: path.to_string_lossy().into_owned(), exists, size, mtime_ms, scope }
}

pub(crate) fn collect(cwd: &Path, vendor: &str, home: Option<&Path>, managed: &Path) -> Vec<InstructionFile> {
    plan(cwd, vendor, home, managed)
        .into_iter()
        .filter(|(p, _, _)| !pathguard::is_remote_or_device(p))
        .map(|(p, scope, only_present)| (stat(&p, scope), only_present))
        .filter(|(f, only_present)| f.exists || !only_present)
        .map(|(f, _)| f)
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

#[tauri::command(async)]
pub fn instruction_files(cwd: String, vendor: String) -> Result<Vec<InstructionFile>, String> {
    pathguard::check(&cwd)?;
    let cwd = PathBuf::from(&cwd);
    if !cwd.is_absolute() {
        return Err("cwd must be an absolute path".into());
    }
    let home = home_dir();
    Ok(collect(&cwd, &vendor, home.as_deref(), &managed_dir()))
}

// ---------------------------------------------------------------------------
// Bounded process runner
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct RunOutput {
    /// "ok" (exit 0) | "failed" (non-zero) | "timeout" | "spawn-error"
    pub status: &'static str,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(r) = r {
            let _ = r.take(OUTPUT_CAP as u64).read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

/// Spawns `program` directly (no shell), stdin closed so nothing can prompt,
/// and kills it if it outlives `timeout`.
pub(crate) fn run_bounded(program: &Path, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> RunOutput {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOutput { status: "spawn-error", code: None, stdout: String::new(), stderr: e.to_string() };
        }
    };
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let start = Instant::now();
    let (status, code) = loop {
        match child.try_wait() {
            Ok(Some(s)) => break (if s.success() { "ok" } else { "failed" }, s.code()),
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break ("timeout", None);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break ("failed", None),
        }
    };
    // After a kill a grandchild may hold the pipe open; don't wait on it forever.
    let join = |h: std::thread::JoinHandle<String>| {
        let t0 = Instant::now();
        while !h.is_finished() && t0.elapsed() < Duration::from_millis(500) {
            std::thread::sleep(Duration::from_millis(10));
        }
        if h.is_finished() { h.join().unwrap_or_default() } else { String::new() }
    };
    RunOutput { status, code, stdout: join(out), stderr: join(err) }
}

/// First match of `claude` on PATH, preferring a real exe over a .cmd shim.
fn find_claude() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd", "claude.bat"] } else { &["claude"] };
    for dir in std::env::split_paths(&path) {
        for n in names {
            let c = dir.join(n);
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

#[derive(Serialize, Debug, Clone)]
pub struct ValidateResult {
    /// false: no claude on PATH, or this version has no `plugin validate`.
    pub available: bool,
    pub version: Option<String>,
    pub ok: bool,
    pub timed_out: bool,
    pub code: Option<i32>,
    pub output: String,
    pub message: String,
}

/// True when `plugin validate --help` succeeded and mentions validate.
fn validate_supported(help: &RunOutput) -> bool {
    help.status == "ok" && help.stdout.to_ascii_lowercase().contains("validate")
}

fn combine(o: &RunOutput) -> String {
    match (o.stdout.trim_end(), o.stderr.trim_end()) {
        (a, "") => a.to_string(),
        ("", b) => b.to_string(),
        (a, b) => format!("{a}\n{b}"),
    }
}

pub(crate) fn validate_with(claude: &Path, path: &Path, timeout: Duration) -> ValidateResult {
    let ver = run_bounded(claude, &["--version"], None, PROBE_TIMEOUT);
    let version = (ver.status == "ok").then(|| ver.stdout.trim().to_string());
    let help = run_bounded(claude, &["plugin", "validate", "--help"], None, PROBE_TIMEOUT);
    if !validate_supported(&help) {
        return ValidateResult {
            available: false, version, ok: false, timed_out: false, code: None, output: String::new(),
            message: "Not available in this Claude Code version".into(),
        };
    }
    // stdin is closed, so nothing can prompt; the report is plain text.
    let p = path.to_string_lossy();
    let r = run_bounded(claude, &["plugin", "validate", &p], Some(path), timeout);
    ValidateResult {
        available: true,
        version,
        ok: r.status == "ok",
        timed_out: r.status == "timeout",
        code: r.code,
        output: combine(&r),
        message: match r.status {
            "ok" => "Validation passed".into(),
            "timeout" => format!("Timed out after {} s", timeout.as_secs()),
            "spawn-error" => format!("Couldn't start claude: {}", r.stderr),
            _ => "Validation failed".into(),
        },
    }
}

#[tauri::command(async)]
pub fn plugin_validate(cwd: String) -> Result<ValidateResult, String> {
    pathguard::check(&cwd)?;
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err("Folder not found".into());
    }
    match find_claude() {
        None => Ok(ValidateResult {
            available: false, version: None, ok: false, timed_out: false, code: None, output: String::new(),
            message: "Claude Code isn't installed, or isn't on PATH".into(),
        }),
        Some(c) => Ok(validate_with(&c, &dir, VALIDATE_TIMEOUT)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fd-doctor-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn claude_walk_up_is_root_first_and_cwd_last() {
        let base = tree("walk");
        let cwd = base.join("a").join("b");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(base.join("CLAUDE.md"), "x").unwrap();
        std::fs::write(base.join("a").join("CLAUDE.md"), "yy").unwrap();
        std::fs::write(cwd.join("CLAUDE.local.md"), "zzz").unwrap();
        let home = base.join("home");
        let files = collect(&cwd, "claude", Some(&home), &base.join("nomanaged"));
        let ps: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        let at = |needle: PathBuf| ps.iter().position(|p| *p == needle.to_string_lossy()).unwrap();
        assert!(at(home.join(".claude").join("CLAUDE.md")) < at(base.join("CLAUDE.md")));
        assert!(at(base.join("CLAUDE.md")) < at(base.join("a").join("CLAUDE.md")));
        assert!(at(base.join("a").join("CLAUDE.md")) < at(cwd.join("CLAUDE.md")));
        assert!(at(cwd.join("CLAUDE.md")) < at(cwd.join("CLAUDE.local.md")));
        assert!(at(cwd.join("CLAUDE.local.md")) < at(cwd.join(".claude").join("settings.json")));
        let f = |p: PathBuf| files.iter().find(|f| f.path == p.to_string_lossy()).unwrap().clone();
        assert_eq!(f(base.join("a").join("CLAUDE.md")).scope, "parent");
        assert_eq!(f(base.join("a").join("CLAUDE.md")).size, 2);
        assert!(f(base.join("a").join("CLAUDE.md")).exists);
        assert_eq!(f(cwd.join("CLAUDE.md")).scope, "project");
        assert!(!f(cwd.join("CLAUDE.md")).exists);
        assert_eq!(f(cwd.join("CLAUDE.local.md")).scope, "local");
        // managed + memory are omitted when absent
        assert!(!ps.iter().any(|p| p.contains("nomanaged")));
        assert!(!files.iter().any(|f| f.scope == "memory"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn memory_file_listed_when_present() {
        let base = tree("mem");
        let cwd = base.join("proj");
        std::fs::create_dir_all(&cwd).unwrap();
        let home = base.join("home");
        let m = home.join(".claude").join("projects").join(project_slug(&cwd)).join("memory");
        std::fs::create_dir_all(&m).unwrap();
        std::fs::write(m.join("MEMORY.md"), "m").unwrap();
        let files = collect(&cwd, "claude", Some(&home), &base.join("none"));
        assert!(files.iter().any(|f| f.scope == "memory" && f.exists));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn slug_replaces_non_alphanumerics() {
        assert_eq!(project_slug(Path::new(r"D:\Dev\ai\flight.deck")), "D--Dev-ai-flight-deck");
    }

    #[test]
    fn stat_only_never_reads_content() {
        let base = tree("stat");
        // A directory named like an instruction file is not a file, and a file
        // of invalid UTF-8 is reported by metadata alone.
        std::fs::create_dir_all(base.join("CLAUDE.md")).unwrap();
        std::fs::write(base.join("AGENTS.md"), vec![0xff_u8; 50_000]).unwrap();
        let c = stat(&base.join("CLAUDE.md"), "project");
        assert!(!c.exists);
        let a = stat(&base.join("AGENTS.md"), "project");
        assert!(a.exists);
        assert_eq!(a.size, 50_000);
        assert!(a.mtime_ms.is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn agents_family_and_codex_override() {
        let base = tree("fam");
        let cwd = base.join("p");
        std::fs::create_dir_all(&cwd).unwrap();
        let files = collect(&cwd, "opencode-local", None, &base);
        assert!(files.iter().all(|f| f.path.ends_with("AGENTS.md")));
        let gem = collect(&cwd, "agy", Some(&base.join("h")), &base);
        assert!(gem.iter().any(|f| f.path.ends_with("GEMINI.md")));
        std::fs::write(cwd.join("AGENTS.override.md"), "o").unwrap();
        let cx = collect(&cwd, "codex", Some(&base.join("h")), &base);
        assert!(cx.iter().any(|f| f.path.ends_with("AGENTS.override.md") && f.exists));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_network_cwd() {
        assert!(instruction_files(r"\\server\share".into(), "claude".into()).is_err());
        assert!(plugin_validate(r"\\server\share".into()).is_err());
    }

    #[cfg(windows)]
    fn sh() -> PathBuf { PathBuf::from("cmd.exe") }
    #[cfg(not(windows))]
    fn sh() -> PathBuf { PathBuf::from("sh") }
    #[cfg(windows)]
    const FLAG: &str = "/C";
    #[cfg(not(windows))]
    const FLAG: &str = "-c";

    #[test]
    fn runner_captures_output_and_exit_code() {
        let o = run_bounded(&sh(), &[FLAG, "echo hello"], None, Duration::from_secs(10));
        assert_eq!(o.status, "ok");
        assert!(o.stdout.contains("hello"));
        let f = run_bounded(&sh(), &[FLAG, "exit 3"], None, Duration::from_secs(10));
        assert_eq!(f.status, "failed");
        assert_eq!(f.code, Some(3));
    }

    #[test]
    fn runner_times_out_and_kills() {
        #[cfg(windows)]
        let slow = "ping -n 30 127.0.0.1 >nul";
        #[cfg(not(windows))]
        let slow = "sleep 30";
        let t = Instant::now();
        let o = run_bounded(&sh(), &[FLAG, slow], None, Duration::from_millis(300));
        assert_eq!(o.status, "timeout");
        assert!(t.elapsed() < Duration::from_secs(5), "took {:?}", t.elapsed());
    }

    #[test]
    fn runner_reports_spawn_error() {
        let o = run_bounded(Path::new("definitely-not-a-real-program-xyz"), &[], None, Duration::from_secs(2));
        assert_eq!(o.status, "spawn-error");
    }

    #[test]
    fn validate_support_detection() {
        let bad = RunOutput { status: "failed", code: Some(1), stdout: String::new(), stderr: "unknown command".into() };
        assert!(!validate_supported(&bad));
        let ok = RunOutput { status: "ok", code: Some(0), stdout: "Usage: claude plugin validate".into(), stderr: String::new() };
        assert!(validate_supported(&ok));
    }
}
