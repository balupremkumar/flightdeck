//! QL-752: shell integration (FinalTerm / OSC 133 command marks + OSC 9;9 cwd)
//! injected into interactive PowerShell panes at spawn.
//!
//! WHY INJECTION AT ALL: a pane can only draw command boundaries — where a
//! command started, where its output began, whether it succeeded — if the shell
//! says so. Nothing on Windows emits those sequences by default, so Flightdeck
//! has to install the hook itself, the same way Windows Terminal and VS Code
//! ask users to paste a snippet into their profile. We do it per-launch instead
//! so the user's profile is never touched.
//!
//! WHAT GETS INJECTED (and what deliberately does not):
//!   * ONLY a bare interactive PowerShell — argv is exactly `pwsh.exe` (or
//!     `powershell.exe`) with no arguments. That is the whole detection rule,
//!     and it is what keeps this off every other vendor:
//!       - Claude Code launches `pwsh.exe -NoLogo -NoProfile -Command claude`,
//!         so argv.len() > 1 and it is skipped. Agents that emit their own 133
//!         sequences therefore can never be double-marked by us — we simply do
//!         not wrap anything that is running a program.
//!       - The worktree setup wrapper (vendors::wrap_with_setup) also produces
//!         `pwsh.exe -NoLogo -Command <script>`, likewise skipped.
//!       - cmd.exe, git-bash and wsl are skipped: cmd has no prompt hook that
//!         can report an exit code (Windows Terminal needs clink for it), and
//!         bash would need PROMPT_COMMAND + a DEBUG trap surviving an
//!         unknown ~/.bashrc. Neither is robust enough to inject blind, so
//!         they stay plain shells until someone asks for them specifically.
//!   * A manifest vendor whose exe IS a bare pwsh gets the integration too,
//!     which is the intended behaviour (it is an interactive shell). No
//!     manifest opt-out flag was added: the argv rule already gives one — a
//!     manifest that passes any arg is treated as "running a program" — and
//!     the schema/adapter live in vendors.rs, which this change deliberately
//!     does not touch.
//!
//! HOW: `pwsh -NoExit -Command ". '<script>'"`. Dot-sourcing (rather than
//! `-File`) runs the script in the GLOBAL scope, which is the only way the
//! `prompt` function it defines survives past the script. Profiles load before
//! `-Command` runs, so the script sees the user's own prompt and WRAPS it
//! (oh-my-posh and friends keep working) instead of replacing it. The script
//! is written to disk at launch rather than passed inline because PowerShell's
//! parsing of embedded quotes inside a `-Command` string is a known minefield;
//! the only thing on the command line is a quoted path.

use portable_pty::CommandBuilder;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

const SCRIPT_NAME: &str = "flightdeck-shell-integration.ps1";

/// The injected preamble. Emits, per prompt:
///   OSC 133;D;<exit>  the command that just finished (omitted for the first
///                     prompt, and emitted without a code when nothing ran —
///                     a bare Enter or Ctrl+C, which history can detect)
///   OSC 133;A         prompt start
///   OSC 9;9;<cwd>     Windows Terminal's cwd convention (QL-757)
///   OSC 133;B         command start (the user's input begins here)
/// and, from the PSReadLine read-line wrapper, OSC 133;C right before the
/// command's output. PSReadLine is present in every stock pwsh but the wrapper
/// is guarded anyway — without it the pane still gets A/B/D, only the exact
/// output boundary is missing.
const SCRIPT: &str = r##"# Flightdeck shell integration (QL-752/753/757).
# Written by Flightdeck at launch and dot-sourced into interactive PowerShell
# panes. Hand edits are overwritten on the next launch.
if ($global:__FlightdeckShellIntegration) { return }
$global:__FlightdeckShellIntegration = $true
$global:__FlightdeckLastHistoryId = -1
$global:__FlightdeckOrigPrompt = $function:prompt

function global:__Flightdeck-ExitCode {
  # $? is the success of the last statement the USER ran, because this is the
  # first thing prompt does. A failed native command leaves its code in
  # $LASTEXITCODE; a failed cmdlet leaves none, so report 1.
  if ($? -eq $true) { return 0 }
  if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { return $global:LASTEXITCODE }
  return 1
}

function global:prompt {
  $code = __Flightdeck-ExitCode
  $e = [char]27
  $bel = [char]7
  $last = Get-History -Count 1
  $out = ''
  if ($global:__FlightdeckLastHistoryId -ne -1) {
    if ($last -and $last.Id -eq $global:__FlightdeckLastHistoryId) {
      $out += "$e]133;D$bel"
    } else {
      $out += "$e]133;D;$code$bel"
    }
  }
  $out += "$e]133;A$bel"
  $loc = $ExecutionContext.SessionState.Path.CurrentLocation
  $path = $loc.ProviderPath
  if (-not $path) { $path = $loc.Path }
  if ($loc.Provider.Name -eq 'FileSystem' -and $path) { $out += "$e]9;9;$path$bel" }
  # Wrap the user's own prompt rather than replacing it. A prompt that writes
  # to the host itself returns '' — that is NOT missing, so only a genuinely
  # absent/throwing prompt falls back to a plain one.
  $inner = $null
  if ($global:__FlightdeckOrigPrompt) {
    try { $inner = [string](& $global:__FlightdeckOrigPrompt) } catch { $inner = $null }
  }
  if ($null -eq $inner) { $inner = "PS $path$('>' * ($nestedPromptLevel + 1)) " }
  $out += $inner
  $out += "$e]133;B$bel"
  if ($last) { $global:__FlightdeckLastHistoryId = $last.Id }
  return $out
}

# OSC 133;C — the output boundary. PSConsoleHostReadLine is PSReadLine's
# read-line entry point, so wrapping it fires exactly once per accepted line,
# after the user pressed Enter and before the command runs.
if (Test-Path Function:\PSConsoleHostReadLine) {
  $global:__FlightdeckOrigReadLine = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $line = & $global:__FlightdeckOrigReadLine
    [Console]::Write("$([char]27)]133;C$([char]7)")
    return $line
  }
}
"##;

static SCRIPT_PATH: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Called once at app start with a private directory under app-data. Rewrites
/// the script every launch so it can never go stale against a newer build, and
/// only publishes the path if the write actually succeeded — a failed write
/// means no injection at all, i.e. a plain pwsh pane, never a broken one.
pub fn init(dir: PathBuf) {
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(SCRIPT_NAME);
    if std::fs::write(&path, SCRIPT).is_err() {
        return;
    }
    *SCRIPT_PATH.write().unwrap() = Some(path);
}

/// The on-disk script, once `init` has written it.
pub fn script_path() -> Option<PathBuf> {
    SCRIPT_PATH.read().unwrap().clone()
}

/// Single-quote for PowerShell (embedded quotes double). Same rule as
/// vendors::psq, duplicated rather than making that helper public — this
/// module is meant to be removable without touching the vendor registry.
fn psq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The whole detection rule: a PowerShell with no arguments is an interactive
/// shell; a PowerShell with arguments is running something else.
fn is_bare_powershell(argv: &[OsString]) -> bool {
    if argv.len() != 1 {
        return false;
    }
    let name = Path::new(&argv[0])
        .file_name()
        .map(|f| f.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(name.as_str(), "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe")
}

/// Add the integration to `cmd` if it qualifies. Returns whether it did.
pub fn inject(cmd: &mut CommandBuilder) -> bool {
    match script_path() {
        Some(p) => inject_with_script(cmd, &p),
        None => false, // init never ran or the write failed — plain shell
    }
}

pub(crate) fn inject_with_script(cmd: &mut CommandBuilder, script: &Path) -> bool {
    if !is_bare_powershell(cmd.get_argv()) {
        return false;
    }
    let dot_source = format!(". {}", psq(&script.to_string_lossy()));
    let argv = cmd.get_argv_mut();
    argv.push(OsString::from("-NoExit"));
    argv.push(OsString::from("-Command"));
    argv.push(OsString::from(dot_source));
    // Lets the shell (and anything it launches) tell it's a Flightdeck pane
    // with marks enabled; also what a nested pwsh would check if we ever want
    // to suppress double injection.
    cmd.env("FLIGHTDECK_SHELL_INTEGRATION", "1");
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv_of(cmd: &CommandBuilder) -> Vec<String> {
        cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn script() -> PathBuf {
        PathBuf::from(r"C:\Users\Me\AppData\Roaming\Flightdeck\shell\flightdeck-shell-integration.ps1")
    }

    #[test]
    fn bare_pwsh_gets_the_preamble_dot_sourced() {
        let mut c = CommandBuilder::new("pwsh.exe");
        c.cwd(r"C:\repo");
        assert!(inject_with_script(&mut c, &script()));
        assert_eq!(
            argv_of(&c),
            vec![
                "pwsh.exe".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                r". 'C:\Users\Me\AppData\Roaming\Flightdeck\shell\flightdeck-shell-integration.ps1'".to_string(),
            ]
        );
        // cwd survives the splice — the pane must still open in its folder.
        assert_eq!(c.get_cwd().map(|d| d.to_string_lossy().into_owned()), Some(r"C:\repo".to_string()));
        assert_eq!(c.get_env("FLIGHTDECK_SHELL_INTEGRATION").map(|v| v.to_string_lossy().into_owned()), Some("1".into()));
    }

    #[test]
    fn windows_powershell_and_bare_names_qualify_too() {
        for prog in ["powershell.exe", "pwsh", "POWERSHELL.EXE", r"C:\Program Files\PowerShell\7\pwsh.exe"] {
            let mut c = CommandBuilder::new(prog);
            assert!(inject_with_script(&mut c, &script()), "{prog} should qualify");
        }
    }

    // The load-bearing guard: an agent launched THROUGH pwsh is running a
    // program, not sitting at a prompt. Claude Code emits its own sequences;
    // wrapping it would double-mark and could disturb its TUI.
    #[test]
    fn a_powershell_that_is_running_a_program_is_left_alone() {
        let mut claude = CommandBuilder::new("pwsh.exe");
        claude.args(["-NoLogo", "-NoProfile", "-Command", "claude"]);
        assert!(!inject_with_script(&mut claude, &script()));
        assert_eq!(argv_of(&claude).len(), 5);

        // vendors::wrap_with_setup's shape (worktree setup phase).
        let mut setup = CommandBuilder::new("pwsh.exe");
        setup.args(["-NoLogo", "-Command", "npm ci\n& 'pwsh.exe'"]);
        assert!(!inject_with_script(&mut setup, &script()));
    }

    #[test]
    fn other_shells_and_agents_are_left_alone() {
        for prog in ["cmd.exe", "bash.exe", "wsl.exe", "agy.exe", "opencode"] {
            let mut c = CommandBuilder::new(prog);
            assert!(!inject_with_script(&mut c, &script()), "{prog} must not be wrapped");
            assert_eq!(argv_of(&c), vec![prog.to_string()]);
        }
    }

    #[test]
    fn a_quote_in_the_script_path_is_escaped_not_injected() {
        let mut c = CommandBuilder::new("pwsh.exe");
        inject_with_script(&mut c, Path::new(r"C:\it's\shell.ps1"));
        assert_eq!(argv_of(&c)[3], r". 'C:\it''s\shell.ps1'");
    }

    // The frontend (Terminal.tsx) can only draw marks for sequences the script
    // actually emits, so pin the contract here.
    #[test]
    fn the_script_emits_every_sequence_the_pane_parses() {
        for seq in ["]133;A", "]133;B", "]133;C", "]133;D;$code", "]133;D$bel", "]9;9;$path"] {
            assert!(SCRIPT.contains(seq), "script must emit {seq}");
        }
        // Global scope everywhere: dot-sourced or not, the prompt must outlive
        // the script that defined it.
        assert!(SCRIPT.contains("function global:prompt"));
        // Re-entrancy guard, so a nested dot-source can't stack two wrappers.
        assert!(SCRIPT.contains("if ($global:__FlightdeckShellIntegration) { return }"));
    }

    #[test]
    fn init_writes_the_script_and_publishes_a_usable_path() {
        let dir = std::env::temp_dir().join(format!("flightdeck-shellmarks-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        init(dir.clone());
        let p = script_path().expect("init should publish a path");
        assert!(p.exists());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), SCRIPT);
        // And the published path is the one injection uses.
        let mut c = CommandBuilder::new("pwsh.exe");
        assert!(inject(&mut c));
        assert!(argv_of(&c)[3].contains(SCRIPT_NAME));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
