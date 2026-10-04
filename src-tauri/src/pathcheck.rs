//! Batch "does this path exist" resolver for terminal/preview links.
//! Metadata only, never reads contents, never touches UNC paths.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

const MAX_RAWS: usize = 200;
const MAX_BASES: usize = 8;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathHit {
    pub input: String,
    pub path: String,
    pub is_dir: bool,
}

fn is_unc(s: &str) -> bool {
    crate::pathguard::is_remote_or_device(Path::new(s))
}

fn has_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// `/c/x`, `/c`, `/mnt/c/x`, `/mnt/c` -> `C:\x`.
fn map_posix_drive(s: &str) -> Option<String> {
    let rest = s.strip_prefix("/mnt/").or_else(|| s.strip_prefix('/'))?;
    let b = rest.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() || (b.len() > 1 && b[1] != b'/') {
        return None;
    }
    let drive = (b[0] as char).to_ascii_uppercase();
    let tail = rest[1..].trim_start_matches('/');
    Some(format!("{drive}:\\{}", tail.replace('/', "\\")))
}

/// Lexically resolve `.` and `..` (no filesystem access).
fn normalise(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Strip a trailing `:line` or `:line:col`. None if there is no such suffix.
fn strip_line_suffix(raw: &str) -> Option<&str> {
    let mut s = raw;
    for _ in 0..2 {
        let Some(i) = s.rfind(':') else { break };
        let tail = &s[i + 1..];
        if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) || i < 2 {
            break;
        }
        s = &s[..i];
    }
    if s.len() == raw.len() {
        None
    } else {
        Some(s)
    }
}

fn probe(candidate: &str, bases: &[String], home: Option<&Path>) -> Option<(String, bool)> {
    let mut c = candidate.to_string();
    if c.is_empty() || is_unc(&c) {
        return None;
    }
    if c == "~" || c.starts_with("~/") || c.starts_with("~\\") {
        let h = home?;
        c = format!("{}{}", h.display(), &c[1..]);
    } else if let Some(m) = map_posix_drive(&c) {
        c = m;
    }
    if is_unc(&c) {
        return None;
    }
    let try_path = |p: PathBuf| -> Option<(String, bool)> {
        if crate::pathguard::is_remote_or_device(&p) {
            return None;
        }
        let n = normalise(&p);
        let s = n.to_string_lossy();
        if crate::pathguard::is_remote_or_device(&n) {
            return None;
        }
        std::fs::metadata(&n).ok().map(|m| (s.into_owned(), m.is_dir()))
    };
    if has_drive(&c) {
        return try_path(PathBuf::from(&c));
    }
    if c.as_bytes().get(1) == Some(&b':') {
        return None; // drive-relative like `C:foo`
    }
    for b in bases {
        if b.is_empty() || is_unc(b) {
            continue;
        }
        if let Some(hit) = try_path(Path::new(b).join(&c)) {
            return Some(hit);
        }
    }
    None
}

pub fn resolve_with_home(raws: &[String], bases: &[String], home: Option<&Path>) -> Vec<Option<PathHit>> {
    let bases = &bases[..bases.len().min(MAX_BASES)];
    raws.iter()
        .enumerate()
        .map(|(i, raw)| {
            if i >= MAX_RAWS {
                return None;
            }
            let found = probe(raw, bases, home)
                .or_else(|| strip_line_suffix(raw).and_then(|s| probe(s, bases, home)));
            found.map(|(path, is_dir)| PathHit { input: raw.clone(), path, is_dir })
        })
        .collect()
}

#[tauri::command]
pub async fn paths_exist(raws: Vec<String>, bases: Vec<String>) -> Vec<Option<PathHit>> {
    let n = raws.len();
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
        resolve_with_home(&raws, &bases, home.as_deref())
    })
    .await
    .unwrap_or_else(|_| vec![None; n])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fd-pathcheck-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let c = d.canonicalize().unwrap();
        PathBuf::from(c.to_string_lossy().trim_start_matches(r"\\?\"))
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn absolute_hit_and_dir_flag() {
        let d = tmp("abs");
        fs::write(d.join("a.txt"), "x").unwrap();
        fs::create_dir(d.join("sub")).unwrap();
        let r = resolve_with_home(&[s(&d.join("a.txt")), s(&d.join("sub")), s(&d.join("nope"))], &[], None);
        assert!(!r[0].as_ref().unwrap().is_dir);
        assert!(r[1].as_ref().unwrap().is_dir);
        assert!(r[2].is_none());
        assert_eq!(r[0].as_ref().unwrap().input, s(&d.join("a.txt")));
    }

    #[test]
    fn relative_against_second_base() {
        let a = tmp("rel-a");
        let b = tmp("rel-b");
        fs::write(b.join("f.rs"), "x").unwrap();
        let r = resolve_with_home(&["f.rs".into()], &[s(&a), s(&b)], None);
        assert_eq!(r[0].as_ref().unwrap().path, s(&b.join("f.rs")));
    }

    #[test]
    fn first_base_wins() {
        let a = tmp("first-a");
        let b = tmp("first-b");
        fs::write(a.join("f"), "x").unwrap();
        fs::write(b.join("f"), "x").unwrap();
        let r = resolve_with_home(&["f".into()], &[s(&a), s(&b)], None);
        assert_eq!(r[0].as_ref().unwrap().path, s(&a.join("f")));
    }

    #[test]
    fn tilde_expansion() {
        let h = tmp("home");
        fs::write(h.join("rc"), "x").unwrap();
        let raws = ["~/rc".to_string(), "~\\rc".to_string(), "~".to_string()];
        let r = resolve_with_home(&raws, &[], Some(&h));
        assert_eq!(r[0].as_ref().unwrap().path, s(&h.join("rc")));
        assert!(r[1].is_some());
        assert!(r[2].as_ref().unwrap().is_dir);
        assert!(resolve_with_home(&["~/rc".into()], &[], None)[0].is_none());
    }

    #[test]
    fn git_bash_and_wsl_mapping() {
        let d = tmp("map");
        fs::write(d.join("m.txt"), "x").unwrap();
        let st = s(&d);
        let drive = st.chars().next().unwrap().to_ascii_lowercase();
        let tail = st[2..].replace('\\', "/");
        let gb = format!("/{drive}{tail}/m.txt");
        let wsl = format!("/mnt/{drive}{tail}/m.txt");
        let r = resolve_with_home(&[gb, wsl], &[], None);
        assert_eq!(r[0].as_ref().unwrap().path, s(&d.join("m.txt")));
        assert_eq!(r[1].as_ref().unwrap().path, s(&d.join("m.txt")));
    }

    #[test]
    fn dotdot_normalised() {
        let d = tmp("dots");
        fs::create_dir(d.join("sub")).unwrap();
        fs::write(d.join("t.txt"), "x").unwrap();
        let r = resolve_with_home(&["../t.txt".into(), "./t.txt".into()], &[s(&d.join("sub")), s(&d)], None);
        assert_eq!(r[0].as_ref().unwrap().path, s(&d.join("t.txt")));
        assert_eq!(r[1].as_ref().unwrap().path, s(&d.join("t.txt")));
    }

    #[test]
    fn line_suffix_only_when_needed() {
        let d = tmp("line");
        fs::write(d.join("a.rs"), "x").unwrap();
        let r = resolve_with_home(&["a.rs:12".into(), "a.rs:12:5".into(), "a.rs:x".into()], &[s(&d)], None);
        assert_eq!(r[0].as_ref().unwrap().path, s(&d.join("a.rs")));
        assert_eq!(r[1].as_ref().unwrap().path, s(&d.join("a.rs")));
        assert!(r[2].is_none());
        // the whole raw is tried first: a bare drive-letter colon is not a suffix
        assert_eq!(strip_line_suffix("C:\\x\\a.rs:3"), Some("C:\\x\\a.rs"));
        assert_eq!(strip_line_suffix("C:5"), None);
    }

    #[test]
    fn unc_rejected() {
        let d = tmp("unc");
        fs::write(d.join("f"), "x").unwrap();
        let raws = ["\\\\host\\share\\f".to_string(), "//host/share/f".to_string(), "f".to_string()];
        let r = resolve_with_home(&raws, &["\\\\host\\share".into(), "//host/share".into(), s(&d)], None);
        assert!(r[0].is_none());
        assert!(r[1].is_none());
        assert!(r[2].is_some()); // UNC bases skipped, real base still used
    }

    #[test]
    fn mixed_slash_and_device_paths_rejected() {
        let d = tmp("mixed");
        fs::write(d.join("f"), "x").unwrap();
        let bad = [
            r"/\server\share\x",
            r"\/server/share/x",
            r"/\\server\share",
            r"\\?\UNC\server\share\x",
            r"\\?\C:\x",
            r"\\.\pipe\x",
            "//server/share",
            "%5C%5Cserver%5Cshare",
        ];
        let raws: Vec<String> = bad.iter().map(|b| b.to_string()).collect();
        let r = resolve_with_home(&raws, &[s(&d)], None);
        assert!(r.iter().all(|x| x.is_none()));
        // bad bases are skipped, the real base still resolves
        let bases = [r"/\server\share".to_string(), r"\/server/x".to_string(), r"\\?\C:\".to_string(), s(&d)];
        let r = resolve_with_home(&["f".into()], &bases, None);
        assert_eq!(r[0].as_ref().unwrap().path, s(&d.join("f")));
        // a UNC raw that follows a `~` expansion is also refused
        let h = tmp("mixed-home");
        assert!(resolve_with_home(&[r"~/\server\share".into()], &[], Some(&h))[0].is_none());
    }

    #[test]
    fn caps_respected() {
        let d = tmp("cap");
        fs::write(d.join("f"), "x").unwrap();
        let raws: Vec<String> = (0..205).map(|_| "f".to_string()).collect();
        let r = resolve_with_home(&raws, &[s(&d)], None);
        assert_eq!(r.len(), 205);
        assert!(r[199].is_some());
        assert!(r[200].is_none());
        // the 9th base is ignored
        let mut bases: Vec<String> = (0..8).map(|i| s(&d.join(format!("missing{i}")))).collect();
        bases.push(s(&d));
        assert!(resolve_with_home(&["f".into()], &bases, None)[0].is_none());
    }
}
