//! Refuses network and device paths before any filesystem call.
//! A UNC path makes Windows open an SMB connection (NTLM to a named host),
//! so the check is structural and runs before metadata/read/open.
//! Rust's Windows parser treats mixed slashes (`/\host`, `\/host`) as UNC,
//! so a plain `starts_with("\\\\")` string test is not enough.

use std::path::{Component, Path, PathBuf, Prefix};

pub const NETWORK_PATH_ERR: &str = "Network paths are not opened from Flightdeck.";

/// True for UNC, verbatim (`\\?\`) and device (`\\.\`) prefixes, and for any
/// string that starts with two separators of either kind.
pub fn is_remote_or_device(p: &Path) -> bool {
    if is_remote_or_device_str(&p.to_string_lossy()) {
        return true;
    }
    matches!(
        p.components().next(),
        Some(Component::Prefix(pre)) if matches!(
            pre.kind(),
            Prefix::UNC(..)
                | Prefix::VerbatimUNC(..)
                | Prefix::Verbatim(..)
                | Prefix::VerbatimDisk(..)
                | Prefix::DeviceNS(..)
        )
    )
}

pub fn is_remote_or_device_str(s: &str) -> bool {
    let s = s.trim_start();
    let mut it = s.chars();
    matches!((it.next(), it.next()), (Some('/' | '\\'), Some('/' | '\\')))
}

/// Err for a path the webview must not make us touch.
pub fn check(p: &str) -> Result<(), String> {
    if is_remote_or_device(Path::new(p)) {
        Err(NETWORK_PATH_ERR.to_string())
    } else {
        Ok(())
    }
}

/// Like `check`, for a path already built (joined/normalised).
#[allow(dead_code)]
pub fn check_path(p: &Path) -> Result<PathBuf, String> {
    if is_remote_or_device(p) {
        Err(NETWORK_PATH_ERR.to_string())
    } else {
        Ok(p.to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_network_and_device_forms() {
        for p in [
            r"/\server\share\x",
            r"\/server/share/x",
            r"/\\server\share",
            r"\\?\UNC\server\share\x",
            r"\\?\C:\x",
            r"\\.\pipe\x",
            "//server/share",
            r"\\server\share",
            "  \\\\server\\share",
        ] {
            assert!(is_remote_or_device(Path::new(p)), "{p}");
            assert_eq!(check(p).unwrap_err(), NETWORK_PATH_ERR, "{p}");
        }
    }

    #[test]
    fn rejects_joined_unc() {
        let j = Path::new(r"D:\base").join(r"/\server/share/x.txt");
        assert!(is_remote_or_device(&j));
        assert!(check_path(&j).is_err());
    }

    #[test]
    fn allows_local_paths() {
        for p in [r"C:\x\y", "C:/x/y", "rel/path", "./a", "~/a", "/c/Users/x", "/mnt/c/x", "/tmp/x"] {
            assert!(check(p).is_ok(), "{p}");
        }
    }
}
