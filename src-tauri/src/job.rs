// job.rs — Windows Job Object hardening (R2). Clean-exit reaping already
// covers `RunEvent::ExitRequested` (reap_pane taskkills every live tree). This
// covers the path that misses: Flightdeck.exe hard-crashing (panic in a
// native dep, forced process kill, BSOD-adjacent teardown) with no chance to
// run its own exit handler.
//
// One process-wide Job Object, created lazily, with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE set. Every PTY child is assigned to it
// right after spawn (and since a job's flag applies transitively, any
// grandchildren the CLI itself spawns join automatically). When
// Flightdeck.exe's process terminates for any reason, Windows tears down its
// handle table — including the job handle — and KILL_ON_JOB_CLOSE fires,
// killing every process still in the job.

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    // HANDLE (*mut c_void) is not Send/Sync by default; this handle is only
    // ever read, never mutated, and Windows handles are safe to use from any
    // thread, so this wrapper is sound.
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<JobHandle> = OnceLock::new();

    fn job_handle() -> HANDLE {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !job.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                // BREAKAWAY_OK does not weaken the kill-on-close net: a child
                // stays in the job unless it explicitly spawns with
                // CREATE_BREAKAWAY_FROM_JOB. It exists for exactly one case —
                // a Flightdeck launched inside another Flightdeck's pane must
                // still be able to break its update watcher (updates.rs) out
                // of this job, or the watcher dies with the app it's updating.
                info.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
            JobHandle(job)
        })
        .0
    }

    /// Put a freshly spawned child's root pid into the shared job. Best-effort
    /// — a failure here just means that one pane misses hard-crash coverage;
    /// clean-exit reaping still applies to it.
    pub fn assign(pid: u32) {
        let job = job_handle();
        if job.is_null() {
            return;
        }
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !proc.is_null() {
                AssignProcessToJobObject(job, proc);
                CloseHandle(proc);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn assign(_pid: u32) {}
}

pub use imp::assign;
