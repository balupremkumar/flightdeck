// health.rs — per-pane health metrics (202): pid, CPU%, memory. CPU% is
// computed by the caller from two consecutive samples (kernel+user time
// deltas over wall-clock elapsed), since a single point-in-time read of
// cumulative process time isn't a percentage on its own. `sample()` returns
// the raw cumulative numbers for that purpose.

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneHealth {
    pub pane_id: u32,
    pub pid: u32,
    /// Percentage of one CPU core consumed since the previous sample (0 on
    /// the first sample for a pane, since there's no baseline yet). Not
    /// normalised across cores — a busy multi-threaded process can exceed 100.
    pub cpu_percent: f64,
    pub memory_mb: f64,
    /// Best-effort live foreground process name for this pane (procname.rs),
    /// e.g. "claude" / "node" / "pwsh" — the deepest descendant of the pane's
    /// root pid, `.exe` stripped. Empty until the sampler's first tick.
    pub proc_name: String,
    /// UX-596: the warning threshold this reading was compared against (echoed
    /// back so the UI can label the number, e.g. "memory ceiling: 1024 MB").
    pub memory_warn_mb: f64,
    /// True when `memory_mb` is at or over `memory_warn_mb` — Diagnostics uses
    /// this to flag the pane rather than every caller re-deriving the compare.
    pub over_memory_warn: bool,
}

/// Sensible default when the caller (Settings, eventually) hasn't configured
/// one yet: generous enough that a normal agent + its node/npm children don't
/// trip it, low enough to actually catch a runaway process.
pub const DEFAULT_MEMORY_WARN_MB: f64 = 1024.0;
/// Clamp bounds for a caller-supplied threshold — keeps a fat-fingered or
/// corrupt Settings value from disabling the warning entirely (too high) or
/// making it fire constantly (too low).
const MIN_MEMORY_WARN_MB: f64 = 64.0;
const MAX_MEMORY_WARN_MB: f64 = 65536.0;

/// UX-596: resolve the effective memory warning threshold from an optional
/// caller-supplied value (Settings, eventually), clamped to a sane range so a
/// bad value can't silently disable the warning or make it useless.
pub fn resolve_memory_warn_mb(requested: Option<f64>) -> f64 {
    match requested {
        Some(mb) if mb.is_finite() => mb.clamp(MIN_MEMORY_WARN_MB, MAX_MEMORY_WARN_MB),
        _ => DEFAULT_MEMORY_WARN_MB,
    }
}

/// Cumulative (kernel+user) CPU time in 100ns units, and working-set memory
/// in bytes, for a pid. `None` if the process can't be queried (already gone,
/// access denied).
#[cfg(windows)]
pub fn sample(pid: u32) -> Option<(u64, u64)> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    fn filetime_to_u64(low: u32, high: u32) -> u64 {
        ((high as u64) << 32) | low as u64
    }

    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() {
            return None;
        }

        let mut creation = std::mem::zeroed();
        let mut exit = std::mem::zeroed();
        let mut kernel = std::mem::zeroed();
        let mut user = std::mem::zeroed();
        let times_ok = GetProcessTimes(h, &mut creation, &mut exit, &mut kernel, &mut user);

        let mut mem: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let mem_ok = GetProcessMemoryInfo(h, &mut mem, mem.cb);

        CloseHandle(h);

        if times_ok == 0 {
            return None;
        }
        let cpu_100ns = filetime_to_u64(kernel.dwLowDateTime, kernel.dwHighDateTime)
            + filetime_to_u64(user.dwLowDateTime, user.dwHighDateTime);
        let mem_bytes = if mem_ok != 0 { mem.WorkingSetSize as u64 } else { 0 };
        Some((cpu_100ns, mem_bytes))
    }
}

#[cfg(not(windows))]
pub fn sample(_pid: u32) -> Option<(u64, u64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_threshold_supplied_uses_the_default() {
        assert_eq!(resolve_memory_warn_mb(None), DEFAULT_MEMORY_WARN_MB);
    }

    #[test]
    fn a_sane_supplied_threshold_is_used_as_is() {
        assert_eq!(resolve_memory_warn_mb(Some(2048.0)), 2048.0);
    }

    #[test]
    fn out_of_range_thresholds_are_clamped_not_trusted() {
        assert_eq!(resolve_memory_warn_mb(Some(1.0)), MIN_MEMORY_WARN_MB, "too low to be useful");
        assert_eq!(resolve_memory_warn_mb(Some(1_000_000.0)), MAX_MEMORY_WARN_MB, "too high to ever fire");
        assert_eq!(resolve_memory_warn_mb(Some(f64::NAN)), DEFAULT_MEMORY_WARN_MB, "NaN falls back to the default");
        assert_eq!(resolve_memory_warn_mb(Some(f64::INFINITY)), DEFAULT_MEMORY_WARN_MB, "infinity falls back to the default");
    }
}
