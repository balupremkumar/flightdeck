// vendors.rs — vendor adapter trait + registry (R1b). Was a hand-rolled
// VendorSpec table + if/else in lib.rs; promoted to a small dyn-dispatch
// contract so adding an agent/shell is one impl + one line in `registry()`.
//
// A VendorAdapter owns everything specific to one agent/shell: how to detect
// it (`probe`), how to launch it (`command`), its process-tree root image
// name for orphan scanning (`root_exe`), and any pre-spawn side effect
// (`prepare`, e.g. agy's sticky workspace trust). Cross-vendor concerns (env
// stripping, colour forcing, cwd) stay centralised in lib.rs's
// `build_command`, since they apply identically to every vendor.

use std::sync::OnceLock;

use portable_pty::CommandBuilder;
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorInfo {
    pub id: String,
    pub label: String,
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
// Ported from gemini-run.ps1.
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
    /// Build the launch command (program + args + cwd). Env stripping/colour
    /// forcing is applied centrally by the caller (lib.rs::build_command).
    fn command(&self, cwd: &str) -> CommandBuilder;
    /// Base image name of the root process this adapter launches, used by the
    /// orphan scanner (203) to recognise stray Flightdeck-spawned trees.
    fn root_exe(&self) -> &'static str;
    /// Pre-spawn side effect hook. No-op by default.
    fn prepare(&self, _cwd: &str) {}
}

struct Claude;
impl VendorAdapter for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn label(&self) -> &'static str {
        "Claude Code"
    }
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
    fn root_exe(&self) -> &'static str {
        "pwsh.exe"
    }
}

struct Agy;
impl VendorAdapter for Agy {
    fn id(&self) -> &'static str {
        "agy"
    }
    fn label(&self) -> &'static str {
        "Antigravity"
    }
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
    fn root_exe(&self) -> &'static str {
        "agy.exe"
    }
    fn prepare(&self, cwd: &str) {
        ensure_agy_trust(cwd);
    }
}

struct Pwsh;
impl VendorAdapter for Pwsh {
    fn id(&self) -> &'static str {
        "pwsh"
    }
    fn label(&self) -> &'static str {
        "pwsh (shell)"
    }
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
    fn root_exe(&self) -> &'static str {
        "pwsh.exe"
    }
}

// --- Shell selection (170) -------------------------------------------------

struct Cmd;
impl VendorAdapter for Cmd {
    fn id(&self) -> &'static str {
        "cmd"
    }
    fn label(&self) -> &'static str {
        "cmd (shell)"
    }
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
    fn root_exe(&self) -> &'static str {
        "cmd.exe"
    }
}

struct GitBash;
impl VendorAdapter for GitBash {
    fn id(&self) -> &'static str {
        "git-bash"
    }
    fn label(&self) -> &'static str {
        "Git Bash"
    }
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
    fn root_exe(&self) -> &'static str {
        "bash.exe"
    }
}

struct Wsl;
impl VendorAdapter for Wsl {
    fn id(&self) -> &'static str {
        "wsl"
    }
    fn label(&self) -> &'static str {
        "WSL"
    }
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
    fn root_exe(&self) -> &'static str {
        "wsl.exe"
    }
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
