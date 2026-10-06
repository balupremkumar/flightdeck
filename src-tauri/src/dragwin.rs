//! Window drag (D3), pure core. Where a workspace dragged out of its window lands,
//! and the state machine that turns cursor samples into events. Nothing here
//! touches the OS or tauri: every coordinate is a physical virtual-desktop pixel
//! (the space `GetCursorPos`, window rects and `Monitor::work_area` share), so the
//! poll thread in `dragrun.rs` is a thin wrapper and all of this is unit tested.

use serde::{Deserialize, Serialize};

/// Cursor distance past the source window's edge before the drag tears out. Coming
/// back needs the cursor inside the window, so a wobble on the border never flaps.
pub const TEAR_PX: i32 = 8;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pt {
    pub x: i32,
    pub y: i32,
}

/// Physical rectangle (top-left and size). Serialises as `{x, y, w, h}`, the shape
/// of `TransferTarget::New.at` and of the `drag://drop` payload.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }

    /// Half open: the right and bottom edges belong to the neighbour.
    pub fn contains(&self, p: Pt) -> bool {
        p.x >= self.x && p.y >= self.y && p.x < self.x + self.w && p.y < self.y + self.h
    }

    /// How far `p` is outside the rect, the larger of the two axis gaps (0 inside).
    pub fn distance_outside(&self, p: Pt) -> i32 {
        let dx = (self.x - p.x).max(p.x - (self.x + self.w - 1)).max(0);
        let dy = (self.y - p.y).max(p.y - (self.y + self.h - 1)).max(0);
        dx.max(dy)
    }
}

/// One of our windows as the hit test sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WinInfo {
    pub label: String,
    pub rect: Rect,
    pub minimised: bool,
    pub visible: bool,
    pub booted: bool,
    pub last_focus_ms: u64,
}

impl WinInfo {
    /// Can a drop land here? Minimised, hidden and not yet booted windows cannot.
    pub fn eligible(&self) -> bool {
        self.booted && self.visible && !self.minimised
    }
}

/// The top-level window under the cursor, from `WindowFromPoint` + `GetAncestor`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Topmost {
    /// One of ours, by label.
    Ours(String),
    /// Another app (or the desktop).
    Foreign,
    /// The OS gave no answer.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DropPick {
    /// Over the source window itself: nothing moves.
    Cancel,
    /// Over another Flightdeck window: the workspace moves into it.
    Join(String),
    /// Over the desktop, another app or another monitor: a new window opens here.
    NewAt(Pt),
}

/// Where a release at `cursor` lands. The OS's z-order answer (`topmost`) wins;
/// only when it is unknown do the rects decide, preferring the most recently
/// focused window among those that contain the cursor.
pub fn pick_drop(cursor: Pt, source: &str, windows: &[WinInfo], topmost: &Topmost) -> DropPick {
    let over = |label: &str| if label == source { DropPick::Cancel } else { DropPick::Join(label.to_string()) };
    match topmost {
        Topmost::Ours(l) if l == source => DropPick::Cancel,
        Topmost::Ours(l) => match windows.iter().find(|w| &w.label == l) {
            Some(w) if w.eligible() => over(l),
            _ => DropPick::NewAt(cursor),
        },
        Topmost::Foreign => DropPick::NewAt(cursor),
        Topmost::Unknown => windows
            .iter()
            .filter(|w| w.eligible() && w.rect.contains(cursor))
            .max_by(|a, b| a.last_focus_ms.cmp(&b.last_focus_ms).then_with(|| b.label.cmp(&a.label)))
            .map(|w| over(&w.label))
            .unwrap_or(DropPick::NewAt(cursor)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Button down, still inside (or just outside) the source window.
    Armed,
    /// Past the tear threshold: the drop is live.
    Torn,
    /// Tore out but the workspace cannot move (a pane is still starting).
    Refused,
}

impl Phase {
    /// The `drag://state` phase string.
    pub fn name(self) -> &'static str {
        match self {
            Phase::Armed => "armed",
            Phase::Torn => "torn",
            Phase::Refused => "refused",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Button up without tearing out (or while refused): JS commits its reorder.
    Released,
    Cancelled,
    /// A drop was decided and sent.
    Dropped,
    /// The source was the only workspace of a secondary, so the window itself moved.
    Moved,
    Timeout,
}

impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Released => "released",
            Outcome::Cancelled => "cancelled",
            Outcome::Dropped => "dropped",
            Outcome::Moved => "moved",
            Outcome::Timeout => "timeout",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DragState {
    pub phase: Phase,
    pub tearable: bool,
    /// The window currently showing the drop hint.
    pub hover: Option<String>,
}

impl DragState {
    pub fn new(tearable: bool) -> DragState {
        DragState { phase: Phase::Armed, tearable, hover: None }
    }
}

/// One reading of the OS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    pub cursor: Pt,
    /// The primary button (swap-button aware) is held.
    pub down: bool,
    pub topmost: Topmost,
}

/// The windows at the moment of a sample.
pub struct World<'a> {
    pub source: &'a str,
    pub source_rect: Rect,
    pub windows: &'a [WinInfo],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Tell the source window the phase changed (`drag://state`).
    Phase(Phase),
    HoverStart(String),
    HoverEnd(String),
    /// Release decided on `Join` or `NewAt` (never `Cancel`, that is `End(Cancelled)`).
    Drop(DropPick),
    /// The drag is over; the caller stops polling.
    End(Outcome),
}

/// Where samples come from: the OS, or a script (the Canary harness, tests).
pub trait CursorSource {
    fn sample(&mut self) -> Sample;
}

/// Advance one sample. The state after an `End` action is meaningless.
pub fn step(state: &DragState, sample: &Sample, world: &World) -> (DragState, Vec<Action>) {
    let mut next = state.clone();
    let mut out = Vec::new();
    let clear_hover = |next: &mut DragState, out: &mut Vec<Action>| {
        if let Some(h) = next.hover.take() {
            out.push(Action::HoverEnd(h));
        }
    };

    if !sample.down {
        match state.phase {
            Phase::Torn => {
                clear_hover(&mut next, &mut out);
                match pick_drop(sample.cursor, world.source, world.windows, &sample.topmost) {
                    DropPick::Cancel => out.push(Action::End(Outcome::Cancelled)),
                    pick => {
                        out.push(Action::Drop(pick));
                        out.push(Action::End(Outcome::Dropped));
                    }
                }
            }
            Phase::Armed | Phase::Refused => out.push(Action::End(Outcome::Released)),
        }
        return (next, out);
    }

    let outside = world.source_rect.distance_outside(sample.cursor);
    match state.phase {
        Phase::Armed if outside >= TEAR_PX => {
            next.phase = if state.tearable { Phase::Torn } else { Phase::Refused };
            out.push(Action::Phase(next.phase));
        }
        Phase::Torn if outside == 0 => {
            next.phase = Phase::Armed;
            out.push(Action::Phase(Phase::Armed));
            clear_hover(&mut next, &mut out);
        }
        _ => {}
    }
    if next.phase == Phase::Torn {
        let want = match pick_drop(sample.cursor, world.source, world.windows, &sample.topmost) {
            DropPick::Join(l) => Some(l),
            _ => None,
        };
        if want != next.hover {
            clear_hover(&mut next, &mut out);
            if let Some(l) = want {
                out.push(Action::HoverStart(l.clone()));
                next.hover = Some(l);
            }
        }
    }
    (next, out)
}

/// End the drag from outside the sample loop (Escape, timeout, source gone).
pub fn abort(state: &DragState, outcome: Outcome) -> Vec<Action> {
    let mut out = Vec::new();
    if let Some(h) = &state.hover {
        out.push(Action::HoverEnd(h.clone()));
    }
    out.push(Action::End(outcome));
    out
}

/// Grab offset (physical) for a new window dropped at the cursor: horizontally
/// centred, a title bar's depth down, so the cursor lands on the new title bar.
pub fn default_grab(size: (i32, i32), scale: f64) -> Pt {
    Pt { x: size.0 / 2, y: (20.0 * scale).round() as i32 }
}

/// Outer rect for a window dropped at `cursor` on the monitor whose work area and
/// scale are given. `logical` is the source window's logical outer size; the size
/// on the target is that times the target scale, shrunk to fit the work area. The
/// window is then kept entirely inside the work area, which keeps its title bar on
/// screen. `grab` is the physical offset of the cursor inside the new window.
pub fn place_at(cursor: Pt, grab: Pt, work: Rect, scale: f64, logical: (f64, f64)) -> Rect {
    let w = ((logical.0 * scale).round() as i32).clamp(1, work.w.max(1));
    let h = ((logical.1 * scale).round() as i32).clamp(1, work.h.max(1));
    let x = (cursor.x - grab.x).clamp(work.x, (work.x + work.w - w).max(work.x));
    let y = (cursor.y - grab.y).clamp(work.y, (work.y + work.h - h).max(work.y));
    Rect { x, y, w, h }
}

/// Ghost window size and cursor offset, logical px (plan section 2).
pub const GHOST_W: f64 = 240.0;
pub const GHOST_H: f64 = 56.0;
pub const GHOST_OFFSET: f64 = 14.0;

/// What a release would do right now, as the ghost's mode line says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GhostMode {
    New,
    Join,
    Cancel,
}

impl GhostMode {
    /// The string `ghost.ts` takes (`window.__ghostMode`).
    pub fn name(self) -> &'static str {
        match self {
            GhostMode::New => "new",
            GhostMode::Join => "join",
            GhostMode::Cancel => "cancel",
        }
    }
}

pub fn ghost_mode(pick: &DropPick) -> GhostMode {
    match pick {
        DropPick::Cancel => GhostMode::Cancel,
        DropPick::Join(_) => GhostMode::Join,
        DropPick::NewAt(_) => GhostMode::New,
    }
}

/// The monitor (full rect, scale) containing `p`.
pub fn monitor_at(monitors: &[(Rect, f64)], p: Pt) -> Option<(Rect, f64)> {
    monitors.iter().find(|(r, _)| r.contains(p)).copied()
}

/// Physical top-left of the ghost: `GHOST_OFFSET` right of and below the cursor, so it
/// never sits under it. Flipped to the other side of the cursor where it would leave
/// the monitor, then clamped, so it is always fully on the cursor's monitor.
pub fn ghost_origin(cursor: Pt, scale: f64, monitor: Rect) -> Pt {
    let w = (GHOST_W * scale).round() as i32;
    let h = (GHOST_H * scale).round() as i32;
    let off = (GHOST_OFFSET * scale).round() as i32;
    let mut x = cursor.x + off;
    if x + w > monitor.x + monitor.w {
        x = cursor.x - off - w;
    }
    let mut y = cursor.y + off;
    if y + h > monitor.y + monitor.h {
        y = cursor.y - off - h;
    }
    Pt { x: x.clamp(monitor.x, (monitor.x + monitor.w - w).max(monitor.x)), y: y.clamp(monitor.y, (monitor.y + monitor.h - h).max(monitor.y)) }
}

/// RFC 3986 percent-encoding of everything but unreserved characters.
pub fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The ghost page path with its query. The name is cut to 80 chars here as well, so
/// the URL stays short whatever a workspace is called.
pub fn ghost_path(name: &str, tint: &str, panes: u32, mode: GhostMode) -> String {
    let name: String = name.chars().take(80).collect();
    let tint: String = tint.chars().take(64).collect();
    format!("ghost.html?name={}&tint={}&panes={}&mode={}", pct_encode(&name), pct_encode(&tint), panes, mode.name())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(label: &str, x: i32, y: i32, w: i32, h: i32, focus: u64) -> WinInfo {
        WinInfo { label: label.into(), rect: Rect::new(x, y, w, h), minimised: false, visible: true, booted: true, last_focus_ms: focus }
    }

    fn pt(x: i32, y: i32) -> Pt {
        Pt { x, y }
    }

    fn ours(l: &str) -> Topmost {
        Topmost::Ours(l.into())
    }

    /// main at (0,0) 1000x800, fw-1 at (1200,0) 800x600.
    fn two() -> Vec<WinInfo> {
        vec![win("main", 0, 0, 1000, 800, 5), win("fw-1", 1200, 0, 800, 600, 9)]
    }

    #[test]
    fn rect_distance_and_contains() {
        let r = Rect::new(100, 100, 50, 50);
        assert!(r.contains(pt(100, 100)) && r.contains(pt(149, 149)));
        assert!(!r.contains(pt(150, 120)) && !r.contains(pt(99, 120)));
        assert_eq!(r.distance_outside(pt(120, 120)), 0);
        assert_eq!(r.distance_outside(pt(149, 149)), 0);
        assert_eq!(r.distance_outside(pt(150, 120)), 1);
        assert_eq!(r.distance_outside(pt(160, 90)), 11);
        assert_eq!(r.distance_outside(pt(90, 200)), 51);
    }

    #[test]
    fn drop_over_own_source_cancels() {
        assert_eq!(pick_drop(pt(500, 400), "main", &two(), &ours("main")), DropPick::Cancel);
        assert_eq!(pick_drop(pt(500, 400), "main", &two(), &Topmost::Unknown), DropPick::Cancel);
    }

    #[test]
    fn drop_over_another_flightdeck_window_joins_it() {
        assert_eq!(pick_drop(pt(1500, 300), "main", &two(), &ours("fw-1")), DropPick::Join("fw-1".into()));
        assert_eq!(pick_drop(pt(500, 300), "fw-1", &two(), &ours("main")), DropPick::Join("main".into()));
        assert_eq!(pick_drop(pt(1500, 300), "main", &two(), &Topmost::Unknown), DropPick::Join("fw-1".into()));
    }

    #[test]
    fn drop_over_desktop_or_another_monitor_opens_a_new_window() {
        let c = pt(1100, 700);
        assert_eq!(pick_drop(c, "main", &two(), &Topmost::Foreign), DropPick::NewAt(c));
        assert_eq!(pick_drop(c, "main", &two(), &Topmost::Unknown), DropPick::NewAt(c));
        let far = pt(-1500, 200);
        assert_eq!(pick_drop(far, "main", &two(), &Topmost::Foreign), DropPick::NewAt(far));
    }

    #[test]
    fn a_foreign_window_on_top_of_ours_counts_as_desktop() {
        // The cursor is inside fw-1's rect but another app is in front there.
        let c = pt(1500, 300);
        assert_eq!(pick_drop(c, "main", &two(), &Topmost::Foreign), DropPick::NewAt(c));
        // And over the source itself: Foreign in front of the source is also desktop.
        let c2 = pt(500, 400);
        assert_eq!(pick_drop(c2, "main", &two(), &Topmost::Foreign), DropPick::NewAt(c2));
    }

    #[test]
    fn unknown_falls_back_to_the_most_recently_focused_containing_window() {
        // Both contain (1300, 100) when they overlap.
        let w = vec![win("main", 0, 0, 2000, 800, 5), win("fw-1", 1200, 0, 800, 600, 9), win("fw-2", 1250, 0, 400, 300, 7)];
        let c = pt(1300, 100);
        assert_eq!(pick_drop(c, "main", &w, &Topmost::Unknown), DropPick::Join("fw-1".into()));
        // The source being the most recent means cancel.
        let w2 = vec![win("main", 0, 0, 2000, 800, 20), win("fw-1", 1200, 0, 800, 600, 9)];
        assert_eq!(pick_drop(c, "main", &w2, &Topmost::Unknown), DropPick::Cancel);
        // A focus tie is broken by label, deterministically.
        let tie = vec![win("fw-2", 0, 0, 100, 100, 3), win("fw-1", 0, 0, 100, 100, 3)];
        assert_eq!(pick_drop(pt(5, 5), "main", &tie, &Topmost::Unknown), DropPick::Join("fw-1".into()));
    }

    #[test]
    fn minimised_hidden_and_unbooted_windows_are_skipped() {
        let mut w = two();
        w[1].minimised = true;
        assert_eq!(pick_drop(pt(1500, 300), "main", &w, &Topmost::Unknown), DropPick::NewAt(pt(1500, 300)));
        w[1].minimised = false;
        w[1].visible = false;
        assert_eq!(pick_drop(pt(1500, 300), "main", &w, &Topmost::Unknown), DropPick::NewAt(pt(1500, 300)));
        w[1].visible = true;
        w[1].booted = false;
        assert_eq!(pick_drop(pt(1500, 300), "main", &w, &Topmost::Unknown), DropPick::NewAt(pt(1500, 300)));
        // The OS naming an ineligible window as topmost does not make it a target either.
        assert_eq!(pick_drop(pt(1500, 300), "main", &w, &ours("fw-1")), DropPick::NewAt(pt(1500, 300)));
        // A label the registry does not list is not a target.
        assert_eq!(pick_drop(pt(1500, 300), "main", &w, &ours("fw-9")), DropPick::NewAt(pt(1500, 300)));
        // An eligible window under an ineligible one still wins the fallback.
        let stack = vec![
            WinInfo { minimised: true, ..win("fw-2", 0, 0, 100, 100, 99) },
            win("fw-1", 0, 0, 100, 100, 1),
        ];
        assert_eq!(pick_drop(pt(5, 5), "main", &stack, &Topmost::Unknown), DropPick::Join("fw-1".into()));
    }

    fn sample(x: i32, y: i32, down: bool, topmost: Topmost) -> Sample {
        Sample { cursor: pt(x, y), down, topmost }
    }

    fn run(state: &DragState, s: Sample, w: &[WinInfo]) -> (DragState, Vec<Action>) {
        let src = w.iter().find(|i| i.label == "main").unwrap();
        step(state, &s, &World { source: "main", source_rect: src.rect, windows: w })
    }

    #[test]
    fn staying_inside_or_within_the_threshold_stays_armed() {
        let w = two();
        let st = DragState::new(true);
        let (st, a) = run(&st, sample(500, 400, true, ours("main")), &w);
        assert!(a.is_empty() && st.phase == Phase::Armed);
        // 7 px past the right edge (x = 999 is the last inside pixel).
        let (st, a) = run(&st, sample(1006, 400, true, Topmost::Foreign), &w);
        assert!(a.is_empty() && st.phase == Phase::Armed);
    }

    #[test]
    fn eight_px_out_tears_and_the_return_needs_the_inside() {
        let w = two();
        let (st, a) = run(&DragState::new(true), sample(1007, 400, true, Topmost::Foreign), &w);
        assert_eq!(a, vec![Action::Phase(Phase::Torn)]);
        // Back to 3 px outside: still torn, no event (hysteresis).
        let (st, a) = run(&st, sample(1002, 400, true, Topmost::Foreign), &w);
        assert!(a.is_empty() && st.phase == Phase::Torn);
        // Inside the window again: armed, announced once.
        let (st, a) = run(&st, sample(900, 400, true, ours("main")), &w);
        assert_eq!(a, vec![Action::Phase(Phase::Armed)]);
        assert_eq!(st.phase, Phase::Armed);
        // And it can tear again.
        let (_, a) = run(&st, sample(1100, 400, true, Topmost::Foreign), &w);
        assert_eq!(a, vec![Action::Phase(Phase::Torn)]);
    }

    #[test]
    fn a_workspace_that_cannot_move_is_refused_once_and_never_drops() {
        let w = two();
        let (st, a) = run(&DragState::new(false), sample(1100, 400, true, Topmost::Foreign), &w);
        assert_eq!(a, vec![Action::Phase(Phase::Refused)]);
        let (st, a) = run(&st, sample(1500, 300, true, ours("fw-1")), &w);
        assert!(a.is_empty(), "no hover while refused");
        let (_, a) = run(&st, sample(1500, 300, false, ours("fw-1")), &w);
        assert_eq!(a, vec![Action::End(Outcome::Released)]);
    }

    #[test]
    fn hover_is_emitted_only_on_change() {
        let w = two();
        let torn = DragState { phase: Phase::Torn, tearable: true, hover: None };
        let (st, a) = run(&torn, sample(1500, 300, true, ours("fw-1")), &w);
        assert_eq!(a, vec![Action::HoverStart("fw-1".into())]);
        let (st, a) = run(&st, sample(1510, 310, true, ours("fw-1")), &w);
        assert!(a.is_empty(), "same target, nothing emitted");
        let (st, a) = run(&st, sample(1100, 300, true, Topmost::Foreign), &w);
        assert_eq!(a, vec![Action::HoverEnd("fw-1".into())]);
        assert_eq!(st.hover, None);
        // Moving between two other windows swaps the hint in one sample.
        let three = vec![win("main", 0, 0, 1000, 800, 5), win("fw-1", 1200, 0, 400, 600, 9), win("fw-2", 1600, 0, 400, 600, 7)];
        let on1 = DragState { hover: Some("fw-1".into()), ..torn.clone() };
        let (_, a) = run(&on1, sample(1700, 100, true, ours("fw-2")), &three);
        assert_eq!(a, vec![Action::HoverEnd("fw-1".into()), Action::HoverStart("fw-2".into())]);
    }

    #[test]
    fn returning_over_the_source_clears_the_hint_and_never_hovers_the_source() {
        let w = two();
        let torn = DragState { phase: Phase::Torn, tearable: true, hover: Some("fw-1".into()) };
        let (st, a) = run(&torn, sample(500, 400, true, ours("main")), &w);
        assert_eq!(a, vec![Action::Phase(Phase::Armed), Action::HoverEnd("fw-1".into())]);
        assert_eq!(st.hover, None);
        // Torn but cursor over the source's own border band: no hover on it.
        let torn2 = DragState { phase: Phase::Torn, tearable: true, hover: None };
        let (_, a) = run(&torn2, sample(1003, 400, true, ours("main")), &w);
        assert!(a.is_empty());
    }

    #[test]
    fn release_while_armed_is_a_plain_release() {
        let w = two();
        let (_, a) = run(&DragState::new(true), sample(500, 400, false, ours("main")), &w);
        assert_eq!(a, vec![Action::End(Outcome::Released)]);
    }

    #[test]
    fn release_over_desktop_drops_a_new_window_at_the_cursor() {
        let w = two();
        let torn = DragState { phase: Phase::Torn, tearable: true, hover: None };
        let (_, a) = run(&torn, sample(1100, 700, false, Topmost::Foreign), &w);
        assert_eq!(a, vec![Action::Drop(DropPick::NewAt(pt(1100, 700))), Action::End(Outcome::Dropped)]);
    }

    #[test]
    fn release_over_another_window_joins_and_ends_its_hint_first() {
        let w = two();
        let torn = DragState { phase: Phase::Torn, tearable: true, hover: Some("fw-1".into()) };
        let (_, a) = run(&torn, sample(1500, 300, false, ours("fw-1")), &w);
        assert_eq!(a, vec![Action::HoverEnd("fw-1".into()), Action::Drop(DropPick::Join("fw-1".into())), Action::End(Outcome::Dropped)]);
    }

    #[test]
    fn release_back_over_the_source_after_tearing_cancels() {
        let w = two();
        let torn = DragState { phase: Phase::Torn, tearable: true, hover: None };
        let (_, a) = run(&torn, sample(1003, 400, false, ours("main")), &w);
        assert_eq!(a, vec![Action::End(Outcome::Cancelled)]);
    }

    #[test]
    fn abort_ends_the_hint_then_the_drag() {
        let torn = DragState { phase: Phase::Torn, tearable: true, hover: Some("fw-1".into()) };
        assert_eq!(abort(&torn, Outcome::Timeout), vec![Action::HoverEnd("fw-1".into()), Action::End(Outcome::Timeout)]);
        assert_eq!(abort(&DragState::new(true), Outcome::Cancelled), vec![Action::End(Outcome::Cancelled)]);
    }

    /// A scripted source drives the same machine end to end.
    struct Script(Vec<Sample>);
    impl CursorSource for Script {
        fn sample(&mut self) -> Sample {
            if self.0.len() > 1 { self.0.remove(0) } else { self.0[0].clone() }
        }
    }

    #[test]
    fn a_scripted_drag_runs_through_the_state_machine() {
        let w = two();
        let mut src = Script(vec![
            sample(900, 400, true, ours("main")),
            sample(1100, 400, true, Topmost::Foreign),
            sample(1500, 300, true, ours("fw-1")),
            sample(1500, 300, false, ours("fw-1")),
        ]);
        let mut st = DragState::new(true);
        let mut all = Vec::new();
        for _ in 0..4 {
            let s = src.sample();
            let (n, a) = run(&st, s, &w);
            st = n;
            all.extend(a);
        }
        assert_eq!(
            all,
            vec![
                Action::Phase(Phase::Torn),
                Action::HoverStart("fw-1".into()),
                Action::HoverEnd("fw-1".into()),
                Action::Drop(DropPick::Join("fw-1".into())),
                Action::End(Outcome::Dropped)
            ]
        );
    }

    // place_at: monitor A 100% at (0,0) 1920x1040 work area; B 150% at (1920,0) 2560x1400 work area.
    const A: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };
    const B: Rect = Rect { x: 1920, y: 0, w: 2560, h: 1400 };

    #[test]
    fn place_at_scales_the_logical_size_by_the_target_monitor() {
        let on_a = place_at(pt(900, 200), pt(600, 20), A, 1.0, (1200.0, 800.0));
        assert_eq!(on_a, Rect::new(300, 180, 1200, 800));
        let on_b = place_at(pt(3000, 100), pt(900, 30), B, 1.5, (1200.0, 800.0));
        assert_eq!((on_b.w, on_b.h), (1800, 1200));
        assert_eq!((on_b.x, on_b.y), (2100, 70));
    }

    #[test]
    fn place_at_clamps_into_the_work_area_keeping_the_title_bar_on_screen() {
        // Dropped at the bottom edge: pushed up so the whole window, title bar included, is visible.
        let r = place_at(pt(900, 1035), pt(600, 20), A, 1.0, (1200.0, 800.0));
        assert_eq!(r.y, 1040 - 800);
        assert!(r.y >= A.y && r.y + 40 <= A.y + A.h);
        // Dropped at the top-left: not above or left of the work area.
        let r = place_at(pt(5, 2), pt(600, 20), A, 1.0, (1200.0, 800.0));
        assert_eq!((r.x, r.y), (0, 0));
        // Right edge.
        let r = place_at(pt(1915, 500), pt(600, 20), A, 1.0, (1200.0, 800.0));
        assert_eq!(r.x + r.w, 1920);
        // Oversize for the monitor (200% source window onto a small 100% screen): shrunk to fit.
        let r = place_at(pt(100, 100), pt(0, 0), A, 1.0, (3000.0, 2000.0));
        assert_eq!(r, A);
    }

    #[test]
    fn place_at_handles_a_negative_origin_monitor_and_200_percent() {
        // A monitor left of the primary at 200%.
        let left = Rect { x: -2560, y: -200, w: 2560, h: 1400 };
        let r = place_at(pt(-1000, 100), pt(1200, 40), left, 2.0, (1200.0, 700.0));
        assert_eq!((r.w, r.h), (2400, 1400));
        assert_eq!(r.x, -2560 + 160, "clamped to the right edge of the work area");
        assert_eq!(r.y, -200, "clamped to the top: 100-40=60 would sit inside but the height fills the work area");
        assert!(r.x >= left.x && r.x + r.w <= left.x + left.w);
        // Cursor far outside the monitor still lands inside it.
        let r = place_at(pt(-9000, -9000), pt(0, 0), left, 2.0, (600.0, 400.0));
        assert_eq!((r.x, r.y), (left.x, left.y));
    }

    #[test]
    fn mixed_dpi_same_logical_window_is_bigger_in_pixels_on_the_150_percent_monitor() {
        let a = place_at(pt(500, 300), default_grab((1200, 800), 1.0), A, 1.0, (1200.0, 800.0));
        let b = place_at(pt(2500, 300), default_grab((1800, 1200), 1.5), B, 1.5, (1200.0, 800.0));
        assert_eq!(a.w * 3, b.w * 2);
        assert_eq!(a.h * 3, b.h * 2);
    }

    #[test]
    fn default_grab_centres_on_the_title_bar() {
        assert_eq!(default_grab((1200, 800), 1.0), pt(600, 20));
        assert_eq!(default_grab((1800, 1200), 1.5), pt(900, 30));
    }

    #[test]
    fn ghost_mode_follows_the_pick() {
        assert_eq!(ghost_mode(&DropPick::Cancel), GhostMode::Cancel);
        assert_eq!(ghost_mode(&DropPick::Join("fw-1".into())), GhostMode::Join);
        assert_eq!(ghost_mode(&DropPick::NewAt(pt(1, 2))), GhostMode::New);
        assert_eq!(GhostMode::Join.name(), "join");
    }

    const MON: Rect = Rect { x: 0, y: 0, w: 1920, h: 1080 };

    #[test]
    fn ghost_sits_offset_from_the_cursor() {
        assert_eq!(ghost_origin(pt(500, 300), 1.0, MON), pt(514, 314));
        assert_eq!(ghost_origin(pt(500, 300), 1.5, MON), pt(521, 321));
    }

    #[test]
    fn ghost_flips_and_clamps_at_monitor_edges() {
        // Right edge: flips to the left of the cursor.
        assert_eq!(ghost_origin(pt(1900, 300), 1.0, MON), pt(1900 - 14 - 240, 314));
        // Bottom edge: flips above.
        assert_eq!(ghost_origin(pt(500, 1070), 1.0, MON), pt(514, 1070 - 14 - 56));
        // Left of a monitor to the left (negative origin): stays on that monitor.
        let left = Rect::new(-1920, 0, 1920, 1080);
        assert_eq!(ghost_origin(pt(-5, 10), 1.0, left), pt(-5 - 14 - 240, 24));
        // Flip would leave the monitor too (tiny monitor): clamped on.
        let tiny = Rect::new(0, 0, 100, 40);
        assert_eq!(ghost_origin(pt(50, 20), 1.0, tiny), pt(0, 0));
    }

    #[test]
    fn monitor_lookup_is_by_containing_rect() {
        let ms = [(MON, 1.0), (Rect::new(-2560, 0, 2560, 1440), 1.5)];
        assert_eq!(monitor_at(&ms, pt(10, 10)), Some((MON, 1.0)));
        assert_eq!(monitor_at(&ms, pt(-1, 10)).map(|m| m.1), Some(1.5));
        assert_eq!(monitor_at(&ms, pt(5000, 10)), None);
    }

    #[test]
    fn ghost_path_encodes_and_truncates() {
        assert_eq!(pct_encode("a b&c=d?e\u{e9}"), "a%20b%26c%3Dd%3Fe%C3%A9");
        let p = ghost_path("api & web", "#4aa3ff", 3, GhostMode::Join);
        assert_eq!(p, "ghost.html?name=api%20%26%20web&tint=%234aa3ff&panes=3&mode=join");
        let long = ghost_path(&"x".repeat(500), "", 0, GhostMode::New);
        assert!(long.len() < 200, "{}", long.len());
        assert!(!ghost_path("</script>", "", 0, GhostMode::New).contains('<'));
    }
}
