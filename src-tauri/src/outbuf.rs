// outbuf.rs — output coalescing/backpressure for the PTY reader (UX-594).
//
// Before this module, pty_spawn's reader thread emitted one Tauri event per
// OS read() (up to 8KB). A pane flooding output (e.g. `git log -p` on a big
// repo, a noisy build) could trip thousands of reads/sec, each one a
// serialize + IPC + webview dispatch — the frontend's own per-frame batching
// (Terminal.tsx) can't help if the Rust side never lets output pile up
// before crossing the bridge.
//
// The fix: the reader thread only appends bytes into this buffer (a cheap
// lock + extend); a separate low-frequency flusher thread drains it into one
// event on a fixed interval. If output arrives faster than the flusher can
// emit — the pathological case, not the normal one — the buffer is capped:
// oldest bytes are dropped rather than growing without bound. A flood the
// user can't read at full speed anyway; the app staying responsive matters
// more than not losing a byte of a runaway burst.

use std::sync::Mutex;

/// Bytes kept before the coalescer starts dropping the oldest overflow.
/// Generous enough that a normal burst (a big diff, a build log) never trips
/// it; small enough that a truly pathological flood can't grow unbounded.
pub const MAX_BUFFERED_BYTES: usize = 4 * 1024 * 1024;

pub struct OutputCoalescer {
    buf: Mutex<Vec<u8>>,
}

impl OutputCoalescer {
    pub fn new() -> Self {
        Self { buf: Mutex::new(Vec::new()) }
    }

    /// Append PTY output. Applies backpressure: once the buffer exceeds the
    /// cap (the flusher isn't keeping up), the oldest bytes are dropped so
    /// memory never grows without bound.
    pub fn push(&self, data: &[u8]) {
        let mut buf = self.buf.lock().unwrap();
        buf.extend_from_slice(data);
        if buf.len() > MAX_BUFFERED_BYTES {
            let excess = buf.len() - MAX_BUFFERED_BYTES;
            buf.drain(0..excess);
        }
    }

    /// Take everything currently buffered, leaving it empty. `None` when
    /// there's nothing to send — the caller skips emitting an empty event.
    pub fn drain(&self) -> Option<Vec<u8>> {
        let mut buf = self.buf.lock().unwrap();
        if buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut *buf))
        }
    }
}

impl Default for OutputCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_returns_none_when_empty() {
        let c = OutputCoalescer::new();
        assert!(c.drain().is_none());
    }

    #[test]
    fn push_then_drain_round_trips_and_clears() {
        let c = OutputCoalescer::new();
        c.push(b"hello ");
        c.push(b"world");
        assert_eq!(c.drain().unwrap(), b"hello world");
        assert!(c.drain().is_none(), "drain must leave the buffer empty");
    }

    /// UX-594: pump a large synthetic burst — 20MB in 8KB chunks, matching the
    /// reader's real read buffer size — WITHOUT draining, simulating a
    /// flusher that can't keep up with the flood. The buffer must never grow
    /// past the cap; this is the actual resilience property, proven
    /// deterministically without spawning a real PTY/app context.
    #[test]
    fn large_synthetic_burst_is_capped_not_unbounded() {
        let c = OutputCoalescer::new();
        let chunk = vec![b'x'; 8192];
        let mut pushed = 0usize;
        while pushed < 20 * 1024 * 1024 {
            c.push(&chunk);
            pushed += chunk.len();
        }
        let drained = c.drain().unwrap();
        assert_eq!(drained.len(), MAX_BUFFERED_BYTES, "sustained flood should saturate exactly at the cap");
    }

    #[test]
    fn overflow_keeps_the_most_recent_bytes_not_the_oldest() {
        let c = OutputCoalescer::new();
        c.push(&vec![b'a'; MAX_BUFFERED_BYTES]);
        c.push(b"TAIL");
        let drained = c.drain().unwrap();
        assert!(drained.ends_with(b"TAIL"), "the newest bytes must survive the drop, not the oldest");
        assert_eq!(drained.len(), MAX_BUFFERED_BYTES);
    }

    #[test]
    fn concurrent_pushes_from_many_threads_never_exceed_the_cap() {
        use std::sync::Arc;
        let c = Arc::new(OutputCoalescer::new());
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let c = c.clone();
                std::thread::spawn(move || {
                    for _ in 0..200 {
                        c.push(&vec![b'z'; 8192]);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert!(c.drain().unwrap().len() <= MAX_BUFFERED_BYTES);
    }
}
