# Phase 4 + 5 red team (Sonnet reviewer, 2026-10-05)

Scope: `git diff main..qol/phase-4` (S4-S10b, Home 1-7, fixes).
Not audited: test quality, scrollback redaction in v2 doc and support bundle, flag-off leak; the Fable pre-release red team covers those.
Result: High 0, Medium 4, Low 6. No confirmed PTY-kill path.

## Medium (fix)
1. windows.rs:336 dead_windows / :293 spawn_watcher: sleep, clock jump or a DevTools pause reaps healthy secondaries via merge_window with no flush. Fix: skip a tick when the wall gap exceeds the interval, require two consecutive misses, flush first.
2. windows.rs ~:560 ws_transfer Label: win://adopt can be emitted before the target registered its listener (booted=true set in window_boot before windowBoot.ts:98 listens); source releases, panes stay paused. Fix: target acks adopt before the source releases; Rust resumes panes if no ack.
3. windowMove.ts ~:85 + paneSessions.releaseWorkspace: the "still starting" check runs before pause; a pane added during the drain can be released mid-spawn and killed by the entry.disposed guard (Terminal.tsx ~:1606). Fix: re-check ptyIds after the drain, abort if the pane set changed.
4. persist.rs:419-441 write_merged sets dirty=false before the write; on Err the last state is never written at quit. Fix: restore dirty on Err.

## Low
5. windows.rs ~:795 on_close_requested: each X press spawns a close thread. Fix: in-progress guard.
6. windows.rs ~:772 merge_all/merge_window: adopt emitted to main only; lost if main is mid-reload. Fix: verify main rehydrates from the doc on reload, else queue.
7. window_focus_pane: label registry-checked, callers click-driven. Accepted.
8. readscope.rs:177: asset grants persist until restart after a window closes. By design, documented. Accepted.
9. HomeOverlay.tsx:327 capture keydown takes j/k/1-5/Space even when a dialog is stacked above Home. Fix: act only when Home is the top overlay.
10. HomeOverlay.tsx:214-228 approve seq guard checked before an await gap. Fix: re-check immediately before writeToPane.

## Ruling
Session-wide operations from a secondary keep the "switch to main window" refusal for 0.6.0 (safe, no side effects); merge-first-then-act goes to BACKLOG.
