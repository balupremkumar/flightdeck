//! Peek support (Phase 5 Home): the last few lines of a pane's output as plain text.
//!
//! `pane_tail` copies a bounded window out of the replay ring under the PaneOut lock,
//! then strips ANSI here, outside the lock. Peek is context only: alt-screen TUIs can
//! yield fragments, and an empty result means "No recent output". The text is shown
//! in-app only, never logged.

use serde::Serialize;
use tauri::State;

use crate::{out_for_model, paneout, Registry};

const MAX_LINES: usize = 40;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneTail {
    pub lines: Vec<String>,
    pub seq: u64,
}

#[tauri::command(async)]
pub fn pane_tail(reg: State<'_, Registry>, model_id: u32, max_bytes: u32) -> Result<PaneTail, String> {
    let (_, out) = out_for_model(reg.inner(), model_id)?;
    let (bytes, seq) = paneout::lock_out(&out).tail(max_bytes.clamp(1024, 65536) as usize);
    Ok(PaneTail { lines: plain_lines(&bytes, MAX_LINES), seq })
}

fn is_decor(c: char) -> bool {
    c.is_whitespace() || ('\u{2500}'..='\u{259F}').contains(&c)
}

struct Lines {
    done: Vec<String>,
    cur: Vec<char>,
    col: usize,
}

impl Lines {
    /// End the current line (LF, or a cursor-addressed redraw treated as a break).
    fn brk(&mut self) {
        let text: String = self.cur.drain(..).collect();
        self.col = 0;
        let text = text.trim_end().to_string();
        if text.chars().all(is_decor) || self.done.last() == Some(&text) {
            return;
        }
        self.done.push(text);
    }

    fn put(&mut self, c: char) {
        if self.col < self.cur.len() {
            self.cur[self.col] = c;
        } else {
            self.cur.push(c);
        }
        self.col += 1;
    }
}

/// Strip terminal control sequences and return at most `max_lines` trailing lines.
/// CR returns to column 0 so later text overwrites; BS pops; CUP/VPA/CUU/CUD/ED start
/// a new line; OSC/DCS/APC/PM/SOS are dropped to BEL or ST; other CSI and two-byte
/// ESC are dropped. Lines are right-trimmed; blank, box-drawing-only and consecutive
/// duplicate lines are dropped.
pub fn plain_lines(bytes: &[u8], max_lines: usize) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut it = text.chars().peekable();
    let mut l = Lines { done: Vec::new(), cur: Vec::new(), col: 0 };
    while let Some(c) = it.next() {
        match c {
            '\x1b' => match it.next() {
                Some('[') => {
                    // CSI: params/intermediates 0x20..=0x3f, final 0x40..=0x7e.
                    while let Some(&n) = it.peek() {
                        if n == '\x1b' {
                            break; // aborted; the outer loop sees the ESC
                        }
                        it.next();
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            if matches!(n, 'H' | 'f' | 'd' | 'A' | 'B' | 'E' | 'F' | 'J') {
                                l.brk();
                            }
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') | Some('X') => {
                    while let Some(n) = it.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            if it.peek() == Some(&'\\') {
                                it.next();
                            }
                            break;
                        }
                    }
                }
                Some(i) if ('\u{20}'..='\u{2f}').contains(&i) => {
                    // ESC + intermediates + final.
                    while let Some(&n) = it.peek() {
                        it.next();
                        if ('\u{30}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\n' => l.brk(),
            '\r' => l.col = 0,
            '\x08' => {
                l.cur.pop();
                l.col = l.cur.len();
            }
            '\t' => l.put(' '),
            c if c.is_control() => {}
            c => l.put(c),
        }
    }
    l.brk();
    let skip = l.done.len().saturating_sub(max_lines);
    l.done.split_off(skip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ring::PaneRing;

    fn pl(s: &str) -> Vec<String> {
        plain_lines(s.as_bytes(), 40)
    }

    #[test]
    fn tail_is_bounded_and_copies_window_only() {
        let mut r = PaneRing::new(1 << 20);
        r.push(b"aaaa\nbbbb\ncccc\n");
        let (t, seq) = r.tail(7);
        assert!(t.len() <= 7);
        assert_eq!(seq, 15);
        assert_eq!(t, b"cccc\n");
        let (all, _) = r.tail(1000);
        assert_eq!(all, b"aaaa\nbbbb\ncccc\n");
    }

    #[test]
    fn tail_aligns_to_lf_or_window_start() {
        let mut r = PaneRing::new(1 << 20);
        r.push(b"hello world\nnext line\n");
        let (t, _) = r.tail(14);
        assert_eq!(t, b"next line\n");
        let mut r = PaneRing::new(1 << 20);
        r.push(b"no newline here at all");
        let (t, _) = r.tail(8);
        assert_eq!(t, b"here at all"[3..].to_vec());
    }

    #[test]
    fn tail_after_eviction_returns_live_bytes() {
        let mut r = PaneRing::new(64);
        for i in 0..50 {
            r.push(format!("line {i:02}\n").as_bytes());
        }
        let (t, seq) = r.tail(4096);
        assert_eq!(seq, 400);
        assert!(t.len() < 400);
        assert!(t.ends_with(b"line 49\n"));
        assert!(t.starts_with(b"line "), "starts on a line boundary");
    }

    #[test]
    fn cr_overwrites() {
        assert_eq!(pl("progress 10%\rprogress 99%\n"), vec!["progress 99%"]);
        assert_eq!(pl("abcdef\rxy\n"), vec!["xycdef"]);
    }

    #[test]
    fn backspace_pops() {
        assert_eq!(pl("abc\x08\x08xy\n"), vec!["axy"]);
    }

    #[test]
    fn cup_redraw_breaks_lines() {
        assert_eq!(pl("\x1b[2J\x1b[1;1Hfirst\x1b[2;1Hsecond\x1b[3;1Hthird"), vec!["first", "second", "third"]);
    }

    #[test]
    fn osc_dcs_and_csi_removed() {
        assert_eq!(pl("\x1b]0;title\x07hi \x1b[31mred\x1b[0m\x1b]8;;http://x\x1b\\link\n"), vec!["hi redlink"]);
        assert_eq!(pl("a\x1bP1$r0m\x1b\\b\x1b_apc\x07c\n"), vec!["abc"]);
        assert_eq!(pl("x\x1b(By\x1b=z\n"), vec!["xyz"]);
    }

    #[test]
    fn box_drawing_and_blank_lines_dropped() {
        assert_eq!(pl("╭────────╮\n│ hello  │\n╰────────╯\n\n   \n"), vec!["│ hello  │"]);
        assert_eq!(pl("──────\nreal\n"), vec!["real"]);
    }

    #[test]
    fn consecutive_duplicates_collapse() {
        assert_eq!(pl("a\na\nb\na\n"), vec!["a", "b", "a"]);
    }

    #[test]
    fn max_lines_keeps_the_last() {
        let s: String = (0..10).map(|i| format!("l{i}\n")).collect();
        assert_eq!(plain_lines(s.as_bytes(), 3), vec!["l7", "l8", "l9"]);
    }

    #[test]
    fn invalid_utf8_is_lossy_not_fatal() {
        assert_eq!(plain_lines(b"ok\xff\xfe\n", 5), vec!["ok\u{fffd}\u{fffd}"]);
    }
}
