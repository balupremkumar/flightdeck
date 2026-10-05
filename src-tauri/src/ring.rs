//! Bounded per-pane output ring for replaying recent output into a fresh xterm
//! (another window, or the same window after a reload).
//!
//! Eviction only ever cuts at a SAFE MARK: the byte after a `\n` seen while the VT
//! parser is in the ground state and not inside a UTF-8 codepoint. A small parser
//! runs across pushes (so sequences split over chunks are handled). Terminal modes
//! set or reset in evicted bytes are carried in `head` so a replay can restore them
//! before the body is written.
//!
//! Not wired into the app yet. Thread safety is the caller's job (plain struct).
//!
//! Known limits: SGR state is not carried in `head` (a replay starts with default
//! attributes until the body sets them). A string/CSI sequence longer than
//! `SEQ_LIMIT` bytes is abandoned by the parser (back to ground), which can
//! disagree with xterm for pathological input only.

#![allow(dead_code)]

use std::collections::VecDeque;

pub const DEFAULT_CAPACITY: usize = 4 * 1024 * 1024;
/// Longest escape/string sequence the parser will wait on before giving up.
const SEQ_LIMIT: usize = 1024 * 1024;
const MAX_MARK_SPACING: usize = 512;

/// Terminal modes we can restore. Defaults match a freshly reset terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Modes {
    pub alt_screen: bool,      // ?1049 / ?1047 / ?47
    pub sync_output: bool,     // ?2026
    pub bracketed_paste: bool, // ?2004
    pub mouse_1000: bool,
    pub mouse_1002: bool,
    pub mouse_1003: bool,
    pub mouse_1006: bool,
    pub mouse_1015: bool,
    pub app_cursor: bool,      // ?1
    pub cursor_visible: bool,  // ?25 (default on)
    pub autowrap: bool,        // ?7 (default on)
    pub origin: bool,          // ?6
    pub focus_reporting: bool, // ?1004
}

impl Default for Modes {
    fn default() -> Self {
        Modes {
            alt_screen: false,
            sync_output: false,
            bracketed_paste: false,
            mouse_1000: false,
            mouse_1002: false,
            mouse_1003: false,
            mouse_1006: false,
            mouse_1015: false,
            app_cursor: false,
            cursor_visible: true,
            autowrap: true,
            origin: false,
            focus_reporting: false,
        }
    }
}

impl Modes {
    fn set(&mut self, mode: u32, on: bool) {
        match mode {
            1049 | 1047 | 47 => self.alt_screen = on,
            2026 => self.sync_output = on,
            2004 => self.bracketed_paste = on,
            1000 => self.mouse_1000 = on,
            1002 => self.mouse_1002 = on,
            1003 => self.mouse_1003 = on,
            1006 => self.mouse_1006 = on,
            1015 => self.mouse_1015 = on,
            1 => self.app_cursor = on,
            25 => self.cursor_visible = on,
            7 => self.autowrap = on,
            6 => self.origin = on,
            1004 => self.focus_reporting = on,
            _ => {}
        }
    }

    /// Escape sequences that take a default terminal to this state.
    fn to_head(&self) -> Vec<u8> {
        let d = Modes::default();
        let mut out = Vec::new();
        let mut emit = |num: u32, on: bool| {
            out.extend_from_slice(format!("\x1b[?{}{}", num, if on { 'h' } else { 'l' }).as_bytes());
        };
        if self.alt_screen != d.alt_screen { emit(1049, self.alt_screen); }
        if self.app_cursor != d.app_cursor { emit(1, self.app_cursor); }
        if self.origin != d.origin { emit(6, self.origin); }
        if self.autowrap != d.autowrap { emit(7, self.autowrap); }
        if self.bracketed_paste != d.bracketed_paste { emit(2004, self.bracketed_paste); }
        if self.mouse_1000 != d.mouse_1000 { emit(1000, self.mouse_1000); }
        if self.mouse_1002 != d.mouse_1002 { emit(1002, self.mouse_1002); }
        if self.mouse_1003 != d.mouse_1003 { emit(1003, self.mouse_1003); }
        if self.mouse_1006 != d.mouse_1006 { emit(1006, self.mouse_1006); }
        if self.mouse_1015 != d.mouse_1015 { emit(1015, self.mouse_1015); }
        if self.focus_reporting != d.focus_reporting { emit(1004, self.focus_reporting); }
        if self.cursor_visible != d.cursor_visible { emit(25, self.cursor_visible); }
        // Synchronized output last: if left open, the replay body paints inside it.
        if self.sync_output != d.sync_output { emit(2026, self.sync_output); }
        out
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum St {
    Ground,
    Esc,
    EscInter, // ESC + intermediates, waiting for final
    Csi,
    Osc,
    OscEsc,
    Str, // DCS / APC / PM / SOS
    StrEsc,
}

#[derive(Clone, Debug)]
pub(crate) struct Parser {
    st: St,
    /// Remaining UTF-8 continuation bytes (ground only).
    pending: u8,
    params: [u8; 32],
    plen: usize,
    pover: bool,
    seq_len: usize,
    pub(crate) modes: Modes,
}

impl Parser {
    pub(crate) fn new() -> Self {
        Parser { st: St::Ground, pending: 0, params: [0; 32], plen: 0, pover: false, seq_len: 0, modes: Modes::default() }
    }

    #[inline]
    fn idle(&self) -> bool {
        self.st == St::Ground && self.pending == 0
    }

    fn to_ground(&mut self) {
        self.st = St::Ground;
        self.pending = 0;
        self.seq_len = 0;
    }

    fn csi_dispatch(&mut self, fin: u8) {
        if self.pover {
            return;
        }
        let p = &self.params[..self.plen];
        if p.first() == Some(&b'?') && (fin == b'h' || fin == b'l') {
            let on = fin == b'h';
            for part in p[1..].split(|&c| c == b';') {
                if part.is_empty() || !part.iter().all(u8::is_ascii_digit) || part.len() > 6 {
                    continue;
                }
                let n = part.iter().fold(0u32, |a, &c| a * 10 + (c - b'0') as u32);
                self.modes.set(n, on);
            }
        } else if p == b"!" && fin == b'p' {
            // DECSTR soft reset
            self.modes.app_cursor = false;
            self.modes.origin = false;
            self.modes.autowrap = true;
            self.modes.cursor_visible = true;
        }
    }

    /// Feed one byte. Returns true if, after this byte, the parser is at a safe
    /// cut point (a `\n` consumed in ground state, not inside a codepoint).
    fn feed(&mut self, b: u8) -> bool {
        match self.st {
            St::Ground => {
                if self.pending > 0 {
                    if (0x80..0xC0).contains(&b) {
                        self.pending -= 1;
                        return false;
                    }
                    self.pending = 0; // truncated codepoint; reprocess
                }
                match b {
                    0x1b => { self.st = St::Esc; self.seq_len = 0; }
                    b'\n' => return true,
                    0xC2..=0xDF => self.pending = 1,
                    0xE0..=0xEF => self.pending = 2,
                    0xF0..=0xF4 => self.pending = 3,
                    _ => {}
                }
                false
            }
            St::Esc | St::EscInter => {
                match b {
                    0x1b => self.st = St::Esc,
                    0x18 | 0x1a => self.to_ground(),
                    0x00..=0x1f => {}
                    0x20..=0x2f => self.st = St::EscInter,
                    b'[' if self.st == St::Esc => { self.st = St::Csi; self.plen = 0; self.pover = false; self.seq_len = 0; }
                    b']' if self.st == St::Esc => { self.st = St::Osc; self.seq_len = 0; }
                    b'P' | b'X' | b'^' | b'_' if self.st == St::Esc => { self.st = St::Str; self.seq_len = 0; }
                    b'c' if self.st == St::Esc => { self.modes = Modes::default(); self.to_ground(); }
                    0x30..=0x7e => self.to_ground(),
                    _ => { self.to_ground(); return self.feed(b); }
                }
                false
            }
            St::Csi => {
                self.seq_len += 1;
                if self.seq_len > SEQ_LIMIT {
                    self.to_ground();
                    return false;
                }
                match b {
                    0x1b => self.st = St::Esc,
                    0x18 | 0x1a => self.to_ground(),
                    0x00..=0x1f => {}
                    0x20..=0x3f => {
                        if self.plen < self.params.len() {
                            self.params[self.plen] = b;
                            self.plen += 1;
                        } else {
                            self.pover = true;
                        }
                    }
                    0x40..=0x7e => { self.csi_dispatch(b); self.to_ground(); }
                    0x7f => {}
                    _ => { self.to_ground(); return self.feed(b); }
                }
                false
            }
            St::Osc | St::Str => {
                self.seq_len += 1;
                if self.seq_len > SEQ_LIMIT {
                    self.to_ground();
                    return false;
                }
                match b {
                    0x1b => self.st = if self.st == St::Osc { St::OscEsc } else { St::StrEsc },
                    0x18 | 0x1a => self.to_ground(),
                    0x07 if self.st == St::Osc => self.to_ground(),
                    _ => {}
                }
                false
            }
            St::OscEsc | St::StrEsc => {
                if b == b'\\' {
                    self.to_ground();
                    false
                } else {
                    // ESC not followed by `\`: the string is aborted, new escape begins.
                    self.st = St::Esc;
                    self.feed(b)
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Mark {
    seq: u64,
    modes: Modes,
}

#[derive(Clone, Debug)]
pub struct RingSnapshot {
    /// Escape sequences re-establishing modes set in evicted bytes. Write first.
    pub head: Vec<u8>,
    /// Buffered bytes, starting at a safe mark.
    pub body: Vec<u8>,
    pub start_seq: u64,
    pub next_seq: u64,
}

#[derive(Debug)]
pub struct PaneRing {
    cap: usize,
    buf: Vec<u8>,
    /// Offset of the first live byte in `buf` (compacted lazily).
    start: usize,
    /// Total bytes ever pushed.
    seq: u64,
    /// Current cut point: seq of the first live byte plus the modes in force there.
    base: Mark,
    /// Thinned safe marks after `base`, ascending.
    marks: VecDeque<Mark>,
    /// Most recent safe mark (always >= base).
    tail: Mark,
    /// Most recent point where the parser was idle (ground, not in a codepoint),
    /// LF or not. Only used as the hard-ceiling cut for streams with no LF.
    idle_mark: Mark,
    spacing: u64,
    parser: Parser,
}

impl PaneRing {
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        let base = Mark { seq: 0, modes: Modes::default() };
        PaneRing {
            cap,
            buf: Vec::new(),
            start: 0,
            seq: 0,
            base,
            marks: VecDeque::new(),
            tail: base,
            idle_mark: base,
            spacing: (cap / 64).clamp(1, MAX_MARK_SPACING) as u64,
            parser: Parser::new(),
        }
    }

    pub fn with_default_capacity() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }

    /// Total bytes ever pushed.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Bytes currently buffered.
    pub fn len(&self) -> usize {
        self.buf.len() - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.buf.extend_from_slice(bytes);
        let seq0 = self.seq;
        let p = &mut self.parser;
        let mut last_idle: Option<(usize, Modes)> = None;
        for (i, &b) in bytes.iter().enumerate() {
            // Fast path: printable ASCII in ground state changes nothing.
            if (0x20..0x7f).contains(&b) && p.idle() {
                last_idle = Some((i, p.modes));
                continue;
            }
            let safe = p.feed(b);
            if p.idle() {
                last_idle = Some((i, p.modes));
            }
            if safe {
                let m = Mark { seq: seq0 + i as u64 + 1, modes: p.modes };
                self.tail = m;
                let last = self.marks.back().map_or(self.base.seq, |x| x.seq);
                if m.seq - last >= self.spacing {
                    self.marks.push_back(m);
                }
            }
        }
        if let Some((i, modes)) = last_idle {
            self.idle_mark = Mark { seq: seq0 + i as u64 + 1, modes };
        }
        self.seq = seq0 + bytes.len() as u64;
        self.evict();
    }

    fn evict(&mut self) {
        if self.len() <= self.cap {
            return;
        }
        let target = self.seq - self.cap as u64;
        while self.marks.front().is_some_and(|m| m.seq < target) {
            self.marks.pop_front();
        }
        let cut = match self.marks.front() {
            Some(m) => *m,
            None if self.tail.seq >= target => self.tail,
            // No safe point yet: tolerate up to the hard ceiling, then fall back.
            None => {
                if self.len() > self.cap.saturating_mul(2) {
                    self.hard_cut();
                }
                return;
            }
        };
        self.cut_to(cut);
    }

    /// Over the hard ceiling with no LF-safe mark (alt-screen TUIs redraw with CUP/EL
    /// and never emit a ground-state LF). Cut at the latest idle point, else drop the
    /// whole body and keep only the modes in force as head.
    fn hard_cut(&mut self) {
        let m = if self.idle_mark.seq > self.base.seq {
            self.idle_mark
        } else {
            Mark { seq: self.seq, modes: self.parser.modes }
        };
        self.cut_to(m);
        if self.len() > self.cap.saturating_mul(2) {
            // Stuck inside a long sequence since that idle point: drop everything.
            self.cut_to(Mark { seq: self.seq, modes: self.parser.modes });
        }
    }

    fn cut_to(&mut self, m: Mark) {
        debug_assert!(m.seq >= self.base.seq && m.seq <= self.seq);
        self.start += (m.seq - self.base.seq) as usize;
        self.base = m;
        while self.marks.front().is_some_and(|x| x.seq <= m.seq) {
            self.marks.pop_front();
        }
        if self.start >= self.cap.max(4096) {
            self.buf.drain(..self.start);
            self.start = 0;
        }
    }

    pub fn snapshot(&self) -> RingSnapshot {
        RingSnapshot {
            head: self.base.modes.to_head(),
            body: self.buf[self.start..].to_vec(),
            start_seq: self.base.seq,
            next_seq: self.seq,
        }
    }

    /// Last `max` live bytes plus the ring seq, for the peek. Copies only the window.
    /// A window that does not reach the buffer start begins after its first LF (or
    /// at the window start when it has none), so the first line is never a fragment.
    pub fn tail(&self, max: usize) -> (Vec<u8>, u64) {
        let live = &self.buf[self.start..];
        if live.len() <= max {
            return (live.to_vec(), self.seq);
        }
        let win = &live[live.len() - max..];
        let from = win.iter().position(|&b| b == b'\n').map_or(0, |i| i + 1);
        (win[from..].to_vec(), self.seq)
    }

    /// Bytes after `seq` plus the new next_seq. None if `seq` was already evicted
    /// or is in the future.
    pub fn bytes_since(&self, seq: u64) -> Option<(Vec<u8>, u64)> {
        if seq < self.base.seq || seq > self.seq {
            return None;
        }
        let off = self.start + (seq - self.base.seq) as usize;
        Some((self.buf[off..].to_vec(), self.seq))
    }

    /// Call on pty_resize: discard history, keeping only bytes from the most
    /// recent safe mark. Head modes in force at that mark are preserved.
    pub fn truncate_to_resize(&mut self) {
        let t = self.tail;
        if t.seq > self.base.seq {
            self.cut_to(t);
        }
        self.marks.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Oracle: every safe seq in `stream` with the modes in force there.
    fn oracle(stream: &[u8]) -> HashMap<u64, Modes> {
        let mut p = Parser::new();
        let mut m = HashMap::new();
        m.insert(0, Modes::default());
        for (i, &b) in stream.iter().enumerate() {
            if p.feed(b) {
                m.insert(i as u64 + 1, p.modes);
            }
        }
        m
    }

    fn head_modes(head: &[u8]) -> Modes {
        let mut p = Parser::new();
        for &b in head {
            p.feed(b);
        }
        p.modes
    }

    fn ring_with(cap: usize, data: &[u8]) -> PaneRing {
        let mut r = PaneRing::new(cap);
        r.push(data);
        r
    }

    fn lines(count: usize) -> Vec<u8> {
        (0..count).flat_map(|i| format!("line{:04}-xxxxxxxx\n", i).into_bytes()).collect()
    }

    #[test]
    fn seq_arithmetic() {
        let mut r = PaneRing::new(100);
        let mut total = 0u64;
        for i in 0..200usize {
            let chunk = vec![b'a'; i % 17];
            r.push(&chunk);
            total += chunk.len() as u64;
            assert_eq!(r.seq(), total);
            let s = r.snapshot();
            assert_eq!(s.next_seq, total);
            assert_eq!(s.start_seq + s.body.len() as u64, total);
        }
    }

    #[test]
    fn no_eviction_under_capacity() {
        let r = ring_with(1000, b"hello\nworld\n");
        let s = r.snapshot();
        assert_eq!(s.start_seq, 0);
        assert_eq!(s.body, b"hello\nworld\n");
        assert!(s.head.is_empty());
    }

    #[test]
    fn cuts_at_line_start() {
        let data = lines(100);
        let r = ring_with(200, &data);
        let s = r.snapshot();
        assert!(s.start_seq > 0);
        assert_eq!(data[s.start_seq as usize - 1], b'\n');
        assert!(s.body.starts_with(b"line"));
        assert_eq!(&data[s.start_seq as usize..], &s.body[..]);
    }

    #[test]
    fn defers_when_no_newline_then_cuts_at_next_safe_point() {
        let mut r = PaneRing::new(64);
        r.push(&vec![b'x'; 100]); // no newline at all, under the 2x hard ceiling
        assert_eq!(r.snapshot().start_seq, 0);
        assert_eq!(r.len(), 100);
        r.push(b"tail\n");
        r.push(b"more\n");
        let s = r.snapshot();
        assert!(s.start_seq >= 104, "cut must land at a newline after the long line, got {}", s.start_seq);
        assert!(s.body.len() <= 64 + 10);
    }

    #[test]
    fn never_splits_csi() {
        let mut data = Vec::new();
        for i in 0..50 {
            data.extend_from_slice(format!("\x1b[38;2;{};2;3mtext\x1b[0m\n", i).as_bytes());
        }
        let o = oracle(&data);
        for cap in [30usize, 31, 32, 33, 40, 47, 64] {
            let r = ring_with(cap, &data);
            let s = r.snapshot();
            assert!(o.contains_key(&s.start_seq), "cap {}", cap);
            assert!(s.body.starts_with(b"\x1b[38;2;"), "cap {}", cap);
        }
        // Newline inside CSI params is not a mark (it is executed, sequence continues).
        let mut r = PaneRing::new(4);
        r.push(b"\x1b[1\n2mxx");
        assert_eq!(r.tail.seq, 0);
    }

    #[test]
    fn never_splits_osc_bel_and_st() {
        let mut data = Vec::new();
        for _ in 0..20 {
            data.extend_from_slice(b"\x1b]0;title\nwith newline\x07after bel\n");
            data.extend_from_slice(b"\x1b]8;;http://x\nrest\x1b\\link\n");
        }
        let o = oracle(&data);
        for cap in [10usize, 20, 30, 40, 50, 60] {
            let r = ring_with(cap, &data);
            let s = r.snapshot();
            assert!(o.contains_key(&s.start_seq), "cap {}", cap);
            assert!(s.body.is_empty() || s.body.starts_with(b"\x1b]") || s.body.starts_with(b"link") || s.body.starts_with(b"after"), "cap {}", cap);
            // The payload newlines must never be cut points.
            assert!(!s.body.starts_with(b"with newline") && !s.body.starts_with(b"rest"), "cap {}", cap);
        }
    }

    #[test]
    fn never_splits_dcs() {
        let mut data = Vec::new();
        for _ in 0..20 {
            data.extend_from_slice(b"\x1bPq#0;2;0;0;0\n#1;2;100;0;0\x1b\\row\n");
        }
        let o = oracle(&data);
        for cap in [10usize, 25, 40, 55] {
            let r = ring_with(cap, &data);
            let s = r.snapshot();
            assert!(o.contains_key(&s.start_seq), "cap {}", cap);
            assert!(s.body.is_empty() || s.body.starts_with(b"\x1bPq"), "cap {}", cap);
        }
    }

    #[test]
    fn bel_does_not_end_dcs() {
        let mut r = PaneRing::new(4);
        r.push(b"\x1bPabc\x07\ndef");
        assert_eq!(r.tail.seq, 0);
    }

    #[test]
    fn never_splits_utf8() {
        let mut data = Vec::new();
        for _ in 0..60 {
            data.extend_from_slice("héllo wörld \u{1F600} 日本語\n".as_bytes());
        }
        for cap in 20..80usize {
            let r = ring_with(cap, &data);
            let s = r.snapshot();
            assert!(std::str::from_utf8(&s.body).is_ok(), "cap {}", cap);
            assert_eq!(data[s.start_seq as usize - 1], b'\n');
        }
        // One byte at a time: every intermediate snapshot is valid UTF-8 after the cut.
        let mut r = PaneRing::new(50);
        for b in &data {
            r.push(&[*b]);
            let s = r.snapshot();
            let body = &s.body;
            // body may end mid-codepoint (incomplete tail), but never starts mid-codepoint
            assert!(body.first().map_or(true, |c| (c & 0xC0) != 0x80));
        }
    }

    #[test]
    fn sequences_split_across_pushes() {
        let data = b"aa\n\x1b]0;ti\ntle\x07bb\ncc\n".to_vec();
        let o = oracle(&data);
        for split in 0..data.len() {
            let mut r = PaneRing::new(8);
            r.push(&data[..split]);
            r.push(&data[split..]);
            let s = r.snapshot();
            assert!(o.contains_key(&s.start_seq), "split {}", split);
        }
    }

    #[test]
    fn bytes_since_boundaries() {
        let data = lines(50);
        let r = ring_with(200, &data);
        let s = r.snapshot();
        let (b, next) = r.bytes_since(s.start_seq).unwrap();
        assert_eq!(b, s.body);
        assert_eq!(next, r.seq());
        let mid = s.start_seq + 7;
        assert_eq!(r.bytes_since(mid).unwrap().0, &data[mid as usize..]);
        let (b, next) = r.bytes_since(r.seq()).unwrap();
        assert!(b.is_empty());
        assert_eq!(next, r.seq());
        assert!(r.bytes_since(s.start_seq - 1).is_none());
        assert!(r.bytes_since(0).is_none());
        assert!(r.bytes_since(r.seq() + 1).is_none());
    }

    #[test]
    fn bytes_since_zero_when_nothing_evicted() {
        let r = ring_with(100, b"abc\n");
        assert_eq!(r.bytes_since(0).unwrap(), (b"abc\n".to_vec(), 4));
    }

    /// Set `seq_in` at the start, evict it with filler, return the snapshot head.
    fn head_after(seq_in: &[u8]) -> Vec<u8> {
        let mut data = seq_in.to_vec();
        data.push(b'\n');
        data.extend(lines(40));
        let r = ring_with(100, &data);
        let s = r.snapshot();
        assert!(s.start_seq > seq_in.len() as u64, "setup: mode bytes must be evicted");
        s.head
    }

    #[test]
    fn head_each_mode_set() {
        let cases: &[(&str, &str)] = &[
            ("\x1b[?1049h", "\x1b[?1049h"),
            ("\x1b[?1047h", "\x1b[?1049h"),
            ("\x1b[?47h", "\x1b[?1049h"),
            ("\x1b[?2026h", "\x1b[?2026h"),
            ("\x1b[?2004h", "\x1b[?2004h"),
            ("\x1b[?1000h", "\x1b[?1000h"),
            ("\x1b[?1002h", "\x1b[?1002h"),
            ("\x1b[?1003h", "\x1b[?1003h"),
            ("\x1b[?1006h", "\x1b[?1006h"),
            ("\x1b[?1015h", "\x1b[?1015h"),
            ("\x1b[?1h", "\x1b[?1h"),
            ("\x1b[?25l", "\x1b[?25l"),
            ("\x1b[?7l", "\x1b[?7l"),
            ("\x1b[?6h", "\x1b[?6h"),
            ("\x1b[?1004h", "\x1b[?1004h"),
        ];
        for (input, want) in cases {
            assert_eq!(String::from_utf8(head_after(input.as_bytes())).unwrap(), *want, "input {:?}", input);
        }
    }

    #[test]
    fn head_set_reset_pairs_cancel() {
        let pairs = ["1049", "1047", "47", "2026", "2004", "1000", "1002", "1003", "1006", "1015", "1", "25", "7", "6", "1004"];
        for m in pairs {
            let (a, b) = if m == "25" || m == "7" { ('l', 'h') } else { ('h', 'l') };
            let input = format!("\x1b[?{}{}\x1b[?{}{}", m, a, m, b);
            assert!(head_after(input.as_bytes()).is_empty(), "mode {}", m);
        }
    }

    #[test]
    fn head_multi_param_and_combined() {
        let h = head_after(b"\x1b[?1000;1006;2004h\x1b[?1049h\x1b[?25l\x1b[?2026h");
        let m = head_modes(&h);
        assert!(m.mouse_1000 && m.mouse_1006 && m.bracketed_paste && m.alt_screen && !m.cursor_visible && m.sync_output);
        let s = String::from_utf8(h).unwrap();
        assert!(s.starts_with("\x1b[?1049h"));
        assert!(s.ends_with("\x1b[?2026h"));
    }

    #[test]
    fn head_2026_left_open_is_reestablished() {
        let mut data = b"\x1b[?2026hpartial frame\n".to_vec();
        data.extend(lines(60));
        let r = ring_with(120, &data);
        let s = r.snapshot();
        assert!(s.start_seq > 0);
        assert_eq!(String::from_utf8(s.head).unwrap(), "\x1b[?2026h");
    }

    #[test]
    fn head_2026_closed_in_evicted_region_not_reopened() {
        let mut data = b"\x1b[?2026hframe\x1b[?2026l\n".to_vec();
        data.extend(lines(60));
        let r = ring_with(120, &data);
        assert!(r.snapshot().head.is_empty());
    }

    #[test]
    fn modes_changed_in_body_not_in_head() {
        let mut data = lines(60);
        data.extend_from_slice(b"\x1b[?1049h\n");
        let r = ring_with(120, &data);
        let s = r.snapshot();
        assert!(s.head.is_empty());
        assert!(s.body.windows(8).any(|w| w == b"\x1b[?1049h"));
    }

    #[test]
    fn ris_and_decstr_reset_modes() {
        assert!(head_after(b"\x1b[?1049h\x1b[?1000h\x1bc").is_empty());
        assert!(head_after(b"\x1b[?25l\x1b[?7l\x1b[?1h\x1b[?6h\x1b[!p").is_empty());
    }

    #[test]
    fn truncate_to_resize_keeps_modes_and_drops_history() {
        let mut data = b"\x1b[?1049h\x1b[?2026h".to_vec();
        data.extend(lines(5));
        data.extend_from_slice(b"partial line no newline");
        let mut r = ring_with(1 << 20, &data);
        assert_eq!(r.snapshot().start_seq, 0);
        r.truncate_to_resize();
        let s = r.snapshot();
        assert_eq!(s.body, b"partial line no newline");
        assert_eq!(s.start_seq, r.seq() - s.body.len() as u64);
        let m = head_modes(&s.head);
        assert!(m.alt_screen && m.sync_output);
        let before = r.seq();
        r.truncate_to_resize();
        assert_eq!(r.snapshot().body, b"partial line no newline");
        assert_eq!(r.seq(), before);
        r.push(b" done\nnext\n");
        assert_eq!(r.snapshot().body, b"partial line no newline done\nnext\n");
        r.truncate_to_resize();
        assert!(r.snapshot().body.is_empty());
        assert!(head_modes(&r.snapshot().head).alt_screen);
    }

    #[test]
    fn truncate_never_cuts_inside_sequence() {
        let mut r = PaneRing::new(1 << 20);
        r.push(b"one\ntwo\n\x1b]0;half a titl");
        r.truncate_to_resize();
        assert_eq!(r.snapshot().body, b"\x1b]0;half a titl");
        r.push(b"e\x07\n");
        assert_eq!(r.snapshot().body, b"\x1b]0;half a title\x07\n");
    }

    #[test]
    fn truncate_on_empty_ring() {
        let mut r = PaneRing::new(100);
        r.truncate_to_resize();
        assert_eq!(r.seq(), 0);
        assert!(r.snapshot().body.is_empty());
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn random_stream(rng: &mut Rng, tokens: usize) -> Vec<u8> {
        let mut out = Vec::new();
        const MODES: [&str; 12] = ["1049", "47", "2026", "2004", "1000", "1002", "1003", "1006", "1", "25", "7", "6"];
        for _ in 0..tokens {
            match rng.below(12) {
                0..=2 => {
                    for _ in 0..rng.below(30) {
                        out.push(0x20 + rng.below(0x5f) as u8);
                    }
                }
                3 | 4 => out.push(b'\n'),
                5 => out.extend_from_slice(["é", "日", "\u{1F600}", "ö"][rng.below(4) as usize].as_bytes()),
                6 => out.extend_from_slice(format!("\x1b[{};{}m", rng.below(100), rng.below(256)).as_bytes()),
                7 => {
                    let m = MODES[rng.below(MODES.len() as u64) as usize];
                    out.extend_from_slice(format!("\x1b[?{}{}", m, if rng.below(2) == 0 { 'h' } else { 'l' }).as_bytes());
                }
                8 => {
                    out.extend_from_slice(b"\x1b]0;ti\ntle");
                    out.extend_from_slice(if rng.below(2) == 0 { b"\x07" } else { b"\x1b\\" });
                }
                9 => out.extend_from_slice(b"\x1bPq1;2\n3\x1b\\"),
                10 => out.extend_from_slice(b"\x1b7\x1b8\x1b[2J"),
                _ => {
                    for _ in 0..rng.below(4) {
                        let b = rng.below(256) as u8;
                        if b != 0x1b && b != 0x18 && b != 0x1a {
                            out.push(b);
                        }
                    }
                }
            }
        }
        out
    }

    #[test]
    fn property_random_chunks() {
        for seed in 1..=40u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
            let stream = random_stream(&mut rng, 600);
            let o = oracle(&stream);
            let mut pts: Vec<u64> = o.keys().copied().collect();
            pts.push(stream.len() as u64);
            pts.sort_unstable();
            let max_gap = pts.windows(2).map(|w| w[1] - w[0]).max().unwrap();

            let cap = [64usize, 200, 512, 2048][(seed % 4) as usize];
            let mut r = PaneRing::new(cap);
            // Streams with LF-free gaps past the hard ceiling cut at idle marks by
            // design (covered by the lf_free_* tests); skip those here.
            if (max_gap as usize) + r.spacing as usize + 97 + cap > 2 * cap {
                continue;
            }
            let mut pos = 0usize;
            let mut last_seq = 0u64;
            let mut last_start = 0u64;
            while pos < stream.len() {
                let n = (1 + rng.below(97) as usize).min(stream.len() - pos);
                r.push(&stream[pos..pos + n]);
                pos += n;
                assert!(r.seq() > last_seq);
                last_seq = r.seq();
                assert_eq!(r.seq(), pos as u64);

                let s = r.snapshot();
                assert!(s.start_seq >= last_start, "start must be monotonic");
                last_start = s.start_seq;
                assert_eq!(s.next_seq, pos as u64);
                assert_eq!(&stream[s.start_seq as usize..pos], &s.body[..]);
                let modes_there = o.get(&s.start_seq).unwrap_or_else(|| panic!("seed {} start {} not a safe mark", seed, s.start_seq));
                assert_eq!(head_modes(&s.head), *modes_there, "seed {} start {}", seed, s.start_seq);
                if s.start_seq > 0 {
                    assert_eq!(stream[s.start_seq as usize - 1], b'\n');
                }
                assert!(
                    s.body.len() as u64 <= cap as u64 + r.spacing + max_gap + 97,
                    "seed {} len {} cap {} gap {}", seed, s.body.len(), cap, max_gap
                );
                if rng.below(40) == 0 {
                    r.truncate_to_resize();
                    let s2 = r.snapshot();
                    let m2 = o.get(&s2.start_seq).expect("truncate lands on safe mark");
                    assert_eq!(head_modes(&s2.head), *m2);
                    last_start = s2.start_seq;
                    assert_eq!(r.seq(), pos as u64);
                }
            }
        }
    }

    #[test]
    fn throughput_50mb() {
        let mut rng = Rng(12345);
        let mut chunk_src = random_stream(&mut rng, 4000);
        while chunk_src.len() < 16 * 1024 {
            let more = random_stream(&mut rng, 4000);
            chunk_src.extend(more);
        }
        let mut r = PaneRing::with_default_capacity();
        let total = 50 * 1024 * 1024;
        let t = std::time::Instant::now();
        let mut pushed = 0usize;
        let mut off = 0usize;
        while pushed < total {
            let end = (off + 16 * 1024).min(chunk_src.len());
            let c = &chunk_src[off..end];
            r.push(c);
            pushed += c.len();
            off = if end == chunk_src.len() { 0 } else { end };
        }
        let el = t.elapsed();
        eprintln!("ring throughput: {} bytes in {:?} (debug_assertions={})", pushed, el, cfg!(debug_assertions));
        assert!(r.len() <= DEFAULT_CAPACITY + 64 * 1024);
        assert!(el.as_secs_f64() < 5.0, "too slow: {:?}", el);
    }

    #[test]
    fn lf_free_cup_stream_stays_bounded() {
        let cap = 1000;
        let mut r = PaneRing::new(cap);
        r.push(b"[?1049h");
        let mut peak = 0;
        for i in 0..5000usize {
            let frame = format!("[{};1H[2Kframe {}", i % 24 + 1, i);
            r.push(frame.as_bytes());
            peak = peak.max(r.len());
        }
        assert!(peak <= 2 * cap + 64, "peak {}", peak);
        let s = r.snapshot();
        assert_eq!(s.start_seq + s.body.len() as u64, r.seq());
        assert!(head_modes(&s.head).alt_screen);
    }

    #[test]
    fn lf_free_stream_inside_sequence_drops_body_keeps_modes() {
        let cap = 100;
        let mut r = PaneRing::new(cap);
        r.push(b"[?1049h]0;");
        r.push(&vec![b'x'; 1000]);
        assert!(r.len() <= 2 * cap + 16);
        assert!(head_modes(&r.snapshot().head).alt_screen);
    }
}
