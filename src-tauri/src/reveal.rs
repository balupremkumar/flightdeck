// reveal.rs — "Reveal in Explorer" (Phase 1 audit item 1.1). The
// tauri-plugin-opener `revealItemInDir` command wraps Win32's
// SHOpenFolderAndSelectItems, which caches the shell window per item: once
// the user closes that Explorer window, a second reveal of the SAME item
// "activates" the dead cached window handle and silently no-ops — no error,
// nothing opens. Spawning a fresh `explorer.exe /select,"<path>"` per call
// sidesteps the cache entirely, at the cost of one new (cheap, GUI, no
// console) process per reveal.

/// Builds the `/select,"<path>"` argument explorer.exe expects as a single
/// raw token (explorer does its own non-standard command-line parsing, not
/// CommandLineToArgvW, so this must be passed via `raw_arg` rather than
/// `.arg()` — Rust's normal Windows arg-quoting would mangle the embedded
/// quotes). Pulled out as a pure function so the construction is unit
/// testable without actually spawning a process.
pub fn explorer_select_arg(path: &str) -> String {
    format!("/select,\"{path}\"")
}

#[cfg(windows)]
fn spawn_explorer_select(path: &str) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer.exe")
        .raw_arg(explorer_select_arg(path))
        .spawn()
}

/// Reveals `path` in a fresh Explorer window, selecting it. Validates the
/// path exists first (explorer.exe would otherwise just open a blank/parent
/// window with no feedback that anything went wrong).
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    #[cfg(windows)]
    {
        spawn_explorer_select(&path)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("reveal_in_explorer is only supported on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_arg_wraps_path_in_quotes_after_select_comma() {
        assert_eq!(
            explorer_select_arg(r"C:\Dev\project\file.txt"),
            r#"/select,"C:\Dev\project\file.txt""#
        );
    }

    #[test]
    fn select_arg_preserves_spaces_in_path() {
        let arg = explorer_select_arg(r"C:\Program Files\thing.txt");
        assert_eq!(arg, r#"/select,"C:\Program Files\thing.txt""#);
    }

    #[test]
    fn reveal_missing_path_errs_without_spawning() {
        let result = reveal_in_explorer("D:\\this-path-should-not-exist-flightdeck-test".to_string());
        assert!(result.is_err());
    }
}
