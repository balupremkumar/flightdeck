// Natural pty exit (child-wait fallback).
//
// A ConPTY output pipe does not reach EOF when the child exits; it only does
// once the pseudoconsole is closed, i.e. once the master is dropped. The master
// lives in the pane registry, so waiting for reader EOF alone left a pane whose
// process was long gone looking alive ("waiting", no Restart, stale registry
// entry). This module pairs the reader with a child-wait thread: when the
// process exits the waiter records the exit code, asks the owner to release the
// master (closing the pseudoconsole so the reader drains and ends), and the
// reader's EOF then finishes the pane. If the reader still has not ended after
// a grace period the waiter finishes it itself. `finish` is guarded so the exit
// is delivered exactly once whichever side gets there first.
//
// Tauri-free on purpose: lib.rs supplies the real `PaneIo`, tests supply a fake.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub trait PaneIo: Send + Sync + 'static {
    /// One chunk of pty output.
    fn on_data(&self, chunk: &[u8]);
    /// Drop the master/child handles so the pseudoconsole closes. Idempotent.
    fn release(&self);
    /// Push out any still-buffered output; runs just before `on_exit`.
    fn flush(&self);
    /// The pane is over. Called exactly once. `code` is None when unknown.
    fn on_exit(&self, code: Option<u32>);
}

struct Shared {
    done: AtomicBool,
    reader_done: AtomicBool,
    code: Mutex<Option<u32>>,
}

fn finish<T: PaneIo>(sh: &Shared, io: &T) {
    if sh.done.swap(true, Ordering::SeqCst) {
        return;
    }
    io.flush();
    let code = *sh.code.lock().unwrap_or_else(|e| e.into_inner());
    io.on_exit(code);
}

/// Start the reader thread, and (Windows) the child-wait thread for `pid`.
pub fn start<T: PaneIo>(pid: Option<u32>, mut reader: Box<dyn Read + Send>, io: Arc<T>) {
    let sh = Arc::new(Shared {
        done: AtomicBool::new(false),
        reader_done: AtomicBool::new(false),
        code: Mutex::new(None),
    });

    {
        let (sh, io) = (sh.clone(), io.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => io.on_data(&buf[..n]),
                }
            }
            sh.reader_done.store(true, Ordering::SeqCst);
            finish(&sh, &*io);
        });
    }

    #[cfg(windows)]
    if let Some(pid) = pid {
        use std::time::{Duration, Instant};
        /// How long the waiter lets the reader reach EOF after the master is
        /// released before it finishes the pane itself.
        const READER_GRACE: Duration = Duration::from_secs(3);
        std::thread::spawn(move || {
            let Some(code) = win::wait_for_exit(pid) else { return };
            *sh.code.lock().unwrap_or_else(|e| e.into_inner()) = Some(code);
            io.release();
            let deadline = Instant::now() + READER_GRACE;
            while !sh.reader_done.load(Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(25));
            }
            finish(&sh, &*io);
        });
    }
    #[cfg(not(windows))]
    let _ = pid;
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    /// Block until process `pid` exits; its exit code. None if it cannot be opened.
    /// The pane registry still holds the child (so the pid cannot be recycled)
    /// when this runs right after spawn.
    pub fn wait_for_exit(pid: u32) -> Option<u32> {
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            WaitForSingleObject(h, INFINITE);
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code);
            CloseHandle(h);
            if ok == 0 {
                return None;
            }
            Some(code)
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
    use std::sync::atomic::AtomicU32;
    use std::time::{Duration, Instant};

    struct Fake {
        master: Mutex<Option<Box<dyn MasterPty + Send>>>,
        exits: AtomicU32,
        codes: Mutex<Vec<Option<u32>>>,
        out: Mutex<Vec<u8>>,
    }
    impl PaneIo for Fake {
        fn on_data(&self, c: &[u8]) {
            self.out.lock().unwrap().extend_from_slice(c);
        }
        fn release(&self) {
            self.master.lock().unwrap().take();
        }
        fn flush(&self) {}
        fn on_exit(&self, code: Option<u32>) {
            self.exits.fetch_add(1, Ordering::SeqCst);
            self.codes.lock().unwrap().push(code);
        }
    }

    fn run(args: &[&str]) -> Arc<Fake> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(args);
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let pid = child.process_id();
        let reader = pair.master.try_clone_reader().unwrap();
        let io = Arc::new(Fake {
            master: Mutex::new(Some(pair.master)),
            exits: AtomicU32::new(0),
            codes: Mutex::new(vec![]),
            out: Mutex::new(vec![]),
        });
        start(pid, reader, io.clone());
        // The registry holds the child for the pane's life; mirror that.
        std::mem::forget(child);
        io
    }

    fn wait_exit(io: &Fake, secs: u64) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while io.exits.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn natural_exit_fires_exactly_once_with_the_code_and_the_output() {
        let io = run(&["/c", "echo hello-pane & exit 3"]);
        wait_exit(&io, 8);
        // Linger past the reader grace so a double emit would show.
        std::thread::sleep(Duration::from_millis(3500));
        assert_eq!(io.exits.load(Ordering::SeqCst), 1, "exactly one exit event");
        assert_eq!(*io.codes.lock().unwrap(), vec![Some(3)]);
        let out = String::from_utf8_lossy(&io.out.lock().unwrap()).to_string();
        assert!(out.contains("hello-pane"), "output drained before exit: {out:?}");
    }

    #[test]
    fn a_running_pane_never_receives_another_panes_exit() {
        let a = run(&["/c", "exit 3"]);
        let b = run(&["/c", "ping -n 30 127.0.0.1 >nul"]);
        wait_exit(&a, 8);
        assert_eq!(a.exits.load(Ordering::SeqCst), 1);
        assert_eq!(b.exits.load(Ordering::SeqCst), 0);
        b.release(); // closing the pseudoconsole ends the ping
    }
}
