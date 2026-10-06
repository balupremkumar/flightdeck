# 0.6.1 pre-release red team (Fable reviewer, 2026-10-06)

Scope: `git diff main...HEAD` on qol/rel-061 (28 commits, 76 files), read-only.
Focus in priority order: window drag (dragwin.rs, dragrun.rs, dragghost.rs, windows.rs, railDrag.ts, LeftPanel.tsx, ghost), natural pane exit (ptyexit.rs, lib.rs), Quiet terminal default and per-pane switch, fc43472 and 13b5b94.
The 0.6.0 findings ([[projects/active/flightdeck/docs/plans/release-0.6.0-redteam|0.6.0 red team]]) are not repeated.
The known live finding (Claude's own /focus writing briefTranscript to ~/.claude.json) is out of scope.
Result: High 1, Medium 1, Low 4.
Release call: H1 is the only blocker; it sits on the new per-pane switch, which is the headline of the release, so it is worth fixing before the cut.

## High

### H1. Quiet terminal switch can resume someone else's conversation. CONFIRMED.
Files: `src/sessionLauncherLogic.ts:303-313` (stages `--resume` from the jsonl file name), `src-tauri/src/chatlog.rs:252-269` (`rotated_jsonl`), `:283-300` (`resolve_blocking`), `:318-325` (`exclude` holds only siblings whose id is already known), `src/ChatView.tsx:497` (the only caller that ever resolves a pane).
The switch takes `pane_session_info().jsonl_path`, not the pinned `session_id`, so it inherits the /clear rotation heuristic: the newest UUID-named jsonl in the cwd slug born after this pane's spawn with a newer mtime than the pane's own file.
Before 0.6.1 that heuristic only chose which file the Chat view tailed.
Now it chooses which conversation Claude is relaunched on.
Scenario A: pane A is a Claude pane in folder X with pinned id a.
The user also runs `claude` by hand in a pwsh pane in folder X (or outside Flightdeck) and works there, so `b.jsonl` is born after A's spawn and modified after `a.jsonl`.
The user switches A to Quiet terminal.
`rotated_jsonl` returns `b.jsonl`, the switch stages `--resume b`, and A restarts inside the other process's conversation while that process is still running on the same session, two writers on one transcript.
Scenario B: pane B was forked from the launcher into the Terminal or Quiet view (the new default), so it is `needs_resolve` with no id, nobody calls `pane_session_info` on it (only ChatView does), and it never enters `exclude`.
Switching sibling A then resumes B's session the same way.
If A itself is the unresolved fork, `resolve_blocking` takes `newest_jsonl_since`, which has no exclude list at all, and pins A to whichever file is newest in the slug.
Fix: on the switch path resume the pinned `session_id` when `pinned` is true, and accept a rotation only when the pane's own jsonl holds a `conversation_reset` record whose `new_conversation_id` names the candidate (chatlog.rs:242 documents that Claude writes it), never a newest-file guess.
When neither holds, restart plain and say so in a toast.
Test: cargo `info_from` with a sibling file newer than the pane's own and no reset record must return the pane's own file; vitest `stageResumeOfCurrentSession` with `pinned: true` must stage the pinned id.

## Medium

### M1. Switching an exited pane silently starts a fresh conversation while the dialog promises the same one. CONFIRMED.
Files: `src/PaneView.tsx:735-742` (confirm copy "picks up the same conversation"), `src/sessionLauncherLogic.ts:306-316` (returns false on any error, caller restarts plain), `src-tauri/src/lib.rs:432-434` (`release` removes the registry entry) and `:452-459` (`on_exit` removes it), `src-tauri/src/chatlog.rs:308` ("no such pane").
`SessionState` lives inside the `Pane` registry entry, and ptyexit now prunes that entry the moment the process exits, which 0.6.0 could not do on ConPTY.
Scenario: Claude ends (the user types /exit, Claude crashes, or the user closes it from inside), the pane shows Restart, the user opens the menu and picks Quiet terminal.
The dialog says the conversation carries over, `pane_session_info` fails because the registry entry is gone, nothing is staged, and the pane comes back empty.
The conversation is still on disk but only reachable through the launcher.
Fix: keep the last `SessionState` per model id where `on_exit` can leave it (the `by_model` map outlives the pane), or when staging fails show "Couldn't find this pane's conversation, Claude starts fresh" before restarting rather than after.
Test: vitest `setFocusModeKeepingSession` with `info` rejecting must surface the toast; cargo `pane_session_info` on an exited pane must still answer the last known id.

## Low

### L1. Staged `--resume` is keyed by vendor and folder, not by pane.
Files: `src-tauri/src/usage.rs:526-548`, `src/sessionLauncherLogic.ts:310`, `src/Terminal.tsx:1633` (a new terminal waits up to 500 ms for a sane fit before `pty_spawn`).
Two Claude panes in one folder: a switch on A stages resume a, and any Claude spawn in that folder before A's spawn lands takes it (a Restart on B, a new pane, or a second switch on B, which replaces A's staging at usage.rs:530-533 so A resumes B and B restarts plain).
The window is under a second and needs a second user action inside it, so it is rare, but the outcome is the wrong conversation.
Fix: pass `modelId` through `stage_launch_args` and match on it in `take_at`; the same change closes the launcher's pre-existing version of this.

### L2. Dropping onto a Flightdeck window that is still booting opens another window on top of it.
Files: `src-tauri/src/dragwin.rs:60-62` (`eligible` needs `booted`), `:93-96` (an ineligible topmost window falls to `NewAt`).
Scenario: drop workspace 1 to the desktop, fw-2 appears and boots for about a second, the user drags workspace 2 onto it straight away; the ghost reads "Release to open in a new window" and fw-3 opens over fw-2.
Nothing is lost and the ghost is honest about it, so this is cosmetic.
Fix: treat an unbooted registry window under the cursor as `Cancel` (ghost mode cancel) so the user retries once it is up.

### L3. Turning multiwindow on in Settings arms the pointer drag before Rust allows it.
Files: `src/settingsStore.ts:333-336` (`saveMultiwindow` fires `WINDOW_DRAG_EVENT`), `src/LeftPanel.tsx:190-199` (pointer mode follows localStorage live), `src-tauri/src/dragrun.rs:309` (`require_multiwindow` holds the boot-time value).
Until the restart the copy asks for, every tear-out gets the toast "Could not drag the workspace between windows." and the HTML5 rail path is already switched off (`LeftPanel.tsx:654`), though pointer reorder still works.
Fix: derive `pointerMode` from the value `window_boot` reported, not from live localStorage.

### L4. A pane killed by the user can now carry `crashed: true` in its exit event.
Files: `src-tauri/src/ptyexit.rs:75-84` (the waiter stores the code of a `taskkill /F`, which is 1), `src-tauri/src/lib.rs:452-459` (`code != 0` wins over the registry lookup).
In 0.6.0 the kill path always reported `crashed: false` because the pane was already gone from the registry; now it depends on whether the waiter stores the code before the reader hits EOF.
No user-visible effect today: `src/paneSessions.ts:256-268` removes the listeners before `pty_kill`, and the Terminal ignores other pane ids.
Noted so nobody later keys the pane state or a notification on this field.
Fix: have `reap_pane` mark the pane as killed (an `AtomicBool` the waiter checks) and report `crashed: false, code: None` on that path.

## Verified, no defect

- ptyexit exactly-once: `finish` is guarded by `done.swap`, the waiter opens its own process handle before any kill so pid reuse cannot redirect it, `release` drops the master outside the registry lock, and `OutputCoalescer::push` never blocks so the reader always reaches EOF (ptyexit.rs:37-44, 75-84, outbuf.rs:37).
- pty_kill, restart and supersede races: `reap_pane` and `release` both remove by a never-reused pty id, `dispose` runs disposers before `pty_kill`, and the attach path matches on epoch, so a dying pty cannot be re-attached by its own restart.
- Drag thread lifetime: the poll thread ends on source destroy (geometry None), `exiting`, Escape, disarm, replacement by a newer arm, and the 120 s timeout; the ghost is destroyed on every exit and the late-build race is closed under the `OWNER` lock (dragrun.rs:217-284, dragghost.rs:70-96).
- Ghost page: no capability matches `drag-ghost`, the name is percent-encoded and set with `textContent`, the tint regex cannot end a CSS value, Tauri strips the query before asset lookup (tauri 2.11.5 protocol/tauri.rs:149), the CSP allows inline styles, the window-state plugin denylists the label, and no code iterates `webview_windows()`, so quit, flush and summon never see it.
- Coordinates: cursor, DWM frame rects, monitor work areas and placement all stay in physical virtual-desktop pixels; JS sends none; `place_at` clamps on the target monitor; `valid_placement` bounds anything JS could send back.
- Rail drag: `press` resets `suppressClick`, so a tear-out never eats the next click; Escape goes through the overlay stack with `restoreFocus: false`; a workspace made inside a secondary is claimed on its first slice put (persist.rs:525, 800 ms debounce) so `owns` passes for any drag a human can start.
- Quiet default migration: `migrateQuietDefault` sets the flag before it reads settings, the flag is a `SESSION_KEYS` entry that no reset or import clears, and `parseUiPrefs` only drops Chat views from docs without `paneViewRev`.
- fc43472: `redactOpt` now maps null to undefined; `title` and `draft` are the only `PersistedPane` free-text fields, and the worktree fields pass through untouched.
- 13b5b94: `usesProcessTitle` keys on `vendorMeta(...).kind`, unknown vendors default to agent, and shell panes keep auto-titles and the process chip.

## Fix plan

Round 1: H1 and M1 together (same file set, one agent, failing test first).
Round 2: L1 alongside H1 if the staged-args change is taken, L3 as a one-line gate.
L2 and L4 can wait for 0.6.2.
