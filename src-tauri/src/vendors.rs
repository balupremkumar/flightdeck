// vendors.rs — vendor adapter trait + registry (R1b / I1).
//
// This module is THE source of truth for what agents/shells exist. The frontend
// gets the list from `detect_vendors` (see lib.rs) rather than duplicating it,
// so adding an agent is one impl + one line in `registry()` — no frontend edit.
//
// A VendorAdapter owns everything specific to one agent/shell: how to detect it
// (`probe`), how to launch it (`command`), its process-tree root image name for
// orphan scanning (`root_exe`), any pre-spawn side effect (`prepare`, e.g. agy's
// sticky workspace trust), the env it must not inherit (`env_strip`), and how it
// presents in the UI (`short`, `kind`, `accent`).

use std::sync::OnceLock;

use portable_pty::CommandBuilder;
use serde::Serialize;

/// Env stripped from EVERY child so a stray key in the ambient shell can never
/// turn a subscription CLI into a metered API call. Subtractive only.
/// Adapters extend this via `env_strip` — they never shrink it.
pub const BASE_ENV_STRIP: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
];

/// Proxy / enterprise auth-mode switches. Present here rather than as a TODO:
/// any of these can flip a CLI off subscription auth into metered billing.
pub const PROXY_ENV_STRIP: &[&str] = &[
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "CLOUD_ML_REGION",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorInfo {
    pub id: String,
    pub label: String,
    /// Compact name for chips/badges where the full label won't fit.
    pub short: String,
    /// "agent" (an AI coding CLI) or "shell" (a plain terminal).
    pub kind: String,
    /// CSS custom-property name the UI uses to colour this vendor.
    pub accent: String,
    pub installed: bool,
    pub detail: String,
}

// Resolve an executable through the shell's PATH (Windows `where`).
fn which(exe: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("where")
            .arg(exe)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        s.lines()
            .next()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        None
    }
}

pub fn agy_path() -> String {
    format!(
        "{}\\agy\\bin\\agy.exe",
        std::env::var("LOCALAPPDATA").unwrap_or_default()
    )
}

// Git for Windows ships its own bash.exe; `where bash` can resolve WSL's
// System32\bash.exe launcher instead, so check the standard Git install
// locations directly rather than trusting PATH order.
fn git_bash_path() -> Option<String> {
    let candidates = [
        format!("{}\\Git\\bin\\bash.exe", std::env::var("ProgramFiles").unwrap_or_default()),
        format!("{}\\Git\\bin\\bash.exe", std::env::var("ProgramFiles(x86)").unwrap_or_default()),
        format!(
            "{}\\Programs\\Git\\bin\\bash.exe",
            std::env::var("LOCALAPPDATA").unwrap_or_default()
        ),
    ];
    candidates.into_iter().find(|p| std::path::Path::new(p).exists())
}

// agy (Antigravity) only operates in trusted workspaces. Since Flightdeck can
// root a pane at any folder, ensure the folder is in agy's trustedWorkspaces
// before spawning. Sticky (never revoked). Serialised so concurrent agy panes
// opened at once can't interleave a read-modify-write of settings.json.
static AGY_TRUST_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

fn ensure_agy_trust(work_dir: &str) {
    let lock = AGY_TRUST_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock.lock().unwrap();

    let home = match std::env::var("USERPROFILE") {
        Ok(h) => h,
        Err(_) => return,
    };
    let path = std::path::Path::new(&home)
        .join(".gemini")
        .join("antigravity-cli")
        .join("settings.json");

    let mut val: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if !val.get("trustedWorkspaces").map(|v| v.is_array()).unwrap_or(false) {
        val["trustedWorkspaces"] = serde_json::json!([]);
    }
    let list = val["trustedWorkspaces"].as_array_mut().unwrap();
    if !list.iter().any(|x| x.as_str() == Some(work_dir)) {
        list.push(serde_json::Value::String(work_dir.to_string()));
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = serde_json::to_string_pretty(&val) {
            let _ = std::fs::write(&path, s);
        }
    }
}

pub trait VendorAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// (installed, detail) — detail is a resolved path when installed, or a
    /// human-readable reason when not.
    fn probe(&self) -> (bool, String);
    /// Build the launch command (program + args + cwd). Colour forcing is
    /// applied centrally by the caller; env stripping comes from `env_strip`.
    fn command(&self, cwd: &str) -> CommandBuilder;
    /// Base image name of the root process this adapter launches, used by the
    /// orphan scanner (203) to recognise stray Flightdeck-spawned trees.
    fn root_exe(&self) -> &'static str;

    /// Pre-spawn side effect hook. No-op by default.
    fn prepare(&self, _cwd: &str) {}

    /// Compact display name. Defaults to the full label.
    fn short(&self) -> &'static str {
        self.label()
    }
    /// "agent" or "shell". Agents are the AI CLIs; shells are plain terminals.
    fn kind(&self) -> &'static str {
        "agent"
    }
    /// CSS custom-property name used to colour this vendor in the UI.
    fn accent(&self) -> &'static str {
        "--accent"
    }
    /// Env vars this adapter must not inherit. Always a superset of
    /// BASE_ENV_STRIP — an adapter can add, never remove.
    fn env_strip(&self) -> Vec<&'static str> {
        let mut v: Vec<&'static str> = BASE_ENV_STRIP.to_vec();
        v.extend_from_slice(PROXY_ENV_STRIP);
        v
    }
}

struct Claude;
impl VendorAdapter for Claude {
    fn id(&self) -> &'static str { "claude" }
    fn label(&self) -> &'static str { "Claude Code" }
    fn short(&self) -> &'static str { "Claude" }
    fn accent(&self) -> &'static str { "--agent-claude" }
    fn probe(&self) -> (bool, String) {
        match which("claude") {
            Some(p) => (true, p),
            None => (false, "`claude` not on PATH".into()),
        }
    }
    fn command(&self, cwd: &str) -> CommandBuilder {
        // Launch via pwsh so the npm shim resolves; inherits the login +
        // ~/.claude config untouched.
        let mut c = CommandBuilder::new("pwsh.exe");
        c.args(["-NoLogo", "-NoProfile", "-Command", "claude"]);
        c.cwd(cwd);
        c
    }
    fn root_exe(&self) -> &'static str { "pwsh.exe" }
}

struct Agy;
impl VendorAdapter for Agy {
    fn id(&self) -> &'static str { "agy" }
    fn label(&self) -> &'static str { "Antigravity" }
    fn short(&self) -> &'static str { "Antigravity" }
    fn accent(&self) -> &'static str { "--accent" }
    fn probe(&self) -> (bool, String) {
        let p = agy_path();
        if std::path::Path::new(&p).exists() {
            (true, p)
        } else {
            (false, format!("not found at {}", p))
        }
    }
    fn command(&self, cwd: &str) -> CommandBuilder {
        let mut c = CommandBuilder::new(agy_path());
        c.args(["--add-dir", cwd, "--new-project", "--model", "gemini-3-pro"]);
        c.cwd(cwd);
        c
    }
    fn root_exe(&self) -> &'static str { "agy.exe" }
    fn prepare(&self, cwd: &str) { ensure_agy_trust(cwd); }
}

// --- Shells (170) ----------------------------------------------------------

struct Pwsh;
impl VendorAdapter for Pwsh {
    fn id(&self) -> &'static str { "pwsh" }
    fn label(&self) -> &'static str { "pwsh (shell)" }
    fn short(&self) -> &'static str { "pwsh" }
    fn kind(&self) -> &'static str { "shell" }
    fn accent(&self) -> &'static str { "--aqua" }
    fn probe(&self) -> (bool, String) {
        match which("pwsh.exe").or_else(|| which("pwsh")) {
            Some(p) => (true, p),
            None => (false, "`pwsh` not on PATH".into()),
        }
    }
    fn command(&self, cwd: &str) -> CommandBuilder {
        let mut c = CommandBuilder::new("pwsh.exe");
        c.cwd(cwd);
        c
    }
    fn root_exe(&self) -> &'static str { "pwsh.exe" }
}

struct Cmd;
impl VendorAdapter for Cmd {
    fn id(&self) -> &'static str { "cmd" }
    fn label(&self) -> &'static str { "cmd (shell)" }
    fn short(&self) -> &'static str { "cmd" }
    fn kind(&self) -> &'static str { "shell" }
    fn accent(&self) -> &'static str { "--muted" }
    fn probe(&self) -> (bool, String) {
        match which("cmd.exe") {
            Some(p) => (true, p),
            None => (false, "`cmd.exe` not found".into()),
        }
    }
    fn command(&self, cwd: &str) -> CommandBuilder {
        let mut c = CommandBuilder::new("cmd.exe");
        c.cwd(cwd);
        c
    }
    fn root_exe(&self) -> &'static str { "cmd.exe" }
}

struct GitBash;
impl VendorAdapter for GitBash {
    fn id(&self) -> &'static str { "git-bash" }
    fn label(&self) -> &'static str { "Git Bash" }
    fn short(&self) -> &'static str { "Git Bash" }
    fn kind(&self) -> &'static str { "shell" }
    fn accent(&self) -> &'static str { "--st-waiting" }
    fn probe(&self) -> (bool, String) {
        match git_bash_path() {
            Some(p) => (true, p),
            None => (false, "Git for Windows bash.exe not found".into()),
        }
    }
    fn command(&self, cwd: &str) -> CommandBuilder {
        let exe = git_bash_path().unwrap_or_else(|| "bash.exe".into());
        let mut c = CommandBuilder::new(exe);
        c.args(["--login", "-i"]);
        c.cwd(cwd);
        c
    }
    fn root_exe(&self) -> &'static str { "bash.exe" }
}

struct Wsl;
impl VendorAdapter for Wsl {
    fn id(&self) -> &'static str { "wsl" }
    fn label(&self) -> &'static str { "WSL" }
    fn short(&self) -> &'static str { "WSL" }
    fn kind(&self) -> &'static str { "shell" }
    fn accent(&self) -> &'static str { "--ice" }
    fn probe(&self) -> (bool, String) {
        match which("wsl.exe") {
            Some(p) => (true, p),
            None => (false, "`wsl.exe` not found".into()),
        }
    }
    fn command(&self, cwd: &str) -> CommandBuilder {
        let mut c = CommandBuilder::new("wsl.exe");
        // --cd translates a Windows path for the launched shell's working dir.
        c.args(["--cd", cwd]);
        c.cwd(cwd);
        c
    }
    fn root_exe(&self) -> &'static str { "wsl.exe" }
}

pub fn registry() -> Vec<Box<dyn VendorAdapter>> {
    vec![
        Box::new(Claude),
        Box::new(Agy),
        Box::new(Pwsh),
        Box::new(Cmd),
        Box::new(GitBash),
        Box::new(Wsl),
    ]
}

/// Falls back to the plain shell (pwsh) for an unknown id, matching the
/// pre-trait behaviour's default match arm.
pub fn find(id: &str) -> Box<dyn VendorAdapter> {
    registry()
        .into_iter()
        .find(|v| v.id() == id)
        .unwrap_or_else(|| Box::new(Pwsh))
}

/// Full descriptor list for the frontend — the single source of truth for
/// "what agents exist", including live install detection.
pub fn detect() -> Vec<VendorInfo> {
    registry()
        .iter()
        .map(|v| {
            let (installed, detail) = v.probe();
            VendorInfo {
                id: v.id().into(),
                label: v.label().into(),
                short: v.short().into(),
                kind: v.kind().into(),
                accent: v.accent().into(),
                installed,
                detail,
            }
        })
        .collect()
}

// --- Adapter conformance suite (227) ---------------------------------------
// Every adapter must pass these. A new agent is not "wired" until it does.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_nonempty() {
        let reg = registry();
        let mut ids: Vec<&str> = reg.iter().map(|v| v.id()).collect();
        assert!(ids.iter().all(|i| !i.is_empty()), "every adapter needs an id");
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "adapter ids must be unique");
    }

    #[test]
    fn presentation_fields_are_populated() {
        for v in registry() {
            assert!(!v.label().is_empty(), "{} has no label", v.id());
            assert!(!v.short().is_empty(), "{} has no short name", v.id());
            assert!(!v.root_exe().is_empty(), "{} has no root_exe", v.id());
            assert!(
                v.accent().starts_with("--"),
                "{} accent must be a CSS custom property, got {}",
                v.id(),
                v.accent()
            );
            assert!(
                matches!(v.kind(), "agent" | "shell"),
                "{} has invalid kind {}",
                v.id(),
                v.kind()
            );
        }
    }

    /// The core safety invariant: no adapter may narrow the env-strip list, or a
    /// stray ambient key could flip a subscription CLI to metered billing.
    #[test]
    fn every_adapter_strips_at_least_the_base_keys() {
        for v in registry() {
            let strip = v.env_strip();
            for key in BASE_ENV_STRIP {
                assert!(strip.contains(key), "{} fails to strip {}", v.id(), key);
            }
            for key in PROXY_ENV_STRIP {
                assert!(strip.contains(key), "{} fails to strip proxy var {}", v.id(), key);
            }
        }
    }

    #[test]
    fn command_targets_the_requested_cwd() {
        for v in registry() {
            let cmd = v.command("D:\\test\\dir");
            assert_eq!(
                cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()),
                Some("D:\\test\\dir".to_string()),
                "{} did not set cwd",
                v.id()
            );
        }
    }

    #[test]
    fn find_round_trips_every_id_and_falls_back_safely() {
        for v in registry() {
            assert_eq!(find(v.id()).id(), v.id());
        }
        assert_eq!(find("no-such-vendor").id(), "pwsh", "unknown id must fall back to a shell");
    }

    #[test]
    fn detect_covers_the_whole_registry() {
        assert_eq!(detect().len(), registry().len());
    }
}
