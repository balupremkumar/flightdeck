//! Per-pane output state shared by the PTY threads and the attach/pause commands
//! (Phase 4 S2/S3): the replay ring, the buffer-only switch, and the
//! model-id -> live pty map that lets a reloaded webview reattach.
//!
//! Everything here is plain data behind the caller's locks, so it is unit tested
//! without a PTY or an AppHandle. lib.rs owns the threads and the emits.
//!
//! Lock rules (lib.rs): a `PaneOut` mutex is the innermost lock. `by_model` is
//! never held while taking `panes`, and neither is held while taking a `PaneOut`
//! except to clone its Arc first.

// is_paused / is_tombstoned / epoch are read only by tests and the later transfer step.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use crate::ring::{PaneRing, RingSnapshot};

/// How long after a webview (re)load an unclaimed PTY survives before the reaper
/// looks at it.
pub const REAP_GRACE_SECS: u64 = 10;
/// Tombstones kept for killed models; oldest dropped first.
const MAX_TOMBSTONES: usize = 512;

/// Lock a `PaneOut`, surviving poisoning: a panic elsewhere must never silence a
/// pane's output.
pub fn lock_out(m: &Mutex<PaneOut>) -> std::sync::MutexGuard<'_, PaneOut> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Outcome of `PaneOut::resume`.
#[derive(Debug, PartialEq, Eq)]
pub enum Resumed {
    /// Not paused, or nothing arrived while paused.
    Nothing,
    /// What arrived while paused, and the seq after it: emit as one catch-up chunk.
    Bytes(Vec<u8>, u64),
    /// The paused-at point was evicted: the gap cannot be replayed, the caller
    /// must hand the frontend a full snapshot instead.
    Gap,
}

/// Lock the model map, surviving poisoning for the same reason as `lock_out`: a
/// panic in one command must not wedge attach, kill and the reaper for every pane.
pub fn lock_map(m: &Mutex<ByModel>) -> std::sync::MutexGuard<'_, ByModel> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What `PaneOut::attach` hands the target window.
pub enum AttachBody {
    /// Only the bytes after the source window's serialised snapshot.
    Delta(Vec<u8>, u64),
    /// The whole ring (reload, crash re-adopt, or the delta point was evicted).
    Full(RingSnapshot),
}

pub struct PaneOut {
    ring: PaneRing,
    paused: bool,
    paused_at: u64,
    pub cols: u16,
    pub rows: u16,
}

impl PaneOut {
    pub fn new(cols: u16, rows: u16) -> Self {
        PaneOut { ring: PaneRing::with_default_capacity(), paused: false, paused_at: 0, cols, rows }
    }

    #[cfg(test)]
    fn with_capacity(cap: usize) -> Self {
        PaneOut { ring: PaneRing::new(cap), paused: false, paused_at: 0, cols: 80, rows: 24 }
    }

    /// Record a chunk. Returns the ring seq after it when the chunk should also
    /// be emitted live; None for an empty chunk or while paused (buffer-only).
    pub fn push(&mut self, bytes: &[u8]) -> Option<u64> {
        if bytes.is_empty() {
            return None;
        }
        self.ring.push(bytes);
        if self.paused { None } else { Some(self.ring.seq()) }
    }

    pub fn snapshot(&self) -> RingSnapshot {
        self.ring.snapshot()
    }

    pub fn tail(&self, max: usize) -> (Vec<u8>, u64) {
        self.ring.tail(max)
    }

    pub fn seq(&self) -> u64 {
        self.ring.seq()
    }

    /// pty_resize: remember the size and drop pre-resize history (bytes written
    /// at another width would replay into nonsense).
    /// While paused the ring is not trimmed: `resume` needs every byte since
    /// `paused_at` to still be there.
    pub fn resized(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        if !self.paused {
            self.ring.truncate_to_resize();
        }
    }

    /// Switch to buffer-only. Returns the seq at which live emits stopped.
    /// Idempotent: a second pause keeps the original seq.
    pub fn pause(&mut self) -> u64 {
        if !self.paused {
            self.paused = true;
            self.paused_at = self.ring.seq();
        }
        self.paused_at
    }

    /// Back to live emits. See `Resumed`.
    pub fn resume(&mut self) -> Resumed {
        if !self.paused {
            return Resumed::Nothing;
        }
        self.paused = false;
        match self.ring.bytes_since(self.paused_at) {
            Some((b, next)) if !b.is_empty() => Resumed::Bytes(b, next),
            Some(_) => Resumed::Nothing,
            None => Resumed::Gap,
        }
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// A frontend claims the pane. Always ends buffer-only mode: the target is
    /// about to own live emits. With `since` (the seq `pause` returned, which the
    /// source's serialised snapshot covers) only the bytes after it come back;
    /// when that point is gone from the ring the full snapshot does, and the
    /// caller must repaint from it.
    pub fn attach(&mut self, since: Option<u64>) -> AttachBody {
        self.paused = false;
        if let Some((bytes, next)) = since.and_then(|s| self.ring.bytes_since(s)) {
            return AttachBody::Delta(bytes, next);
        }
        AttachBody::Full(self.ring.snapshot())
    }
}

pub struct ModelEntry {
    pub pty_id: u32,
    pub vendor: String,
    pub cwd: String,
    pub epoch: u64,
    pub out: Arc<Mutex<PaneOut>>,
    /// The window label whose frontend has spawned or attached this pty since
    /// that window's last load. None means nobody has claimed it.
    pub attached: Option<String>,
}

#[derive(Default)]
pub struct ByModel {
    live: HashMap<u32, ModelEntry>,
    tombs: HashMap<u32, u32>,
    tomb_order: VecDeque<u32>,
}

/// `gen` is `epoch|vendor|cwd` (paneSessions.genOf). Unparseable -> epoch 0.
pub fn parse_gen(gen: &str) -> (u64, String, String) {
    let mut it = gen.splitn(3, '|');
    let epoch = it.next().and_then(|e| e.parse().ok()).unwrap_or(0);
    let vendor = it.next().unwrap_or("").to_string();
    let cwd = it.next().unwrap_or("").to_string();
    (epoch, vendor, cwd)
}

impl ByModel {
    /// Map a model to its live pty. Returns the entry it superseded, if any.
    /// A fresh spawn lifts the model's tombstone.
    pub fn insert(&mut self, model_id: u32, entry: ModelEntry) -> Option<ModelEntry> {
        self.tombs.remove(&model_id);
        self.live.insert(model_id, entry)
    }

    /// The live pty for (model, vendor, cwd). The epoch is deliberately not part
    /// of the key: it is not persisted, so after a reload it is whatever the new
    /// webview made up. A model maps to one pty, so there is nothing to
    /// tiebreak; a vendor or cwd change is a different agent and must respawn.
    pub fn lookup(&self, model_id: u32, vendor: &str, cwd: &str) -> Option<&ModelEntry> {
        self.live.get(&model_id).filter(|e| e.vendor == vendor && e.cwd == cwd)
    }

    /// Reattach claim: the live pty for (model, vendor, cwd), marked attached.
    /// `live` is the set of pty ids still in the pane registry; a mapping whose
    /// pty is not in it is a dead entry (child died before it was registered) and
    /// is dropped instead of being attached to.
    ///
    /// `req_epoch` is the requester's restart epoch. A request newer than the
    /// entry's means a Restart: the entry is the pty being replaced and must not
    /// be attached. A reload resets the epoch to 0, so `<=` still attaches.
    pub fn claim_live(&mut self, model_id: u32, vendor: &str, cwd: &str, req_epoch: u64, live: &HashSet<u32>, label: &str) -> Option<(u32, Arc<Mutex<PaneOut>>)> {
        let e = self.live.get(&model_id).filter(|e| e.vendor == vendor && e.cwd == cwd && req_epoch <= e.epoch)?;
        if !live.contains(&e.pty_id) {
            self.live.remove(&model_id);
            return None;
        }
        let found = (e.pty_id, e.out.clone());
        self.mark_attached(model_id, label);
        Some(found)
    }

    pub fn get(&self, model_id: u32) -> Option<&ModelEntry> {
        self.live.get(&model_id)
    }

    pub fn mark_attached(&mut self, model_id: u32, label: &str) {
        if let Some(e) = self.live.get_mut(&model_id) {
            e.attached = Some(label.to_string());
        }
    }

    /// Natural exit: forget the mapping, but only if it still points at this pty
    /// (a replacement spawn for the same model must survive the old reader).
    pub fn remove_pty(&mut self, pty_id: u32) -> Option<u32> {
        let m = self.live.iter().find(|(_, e)| e.pty_id == pty_id).map(|(m, _)| *m)?;
        self.live.remove(&m);
        Some(m)
    }

    /// Kill: forget the mapping and leave a tombstone so a late attach or pause
    /// for that model answers "dead" rather than resurrecting anything.
    pub fn kill_pty(&mut self, pty_id: u32) -> Option<u32> {
        let m = self.remove_pty(pty_id)?;
        if self.tombs.insert(m, pty_id).is_none() {
            self.tomb_order.push_back(m);
            while self.tomb_order.len() > MAX_TOMBSTONES {
                if let Some(old) = self.tomb_order.pop_front() {
                    self.tombs.remove(&old);
                }
            }
        }
        Some(m)
    }

    pub fn is_tombstoned(&self, model_id: u32) -> bool {
        self.tombs.contains_key(&model_id)
    }

    /// Webview (re)load of `label`: whatever it had claimed is unclaimed again.
    /// Entries attached to other windows are untouched.
    pub fn mark_label_unattached(&mut self, label: &str) {
        for e in self.live.values_mut() {
            if e.attached.as_deref() == Some(label) {
                e.attached = None;
            }
        }
    }

    /// (model_id, pty_id) of every pty nobody has claimed.
    pub fn unattached(&self) -> Vec<(u32, u32)> {
        let mut v: Vec<(u32, u32)> =
            self.live.iter().filter(|(_, e)| e.attached.is_none()).map(|(m, e)| (*m, e.pty_id)).collect();
        v.sort_unstable();
        v
    }

    pub fn len(&self) -> usize {
        self.live.len()
    }
}

/// Reaper rule. Safe mode never reaps (it suppresses session restore, so the doc
/// says nothing about what the user wants). An unreadable doc (None) never reaps
/// either. Otherwise only unclaimed ptys whose model id is gone from the doc die.
pub fn reap_targets(
    unattached: &[(u32, u32)],
    doc_models: Option<&HashSet<u32>>,
    safe_mode: bool,
) -> Vec<(u32, u32)> {
    if safe_mode {
        return Vec::new();
    }
    let Some(doc) = doc_models else { return Vec::new() };
    unattached.iter().copied().filter(|(m, _)| !doc.contains(m)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pty_id: u32, vendor: &str, cwd: &str, attached: bool) -> ModelEntry {
        ModelEntry {
            pty_id,
            vendor: vendor.into(),
            cwd: cwd.into(),
            epoch: 0,
            out: Arc::new(Mutex::new(PaneOut::new(80, 24))),
            attached: attached.then(|| "main".to_string()),
        }
    }

    #[test]
    fn lock_map_survives_a_poisoned_mutex() {
        let m = Arc::new(Mutex::new(ByModel::default()));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison the map");
        })
        .join();
        assert!(m.is_poisoned());
        lock_map(&m).insert(1, entry(10, "claude", "c", true));
        assert_eq!(lock_map(&m).len(), 1);
    }

    #[test]
    fn parse_gen_splits_epoch_vendor_cwd() {
        assert_eq!(parse_gen("3|claude|D:\\work\\x"), (3, "claude".into(), "D:\\work\\x".into()));
        assert_eq!(parse_gen("junk"), (0, "".into(), "".into()));
        // A pipe inside the cwd stays in the cwd.
        assert_eq!(parse_gen("1|pwsh|a|b").2, "a|b");
    }

    #[test]
    fn lookup_keys_on_model_vendor_cwd_not_epoch() {
        let mut m = ByModel::default();
        m.insert(7, entry(100, "claude", "D:\\a", true));
        assert_eq!(m.lookup(7, "claude", "D:\\a").map(|e| e.pty_id), Some(100));
        assert!(m.lookup(7, "codex", "D:\\a").is_none(), "vendor change must respawn");
        assert!(m.lookup(7, "claude", "D:\\b").is_none(), "cwd change must respawn");
        assert!(m.lookup(8, "claude", "D:\\a").is_none());
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn claim_live_drops_entry_whose_pty_is_not_registered() {
        let mut m = ByModel::default();
        m.insert(7, entry(100, "claude", "c", false));
        let none: HashSet<u32> = HashSet::new();
        assert!(m.claim_live(7, "claude", "c", 0, &none, "main").is_none(), "dead pty must not attach");
        assert!(m.get(7).is_none(), "dead entry is pruned");
        m.insert(8, entry(101, "claude", "c", false));
        let live: HashSet<u32> = [101].into_iter().collect();
        assert_eq!(m.claim_live(8, "claude", "c", 0, &live, "main").map(|x| x.0), Some(101));
        assert_eq!(m.get(8).unwrap().attached.as_deref(), Some("main"));
    }

    #[test]
    fn claim_live_refuses_a_newer_epoch_restart() {
        let mut m = ByModel::default();
        let mut e = entry(100, "claude", "c", false);
        e.epoch = 2;
        m.insert(7, e);
        let live: HashSet<u32> = [100].into_iter().collect();
        assert!(m.claim_live(7, "claude", "c", 3, &live, "main").is_none(), "restart epoch must spawn, not attach");
        assert!(m.get(7).is_some(), "the dying pty's entry is left for its kill");
        assert!(m.get(7).unwrap().attached.is_none());
        assert!(m.claim_live(7, "claude", "c", 0, &live, "main").is_some(), "reload resets epoch to 0 and attaches");
        assert!(m.claim_live(7, "claude", "c", 2, &live, "main").is_some());
    }

    #[test]
    fn insert_returns_the_superseded_pty() {
        let mut m = ByModel::default();
        assert!(m.insert(1, entry(10, "claude", "c", true)).is_none());
        let old = m.insert(1, entry(11, "claude", "c", true)).unwrap();
        assert_eq!(old.pty_id, 10);
        assert_eq!(m.get(1).unwrap().pty_id, 11);
    }

    #[test]
    fn kill_leaves_a_tombstone_that_a_respawn_lifts() {
        let mut m = ByModel::default();
        m.insert(1, entry(10, "claude", "c", true));
        assert_eq!(m.kill_pty(10), Some(1));
        assert!(m.get(1).is_none());
        assert!(m.is_tombstoned(1));
        assert_eq!(m.kill_pty(10), None, "idempotent");
        m.insert(1, entry(12, "claude", "c", true));
        assert!(!m.is_tombstoned(1));
    }

    #[test]
    fn natural_exit_does_not_tombstone_and_spares_a_replacement() {
        let mut m = ByModel::default();
        m.insert(1, entry(10, "claude", "c", true));
        m.insert(1, entry(11, "claude", "c", true)); // restart: new pty for same model
        assert_eq!(m.remove_pty(10), None, "the old reader must not unmap the new pty");
        assert_eq!(m.get(1).unwrap().pty_id, 11);
        assert_eq!(m.remove_pty(11), Some(1));
        assert!(!m.is_tombstoned(1));
    }

    #[test]
    fn tombstones_are_bounded() {
        let mut m = ByModel::default();
        for i in 0..(MAX_TOMBSTONES as u32 + 20) {
            m.insert(i, entry(1000 + i, "claude", "c", true));
            m.kill_pty(1000 + i);
        }
        assert!(!m.is_tombstoned(0), "oldest dropped");
        assert!(m.is_tombstoned(MAX_TOMBSTONES as u32 + 19));
    }

    #[test]
    fn unattached_tracks_reload_and_claims() {
        let mut m = ByModel::default();
        m.insert(1, entry(10, "claude", "c", true));
        m.insert(2, entry(11, "claude", "c", true));
        assert!(m.unattached().is_empty());
        m.mark_label_unattached("main");
        assert_eq!(m.unattached(), vec![(1, 10), (2, 11)]);
        m.mark_attached(1, "main");
        assert_eq!(m.unattached(), vec![(2, 11)]);
    }

    // Red team item 7: a reload of one window must not unclaim another window's ptys.
    #[test]
    fn reload_only_unclaims_that_windows_entries() {
        let mut m = ByModel::default();
        m.insert(1, entry(10, "claude", "c", true));
        m.insert(2, entry(11, "claude", "c", true));
        m.insert(3, entry(12, "claude", "c", true));
        m.mark_attached(2, "fw-1");
        m.mark_attached(3, "fw-2");
        m.mark_label_unattached("fw-1");
        assert_eq!(m.unattached(), vec![(2, 11)], "only fw-1's entry is unclaimed");
        m.mark_label_unattached("main");
        assert_eq!(m.unattached(), vec![(1, 10), (2, 11)]);
        m.mark_label_unattached("fw-9");
        assert_eq!(m.unattached(), vec![(1, 10), (2, 11)], "unknown label touches nothing");
        assert_eq!(m.get(3).unwrap().attached.as_deref(), Some("fw-2"));
    }

    #[test]
    fn reaper_only_kills_unclaimed_models_missing_from_the_doc() {
        let un = [(1, 10), (2, 11), (3, 12)];
        let doc: HashSet<u32> = [1, 3].into_iter().collect();
        assert_eq!(reap_targets(&un, Some(&doc), false), vec![(2, 11)]);
        let all: HashSet<u32> = [1, 2, 3].into_iter().collect();
        assert!(reap_targets(&un, Some(&all), false).is_empty());
    }

    #[test]
    fn reaper_skips_everything_in_safe_mode() {
        let un = [(2, 11)];
        let doc: HashSet<u32> = HashSet::new();
        assert!(reap_targets(&un, Some(&doc), true).is_empty());
        assert_eq!(reap_targets(&un, Some(&doc), false), vec![(2, 11)]);
    }

    #[test]
    fn reaper_never_kills_on_an_unreadable_doc() {
        assert!(reap_targets(&[(2, 11)], None, false).is_empty());
    }

    #[test]
    fn seq_is_monotonic_across_pushes() {
        let mut o = PaneOut::new(80, 24);
        let mut last = 0;
        for chunk in [&b"hello "[..], b"world\r\n", b"\x1b[31mred\x1b[0m", b"x"] {
            let s = o.push(chunk).unwrap();
            assert!(s > last);
            assert_eq!(s, o.seq());
            last = s;
        }
        assert_eq!(last, 6 + 7 + 12 + 1);
        assert_eq!(o.push(b""), None, "empty chunks emit nothing and do not move seq");
        assert_eq!(o.seq(), last);
    }

    #[test]
    fn attach_snapshot_is_the_whole_stream_up_to_next_seq() {
        let mut o = PaneOut::new(80, 24);
        o.push(b"line one\r\n");
        o.push(b"line two\r\n");
        let s = o.snapshot();
        assert_eq!(s.body, b"line one\r\nline two\r\n");
        assert_eq!(s.start_seq, 0);
        assert_eq!(s.next_seq, 20);
        assert_eq!(s.next_seq, o.seq());
    }

    /// The dedupe contract the frontend relies on: an event carries the seq AFTER
    /// its chunk, so it is already inside a snapshot iff event.seq <= next_seq.
    #[test]
    fn dedupe_boundary_event_seq_vs_snapshot_next_seq() {
        let mut o = PaneOut::new(80, 24);
        let e1 = o.push(b"aaa\r\n").unwrap();
        let e2 = o.push(b"bbb\r\n").unwrap();
        let snap = o.snapshot(); // taken between e2 and e3
        let e3 = o.push(b"ccc\r\n").unwrap();
        let in_snapshot = |seq: u64| seq <= snap.next_seq;
        assert!(in_snapshot(e1) && in_snapshot(e2), "already replayed: frontend drops them");
        assert!(!in_snapshot(e3), "after the snapshot: frontend delivers it");
        assert_eq!(e2, snap.next_seq, "boundary event is dropped, not duplicated");
        let mut screen = snap.body.clone();
        screen.extend_from_slice(b"ccc\r\n");
        assert_eq!(screen, b"aaa\r\nbbb\r\nccc\r\n");
    }

    #[test]
    fn pause_buffers_and_resume_hands_back_exactly_the_gap() {
        let mut o = PaneOut::new(80, 24);
        assert_eq!(o.push(b"live\r\n"), Some(6));
        let at = o.pause();
        assert_eq!(at, 6);
        assert!(o.is_paused());
        assert_eq!(o.push(b"hidden1\r\n"), None);
        assert_eq!(o.push(b"hidden2\r\n"), None);
        assert_eq!(o.pause(), 6, "second pause keeps the first seq");
        let Resumed::Bytes(bytes, next) = o.resume() else { panic!("expected bytes") };
        assert_eq!(bytes, b"hidden1\r\nhidden2\r\n");
        assert_eq!(next, o.seq());
        assert!(!o.is_paused());
        assert_eq!(o.push(b"again\r\n"), Some(o.seq()));
        assert_eq!(o.resume(), Resumed::Nothing, "not paused any more");
    }

    #[test]
    fn resume_with_nothing_buffered_is_nothing() {
        let mut o = PaneOut::new(80, 24);
        o.push(b"x\r\n");
        o.pause();
        assert_eq!(o.resume(), Resumed::Nothing);
        assert!(!o.is_paused());
    }

    #[test]
    fn resume_reports_a_gap_when_the_paused_point_was_evicted() {
        let mut o = PaneOut::with_capacity(64);
        o.push(b"before\r\n");
        o.pause();
        for _ in 0..50 {
            o.push(b"0123456789abcdef0123456789\r\n");
        }
        assert_eq!(o.resume(), Resumed::Gap);
        assert!(!o.is_paused());
    }

    #[test]
    fn resize_while_paused_keeps_the_gap_replayable() {
        let mut o = PaneOut::new(80, 24);
        o.push(b"live\r\n");
        o.pause();
        o.push(b"hidden1\r\n");
        o.resized(100, 30);
        o.push(b"hidden2\r\n");
        assert_eq!((o.cols, o.rows), (100, 30));
        let Resumed::Bytes(bytes, _) = o.resume() else { panic!("expected bytes, not a gap") };
        assert_eq!(bytes, b"hidden1\r\nhidden2\r\n");
    }

    #[test]
    fn ring_is_bounded_but_seq_keeps_counting() {
        let mut o = PaneOut::with_capacity(256);
        for _ in 0..200 {
            o.push(b"0123456789abcdef0123456789\r\n");
        }
        let s = o.snapshot();
        assert!(s.body.len() < 1024, "bounded: {}", s.body.len());
        assert_eq!(s.next_seq, 200 * 28);
        assert!(s.start_seq > 0);
    }

    #[test]
    fn resize_drops_history_and_records_size() {
        let mut o = PaneOut::new(80, 24);
        o.push(b"old width\r\npartial");
        o.resized(120, 40);
        assert_eq!((o.cols, o.rows), (120, 40));
        let s = o.snapshot();
        assert_eq!(s.body, b"partial");
    }

    #[test]
    fn attach_since_returns_only_the_bytes_after_the_pause_point() {
        let mut o = PaneOut::with_capacity(1024);
        o.push(b"before\n");
        let seq = o.pause();
        assert_eq!(seq, 7, "pane_pause reports the ring offset live emits stopped at");
        assert!(o.push(b"while paused\n").is_none(), "buffer-only while paused");
        match o.attach(Some(seq)) {
            AttachBody::Delta(b, next) => {
                assert_eq!(b, b"while paused\n");
                assert_eq!(next, o.seq());
            }
            AttachBody::Full(_) => panic!("delta expected"),
        }
        assert!(!o.is_paused(), "attach resumes live emits");
        assert_eq!(o.push(b"after\n"), Some(o.seq()), "live again");
    }

    #[test]
    fn attach_without_since_or_past_the_ring_is_the_full_ring_and_still_resumes() {
        let mut o = PaneOut::with_capacity(1024);
        o.push(b"abc\n");
        o.pause();
        assert!(matches!(o.attach(None), AttachBody::Full(_)));
        assert!(!o.is_paused());
        o.pause();
        assert!(matches!(o.attach(Some(u64::MAX)), AttachBody::Full(_)), "a seq past the ring is not a delta");
        assert!(!o.is_paused());
    }
}
