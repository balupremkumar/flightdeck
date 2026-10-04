//! OSC 9;4 progress (ConEmu / Windows Terminal convention): `ESC ] 9 ; 4 ; st ; pr`
//! terminated by BEL or ST (`ESC \`). `st` 1..=3 (normal, error, indeterminate)
//! means the program says it is busy; `st` 0 clears it. 4 (paused) is not busy.
//!
//! Used as an EXTRA busy signal: while a pane advertises progress, the quiet
//! timer must not call it "waiting". The scanner is stateful so a sequence split
//! across two pty reads is still seen once.

/// What one complete OSC 9;4 sequence said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub busy: bool,
}

#[derive(Default)]
pub struct ProgressScanner {
    mode: Mode,
    buf: Vec<u8>,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum Mode {
    #[default]
    Ground,
    Esc,
    Osc,
    OscEsc,
}

/// Longest payload we bother to hold; real ones are under 16 bytes.
const MAX_PAYLOAD: usize = 32;

/// Parse an OSC payload (bytes between `ESC ]` and the terminator).
pub fn parse_payload(p: &[u8]) -> Option<Progress> {
    let s = std::str::from_utf8(p).ok()?;
    let mut it = s.split(';');
    if it.next()? != "9" || it.next()? != "4" {
        return None;
    }
    let st: u8 = it.next()?.trim().parse().ok()?;
    match st {
        0 | 4 => Some(Progress { busy: false }),
        1..=3 => Some(Progress { busy: true }),
        _ => None,
    }
}

impl ProgressScanner {
    /// Feed raw pty bytes; returns the LAST progress sequence completed in them.
    pub fn feed(&mut self, bytes: &[u8]) -> Option<Progress> {
        let mut last = None;
        for &b in bytes {
            match self.mode {
                Mode::Ground => {
                    if b == 0x1b {
                        self.mode = Mode::Esc;
                    }
                }
                Mode::Esc => {
                    if b == b']' {
                        self.mode = Mode::Osc;
                        self.buf.clear();
                    } else if b == 0x1b {
                        // stay in Esc
                    } else {
                        self.mode = Mode::Ground;
                    }
                }
                Mode::Osc => match b {
                    0x07 => {
                        if let Some(p) = parse_payload(&self.buf) {
                            last = Some(p);
                        }
                        self.mode = Mode::Ground;
                    }
                    0x1b => self.mode = Mode::OscEsc,
                    _ => {
                        if self.buf.len() >= MAX_PAYLOAD {
                            self.mode = Mode::Ground; // not ours (title, hyperlink...)
                        } else {
                            self.buf.push(b);
                        }
                    }
                },
                Mode::OscEsc => {
                    if b == b'\\' {
                        if let Some(p) = parse_payload(&self.buf) {
                            last = Some(p);
                        }
                        self.mode = Mode::Ground;
                    } else if b == b']' {
                        self.buf.clear();
                        self.mode = Mode::Osc;
                    } else {
                        self.mode = Mode::Ground;
                    }
                }
            }
        }
        last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(s: &[u8]) -> Option<Progress> {
        ProgressScanner::default().feed(s)
    }

    #[test]
    fn bel_and_st_terminators() {
        assert_eq!(feed(b"\x1b]9;4;3;\x07"), Some(Progress { busy: true }));
        assert_eq!(feed(b"\x1b]9;4;1;50\x1b\\"), Some(Progress { busy: true }));
        assert_eq!(feed(b"\x1b]9;4;0;0\x07"), Some(Progress { busy: false }));
        assert_eq!(feed(b"\x1b]9;4;0\x07"), Some(Progress { busy: false }));
    }

    #[test]
    fn paused_is_not_busy_and_junk_is_ignored() {
        assert_eq!(feed(b"\x1b]9;4;4;10\x07"), Some(Progress { busy: false }));
        assert_eq!(feed(b"\x1b]9;4;9;10\x07"), None);
        assert_eq!(feed(b"\x1b]0;window title\x07"), None);
        assert_eq!(feed(b"\x1b]9;1;12\x07"), None);
        assert_eq!(feed(b"plain text \x1b[31mred\x1b[0m"), None);
    }

    #[test]
    fn split_across_reads() {
        let mut s = ProgressScanner::default();
        assert_eq!(s.feed(b"abc\x1b]9;4"), None);
        assert_eq!(s.feed(b";3;\x1b"), None);
        assert_eq!(s.feed(b"\\after"), Some(Progress { busy: true }));
    }

    #[test]
    fn last_one_wins_and_overlong_payload_resets() {
        assert_eq!(feed(b"\x1b]9;4;3;\x07x\x1b]9;4;0;0\x07"), Some(Progress { busy: false }));
        let mut long = b"\x1b]9;4;3;".to_vec();
        long.extend(std::iter::repeat(b'1').take(100));
        long.push(0x07);
        assert_eq!(feed(&long), None);
    }
}
