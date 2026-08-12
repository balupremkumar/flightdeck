// applog.rs — the flight recorder. Every layer that can fail silently writes
// one line here: Rust panics (hook installed in init), frontend render
// crashes / window.onerror / unhandled rejections (via the log_event command),
// and anything else that wants a durable trace. Before this file existed a
// broken release left ZERO evidence on disk (the v0.5.3 boot failure could not
// be diagnosed after the fact) — that is the failure mode this module removes.
//
// Shape: append-only text file <app-data>/logs/flightdeck.log, rotated once
// past MAX_LOG_BYTES to flightdeck.log.1 (previous .1 replaced). Entries are
// timestamped UTC, single-line-headed with 4-space continuation for stacks, so
// `^\d` greps entry starts. Every message passes through support::redact
// before it touches disk — same posture as scrollback persistence (QL-762).
//
// The core functions are path-parameterised for tests (same pattern as the agy
// trust helpers); the process-wide wrappers resolve through a OnceLock set by
// init(), and are no-ops until then, so early callers can never panic the app
// over logging.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::support;

const LOG_FILE: &str = "flightdeck.log";
const MAX_LOG_BYTES: u64 = 1_000_000;
/// A single entry larger than this is truncated (a runaway stack or a pasted
/// buffer must not blow the whole budget in one write).
const MAX_ENTRY_BYTES: usize = 16 * 1024;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
// Serialises rotate+append so two threads can't interleave mid-entry.
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Install the log dir + panic hook. Called once from run() as soon as the
/// app-data dir resolves. Failure to create the dir simply leaves logging off.
pub fn init(dir: PathBuf, app_version: &str) {
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if LOG_DIR.set(dir).is_err() {
        return; // second init (tests, hot paths) — first one wins
    }
    // Chain the previous hook so the default stderr print (useful under a dev
    // console) still happens after we've written the durable line.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string panic payload".into()
        };
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        log("error", "rust-panic", &format!("thread '{thread}' panicked at {location}: {payload}"));
        previous(info);
    }));
    log("info", "boot", &format!("Flightdeck {app_version} starting"));
}

/// Process-wide append. No-op before init() or if the dir was never writable.
pub fn log(level: &str, source: &str, message: &str) {
    let Some(dir) = LOG_DIR.get() else { return };
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _ = write_line_at(&dir.join(LOG_FILE), level, source, message);
}

/// The path of the current log file, if logging is live. Frontend surfaces
/// (ErrorBoundary, Settings > Diagnostics) reveal this in Explorer.
pub fn current_log_path() -> Option<PathBuf> {
    LOG_DIR.get().map(|d| d.join(LOG_FILE))
}

/// Last `max_bytes` of the current log, snapped forward to a line boundary —
/// what the support bundle embeds. None when there is nothing to read.
pub fn tail(max_bytes: usize) -> Option<String> {
    let path = current_log_path()?;
    tail_at(&path, max_bytes)
}

// ---------------------------------------------------------------------------
// Path-parameterised core (testable without touching the process globals)
// ---------------------------------------------------------------------------

fn write_line_at(path: &Path, level: &str, source: &str, message: &str) -> std::io::Result<()> {
    rotate_if_needed(path);
    let mut entry = message.trim_end();
    if entry.len() > MAX_ENTRY_BYTES {
        // Snap to a char boundary below the cap; markers make truncation visible.
        let mut end = MAX_ENTRY_BYTES;
        while end > 0 && !entry.is_char_boundary(end) {
            end -= 1;
        }
        entry = &entry[..end];
    }
    let redacted = support::redact(entry);
    // Continuation indent keeps multi-line stacks inside one visual entry.
    let body = redacted.replace('\n', "\n    ");
    let level_tag = match level {
        "error" => "E",
        "warn" => "W",
        _ => "I",
    };
    let line = format!("{} {} {} | {}\n", iso_utc_now(), level_tag, source, body);
    let mut f = fs::OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(line.as_bytes())
}

fn rotate_if_needed(path: &Path) {
    let too_big = fs::metadata(path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false);
    if !too_big {
        return;
    }
    let rotated = path.with_extension("log.1");
    // rename replaces an existing .1 on Windows only after removal.
    let _ = fs::remove_file(&rotated);
    let _ = fs::rename(path, &rotated);
}

fn tail_at(path: &Path, max_bytes: usize) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    if text.len() <= max_bytes {
        return Some(text.into_owned());
    }
    let cut = &text[text.len() - max_bytes..];
    // Drop the (likely partial) first line so the tail starts on an entry.
    Some(match cut.find('\n') {
        Some(i) => cut[i + 1..].to_string(),
        None => cut.to_string(),
    })
}

// ---------------------------------------------------------------------------
// UTC timestamp, dependency-free (Howard Hinnant's civil-from-days algorithm).
// Millisecond precision so entries correlate with the Windows event log.
// ---------------------------------------------------------------------------

fn iso_utc_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso_utc_from_millis(now.as_millis() as u64)
}

fn iso_utc_from_millis(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, min, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{min:02}:{s:02}.{millis:03}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Frontend log intake. Level is normalised, size capped in write_line_at.
/// The frontend additionally caps itself per session (see src/applog.ts) so a
/// crash loop can't grind the disk.
#[tauri::command]
pub fn log_event(level: String, source: String, message: String) {
    let level = match level.as_str() {
        "error" | "warn" | "info" => level,
        _ => "info".to_string(),
    };
    log(&level, &source, &message);
}

/// Where the log lives, for reveal-in-Explorer surfaces. None until init or
/// when logging never came up.
#[tauri::command]
pub fn log_file_path() -> Option<String> {
    current_log_path().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("flightdeck-applog-tests");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(p.with_extension("log.1"));
        p
    }

    #[test]
    fn writes_headed_entry_with_continuation_indent() {
        let p = tmp("basic.log");
        write_line_at(&p, "error", "react-render", "boom\nat Cockpit\nat App").unwrap();
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.contains(" E react-render | boom\n    at Cockpit\n    at App\n"));
        // Header starts with a 4-digit year.
        assert!(text.chars().take(4).all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn redacts_secrets_on_the_way_in() {
        let p = tmp("redact.log");
        let secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
        write_line_at(&p, "error", "onerror", &format!("failed with {secret} attached")).unwrap();
        let text = fs::read_to_string(&p).unwrap();
        assert!(!text.contains(secret));
        assert!(text.contains("[REDACTED]"));
    }

    #[test]
    fn rotates_past_cap_and_keeps_one_generation() {
        let p = tmp("rotate.log");
        let filler = "x".repeat(10_000);
        for _ in 0..110 {
            write_line_at(&p, "info", "test", &filler).unwrap();
        }
        let rotated = p.with_extension("log.1");
        assert!(rotated.exists(), "expected a rotated generation");
        assert!(fs::metadata(&p).unwrap().len() < MAX_LOG_BYTES);
    }

    #[test]
    fn truncates_oversized_entries_on_a_char_boundary() {
        let p = tmp("huge.log");
        let huge = "é".repeat(MAX_ENTRY_BYTES); // 2 bytes each, forces boundary logic
        write_line_at(&p, "warn", "test", &huge).unwrap();
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.len() < MAX_ENTRY_BYTES + 200);
    }

    #[test]
    fn tail_snaps_to_a_line_boundary() {
        let p = tmp("tail.log");
        for i in 0..50 {
            write_line_at(&p, "info", "test", &format!("entry number {i}")).unwrap();
        }
        let t = tail_at(&p, 200).unwrap();
        assert!(t.len() <= 200);
        // First character of the tail is an entry head (year digit), not a torn line.
        assert!(t.chars().next().unwrap().is_ascii_digit());
        assert!(t.contains("entry number 49"));
    }

    #[test]
    fn tail_of_missing_file_is_none() {
        assert!(tail_at(Path::new("Z:/definitely/not/here.log"), 100).is_none());
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(iso_utc_from_millis(0), "1970-01-01T00:00:00.000Z");
        // 2026-08-12 00:00:00 UTC = 1786492800
        assert_eq!(iso_utc_from_millis(1_786_492_800_000), "2026-08-12T00:00:00.000Z");
        // Leap day: 2024-02-29 12:00:00 UTC = 1709208000
        assert_eq!(iso_utc_from_millis(1_709_208_000_000), "2024-02-29T12:00:00.000Z");
    }
}
