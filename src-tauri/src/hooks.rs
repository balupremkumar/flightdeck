//! QL-720: hook-driven session state.
//!
//! WHY: Flightdeck's pane state ("is this agent blocked on me?") is guessed
//! from terminal text — a quiet timer plus regexes over the last line. That
//! guess is wrong in both directions: a spinner keeps a finished pane "running",
//! and a code block containing "Do you want to..." reads as an approval prompt.
//! Claude Code already announces the two moments we care about through its own
//! hooks (Notification when it needs the user, Stop when it has finished
//! responding), so this module takes the facts instead of the guess.
//!
//! HOW IT FITS TOGETHER:
//!   1. `init` writes `<app-data>/hooks/hook-relay.ps1` at every launch and
//!      starts a tail watcher over `<app-data>/hooks/events.jsonl`.
//!   2. The relay is what Claude Code actually runs. It appends ONE JSON line
//!      per hook fire (the hook's stdin payload + the event name + a timestamp)
//!      and rotates the log at 5MB. It is deliberately tiny and always exits 0 —
//!      a hook that fails or hangs would block the agent it is reporting on.
//!   3. The watcher polls that file once a second and emits each new line to the
//!      frontend as `hook://event`. Polling, not a filesystem-notify crate: the
//!      tree has no such dependency and one stat per second is cheaper than
//!      adding one.
//!   4. `install_claude_hooks` / `uninstall_claude_hooks` edit
//!      `~/.claude/settings.json`. NOTHING here is automatic: nothing is written
//!      to the user's Claude config unless they press Install in Settings.
//!
//! SAFETY RULES for the settings edit (this file is the only thing in
//! Flightdeck that writes to a config the user also hand-edits):
//!   * refuse rather than repair — a BOM or a parse error aborts with a message
//!     instead of rewriting a file we didn't fully understand;
//!   * a timestamped `.bak` is written next to the file before every change;
//!   * unknown keys survive (the whole document is a `serde_json::Value`);
//!   * user-owned hook entries are never touched: install appends, uninstall
//!     removes only entries whose command points into OUR hooks folder.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

/// The relay script Claude Code invokes, written into our hooks folder.
const RELAY_SCRIPT: &str = "hook-relay.ps1";
/// The append-only log the relay writes and the watcher tails.
const EVENTS_FILE: &str = "events.jsonl";
/// Frontend event name. Kept in step with Notifications.tsx (HOOK_EVENT).
const HOOK_EVENT: &str = "hook://event";
/// The Claude Code hook events we register. Notification = "I need you";
/// Stop = "I've finished responding". Nothing else is installed: every extra
/// hook is another process spawned on the agent's critical path.
const HOOK_EVENTS: [&str; 2] = ["Notification", "Stop"];

/// The relay. Appends one compact JSON line per hook fire.
///
/// Contract with the watcher: exactly one line per event, UTF-8, no BOM,
/// `{ "event": <name>, "ts": <epoch ms>, "payload": <hook stdin JSON> }`.
/// Everything is wrapped so the script can only ever exit 0 — Claude Code waits
/// on its hooks, so a throwing relay would stall the very pane it reports on.
/// A cross-process mutex serialises concurrent fires (several panes can hit a
/// Stop at the same moment); failing to take it still writes, since a
/// best-effort interleaved line is better than a lost event.
const RELAY_BODY: &str = r##"param([Parameter(Mandatory = $true)][string]$EventName)
# Flightdeck hook relay (QL-720). Written by Flightdeck at launch — hand edits
# are overwritten. Appends one JSON line per hook fire to events.jsonl, which
# Flightdeck tails to learn when an agent needs you and when it has finished.
# It reads stdin, writes a line, and exits 0. It never blocks the agent.
$ErrorActionPreference = 'Stop'
$mtx = $null
try {
  $dir = Split-Path -Parent $PSCommandPath
  $log = Join-Path $dir 'events.jsonl'

  $raw = ''
  try { if ([Console]::IsInputRedirected) { $raw = [Console]::In.ReadToEnd() } } catch { $raw = '' }
  $payload = $null
  if ($raw -and $raw.Trim()) { try { $payload = $raw | ConvertFrom-Json } catch { $payload = $null } }

  $rec = [ordered]@{
    event   = $EventName
    ts      = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    payload = $payload
  }
  $line = ConvertTo-Json $rec -Depth 12 -Compress

  try {
    $mtx = New-Object System.Threading.Mutex($false, 'Local\FlightdeckHookRelay')
    [void]$mtx.WaitOne(2000)
  } catch { $mtx = $null }

  # Rotate before appending so the log can never grow past ~5MB.
  if (Test-Path -LiteralPath $log) {
    $len = (Get-Item -LiteralPath $log).Length
    if ($len -ge 5242880) { Move-Item -LiteralPath $log -Destination "$log.1" -Force }
  }
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::AppendAllText($log, $line + "`n", $enc)
} catch {
  # Never surface anything to the agent.
} finally {
  if ($mtx) { try { [void]$mtx.ReleaseMutex() } catch { } ; $mtx.Dispose() }
}
exit 0
"##;

/// Published once `init` has written the relay. `None` means "no hooks folder",
/// which every command below treats as "not available" rather than an error to
/// paper over.
static HOOKS_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

pub fn hooks_dir() -> Option<PathBuf> {
    HOOKS_DIR.read().unwrap().clone()
}

fn relay_path() -> Option<PathBuf> {
    Some(hooks_dir()?.join(RELAY_SCRIPT))
}

/// `~/.claude/settings.json` — the USER scope, same file ConfigDoctorView reads.
/// Project scopes are deliberately out: a hook installed per-repo would follow
/// the repo into everyone else's checkout.
fn claude_settings_path() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(|h| PathBuf::from(h).join(".claude").join("settings.json"))
}

/// Called once at app start. Creates the hooks folder, rewrites the relay (so a
/// newer build can't leave a stale script behind an already-installed hook
/// entry), and starts the tail watcher. Every failure is silent and total: no
/// folder means no relay path, which means Install refuses rather than half-
/// working.
pub fn init(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else { return };
    let dir = data_dir.join("hooks");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if std::fs::write(dir.join(RELAY_SCRIPT), RELAY_BODY).is_err() {
        return;
    }
    let events = dir.join(EVENTS_FILE);
    *HOOKS_DIR.write().unwrap() = Some(dir);
    spawn_tail_watcher(app.clone(), events);
}

/// Tail `events.jsonl` and emit every new line as `hook://event`.
///
/// Starts at the CURRENT end of the file: a restart must not replay yesterday's
/// events as if the agents were blocked right now. A file that shrank (the
/// relay rotated it, or it was deleted) resets the offset to 0. Partial trailing
/// bytes are carried to the next tick, so a line caught mid-append is emitted
/// once, whole, rather than twice broken.
fn spawn_tail_watcher(app: AppHandle, path: PathBuf) {
    std::thread::spawn(move || {
        let mut offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut carry: Vec<u8> = Vec::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let len = match std::fs::metadata(&path) {
                Ok(m) => m.len(),
                // No file yet (hooks never installed, or it was deleted).
                Err(_) => {
                    offset = 0;
                    carry.clear();
                    continue;
                }
            };
            if len < offset {
                offset = 0;
                carry.clear();
            }
            if len == offset {
                continue;
            }
            let Ok(mut f) = std::fs::File::open(&path) else { continue };
            if f.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_err() {
                continue;
            }
            offset += buf.len() as u64;
            carry.extend_from_slice(&buf);
            let Some(cut) = carry.iter().rposition(|b| *b == b'\n') else { continue };
            let complete: Vec<u8> = carry.drain(..=cut).collect();
            for line in String::from_utf8_lossy(&complete).lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // A malformed line is skipped, not fatal: the relay writes with
                // ConvertTo-Json, so this only happens if something else wrote
                // into the file.
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    let _ = app.emit(HOOK_EVENT, v);
                }
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    /// The relay script exists on disk (i.e. `init` ran and the write worked).
    pub relay_installed: bool,
    pub hooks_dir: String,
    pub settings_path: String,
    /// Our entries are present in `~/.claude/settings.json`.
    pub settings_installed: bool,
    /// Why the settings file couldn't be inspected (BOM, bad JSON). `None` when
    /// it parsed cleanly or simply doesn't exist yet.
    pub settings_error: Option<String>,
    /// Age of the newest relay write, in ms. `None` when nothing has ever
    /// fired — the honest "installed but never seen an event" state.
    pub last_event_age_ms: Option<u64>,
}

/// Everything Settings needs to describe the current state in one sentence.
/// Read-only: it never creates or repairs anything.
#[tauri::command]
pub fn hook_events_status() -> HookStatus {
    let dir = hooks_dir();
    let relay_installed = relay_path().map(|p| p.exists()).unwrap_or(false);
    let last_event_age_ms = dir
        .as_ref()
        .map(|d| d.join(EVENTS_FILE))
        .and_then(|p| std::fs::metadata(&p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| now_ms().saturating_sub(d.as_millis() as u64));

    let settings_path = claude_settings_path();
    let (settings_installed, settings_error) = match (&settings_path, &dir) {
        (Some(p), Some(d)) => match read_settings(p) {
            Ok(None) => (false, None), // no file yet
            Ok(Some(v)) => (count_our_hooks(&v, d) > 0, None),
            Err(e) => (false, Some(e)),
        },
        _ => (false, None),
    };

    HookStatus {
        relay_installed,
        hooks_dir: dir.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
        settings_path: settings_path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        settings_installed,
        settings_error,
        last_event_age_ms,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEdit {
    /// The file actually changed (false = already in the wanted state).
    pub changed: bool,
    pub settings_path: String,
    /// Where the pre-edit copy went. `None` when nothing was written.
    pub backup_path: Option<String>,
    /// Hook entries added, or removed by uninstall.
    pub entries: usize,
}

/// Read `~/.claude/settings.json` as a JSON value.
/// `Ok(None)` = the file doesn't exist yet (a perfectly normal fresh install).
/// `Err` = it exists but we refuse to touch it. Both BOM and parse failure land
/// here on purpose: rewriting a file we couldn't fully read would be the one
/// way this feature could destroy someone's config.
fn read_settings(path: &Path) -> Result<Option<Value>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("couldn't read {}: {e}", path.display())),
    };
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(format!(
            "{} starts with a byte-order mark. Claude Code can read it but rewriting it here would change every byte, so Flightdeck won't touch it — re-save it as UTF-8 without a BOM and try again.",
            path.display()
        ));
    }
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Some(Value::Object(Map::new())));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("{} isn't valid UTF-8.", path.display()))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("{} isn't valid JSON ({e}). Fix it by hand first — Flightdeck won't overwrite a file it can't parse.", path.display()))
}

/// `pwsh` where it exists, else Windows PowerShell. Resolved at install time and
/// baked into the command string, so a later PATH change can't silently break an
/// installed hook (it would need reinstalling, which the status row shows).
fn powershell_exe() -> &'static str {
    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join("pwsh.exe").exists()))
        .unwrap_or(false);
    if on_path {
        "pwsh"
    } else {
        "powershell"
    }
}

/// The exact command string one of our hook entries runs.
fn relay_command(exe: &str, script: &Path, event: &str) -> String {
    format!(
        "{exe} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\" {event}",
        script.display()
    )
}

/// Path comparison that survives Windows: case-insensitive, slash-agnostic, no
/// trailing separator. Used to decide whether a hook entry is ours.
fn norm_path(s: &str) -> String {
    let s = s.replace('\\', "/").to_lowercase();
    s.trim_end_matches('/').to_string()
}

/// Is this hook command one WE installed? The test is "its command mentions our
/// hooks folder", which is what makes uninstall surgical: a user's own hook that
/// happens to also be a pwsh one-liner is left completely alone.
fn is_ours(command: &str, hooks_dir: &Path) -> bool {
    let needle = norm_path(&hooks_dir.to_string_lossy());
    !needle.is_empty() && norm_path(command).contains(&needle)
}

/// Does this hook entry belong to us?
fn entry_is_ours(entry: &Value, hooks_dir: &Path) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .map(|c| is_ours(c, hooks_dir))
        .unwrap_or(false)
}

/// How many of the entries in this document are ours. Walks every event, not
/// just the two we install, so an entry left behind by an older build is still
/// counted (and therefore still removable).
pub(crate) fn count_our_hooks(root: &Value, hooks_dir: &Path) -> usize {
    let Some(hooks) = root.get("hooks").and_then(Value::as_object) else { return 0 };
    hooks
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|g| g.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter(|e| entry_is_ours(e, hooks_dir))
        .count()
}

/// Add our Notification + Stop entries to `root`, in place.
///
/// Idempotent and self-healing: any existing entry of ours is removed first, so
/// reinstalling after the app data folder moved (or the pwsh flavour changed)
/// replaces the stale entry instead of stacking a second one. Everything else in
/// the document — other events, other groups, the user's own entries inside the
/// SAME group — is preserved exactly.
///
/// Refuses (rather than overwrites) when `hooks`, an event's value, or a group
/// isn't the shape Claude Code documents: a `hooks` key holding a string is a
/// config we don't understand, and guessing at it is how config files get eaten.
pub(crate) fn merge_hooks(root: &mut Value, hooks_dir: &Path, exe: &str) -> Result<usize, String> {
    if !root.is_object() {
        return Err("settings.json isn't a JSON object.".into());
    }
    // Validate BEFORE mutating anything, so a refusal leaves the in-memory
    // document exactly as it was read.
    if let Some(hooks) = root.get("hooks") {
        if !hooks.is_object() {
            return Err("`hooks` in settings.json isn't an object — Flightdeck won't rewrite it.".into());
        }
        for event in HOOK_EVENTS {
            if let Some(groups) = hooks.get(event) {
                if !groups.is_array() {
                    return Err(format!("`hooks.{event}` in settings.json isn't a list — Flightdeck won't rewrite it."));
                }
            }
        }
    }
    remove_hooks(root, hooks_dir);

    let obj = root.as_object_mut().expect("checked above");
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("validated above");
    let script = hooks_dir.join(RELAY_SCRIPT);
    let mut added = 0;
    for event in HOOK_EVENTS {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("validated above");
        // Our own group, so uninstall can lift it out cleanly. `timeout` is a
        // belt-and-braces guard: the relay is a few milliseconds of work, and
        // Claude should never wait on it.
        groups.push(json!({
            "hooks": [{
                "type": "command",
                "command": relay_command(exe, &script, event),
                "timeout": 5
            }]
        }));
        added += 1;
    }
    Ok(added)
}

/// Remove exactly our entries and nothing else. Returns how many went.
///
/// A group that held one of ours plus one of the user's keeps the user's. A
/// group emptied by the removal is dropped, an event array emptied by that is
/// dropped, and a `hooks` object emptied by THAT is dropped — so uninstalling
/// leaves a settings.json that looks like it did before install, rather than a
/// trail of empty scaffolding.
pub(crate) fn remove_hooks(root: &mut Value, hooks_dir: &Path) -> usize {
    let mut removed = 0;
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else { return 0 };
    // Events we emptied ourselves. Tracked per event (rather than "is it empty
    // now?") so an event array the user already had empty is left alone.
    let mut emptied: Vec<String> = Vec::new();
    for (event, groups) in hooks.iter_mut() {
        let Some(groups) = groups.as_array_mut() else { continue };
        let mut drop_at: Vec<usize> = Vec::new();
        for (i, group) in groups.iter_mut().enumerate() {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else { continue };
            let before = list.len();
            list.retain(|e| !entry_is_ours(e, hooks_dir));
            let n = before - list.len();
            removed += n;
            // Only a group WE emptied is dropped; a group that arrived empty is
            // the user's business.
            if n > 0 && list.is_empty() {
                drop_at.push(i);
            }
        }
        let dropped = drop_at.len();
        for i in drop_at.into_iter().rev() {
            groups.remove(i);
        }
        if dropped > 0 && groups.is_empty() {
            emptied.push(event.clone());
        }
    }
    for event in emptied {
        hooks.remove(&event);
    }
    // Same rule one level up: if the block is empty and we're the reason, take
    // the key with us so an uninstall leaves no scaffolding behind.
    if removed > 0 && hooks.is_empty() {
        if let Some(obj) = root.as_object_mut() {
            obj.remove("hooks");
        }
    }
    removed
}

/// Write `value` to `path`, pretty-printed, after copying the current file to a
/// timestamped `.bak`. Written to a sibling temp file and renamed, so an
/// interrupted write can't leave a truncated settings.json.
fn write_settings(path: &Path, value: &Value) -> Result<Option<String>, String> {
    let backup = if path.exists() {
        let bak = path.with_extension(format!("json.{}.bak", now_ms()));
        std::fs::copy(path, &bak).map_err(|e| format!("couldn't back up settings.json: {e}"))?;
        Some(bak.to_string_lossy().into_owned())
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
        }
        None
    };
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    let tmp = path.with_extension("json.flightdeck-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("couldn't write settings.json: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("couldn't replace settings.json: {e}"))?;
    Ok(backup)
}

/// Install the Notification + Stop relay hooks. Only ever called from the
/// Settings row, behind an explicit confirm that names this file.
#[tauri::command]
pub fn install_claude_hooks() -> Result<HookEdit, String> {
    let Some(dir) = hooks_dir() else {
        return Err("Flightdeck's hooks folder isn't available, so there's nothing to install.".into());
    };
    if !dir.join(RELAY_SCRIPT).exists() {
        return Err("The relay script is missing from Flightdeck's hooks folder. Restart Flightdeck and try again.".into());
    }
    let Some(path) = claude_settings_path() else {
        return Err("Couldn't find your home folder, so ~/.claude/settings.json can't be located.".into());
    };
    let mut doc = read_settings(&path)?.unwrap_or_else(|| Value::Object(Map::new()));
    let before = doc.clone();
    let entries = merge_hooks(&mut doc, &dir, powershell_exe())?;
    if doc == before {
        return Ok(HookEdit {
            changed: false,
            settings_path: path.to_string_lossy().into_owned(),
            backup_path: None,
            entries,
        });
    }
    let backup_path = write_settings(&path, &doc)?;
    Ok(HookEdit { changed: true, settings_path: path.to_string_lossy().into_owned(), backup_path, entries })
}

/// Remove our entries. Same refusal rules as install: a settings.json we can't
/// parse is left exactly as it is, with the reason reported.
#[tauri::command]
pub fn uninstall_claude_hooks() -> Result<HookEdit, String> {
    let Some(dir) = hooks_dir() else {
        return Err("Flightdeck's hooks folder isn't available, so there's nothing to uninstall.".into());
    };
    let Some(path) = claude_settings_path() else {
        return Err("Couldn't find your home folder, so ~/.claude/settings.json can't be located.".into());
    };
    let Some(mut doc) = read_settings(&path)? else {
        return Ok(HookEdit { changed: false, settings_path: path.to_string_lossy().into_owned(), backup_path: None, entries: 0 });
    };
    let entries = remove_hooks(&mut doc, &dir);
    if entries == 0 {
        return Ok(HookEdit { changed: false, settings_path: path.to_string_lossy().into_owned(), backup_path: None, entries: 0 });
    }
    let backup_path = write_settings(&path, &doc)?;
    Ok(HookEdit { changed: true, settings_path: path.to_string_lossy().into_owned(), backup_path, entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        PathBuf::from(r"C:\Users\Me\AppData\Roaming\Flightdeck\hooks")
    }

    /// A settings.json with the user's own hooks in it, including one under an
    /// event we also install into. Nothing here may be lost or reordered.
    fn user_settings() -> Value {
        json!({
            "model": "opus",
            "env": { "FOO": "bar" },
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "pwsh -File C:\\me\\audit.ps1" }] }
                ],
                "Notification": [
                    { "hooks": [{ "type": "command", "command": "C:\\me\\ping.exe" }] }
                ]
            }
        })
    }

    #[test]
    fn install_appends_both_events_without_touching_user_hooks() {
        let mut doc = user_settings();
        assert_eq!(merge_hooks(&mut doc, &dir(), "pwsh").unwrap(), 2);

        // Unknown top-level keys survive untouched.
        assert_eq!(doc["model"], json!("opus"));
        assert_eq!(doc["env"]["FOO"], json!("bar"));
        // The user's own events and entries are exactly as they were.
        assert_eq!(doc["hooks"]["PreToolUse"], user_settings()["hooks"]["PreToolUse"]);
        let notif = doc["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2, "ours is appended, the user's stays first");
        assert_eq!(notif[0], user_settings()["hooks"]["Notification"][0]);
        let ours = notif[1]["hooks"][0]["command"].as_str().unwrap();
        assert!(ours.contains("hook-relay.ps1") && ours.ends_with("Notification"));
        assert_eq!(notif[1]["hooks"][0]["type"], json!("command"));

        let stop = doc["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert!(stop[0]["hooks"][0]["command"].as_str().unwrap().ends_with("Stop"));
    }

    #[test]
    fn install_into_an_empty_settings_file_creates_the_whole_block() {
        let mut doc = json!({});
        merge_hooks(&mut doc, &dir(), "powershell").unwrap();
        assert_eq!(doc["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(doc["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(doc["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .starts_with("powershell -NoProfile"));
    }

    /// Pressing Install twice (or after an upgrade) must not stack duplicates —
    /// two relays per event would double every notification.
    #[test]
    fn install_is_idempotent() {
        let mut doc = user_settings();
        merge_hooks(&mut doc, &dir(), "pwsh").unwrap();
        let once = doc.clone();
        merge_hooks(&mut doc, &dir(), "pwsh").unwrap();
        assert_eq!(doc, once);
        assert_eq!(count_our_hooks(&doc, &dir()), 2);
    }

    /// Reinstalling after the hooks folder moved must REPLACE the stale entry.
    #[test]
    fn reinstall_replaces_an_entry_pointing_at_an_old_folder() {
        let old = PathBuf::from(r"C:\Old\Flightdeck\hooks");
        let mut doc = json!({});
        merge_hooks(&mut doc, &old, "pwsh").unwrap();
        merge_hooks(&mut doc, &old, "pwsh").unwrap(); // still one per event
        assert_eq!(count_our_hooks(&doc, &old), 2);

        // A move to a new folder leaves the old entry behind unless uninstalled
        // from the old path first — so install removes only ITS own path's
        // entries, and the old one is still visible to a targeted remove.
        assert_eq!(remove_hooks(&mut doc, &old), 2);
        assert!(doc.get("hooks").is_none());
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let mut doc = user_settings();
        merge_hooks(&mut doc, &dir(), "pwsh").unwrap();
        assert_eq!(remove_hooks(&mut doc, &dir()), 2);
        assert_eq!(doc, user_settings(), "the file must come back exactly as it went in");
    }

    /// The nastiest case: the user's own hook sits in the SAME group array as
    /// ours (hand-merged, or another tool did it). Removal is per-entry.
    #[test]
    fn uninstall_leaves_a_user_entry_sharing_our_group() {
        let script = dir().join(RELAY_SCRIPT);
        let mut doc = json!({
            "hooks": {
                "Stop": [{
                    "hooks": [
                        { "type": "command", "command": "C:\\me\\mine.exe" },
                        { "type": "command", "command": relay_command("pwsh", &script, "Stop") }
                    ]
                }]
            }
        });
        assert_eq!(remove_hooks(&mut doc, &dir()), 1);
        let list = doc["hooks"]["Stop"][0]["hooks"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["command"], json!("C:\\me\\mine.exe"));
    }

    #[test]
    fn uninstall_is_a_no_op_when_nothing_is_ours() {
        let mut doc = user_settings();
        assert_eq!(remove_hooks(&mut doc, &dir()), 0);
        assert_eq!(doc, user_settings());
        // An empty group the user wrote themselves is left alone.
        let mut empty = json!({ "hooks": { "Stop": [{ "hooks": [] }] } });
        assert_eq!(remove_hooks(&mut empty, &dir()), 0);
        assert_eq!(empty, json!({ "hooks": { "Stop": [{ "hooks": [] }] } }));
    }

    /// Windows path comparison: the same folder written with forward slashes
    /// and different casing is still our folder.
    #[test]
    fn our_entry_is_recognised_across_slash_and_case_differences() {
        let mut doc = json!({
            "hooks": { "Stop": [{ "hooks": [{ "type": "command",
                "command": "pwsh -File \"c:/users/me/appdata/roaming/flightdeck/HOOKS/hook-relay.ps1\" Stop" }] }] }
        });
        assert_eq!(count_our_hooks(&doc, &dir()), 1);
        assert_eq!(remove_hooks(&mut doc, &dir()), 1);
    }

    /// A hooks block of the wrong shape is a config we don't understand.
    /// Refuse, don't rewrite.
    #[test]
    fn a_malformed_hooks_block_is_refused_not_repaired() {
        let mut doc = json!({ "hooks": "please" });
        assert!(merge_hooks(&mut doc, &dir(), "pwsh").is_err());
        assert_eq!(doc["hooks"], json!("please"), "the bad value is left untouched");

        let mut doc = json!({ "hooks": { "Stop": "nope" } });
        assert!(merge_hooks(&mut doc, &dir(), "pwsh").is_err());

        let mut doc = json!([1, 2, 3]);
        assert!(merge_hooks(&mut doc, &dir(), "pwsh").is_err());
    }

    /// Groups whose shape we don't recognise must survive a removal pass —
    /// remove_hooks runs on every install too.
    #[test]
    fn removal_walks_past_junk_without_dropping_it() {
        let mut doc = json!({
            "hooks": { "Stop": ["a string group", { "no_hooks_key": true }, 7] }
        });
        let before = doc.clone();
        assert_eq!(remove_hooks(&mut doc, &dir()), 0);
        assert_eq!(doc, before);
    }

    #[test]
    fn the_command_string_quotes_the_script_and_names_the_event() {
        let cmd = relay_command("pwsh", &dir().join(RELAY_SCRIPT), "Notification");
        assert_eq!(
            cmd,
            r#"pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\Me\AppData\Roaming\Flightdeck\hooks\hook-relay.ps1" Notification"#
        );
        // Quoted, because the real path contains spaces on plenty of machines.
        let spaced = relay_command("pwsh", Path::new(r"C:\Program Files\fd\hooks\hook-relay.ps1"), "Stop");
        assert!(spaced.contains(r#""C:\Program Files\fd\hooks\hook-relay.ps1""#));
    }

    /// A BOM is the documented refusal case: Claude Code tolerates it, so the
    /// file is valid — it just isn't one we can rewrite byte-for-byte.
    #[test]
    fn a_bom_or_broken_json_is_refused_with_a_reason() {
        let tmp = std::env::temp_dir().join(format!("fd-hooks-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        let bom = tmp.join("bom.json");
        std::fs::write(&bom, [0xEF, 0xBB, 0xBF, b'{', b'}']).unwrap();
        assert!(read_settings(&bom).unwrap_err().contains("byte-order mark"));

        let bad = tmp.join("bad.json");
        std::fs::write(&bad, "{ \"model\": \"opus\", }").unwrap();
        assert!(read_settings(&bad).unwrap_err().contains("isn't valid JSON"));

        // Missing = fresh install, not an error. Empty = same.
        assert!(read_settings(&tmp.join("nope.json")).unwrap().is_none());
        let empty = tmp.join("empty.json");
        std::fs::write(&empty, "  \n").unwrap();
        assert_eq!(read_settings(&empty).unwrap(), Some(json!({})));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The round trip through disk: back up, write, re-read, uninstall back to
    /// the original bytes' meaning.
    #[test]
    fn writing_backs_up_first_and_stays_parseable() {
        let tmp = std::env::temp_dir().join(format!("fd-hooks-write-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("settings.json");
        std::fs::write(&path, serde_json::to_string_pretty(&user_settings()).unwrap()).unwrap();

        let mut doc = read_settings(&path).unwrap().unwrap();
        merge_hooks(&mut doc, &dir(), "pwsh").unwrap();
        let backup = write_settings(&path, &doc).unwrap().expect("an existing file is backed up");
        assert_eq!(read_settings(Path::new(&backup)).unwrap().unwrap(), user_settings());

        let mut back = read_settings(&path).unwrap().unwrap();
        assert_eq!(count_our_hooks(&back, &dir()), 2);
        remove_hooks(&mut back, &dir());
        assert_eq!(back, user_settings());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The relay is a contract with the watcher and with Claude Code. Pin the
    /// parts that would silently break it.
    #[test]
    fn the_relay_script_holds_up_its_end() {
        const MAX_EVENTS_BYTES: u64 = 5 * 1024 * 1024;
        assert!(RELAY_BODY.contains("param([Parameter(Mandatory = $true)][string]$EventName)"));
        assert!(RELAY_BODY.contains("ConvertTo-Json $rec -Depth 12 -Compress"), "one line per event");
        assert!(RELAY_BODY.contains(&MAX_EVENTS_BYTES.to_string()), "rotation ceiling must be the documented 5MB");
        assert!(RELAY_BODY.contains("AppendAllText"), "append, never rewrite");
        assert!(RELAY_BODY.contains("UTF8Encoding($false)"), "no BOM, or the watcher's first line is junk");
        assert!(RELAY_BODY.trim_end().ends_with("exit 0"), "a hook must never fail the agent");
    }
}
