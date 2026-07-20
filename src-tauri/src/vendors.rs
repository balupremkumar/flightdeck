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
// before spawning. Serialised so concurrent agy panes opened at once can't
// interleave a read-modify-write of settings.json. Worktree entries are pruned
// again on worktree removal (K0a) — per-session paths must not accumulate
// forever in the user's agy settings.
static AGY_TRUST_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

fn agy_settings_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE").ok()?;
    Some(
        std::path::Path::new(&home)
            .join(".gemini")
            .join("antigravity-cli")
            .join("settings.json"),
    )
}

fn read_trust_doc(path: &std::path::Path) -> serde_json::Value {
    let mut val: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !val.get("trustedWorkspaces").map(|v| v.is_array()).unwrap_or(false) {
        val["trustedWorkspaces"] = serde_json::json!([]);
    }
    val
}

fn write_trust_doc(path: &std::path::Path, val: &serde_json::Value) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(val) {
        let _ = std::fs::write(path, s);
    }
}

fn trust_file_add(path: &std::path::Path, work_dir: &str) {
    let mut val = read_trust_doc(path);
    let list = val["trustedWorkspaces"].as_array_mut().unwrap();
    if !list.iter().any(|x| x.as_str() == Some(work_dir)) {
        list.push(serde_json::Value::String(work_dir.to_string()));
        write_trust_doc(path, &val);
    }
}

/// Windows paths compare case-insensitively and slash-agnostically.
fn same_path(a: &str, b: &str) -> bool {
    a.replace('\\', "/").to_lowercase() == b.replace('\\', "/").to_lowercase()
}

fn trust_file_prune(path: &std::path::Path, dirs: &[String]) {
    let mut val = read_trust_doc(path);
    let list = val["trustedWorkspaces"].as_array_mut().unwrap();
    let before = list.len();
    list.retain(|x| {
        x.as_str()
            .map(|s| !dirs.iter().any(|d| same_path(s, d)))
            .unwrap_or(true)
    });
    if list.len() != before {
        write_trust_doc(path, &val);
    }
}

fn ensure_agy_trust(work_dir: &str) {
    let lock = AGY_TRUST_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock.lock().unwrap();
    if let Some(path) = agy_settings_path() {
        trust_file_add(&path, work_dir);
    }
}

/// K0a: drop removed worktree paths from agy's trustedWorkspaces so a session's
/// throwaway dirs don't pile up in the user's settings. Called by worktree
/// removal/GC; a path that was never trusted (non-agy pane) is a no-op.
pub fn prune_agy_trust(dirs: &[String]) {
    if dirs.is_empty() {
        return;
    }
    let lock = AGY_TRUST_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock.lock().unwrap();
    if let Some(path) = agy_settings_path() {
        trust_file_prune(&path, dirs);
    }
}

/// Single-quote a string for PowerShell (embedded quotes double).
fn psq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Tier 0 follow-up (worktree setup command): wrap a vendor's launch in a pwsh
/// phase that runs the workspace's setup command first — fresh worktrees have
/// no node_modules, so agents can't build/test until e.g. `npm ci` has run.
/// Setup failure exits the pane (nonzero → crashed → error state) WITHOUT
/// starting the agent. The inner command's explicit env (manifest overrides)
/// is copied onto the wrapper so it still reaches the agent; the caller applies
/// env stripping afterwards exactly as in the unwrapped path.
pub fn wrap_with_setup(inner: &CommandBuilder, setup: &str, cwd: &str) -> CommandBuilder {
    let launch = inner
        .get_argv()
        .iter()
        .map(|a| psq(&a.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ");
    // $? catches failing cmdlets (no $LASTEXITCODE); the $null guard stops a
    // cmdlet-only setup from tripping the native-exit-code check.
    let script = format!(
        concat!(
            "$E=[char]27\n",
            "Write-Host (\"${{E}}[36m[flightdeck] worktree setup: \" + {disp} + \"${{E}}[0m\")\n",
            "{setup}\n",
            "if ((-not $?) -or ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0)) {{\n",
            "  Write-Host (\"${{E}}[31m[flightdeck] setup failed - agent not started. ",
            "Fix the setup command (or clear it in this workspace), then Restart the pane.${{E}}[0m\")\n",
            "  exit 1\n",
            "}}\n",
            "Write-Host (\"${{E}}[36m[flightdeck] setup complete - launching agent${{E}}[0m\")\n",
            "& {launch}\n",
            "exit $LASTEXITCODE"
        ),
        disp = psq(setup),
        setup = setup,
        launch = launch,
    );
    let mut c = CommandBuilder::new("pwsh.exe");
    c.args(["-NoLogo", "-Command", &script]);
    for (k, v) in inner.iter_extra_env_as_str() {
        c.env(k, v);
    }
    c.cwd(cwd);
    c
}

pub trait VendorAdapter: Send + Sync {
    fn id(&self) -> &str;
    fn label(&self) -> &str;
    /// (installed, detail) — detail is a resolved path when installed, or a
    /// human-readable reason when not.
    fn probe(&self) -> (bool, String);
    /// Build the launch command (program + args + cwd). Colour forcing is
    /// applied centrally by the caller; env stripping comes from `env_strip`.
    fn command(&self, cwd: &str) -> CommandBuilder;
    /// Base image name of the root process this adapter launches, used by the
    /// orphan scanner (203) to recognise stray Flightdeck-spawned trees.
    fn root_exe(&self) -> &str;

    /// Pre-spawn side effect hook. No-op by default.
    fn prepare(&self, _cwd: &str) {}

    /// Compact display name. Defaults to the full label.
    fn short(&self) -> &str {
        self.label()
    }
    /// "agent" or "shell". Agents are the AI CLIs; shells are plain terminals.
    fn kind(&self) -> &str {
        "agent"
    }
    /// CSS custom-property name used to colour this vendor in the UI.
    fn accent(&self) -> &str {
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
    fn id(&self) -> &str { "claude" }
    fn label(&self) -> &str { "Claude Code" }
    fn short(&self) -> &str { "Claude" }
    fn accent(&self) -> &str { "--agent-claude" }
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
    fn root_exe(&self) -> &str { "pwsh.exe" }
}

struct Agy;
impl VendorAdapter for Agy {
    fn id(&self) -> &str { "agy" }
    fn label(&self) -> &str { "Antigravity" }
    fn short(&self) -> &str { "Antigravity" }
    fn accent(&self) -> &str { "--accent" }
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
    fn root_exe(&self) -> &str { "agy.exe" }
    fn prepare(&self, cwd: &str) { ensure_agy_trust(cwd); }
}

// --- Shells (170) ----------------------------------------------------------

struct Pwsh;
impl VendorAdapter for Pwsh {
    fn id(&self) -> &str { "pwsh" }
    fn label(&self) -> &str { "pwsh (shell)" }
    fn short(&self) -> &str { "pwsh" }
    fn kind(&self) -> &str { "shell" }
    fn accent(&self) -> &str { "--aqua" }
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
    fn root_exe(&self) -> &str { "pwsh.exe" }
}

struct Cmd;
impl VendorAdapter for Cmd {
    fn id(&self) -> &str { "cmd" }
    fn label(&self) -> &str { "cmd (shell)" }
    fn short(&self) -> &str { "cmd" }
    fn kind(&self) -> &str { "shell" }
    fn accent(&self) -> &str { "--muted" }
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
    fn root_exe(&self) -> &str { "cmd.exe" }
}

struct GitBash;
impl VendorAdapter for GitBash {
    fn id(&self) -> &str { "git-bash" }
    fn label(&self) -> &str { "Git Bash" }
    fn short(&self) -> &str { "Git Bash" }
    fn kind(&self) -> &str { "shell" }
    fn accent(&self) -> &str { "--st-waiting" }
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
    fn root_exe(&self) -> &str { "bash.exe" }
}

struct Wsl;
impl VendorAdapter for Wsl {
    fn id(&self) -> &str { "wsl" }
    fn label(&self) -> &str { "WSL" }
    fn short(&self) -> &str { "WSL" }
    fn kind(&self) -> &str { "shell" }
    fn accent(&self) -> &str { "--ice" }
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
    fn root_exe(&self) -> &str { "wsl.exe" }
}

// --- Manifest vendors (I1 #218) --------------------------------------------
// The "add any LLM without recompiling" unlock: a JSON file dropped into
// <app-data>/vendors/ becomes a launchable vendor on the next detect. Files
// whose names start with '_' are ignored (used for the shipped example).
//
//   { "id": "opencode-local", "label": "OpenCode (Local)", "short": "OpenCode",
//     "kind": "agent", "accent": "#3FD79B",
//     "exe": "opencode", "args": ["--model", "qwen2.5-coder"],
//     "env": { "OPENAI_BASE_URL": "http://127.0.0.1:1234/v1",
//              "OPENAI_API_KEY": "lm-studio" },
//     "probe": "opencode" }
//
// `accent` may be a theme token ("--aqua") or a hex colour — the frontend
// resolves either. `env` values are EXPLICIT overrides: a key set here is
// exempted from the ambient-key strip (the user opted in on purpose; that is
// exactly how a local endpoint gets its dummy API key), while every other
// BASE/PROXY key is still stripped.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

static MANIFEST_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

const EXAMPLE_MANIFEST: &str = r##"{
  "_comment": "Rename to <something>.json (files starting with _ are ignored) to add this agent. Restart Flightdeck or reopen New Workspace to detect it.",
  "id": "opencode-local",
  "label": "OpenCode (Local)",
  "short": "OpenCode",
  "kind": "agent",
  "accent": "#3FD79B",
  "exe": "opencode",
  "args": [],
  "env": {
    "OPENAI_BASE_URL": "http://127.0.0.1:1234/v1",
    "OPENAI_API_KEY": "lm-studio"
  },
  "probe": "opencode"
}
"##;

/// Called once at app start with `<app-data>/vendors`. Creates the dir and
/// drops the example manifest on first run so the format is discoverable.
pub fn set_manifest_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let example = dir.join("_example-opencode.json");
    if !example.exists() {
        let _ = std::fs::write(&example, EXAMPLE_MANIFEST);
    }
    *MANIFEST_DIR.write().unwrap() = Some(dir);
}

pub fn manifest_dir() -> Option<PathBuf> {
    MANIFEST_DIR.read().unwrap().clone()
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VendorManifest {
    id: String,
    label: String,
    #[serde(default)]
    short: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    accent: Option<String>,
    exe: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: std::collections::HashMap<String, String>,
    #[serde(default)]
    probe: Option<String>,
}

struct ManifestVendor {
    m: VendorManifest,
    /// Base image name of `exe`, for the orphan scanner.
    root: String,
}

impl ManifestVendor {
    fn new(m: VendorManifest) -> Self {
        let root = Path::new(&m.exe)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| m.exe.clone());
        ManifestVendor { m, root }
    }
}

impl VendorAdapter for ManifestVendor {
    fn id(&self) -> &str { &self.m.id }
    fn label(&self) -> &str { &self.m.label }
    fn short(&self) -> &str { self.m.short.as_deref().unwrap_or(&self.m.label) }
    fn kind(&self) -> &str {
        match self.m.kind.as_deref() {
            Some("shell") => "shell",
            _ => "agent",
        }
    }
    fn accent(&self) -> &str { self.m.accent.as_deref().unwrap_or("--accent") }
    fn root_exe(&self) -> &str { &self.root }

    fn probe(&self) -> (bool, String) {
        let target = self.m.probe.as_deref().unwrap_or(&self.m.exe);
        // A path-looking probe checks the filesystem; a bare name goes
        // through PATH resolution like the builtin adapters.
        if target.contains('\\') || target.contains('/') {
            if Path::new(target).exists() {
                (true, target.to_string())
            } else {
                (false, format!("not found at {target}"))
            }
        } else {
            match which(target) {
                Some(p) => (true, p),
                None => (false, format!("`{target}` not on PATH")),
            }
        }
    }

    fn command(&self, cwd: &str) -> CommandBuilder {
        let mut c = CommandBuilder::new(&self.m.exe);
        c.args(&self.m.args);
        for (k, v) in &self.m.env {
            c.env(k, v);
        }
        c.cwd(cwd);
        c
    }

    /// Ambient-key stripping still applies — EXCEPT keys the manifest sets
    /// explicitly (build_command strips after `command()`, so an un-exempted
    /// key would delete the manifest's own value, breaking e.g. the dummy
    /// OPENAI_API_KEY a local endpoint needs).
    fn env_strip(&self) -> Vec<&'static str> {
        BASE_ENV_STRIP
            .iter()
            .chain(PROXY_ENV_STRIP.iter())
            .filter(|k| !self.m.env.contains_key(**k))
            .copied()
            .collect()
    }
}

/// Load every valid manifest in `dir`. Invalid JSON, missing fields, blank
/// ids/exes, and ids colliding with builtins or earlier files are skipped —
/// a bad file must never break the registry.
fn load_manifests_from(dir: &Path, taken: &[String]) -> Vec<ManifestVendor> {
    let mut out: Vec<ManifestVendor> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().map(|x| x == "json").unwrap_or(false)
                && !p.file_name().map(|f| f.to_string_lossy().starts_with('_')).unwrap_or(true)
        })
        .collect();
    files.sort(); // deterministic precedence for duplicate ids
    for f in files {
        let Ok(s) = std::fs::read_to_string(&f) else { continue };
        let Ok(m) = serde_json::from_str::<VendorManifest>(&s) else { continue };
        if m.id.trim().is_empty() || m.exe.trim().is_empty() {
            continue;
        }
        if taken.iter().any(|t| t == &m.id) || out.iter().any(|v| v.m.id == m.id) {
            continue;
        }
        out.push(ManifestVendor::new(m));
    }
    out
}

pub fn registry() -> Vec<Box<dyn VendorAdapter>> {
    let mut reg: Vec<Box<dyn VendorAdapter>> = vec![
        Box::new(Claude),
        Box::new(Agy),
        Box::new(Pwsh),
        Box::new(Cmd),
        Box::new(GitBash),
        Box::new(Wsl),
    ];
    if let Some(dir) = manifest_dir() {
        let taken: Vec<String> = reg.iter().map(|v| v.id().to_string()).collect();
        for mv in load_manifests_from(&dir, &taken) {
            reg.push(Box::new(mv));
        }
    }
    reg
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
                v.accent().starts_with("--") || v.accent().starts_with('#'),
                "{} accent must be a CSS custom property or hex colour, got {}",
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

    // --- Manifest vendors (#218) -------------------------------------------

    fn temp_manifest_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "fd-manifest-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const GOOD: &str = r##"{
        "id": "opencode-local", "label": "OpenCode (Local)", "short": "OpenCode",
        "kind": "agent", "accent": "#3FD79B",
        "exe": "opencode", "args": ["--fast"],
        "env": { "OPENAI_BASE_URL": "http://127.0.0.1:1234/v1", "OPENAI_API_KEY": "lm-studio" }
    }"##;

    #[test]
    fn manifests_load_and_skip_bad_files() {
        let dir = temp_manifest_dir();
        std::fs::write(dir.join("opencode.json"), GOOD).unwrap();
        std::fs::write(dir.join("broken.json"), "{ not json").unwrap();
        std::fs::write(dir.join("noexe.json"), r#"{"id":"x","label":"X","exe":""}"#).unwrap();
        std::fs::write(dir.join("collide.json"), r#"{"id":"claude","label":"Fake","exe":"evil.exe"}"#).unwrap();
        std::fs::write(dir.join("_example.json"), GOOD).unwrap(); // underscore = ignored
        let loaded = load_manifests_from(&dir, &["claude".to_string()]);
        assert_eq!(loaded.len(), 1, "only the one valid, non-colliding manifest loads");
        assert_eq!(loaded[0].id(), "opencode-local");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_vendor_meets_the_adapter_contract() {
        let m: VendorManifest = serde_json::from_str(GOOD).unwrap();
        let v = ManifestVendor::new(m);
        assert_eq!(v.short(), "OpenCode");
        assert_eq!(v.kind(), "agent");
        assert!(v.accent().starts_with('#'));
        assert_eq!(v.root_exe(), "opencode");
        let cmd = v.command("D:\\test\\dir");
        assert_eq!(
            cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()),
            Some("D:\\test\\dir".to_string())
        );
    }

    // --- agy trust add/prune (K0a) -----------------------------------------

    #[test]
    fn agy_trust_add_then_prune_round_trips() {
        let dir = temp_manifest_dir(); // any temp dir works
        let file = dir.join("settings.json");
        // Seed with an unrelated user entry that must survive.
        std::fs::write(&file, r#"{"trustedWorkspaces":["D:\\my\\project"],"other":42}"#).unwrap();

        trust_file_add(&file, "C:\\app\\worktrees\\abc\\p1");
        trust_file_add(&file, "C:\\app\\worktrees\\abc\\p1"); // idempotent
        let v = read_trust_doc(&file);
        assert_eq!(v["trustedWorkspaces"].as_array().unwrap().len(), 2);

        // Prune matches case/slash-insensitively; unrelated entries + keys stay.
        trust_file_prune(&file, &["c:/app/worktrees/abc/P1".to_string()]);
        let v = read_trust_doc(&file);
        let list = v["trustedWorkspaces"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].as_str(), Some("D:\\my\\project"));
        assert_eq!(v["other"], 42);

        // Pruning a path that isn't there is a no-op.
        trust_file_prune(&file, &["C:\\nope".to_string()]);
        assert_eq!(read_trust_doc(&file)["trustedWorkspaces"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Setup wrapper (Tier 0 follow-up) ----------------------------------

    #[test]
    fn setup_wrapper_quotes_argv_and_keeps_cwd_and_env() {
        let m: VendorManifest = serde_json::from_str(GOOD).unwrap();
        let v = ManifestVendor::new(m);
        let inner = v.command("D:\\wt\\pane1");
        let wrapped = wrap_with_setup(&inner, "npm ci", "D:\\wt\\pane1");
        assert_eq!(
            wrapped.get_cwd().map(|c| c.to_string_lossy().into_owned()),
            Some("D:\\wt\\pane1".to_string())
        );
        let argv: Vec<String> = wrapped.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(argv[0], "pwsh.exe");
        let script = &argv[argv.len() - 1];
        assert!(script.contains("npm ci"), "setup command must appear in the script");
        assert!(script.contains("& 'opencode' '--fast'"), "inner launch must be single-quoted: {script}");
        assert!(script.contains("exit 1"), "setup failure must exit the pane");
        // Manifest env overrides must survive the wrap.
        let env: Vec<(String, String)> = wrapped
            .iter_extra_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert!(env.iter().any(|(k, v)| k == "OPENAI_API_KEY" && v == "lm-studio"));
    }

    #[test]
    fn setup_wrapper_escapes_embedded_quotes() {
        let inner = find("pwsh").command("D:\\x");
        let wrapped = wrap_with_setup(&inner, "echo 'it''s fine'", "D:\\x");
        let argv = wrapped.get_argv();
        let script = argv.last().unwrap().to_string_lossy();
        // The display line quotes the whole setup string; doubled quotes stay doubled.
        assert!(script.contains("echo 'it''s fine'"));
    }

    /// Explicitly-set env keys are exempt from the ambient strip (or
    /// build_command would delete the manifest's own values); everything
    /// else in BASE/PROXY is still stripped.
    #[test]
    fn manifest_env_exemption_is_exact() {
        let m: VendorManifest = serde_json::from_str(GOOD).unwrap();
        let v = ManifestVendor::new(m);
        let strip = v.env_strip();
        assert!(!strip.contains(&"OPENAI_API_KEY"), "explicit key must be exempt");
        for key in BASE_ENV_STRIP.iter().filter(|k| **k != "OPENAI_API_KEY") {
            assert!(strip.contains(key), "still strips {key}");
        }
        for key in PROXY_ENV_STRIP {
            assert!(strip.contains(key), "still strips proxy var {key}");
        }
    }
}
