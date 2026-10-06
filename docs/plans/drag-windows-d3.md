# D3: drag workspaces out of the window and back (design, 2026-10-06)

Source: Balu, "drag one of them out into another screen... drag them back into the main Flightdeck to merge".
Builds on [[projects/active/flightdeck/docs/plans/phase4-multiwindow|Phase 4 multi-window]] (S16-S18 never built) and the shipped 0.6.0 move machinery.
Status: plan only, nothing built. Pane tear-out stays backlog.

## Shape in one paragraph

The drag is a thin front end on the transfer that already exists: `moveWorkspace` (src/windowMove.ts:50) with target New or Label (windows.rs:749-755).
JS owns the press and the in-rail reorder.
Rust owns everything once the cursor leaves the window: it polls the OS cursor and left button, hit-tests windows, shows a ghost, and on release tells the source window what to do.
JS never sends coordinates, so physical versus logical pixels never mix.
Release is decided by Rust alone, so it does not matter whether WebView2 keeps pointer capture outside its window.

## 1. Interaction spec

- Press on a rail tile with the primary button and move 4 px: drag starts. A plain click still opens the workspace (the click after a drag is suppressed).
- While the cursor is inside the rail or window: reorder exactly as today (insertion highlight, commit on release). Sort-by-last (LeftPanel.tsx:563) disables reorder but tear-out still works.
- Cursor leaves the source window by 8 physical px: tear-out begins. The reorder highlight clears, the tile dims, and a ghost (name, pane count) follows the cursor with a mode line.
- Release over empty desktop or another monitor: a new window opens there with that workspace. Agents keep running, no restart.
- Release over another Flightdeck window (rail, body or title bar): the workspace moves into it, appended and made active, and that window comes forward. This is "drag back to merge".
- Release back over the source window, Escape, or the source closing: cancel, nothing moves.
- A different app overlapping a Flightdeck window counts as desktop (topmost window under the cursor decides), so a new window opens.
- Last workspace of a secondary dragged to a new spot: that window is moved there, not recreated. Dragged into another window: it moves and the empty secondary closes (windows.rs:855).
- Only workspace of main: allow. Main shows the launcher (App.tsx:88) like after closing the last workspace, and the whole window is a drop target. One predicate `canTearOut(ws)` holds the policy so it is a one-line flip to a refusal toast if the real app disagrees.
- Not tearable: any pane still starting (same rule as windowMove.ts:57-62). The drag still reorders, and leaving the window shows one toast instead of a ghost.
- No keyboard path needed in the drag itself: Ctrl+Shift+N and the palette already exist. D7 adds tile context menu entries for discoverability.

## 2. Decisions and tradeoffs

Ghost. Chosen: a small borderless Tauri window, label `drag-ghost`, positioned from the Rust poll.
It is transparent, always on top, skip-taskbar, not focusable, click-through, 240x56 logical, offset 14 px from the cursor so it never sits under it.
It loads a static `ghost.html` plus `src/ghost.ts` (no React, no store, no IPC), reads name and tint from the query string, and sets text with `textContent`. Rust flips its mode with `eval` (new, join, cancel).
Its label does not match `fw-*`, so default.json:5-8 grants it nothing.
Rejected: cursor-only feedback (says nothing about what is carried or where it will land; kept as the fallback if the ghost proves janky, because the ghost step is separable). Rejected: a real new window that follows the cursor like Chrome (two full transfers and two TUI replays on every cancel, plan risk "replay garbles a TUI"). Rejected: OS drag image (needs the OLE loop, which wry's handler owns).
Cost: one extra webview at tear time. D0 measures creation time. Over 250 ms means prewarm it hidden at drag start instead.

Release detection. Chosen: Rust polls `app.cursor_position()` and `GetAsyncKeyState(VK_LBUTTON)` every 16 ms, only while a drag is armed (about a second).
Rejected: low-level mouse hook (global, antivirus-visible, needs a message loop). Rejected: trusting JS `pointerup` (lost if the button is released outside and capture is not held).
`windows-sys` is already pinned (Cargo.toml:45); add features `Win32_UI_Input_KeyboardAndMouse` and `Win32_UI_WindowsAndMessaging`, no new crate tree. Honour `SM_SWAPBUTTON`.

HTML5 drag. Chosen: replace the tile's HTML5 drag with pointer events, behind a sub-flag. Keep the tile's drop handlers for panes dragged from pane headers (LeftPanel.tsx:370-396), which stay HTML5.
Likely pre-existing bug, to confirm in D0: wry documents that HTML5 drag and drop needs the native drag-drop handler off on Windows, and tauri.conf.json:12-30 leaves `dragDropEnabled` at its default (on). So rail reorder (LeftPanel.tsx:563) and pane reorder (PaneView.tsx:921) may be dead in the real app while passing in the browser e2e. If confirmed, pointer reorder fixes the rail as a side effect. The pane header fix is separate and the same hook later makes pane tear-out cheap.
Native folder drops (LeftPanel.tsx:246, NewWorkspace.tsx:284) stay on, since pointer drag never starts an OS drag.

Target highlight. Rust emits `drag://hover {name, tint, from}` to the window under the cursor when it changes, and `drag://hover-end` to the previous one. A new `DragDropHint` mounted from App.tsx draws an inset accent outline and a "Drop to move <name> here" pill. Nothing is emitted per tick. Per-slot insertion position in the target rail is backlog (append only).

## 3. Contracts

Rust commands (all async, never sync, per the 2026-09-19 rule): `drag_arm {kind: "workspace", id, tearable, name, tint, panes}`, `drag_disarm`, `drag_cancel`.
`drag_arm` takes the label from `window.label()` and checks the registry assigns `id` to it (windows.rs:969 `check_registered` style). One drag at a time, 120 s hard timeout, ends on source destroy or `exiting`.
Rust to source window: `drag://state {phase: "armed"|"torn"|"refused"}`, `drag://end {outcome}`, `drag://drop {id, target: {kind: "new", at} | {kind: "label", label}}`.
`TransferTarget::New` gains optional `at: {x, y, w, h}` physical (serde default, so windowMove.ts:44 is unchanged).
The payload is `kind`-tagged so a later `"pane"` needs no Rust change.

Pure core `src-tauri/src/dragwin.rs`: `pick_drop(cursor, source, rects, topmost) -> Cancel | Join(label) | NewAt(point)`, with `topmost = Ours(label) | Foreign | Unknown` from `WindowFromPoint` plus `GetAncestor(GA_ROOT)` mapped to labels.
`Unknown` falls back to most recently focused among containing rects (WindowRec.last_focus_ms, windows.rs:51 and :1173). Minimised, hidden and unbooted windows are skipped. A state machine `step(state, sample) -> (state, actions)` with 8 px hysteresis, fed by a `CursorSource` trait (real, or scripted for tests).
Placement `place_at(cursor, work_area, scale, size)`: window top-left is cursor minus a grab offset, size is the source's logical size times the target monitor scale, clamped to its work area with the title bar on screen. Set position first, then size, so the DPI change lands before the resize.

## 4. Flags and default

Recommendation for 0.6.1: turn `flightdeck-multiwindow` ON by default (absent key means on, explicit "0" means off, settingsStore.ts:330).
Why: Balu now requires it, the flag mostly hides commands, the infra steps are already unflagged (phase4 section 6), and the restart-to-enable dance is the main reason it has not been seen.
Condition: the checklist's Phase 4 items (release-0.6.0-checklist.md:87-98) pass on Canary first. The Settings toggle stays as the kill switch and the copy "Takes effect after a restart" stays true.
Drag gets its own sub-flag `flightdeck-window-drag` (storageKeys.ts:71, Settings > Windows, hidden while multiwindow is off), default ON in Canary.
It ships ON in 0.6.1 only if the OS-cursor checks in section 6 pass, otherwise ships OFF but visible. Sub-flag off means today's HTML5 tile drag runs unchanged. Delete that path one release later (backlog line).
Audit tests that assume the absent key means off: CommandPalette.test.ts:92, windowMerge.test.ts:56, storageKeys.test.

## 5. Steps (each independently gateable)

TS = TypeScript only, safe for a Codex agent (it may not touch src/store.ts, src/Cockpit.tsx, src-tauri/src/lib.rs, package.json, lockfiles). R = Rust or shared file, Claude Sonnet backend.

- D0 (R, throwaway Canary spike). Prove: HTML5 tile drag dead or alive with the OS cursor; ghost window flags and creation time; `cursor_position`, `monitor_from_point`, `Monitor::work_area` exist in tauri 2.11.5; placement at a point on a 150% monitor with the window-state plugin (lib.rs:1012) not overriding it; no focus steal (e2e/live fgwatch). Notes appended here. Gate: ghost under 250 ms or switch to prewarm.
- D1 (R). `dragwin.rs` pure core plus `mod` line in lib.rs. Not wired. Gate: cargo tests.
- D2 (R). Poll thread, `CursorSource`, the three commands, events, registry rect accessor (windows.rs), handler registration (lib.rs:1043), Cargo.toml features, Canary-only `drag_debug_script(points, release)` refused unless `canary::is_canary_identifier` (canary.rs:43). No ghost yet. Gate: cargo, then a live scripted run.
- D3 (R). `ws_transfer` honours `at`, sole-workspace-secondary move-the-window case, drop handler calls into the existing transfer. Files: windows.rs:749, :765, :865. Gate: cargo `place_at`, vitest that `at` is passed through.
- D4 (TS). `src/railDrag.ts` (pure state machine) and the pointer hook in LeftPanel.tsx (replace :363-406 and :563-567 behind the sub-flag, keep the pane branch), `drag://drop` and `drag://state` listeners, `moveWorkspace` accepts placement, sub-flag in storageKeys.ts, settingsStore.ts, Settings.tsx:2109, `useOverlayEsc(dragging, cancel, {restoreFocus: false})` (ui.ts:649) so Cockpit keeps its single Escape listener (Cockpit.tsx:114). Gate: vitest plus e2e.
- D5 (TS). `DragDropHint.tsx` mounted from App.tsx. Gate: vitest, e2e.
- D6 (R plus static TS). Ghost window in Rust, `ghost.html`, `src/ghost.ts`, vite.config.ts second input. Gate: live scripted run plus screenshot. Skippable: D4 and D5 still ship a working drag.
- D7 (TS, optional). Tile context menu "Move to new window" and "Move to window" (LeftPanel.tsx openMenu, :307), reusing windowActions.ts.
- D8 (TS). Default flip and sub-flag default, test audit, Settings copy, release notes, checklist additions.
- D9 (gate, no code). Full e2e, boot gate, Canary live run, user-away OS checks, then Balu's trial.

D1 to D3 and D4 to D5 can proceed in parallel once the section 3 contract is fixed.

## 6. Tests

- cargo: `pick_drop` (inside source, over other window, overlap by foreign app, minimised and hidden skipped, `Unknown` fallback by focus, window spanning two monitors), `step` hysteresis (8 px, return to source cancels), `place_at` (clamp, mixed DPI 100/150/200, negative monitor origin, title bar on screen), `drag_arm` rejects an id the label does not own.
- vitest: `railDrag` threshold and click suppression, reorder unchanged when flag off, no `drag_arm` when multiwindow off, not-tearable toast once, Escape cancels, `drag://drop` calls `moveWorkspace` with the right target, sub-flag off leaves `draggable` as today.
- e2e two-page harness (e2e/lib/multiwindow.mjs, `ws_transfer` at :438, `newPage` at :105): add `drag_arm`, `drag_cancel` to the bus plus `bus.simulateDrop(from, target)` that emits `drag://drop` to the source page. Cover drop to new, drop to existing, drop back into main merges with output intact, cancel moves nothing, and in-rail reorder via Playwright mouse. reflow-keeps-agents must still pass.
- live (e2e/live, CDP port 9333, drive.mjs:14): CDP mouse events drive the JS half without the OS cursor. `drag_debug_script` feeds scripted cursor samples through the same state machine, so ghost creation, hover events, drop, transfer and placement at a monitor point all run with the user's mouse untouched. Run with fgwatch and assert Canary never became foreground, except the new window the drop opens.
- OS cursor needed, only when Balu is away (a real press moves the foreground): real press, drag, release across the window edge; ghost smoothness; release over an overlapping foreign app; two monitors at different DPI; Escape mid-drag; Explorer folder drag onto the rail still creates a workspace; a real HTML5 pane-header drag still behaves as before (record whether it ever worked).

## 7. Risks

| Risk | Mitigation |
|---|---|
| DPI and multi-monitor mix-ups | Rust reads the cursor and all rects in physical px, JS sends no coordinates; position then size; mixed-DPI row in the OS checks |
| Pointer capture lost outside the webview | Not relied on: Rust polls cursor and button; JS state is ended by `drag://end`; JS `pointerup` inside the window only commits a reorder |
| Stuck drag (missed button-up, closed source) | 120 s timeout, ends on source destroy, `exiting`, and any `drag_arm` replaces a dead drag |
| Focus theft | Ghost is not focusable and shown with no activation; focus is taken only by the drop's new or target window, which the user's own drag caused (windows.rs:844-848 pattern) |
| Rail reorder regresses (daily driver) | Sub-flag keeps the HTML5 path; reflow e2e; D0 settles whether HTML5 ever worked |
| Wrong window chosen when windows overlap | `WindowFromPoint` is exact z-order; last-focus is only the fallback; pure tests |
| Drop during a hung or reloading source | Drop event is lost, workspace stays put, ghost destroyed; `ws_transfer` failure already resumes panes (windowMove.ts:114-118) |
| Ghost window is heavy or janky | Separable step D6; fallback is cursor-only plus target highlight; prewarm option |
| Pane header HTML5 drag conflicts | Tile drag is pointer-only so no element carries both; pane-to-tile drops keep their handler |
| Workspace name in ghost URL | Local only, query-encoded, `textContent`, no IPC, no capability |
| Default-on multiwindow reaches users unverified | Condition on checklist pass; kill switch in Settings; existing merge-on-off behaviour (windows.rs:1239) |
