// support.rs — redacted support bundle export (204) + a key-shaped-string
// redaction helper (159) reused anywhere text might need scrubbing before it
// leaves the machine (this bundle today; future scrollback/log export later).
//
// Scope note: Flightdeck doesn't currently keep a server-side log file or
// scrollback buffer (xterm.js owns scrollback in the frontend, and there's no
// tracing/log-to-file setup in lib.rs), so this bundle is a diagnostic
// snapshot — versions, vendor probe results, live pane roster — rather than a
// log tail. Redaction is applied to every string in it regardless, so this
// stays safe to extend with real log content later without a second pass.

use serde::Serialize;

use crate::vendors;

// ---------------------------------------------------------------------------
// Redaction (159)
// ---------------------------------------------------------------------------

const KEY_PREFIXES: &[&str] = &[
    "sk-ant-", "sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "glpat-", "AIza", "xoxb-", "xoxp-",
    "xoxa-", "xoxs-",
];

fn strip_wrapping(s: &str) -> &str {
    s.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | ')' | '(' | '[' | ']' | '{' | '}'))
}

// Heuristic: a long run of alnum/._- with no path or URL separators, mixing
// letters and digits, looks like an opaque token/secret rather than prose or
// a filesystem path.
fn is_key_shaped(word: &str) -> bool {
    let core = strip_wrapping(word);
    if core.len() < 24 {
        return false;
    }
    if core.contains('/') || core.contains('\\') || core.contains(':') {
        return false;
    }
    let alnum_ok = core
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
    if !alnum_ok {
        return false;
    }
    let has_digit = core.chars().any(|c| c.is_ascii_digit());
    let has_alpha = core.chars().any(|c| c.is_ascii_alphabetic());
    has_digit && has_alpha
}

fn is_secret_token(word: &str) -> bool {
    let core = strip_wrapping(word);
    if core.is_empty() {
        return false;
    }
    KEY_PREFIXES.iter().any(|p| core.starts_with(p)) || is_key_shaped(word)
}

/// Strips anything key-shaped (API keys, tokens) out of arbitrary text,
/// token-by-token, line-by-line. Not cryptographically precise — a
/// deliberately-obfuscated secret can dodge it — but catches the common
/// vendor key/token shapes plus generic long opaque strings.
pub fn redact(input: &str) -> String {
    input
        .lines()
        .map(|line| {
            line.split(' ')
                .map(|tok| if is_secret_token(tok) { "[REDACTED]" } else { tok })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Support bundle (204)
// ---------------------------------------------------------------------------

// Plain data in, redacted-and-serialized-JSON out — deliberately decoupled
// from `Registry`/`AppHandle` so this module doesn't need to know how panes
// are stored; lib.rs extracts the roster and calls in.
pub struct SupportPaneInput {
    pub pane_id: u32,
    pub vendor: String,
    pub cwd: String,
    pub pid: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportPane {
    pane_id: u32,
    vendor: String,
    cwd: String,
    pid: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportBundle {
    generated_at: u64,
    app_version: String,
    os: String,
    arch: String,
    vendors: Vec<vendors::VendorInfo>,
    panes: Vec<SupportPane>,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// Builds the redacted support bundle as pretty JSON. Every string that could
/// carry a leaked secret (vendor probe detail, pane cwd/vendor) is passed
/// through `redact` before serialization.
pub fn build_bundle(app_version: &str, panes: Vec<SupportPaneInput>) -> Result<String, String> {
    let vendor_infos: Vec<vendors::VendorInfo> = vendors::registry()
        .iter()
        .map(|v| {
            let (installed, detail) = v.probe();
            vendors::VendorInfo {
                id: v.id().into(),
                label: v.label().into(),
                installed,
                detail: redact(&detail),
            }
        })
        .collect();

    let panes: Vec<SupportPane> = panes
        .into_iter()
        .map(|p| SupportPane {
            pane_id: p.pane_id,
            vendor: redact(&p.vendor),
            cwd: redact(&p.cwd),
            pid: p.pid,
        })
        .collect();

    let bundle = SupportBundle {
        generated_at: now_ms(),
        app_version: app_version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        vendors: vendor_infos,
        panes,
    };

    serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_known_prefixes() {
        let secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
        let input = format!("using key {secret} for this session");
        let out = redact(&input);
        assert!(!out.contains(secret));
        assert!(out.contains("[REDACTED]"));
    }

    #[test]
    fn leaves_paths_and_prose_alone() {
        let input = "cwd D:\\Dev\\ai\\projects\\active\\flightdeck is a normal sentence";
        assert_eq!(redact(input), input);
    }

    #[test]
    fn redacts_generic_long_opaque_tokens() {
        let input = "token abc123DEF456ghi789JKL012mno345";
        let out = redact(input);
        assert!(out.contains("[REDACTED]"));
        assert!(!out.contains("abc123DEF456ghi789JKL012mno345"));
    }
}
