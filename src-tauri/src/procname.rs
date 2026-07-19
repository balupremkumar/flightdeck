// procname.rs — "live foreground process name per pane" (audit item). Given a
// pane's root pid and a toolhelp snapshot (shared across panes per tick, see
// orphans::snapshot_processes — reused rather than duplicated), approximates
// "the program actually doing work" as the deepest descendant of the root: a
// pane usually launches via pwsh -> node -> the actual CLI, and the leaf is
// what the user perceives as running. Ties at the same depth (e.g. two
// siblings) are broken by pid, since Windows pids are assigned in increasing
// order for the life of a boot — a cheap stand-in for "most recently created"
// that avoids an extra per-process syscall for creation time.

use std::collections::HashMap;

/// Walks `all` (pid, ppid, name) from `root_pid` and returns the normalised
/// image name of the deepest descendant (root included, so a root with no
/// children yet returns its own name). `None` only if `root_pid` isn't present
/// in the snapshot (the process has already exited).
pub fn deepest_descendant_name(root_pid: u32, all: &[(u32, u32, String)]) -> Option<String> {
    if !all.iter().any(|(pid, _, _)| *pid == root_pid) {
        return None;
    }

    let mut depth: HashMap<u32, u32> = HashMap::new();
    depth.insert(root_pid, 0);
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, ppid, _) in all {
            if depth.contains_key(pid) {
                continue;
            }
            if let Some(&pd) = depth.get(ppid) {
                depth.insert(*pid, pd + 1);
                changed = true;
            }
        }
    }

    all.iter()
        .filter(|(pid, _, _)| depth.contains_key(pid))
        .max_by_key(|(pid, _, _)| (depth[pid], *pid))
        .map(|(_, _, name)| normalize(name))
}

/// Strip a trailing `.exe`/`.EXE` extension. Anything else is returned as-is.
pub fn normalize(name: &str) -> String {
    if name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(".exe") {
        name[..name.len() - 4].to_string()
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // pwsh(100) -> node(200) -> claude(300); unrelated(400) is its own tree.
    fn table() -> Vec<(u32, u32, String)> {
        vec![
            (100, 1, "pwsh.exe".to_string()),
            (200, 100, "node.exe".to_string()),
            (300, 200, "claude.exe".to_string()),
            (400, 1, "unrelated.exe".to_string()),
        ]
    }

    #[test]
    fn deepest_descendant_picks_the_leaf() {
        let all = table();
        assert_eq!(deepest_descendant_name(100, &all).as_deref(), Some("claude"));
    }

    #[test]
    fn root_with_no_children_returns_itself() {
        let all = table();
        assert_eq!(deepest_descendant_name(400, &all).as_deref(), Some("unrelated"));
    }

    #[test]
    fn missing_root_returns_none() {
        let all = table();
        assert_eq!(deepest_descendant_name(999, &all), None);
    }

    #[test]
    fn tie_at_same_depth_picks_higher_pid() {
        let all = vec![
            (1, 0, "pwsh.exe".to_string()),
            (2, 1, "aaa.exe".to_string()),
            (3, 1, "zzz.exe".to_string()), // same depth as 2, higher pid
        ];
        assert_eq!(deepest_descendant_name(1, &all).as_deref(), Some("zzz"));
    }

    #[test]
    fn normalize_strips_exe_case_insensitively() {
        assert_eq!(normalize("Claude.EXE"), "Claude");
        assert_eq!(normalize("node.exe"), "node");
        assert_eq!(normalize("bash"), "bash");
    }
}
