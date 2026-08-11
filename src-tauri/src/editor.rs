// editor.rs — UX-517: actually launching the editor chosen in Settings.
//
// Settings has shipped an editor picker (and a resolved command template)
// since UX-516/517, but nothing ever ran it: every "open in editor" in the app
// went through the opener plugin's `openPath`, i.e. whatever Windows has
// associated with the extension. This is the missing half — a dumb spawner.
//
// Deliberately dumb: the frontend (src/editor.ts) owns template resolution and
// tokenising, and hands over an already-split program + argument ARRAY. No
// shell, no `cmd /c`, no re-joining into a command string, so a path with
// spaces (or a filename with a quote in it) can never turn into extra
// arguments. The one piece of real work here is finding the program, because
// std::process::Command on Windows only ever appends `.exe` when it searches
// PATH — and every mainstream editor launcher (`code`, `code-insiders`) is a
// `.cmd` shim, which would otherwise fail with "not found" and silently drop
// every user back onto the OS default-app hand-off.
//
// Batch shims are safe to spawn this way: since the CVE-2024-24576 fix
// (Rust 1.77.2, this crate builds on far newer) std routes a `.bat`/`.cmd`
// program through cmd.exe with the arguments escaped for cmd's own parser, or
// refuses to spawn at all if they can't be escaped.

use std::path::{Path, PathBuf};

/// CREATE_NO_WINDOW. A `.cmd` shim would otherwise flash a console window on
/// every open; GUI editors are unaffected by it.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What Windows falls back to when PATHEXT is missing from the environment.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// PATHEXT as a list of lowercase extensions, each including its dot.
fn pathext() -> Vec<String> {
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| DEFAULT_PATHEXT.to_string());
    parse_pathext(&raw)
}

/// Pure half of `pathext()`. Tolerates the entries Windows itself allows:
/// case-insensitive, semicolon-separated, occasionally missing the leading dot
/// or padded with blanks.
pub(crate) fn parse_pathext(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(|e| e.trim())
        .filter(|e| !e.is_empty())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            if lower.starts_with('.') {
                lower
            } else {
                format!(".{lower}")
            }
        })
        .collect()
}

/// Does `program` already end in one of PATHEXT's extensions? Such a name is
/// tried verbatim first — appending another extension to `idea64.exe` would
/// only produce misses.
pub(crate) fn has_known_ext(program: &str, exts: &[String]) -> bool {
    let lower = program.to_ascii_lowercase();
    exts.iter().any(|e| lower.ends_with(e.as_str()))
}

/// Every filename worth trying for `program`, in the order Windows itself
/// would: the name exactly as configured, then the name plus each PATHEXT
/// extension. `code` therefore resolves to `code.cmd` rather than dying on a
/// missing `code.exe`, while `notepad++` (no extension, real `.exe`) resolves
/// to `notepad++.exe`.
pub(crate) fn name_candidates(program: &str, exts: &[String]) -> Vec<String> {
    let mut out = vec![program.to_string()];
    if !has_known_ext(program, exts) {
        for e in exts {
            out.push(format!("{program}{e}"));
        }
    }
    out
}

/// Is this an explicit path (absolute, or containing a separator) rather than
/// a bare name to look up on PATH?
fn is_explicit_path(program: &str) -> bool {
    program.contains('\\') || program.contains('/')
}

/// The real file to hand to `Command::new`, or None to let the OS try the bare
/// name and produce its own error. Filesystem-touching, hence not unit-tested;
/// the ordering it walks is (`name_candidates`).
fn resolve_program(program: &str) -> Option<PathBuf> {
    let exts = pathext();
    if is_explicit_path(program) {
        return name_candidates(program, &exts)
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file());
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in name_candidates(program, &exts) {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// One clear sentence per failure. "Not found" is by far the likeliest (a
/// custom command with a typo, or an editor that was never installed) and
/// deserves better than the OS's "The system cannot find the file specified.
/// (os error 2)", which never names the program.
pub(crate) fn spawn_error_message(program: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("{program} isn't installed, or isn't on PATH")
    } else {
        format!("couldn't start {program}: {e}")
    }
}

fn spawn(program: &Path, args: &[String]) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        // Detached: nothing here ever reads the child's output, and leaving it
        // holding this process's stdio would tie the editor to Flightdeck.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // The Child is dropped immediately on purpose — this is a launch, not a
    // supervised process. Unlike a pane (see job.rs) the editor is deliberately
    // NOT put in Flightdeck's job object: closing Flightdeck must never close
    // the user's editor.
    cmd.spawn().map(|_| ())
}

/// Launch `program` with `args`, both already resolved by the frontend.
/// Errors are plain sentences: src/editor.ts shows them in a toast and then
/// falls back to the OS default-app hand-off, so a failure here degrades to
/// the old behaviour rather than to nothing happening.
#[tauri::command]
pub fn launch_editor(program: String, args: Vec<String>) -> Result<(), String> {
    if program.trim().is_empty() {
        return Err("no editor command is configured".to_string());
    }
    let resolved = resolve_program(&program).unwrap_or_else(|| PathBuf::from(&program));
    spawn(&resolved, &args).map_err(|e| spawn_error_message(&program, &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exts() -> Vec<String> {
        parse_pathext(DEFAULT_PATHEXT)
    }

    #[test]
    fn pathext_is_parsed_lowercase_and_dotted() {
        assert_eq!(parse_pathext(".COM;.EXE;.BAT;.CMD"), [".com", ".exe", ".bat", ".cmd"]);
    }

    #[test]
    fn pathext_tolerates_blanks_and_missing_dots() {
        assert_eq!(parse_pathext("EXE; .cmd ;;"), [".exe", ".cmd"]);
    }

    #[test]
    fn a_name_with_a_known_extension_is_recognised_whatever_its_case() {
        assert!(has_known_ext("idea64.EXE", &exts()));
        assert!(has_known_ext("code.cmd", &exts()));
        assert!(!has_known_ext("code", &exts()));
        // ".py" isn't in the default PATHEXT, so it is not a launcher extension.
        assert!(!has_known_ext("tool.py", &exts()));
    }

    /// The regression this module exists for: `code` on Windows is `code.cmd`,
    /// and Command::new only ever tries `code.exe`.
    #[test]
    fn a_bare_name_offers_the_cmd_shim_as_a_candidate() {
        let c = name_candidates("code", &exts());
        assert_eq!(c[0], "code", "the name as configured is always tried first");
        assert!(c.contains(&"code.cmd".to_string()));
        assert!(c.contains(&"code.exe".to_string()));
        // .exe beats .cmd, exactly as Windows' own PATHEXT order does.
        let exe = c.iter().position(|x| x == "code.exe").unwrap();
        let cmd = c.iter().position(|x| x == "code.cmd").unwrap();
        assert!(exe < cmd);
    }

    #[test]
    fn a_name_that_already_has_an_extension_is_never_suffixed_again() {
        assert_eq!(name_candidates("idea64.exe", &exts()), ["idea64.exe"]);
    }

    #[test]
    fn an_explicit_path_is_recognised_on_either_separator() {
        assert!(is_explicit_path(r"C:\Program Files\Editor\ed.exe"));
        assert!(is_explicit_path("/usr/local/bin/ed"));
        assert!(!is_explicit_path("code"));
    }

    #[test]
    fn a_missing_program_is_named_in_the_error_rather_than_left_as_os_error_2() {
        let e = std::io::Error::new(std::io::ErrorKind::NotFound, "The system cannot find the file specified.");
        let msg = spawn_error_message("code", &e);
        assert!(msg.contains("code"));
        assert!(!msg.contains("os error"));
    }

    #[test]
    fn any_other_failure_still_names_the_program_and_keeps_the_detail() {
        let e = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Access is denied.");
        let msg = spawn_error_message("idea64", &e);
        assert!(msg.contains("idea64"));
        assert!(msg.contains("Access is denied."));
    }

    #[test]
    fn an_empty_command_is_refused_without_spawning_anything() {
        assert!(launch_editor("   ".to_string(), vec![]).is_err());
    }

    #[test]
    fn a_program_that_does_not_exist_reports_it_instead_of_panicking() {
        let err = launch_editor("flightdeck-no-such-editor".to_string(), vec!["x".into()])
            .expect_err("a missing program must not spawn");
        assert!(err.contains("flightdeck-no-such-editor"));
    }
}
