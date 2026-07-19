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
