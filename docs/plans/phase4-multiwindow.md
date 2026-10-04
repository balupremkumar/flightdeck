# Phase 4: separate windows, merge back (architecture plan, 2026-10-04)

Source: [[projects/active/flightdeck/docs/plans/qol-roadmap-2026-10-04|QoL roadmap]] Phase 4 (D1-D3) and its locked decision "commands and monitor restore first, Chrome-style drag last".
Research: [[research/vscode-qol-for-flightdeck-2026-10/README|VS Code QoL scan]] section 5, [[research/flightdeck-competitor-qol-2026-10/README|competitor scan]] section 2.
Builds on [[projects/active/flightdeck/docs/plans/phase0-r1-terminal-registry|R1 terminal registry]] (`src/paneSessions.ts`).
Status: plan only, nothing built.

## Shape in one paragraph

The workspace is the unit that moves between windows (Windows Terminal model: content moves, the connection never does).
PTYs already live in Rust, so a window is just a view: moving a workspace re-points its panes' output at another webview and replays recent bytes from a Rust ring buffer.
Rust becomes the single authority for three things: which window owns which workspace, window geometry, and the merged session document it alone writes to disk.
Each window's zustand store stays the live, local truth for the workspaces it owns, and only those.
No workspace is ever owned by two windows, so there are no write conflicts to resolve.

## 1. Ownership model

Chosen: slice ownership. Each window owns a slice (its workspaces) and pushes it to Rust; Rust merges slices into one doc.
Rejected: a full replicated store with an op log in every window. It would force every store.ts action through Rust with conflict rules, a rewrite of the daily driver's core for no user-visible gain.

Rust state (new `src-tauri/src/windows.rs`, managed beside `Registry` at lib.rs:644):
- `WindowRegistry { windows: BTreeMap<label, WindowRec>, slices: HashMap<label, Slice>, next_label: u32, exiting: bool }`.
- `WindowRec { workspace_ids, active_ws, geom: Option<Geom>, booted, last_focus_ms }`.
- Label scheme: `main` (from tauri.conf.json:13-22, unlabelled so "main") plus `fw-<n>`, n allocated by Rust only and persisted so a restored window keeps its label. JS never invents a label; any label arriving from JS is validated against the registry.

Session document v2 (persist.rs:80-96): keep `workspaces` flat and add `#[serde(default)] windows: Vec<PersistedWindow { label, workspace_ids, active_workspace_id, geom }>`.
Rollback-safe by construction: an older build ignores `windows` (no deny_unknown_fields) and loads every workspace into one window, which is exactly a merge.
`uiPrefs` merge in Rust: `scrollback` object union (pane ids are global), `summary` concatenated, `groups` taken from main's slice.

Single writer:
- New async command `session_put_slice(window, slice)` replaces `save_session` (persist.rs:191, currently SYNC on the main thread writing up to 3 MB plus a snapshot per autosave; a latent stall of the 2026-09-19 class).
- Invariant: Rust accepts a slice's workspaces only if the registry assigns them to that label; anything else is dropped and logged. This is what stops a closing or stale window clobbering a workspace that has already moved.
- Rust debounces (800 ms, same as session.ts:257) and writes from a worker thread with the existing atomic write + snapshot.
- JS side: `startAutosave` (session.ts:256-288) keeps its diffing and scrollback cache but calls `session_put_slice`; `finalSave` on beforeunload/visibilitychange stays.

Ids: `wseq/pseq/gseq` are per-JS-context counters (store.ts:97-99), so two windows would mint colliding pane ids, and pane id keys paneSessions, scrollback, attention maps and now the Rust ring.
Fix: async `ids_reserve(count) -> start` hands out blocks of 1000 from one Rust high-water mark (initialised from the max id in session.json); the store draws from a local block and refills at half. `hydrate` (store.ts:328-340) reports its max id with `ids_bump(max)`.
Safety net: `pty_spawn` refuses a model id already mapped to a live pty and logs it.

localStorage (same-origin windows share it; WebView2 fires `storage` events across windows):
- Global, shared as today: every key in storageKeys.ts PREFERENCE_KEYS and SESSION_KEYS, plus `flightdeck-layout:`/`flightdeck-setup:` (repo-keyed, a repo's workspace lives in one window).
- Main-only writers: `flightdeck-clean-exit` (session.ts:403-427, `armCleanExitSentinel` runs only when `label === "main"`).
- Last-writer-wins UI keys, accepted: explorer open/width/expanded/scroll, ws-lastactive, uiscale. Wrong at worst on the next boot, never data loss.
- Rule: multi-window adds no localStorage keys except the flag; window state lives in the Rust doc.
- Live apply: Settings dispatches same-context events (`flightdeck-terminal-settings-changed`, memory ceiling, hooks); add one `storage` listener in main.tsx that re-dispatches them so other windows apply settings live.

Boot split in main.tsx:27-50 by `getCurrentWindow().label`:
- main: as today, plus `window_boot("main", { multiwindow })`, then `offerSessionRestore` (session.ts:431), worktree GC, clean-exit sentinel, update check.
- `fw-*`: `window_boot` returns its slice; hydrate it; never show the restore prompt, never run `runWorktreeGc` (worktrees.ts:255; it must read the merged doc, which it already does via `loadSession`), never the update check or what's-new banner.

## 2. PTY output routing

Chosen: one Tauri Channel per pane, passed into `pty_spawn` and swapped by `pty_attach`.
Rejected: `emit_to(label)` plus a routing table. It needs sequence numbers to make "replay then go live" gapless; a channel swap under the ring lock gets that for free, and a dead webview shows up as a failed send.

Contracts (lib.rs):
- `pty_spawn(model_id, gen, vendor, cwd, cols, rows, setup, on_event: Channel<PaneEvent>) -> u32` (stays sync so writes keep order, as STATE 2026-09-19 requires).
- `enum PaneEvent { Output { b64 }, State { state }, Proc { name }, Exit { crashed } }`, serde-tagged. Replaces the four global emits at lib.rs:207, 235, 248, 264, 278, 296 and the proc sampler at :611 (which looks up the pane's channel).
- `pty_attach(model_id, gen, on_event) -> Option<AttachInfo { pty_id, exited: Option<bool>, proc_name, cols, rows, prelude_b64, segments: Vec<{ cols, rows, b64 }> }>`, async. None means "no live pty for this model id with this gen": spawn instead.
- Base64 stays for v1 (same decode path as Terminal.tsx today); raw-bytes channel bodies are a later, measured optimisation.

Ring buffer (new `src-tauri/src/ring.rs`, pure, fully unit-tested):
- 4 MiB per pane (`RING_BYTES`, same order as outbuf.rs:23), allocated lazily; 8 panes cap at 32 MiB. Measure real Claude Code fill rate in S2 and retune.
- Fed in the flusher (lib.rs:288-302) and the exit drain (:246-248), under one per-pane `PaneOut` mutex that also holds the channel: push to ring then send. `pty_attach` snapshots the ring and swaps the channel under the same lock, so no byte is lost or duplicated.
- VT-safe cuts: a small scanner (ground / ESC / CSI / OSC / DCS-string states, UTF-8 aware) records "safe marks" at LF bytes seen in ground state. Trimming always advances to the next safe mark, so replay starts at a line start, outside any sequence.
- Head modes: as bytes are evicted, a second scanner applies them to a DEC private mode set (1049/1047/47 alt screen, 25 cursor, 1 DECCKM, 1000/1002/1003/1006 mouse, 1004 focus, 2004 bracketed paste). `prelude = ESC[0m + those modes`, so a trimmed alt-screen TUI still replays into the alt screen with mouse reporting correct (Claude Code needs mouse mode right or clicks become garbage input).
- Resize markers: `pty_resize` (lib.rs:378) records `(offset, cols, rows)` so replay happens at the widths the bytes were written for; bytes replayed at the wrong width wrap into nonsense.
- Exit keeps a tombstone: the reader's `panes.remove` (lib.rs:261) drops process handles but keeps `PaneOut` (ring + exit status) until `pty_kill`, so a pane that died while its window was gone still shows its last output.

New window, fresh xterm (paneSessions cannot cross JS contexts):
- `createSession` (Terminal.tsx:634) becomes attach-first: try `pty_attach`, else `pty_spawn` (:1400). The `earlyOut` buffer (:1356) goes away because the channel exists before the pty does.
- Replay: build the xterm at the ring's first segment size, write prelude then segments in chunks with write callbacks, applying each resize, while queueing live channel messages; then flush the queue, then fit to the container. The fit's normal `pty_resize` (:1457) makes ConPTY repaint and the agent redraw.
- Replay is written straight through like restored scrollback (:1348-1352), never through marks, bell or progress parsing. Only the last ~600 bytes prime `outTail` (:1269-1311), so a pane moved while asking permission still shows "permission".
- Resize nudge: only when the target size equals the source size AND head modes say alt screen (a full-screen TUI repaints without duplicating scrollback). Never for main-screen agents: a nudge makes Claude Code re-emit its frame into scrollback. Add a manual "Redraw" pane action that sends rows-1 then rows.
- serialize-addon stays what it is today: restart persistence only (session.ts:59-166). Rejected as the move mechanism because it needs the source webview alive and responsive, which is exactly what the crash path lacks.

Side benefit, shipped early (S4): attach-first means a webview reload (Ctrl+R, crash, HMR blowup) reattaches live agents instead of orphaning them. After a reload, ptys not claimed within 10 s of the restore prompt being declined are reaped by `pty_reap_unclaimed`.

Moving a workspace without killing: new `paneSessions.release(modelId)` tears down the xterm and listeners with no `pty_kill`.
Order matters: release every pane, THEN the new store action `detachWorkspace(id)`. The orphan sweep (paneSessions.ts:243-265) disposes, and disposing kills, any session whose pane has left the store. `adoptWorkspace(ws)` is additive hydrate without reconcile or cleanup funnels.

## 3. Window lifecycle

Create (`ws_transfer(ws_snapshot, target: New | Label)`, async):
- Async is mandatory: creating a window from a sync command deadlocks on Windows (Tauri docs; wry#583).
- `WebviewWindowBuilder::new(app, "fw-n", WebviewUrl::App("index.html"))` with tauri.conf.json's min size 940x620, `visible(false)`, drag-drop left at the default (LeftPanel.tsx:246 and NewWorkspace.tsx:284 depend on native folder drops); place, then `show()`. Focused only because the user just ran a command.
- Protocol: Rust assigns W to the target and stores the snapshot as pending; the source releases panes and detaches W; the target gets its slice from `window_boot` (new window) or a `win://adopt` emit_to (existing window).
- Boot watchdog: no `window_boot` from the new label within 15 s means destroy it and re-adopt W into main.
- Capabilities: default.json:5-7 becomes `["main", "fw-*"]`, so secondaries get the same permissions (set-title, progress bar, request attention, destroy, webview zoom). S0 proves the glob; a cargo test parses default.json and asserts the pattern so it cannot silently regress (a missing capability shows only at the boot gate, and the boot gate never opens a secondary).

Close a secondary (X, or the last workspace leaving it): Rust-driven merge, never a kill.
- `on_window_event` for `fw-*`: `CloseRequested` merges its workspaces into main via `win://adopt` using the last slice, then lets the close proceed; `Destroyed` without a prior merge (webview crashed or hung) does the same. Main's panes attach through the ring, so agents survive a dead secondary.
- Skipped when `exiting` is set. A secondary whose assignment becomes empty is destroyed by Rust, so a secondary never renders LauncherChrome (App.tsx:88).
- Last ~800 ms of UI-only edits in a crashed secondary are lost; PTYs and output are not.

Close main = quit the app (decision; promoting a secondary to main is a later option, not v1).
- Cockpit's quit guard (Cockpit.tsx:257-295) counts live panes across all windows from `win://summary`, then calls async `app_quit`.
- `app_quit` sets `exiting`, broadcasts `app://flush`, waits up to 1.5 s for slices, writes session.json, then `app.exit(0)`; `RunEvent::ExitRequested` (lib.rs:773) reaps as today.

Restore on launch (D2):
- Main boots first; `window_boot("main", { multiwindow })` tells Rust whether to recreate secondaries. Flag off with a v2 doc: every slice merges into main.
- Rust creates secondaries after main has hydrated, `focused(false)`, so launch never steals focus.
- Geometry: `Geom { monitor_name, monitor_rect_phys, scale, rect_logical (relative to monitor work area), maximized }`, tracked from Moved/Resized/ScaleChanged window events, debounced.
- Pure `place_window(saved, monitors, primary) -> Placement`: same name and size, else the monitor containing the saved centre, else primary; logical to physical at the target monitor's scale; clamp size to the work area and keep the title bar on-screen; maximise after placing.
- Main stays on tauri-plugin-window-state (lib.rs:634-643) untouched; `fw-*` excluded from the plugin (`with_filter` if the pinned version has it, else `skip_initial_state` per label).
- DPI change at runtime: each window listens to `onScaleChanged` and calls `api.remeasure()` on every attached session (paneSessions.ts:84).

## 4. Cross-window concerns

Attention, badge, title:
- Pane state stays computed in JS (Terminal.tsx:1316-1339). Each window sends async `attention_report { count, top: Option<{ kind_rank, since, ws_id, pane_id }> }` when its `needsHumanQueue` changes; attention.ts keeps the ranking, Rust only compares tuples.
- Rust sets the global count on EVERY window's overlay (`overlay::apply_all`, generalising overlay.rs:156), because Windows groups same-app buttons and shows whichever window's overlay it likes. Notifications.tsx:587-589 switches to the report.
- Window title (Cockpit.tsx:299-315) stays per-window counts plus the workspace names for `fw-*`. Taskbar progress stays per window.

Summon (summon.rs:70-90), one global chord:
- Dismiss if any Flightdeck window is focused: hide all visible ones and remember the set.
- Bring: show the remembered set (never un-minimise or show a window the user put away), `set_focus` the window holding the global top attention item (else last focused), `emit_to` it `app://summon { wsId, paneId }`. Notifications.tsx:641-653 uses the payload instead of local ranking.

Focus rules (fullscreen game on the main screen): `set_focus`/foreground only in direct response to the summon chord, a click or command inside Flightdeck, or a notification click. Never on attention, agent output, window restore or merge.
Notifications: they fire only from the owning window, so no duplicates by construction. Add `onclick` to the OS notification (Notifications.tsx:80) calling `window_focus_pane(label, wsId, paneId)`.
Bell: unchanged for local panes; add a footer row per other window ("2 need you in Window 2") that jumps there. Nothing replaces UX-601 rows.
Escape: each window mounts its own Cockpit, so "exactly one global Escape listener" (Cockpit.tsx:86, :232) holds per JS context with no change. Secondaries must not add another.
Command palette: local commands act on the current window; add "Move workspace to new window", "Move workspace to window...", "Merge all windows"; "Go to workspace" lists every window's workspaces from `win://summary` and focuses remotely via `window_focus_pane`.
Hook events (Notifications.tsx:452) stay broadcast; a window ignores panes it does not own.
Known v1 limits: Broadcast and pane groups reach only local panes (`sendToPane`, store.ts:113-126); "Move pane to workspace" lists local workspaces until S18.
Session-wide operations (named snapshots, export/import, restore points, `adoptSession` at session.ts:396) run "Merge all windows" first, then act in main on the merged doc.
Drag and drop: keep `dragDropEnabled` on (native folder drops). Tear-out is pointer-capture on the rail tile and pane header, replacing their HTML5 drags (LeftPanel.tsx:563, PaneView.tsx:840) so the two drag systems never fight on one element. The drop point comes from Rust `app.cursor_position()`, so no new JS capability is needed.

## 5. Steps (each 15-60 min, each leaves main shippable)

| # | Step | Tests |
|---|---|---|
| S0 | Spike on a throwaway branch: debug command opens `fw-1`; prove the capability glob, async window creation, shared localStorage + cross-window `storage` events, the Channel message shape in installed @tauri-apps/api, and that `focused(false)` does not steal focus. Notes appended here. | Real app only |
| S1 | `ring.rs`: push, safe-mark trim, head modes, resize markers, snapshot. Not wired. | cargo: cut never inside CSI/OSC/UTF-8, prelude restores alt + mouse, markers survive trim |
| S2 | `pty_spawn` takes `model_id, gen`; `by_model` map; `PaneOut` split with tombstone; ring fed from the flusher. Global emits unchanged. Debug command reports ring fill per pane. | cargo; e2e pane-smoke, reflow, draft, links |
| S3 | Per-pane Channel replaces the four `pty://*` emits; Terminal.tsx listeners and `earlyOut` removed; mock gains channel delivery. Riskiest infra step. | vitest; all e2e; boot gate; canary trial |
| S4 | `pty_attach` + attach-first factory + chunked replay + tail priming + `pty_reap_unclaimed`. Ships reload survival. | e2e new `reload-keeps-agents.mjs` (page.reload, no second spawn, output intact); real app: Ctrl+R on a live claude pane |
| S5 | `paneSessions.release`, store `detachWorkspace`/`adoptWorkspace`, release-before-detach order. | vitest: detach after release never calls pty_kill; sweep still disposes a genuine orphan |
| S6 | `ids_reserve`/`ids_bump` and the store id source. | cargo; vitest: two simulated contexts never collide |
| S7a | Doc v2 + `session_put_slice` + Rust merge, shadow mode: writes `session.v2.json` beside the unchanged `save_session` path. | cargo: merge, foreign-workspace rejection, v2 parses in a copy of the v1 struct |
| S7b | Flip: Rust writer primary, `save_session` kept one release for import paths; main-only gating of clean-exit, GC, restore prompt. | e2e draft-survives-restart; canary compares shadow vs primary first |
| S8 | `WindowRegistry`, `window_boot`, capability `fw-*` + cargo guard, flag `flightdeck-multiwindow` (PREFERENCE_KEYS, Settings > Windows "Multiple windows (preview)", default off). | storageKeys.test; cargo |
| S9 | D1a "Move workspace to new window": `ws_transfer`, secondary boot path, titles. | e2e two-page harness (below); real-app list |
| S10 | D1b close semantics: Rust merge on CloseRequested/Destroyed, boot watchdog, empty-window close, main close = quit-all, `app_quit` flush. | cargo; e2e: close page 2, workspace reappears in page 1 with output |
| S11 | D1c "Move to window...", "Merge all windows", `win://summary`, palette "Go to workspace", merge-first for snapshots/import/restore points. | CommandPalette.test; e2e |
| S12 | Attention report, overlay on all windows, multi-window summon, notification click-through, bell footer. | cargo: summon target + remembered set; vitest: report dedupe |
| S13 | `storage` listener re-dispatching live-apply events. | vitest; e2e: theme change in page 1 applies in page 2 |
| S14 | D2: geometry tracking, `place_window`, restore secondaries after main, plugin exclusion, scale-change remeasure. | cargo: unplugged monitor, DPI 100 to 150, off-screen clamp; real-app list |
| S15 | Flag default on, after Balu's canary trial of S9-S14. | Full gate + canary |
| S16 | D3 drag, pointer-capture on rail tile and pane header (in-window reorder keeps working). | e2e reflow-keeps-agents must still pass |
| S17 | D3 drop: Rust `window_drop()` reads the cursor, picks the target by window rects (most recently focused wins overlaps) or creates a window at the point. Own sub-flag, default off one release. | cargo hit-test; real app |
| S18 | D3 pane tear-out: `pane_transfer` into a new workspace (same root) in the target window. | vitest; e2e two-page |

Browser harness (S9 onward): the mock cannot open real windows, so `e2e/lib/multiwindow.mjs` runs the window registry, slices, ids and rings as a JS port of the Rust contracts in the Playwright Node process, exposed to every page with `context.exposeBinding("__fdBus")`.
Pages load with `?label=fw-1`; demo/mock-tauri-interactive.js (:672-696) sets `__TAURI_INTERNALS__.metadata.currentWindow.label` from it and routes window and pty commands through the bus. `ws_transfer(New)` makes the harness call `context.newPage()`.
Two pages in one context share localStorage, so the clobbering hazard is reproduced for real.
Browser-testable: transfer protocol, release-without-kill, replay and gaplessness, merge on close, id uniqueness, slice rejection, storage-event sync, palette scope.
Real-app checklist only (canary build): capabilities on `fw-*`, real window placement and DPI, monitor unplug, taskbar overlay, summon focus across windows with a fullscreen app on screen, Claude Code TUI replay fidelity (main screen and an alt-screen TUI), WebView2 crash (`taskkill` one msedgewebview2 renderer), drag outside the window.

## 6. Risks and rollback

Flag: `flightdeck-multiwindow` (S8) hides every command and stops restoring secondaries; turning it off at runtime runs "Merge all windows". Default off until S15; drag has its own sub-flag.
Infra steps (S2-S7) ship unflagged because they are invisible in one window and pay for themselves (reload survival, async saves). Each passes pane-smoke, the boot gate and a canary trial; Settings > About > Roll back is the escape hatch.
Rollback of data is safe: older builds read a v2 doc as one big window.

| Risk | Mitigation |
|---|---|
| S3 breaks the output hot path (every pane dark) | Own step, full e2e plus boot gate plus canary before stable; mock updated in the same commit |
| Release-before-detach order wrong: the orphan sweep kills moved agents | S5 vitest asserts no `pty_kill`; Rust logs any kill within 2 s of a transfer |
| Stale or closing window clobbers a moved workspace | Rust rejects slice data for workspaces not assigned to that label |
| Id collision across windows | Rust allocator; `pty_spawn` refuses a mapped model id |
| Ring too small for Claude Code redraw volume | S2 measures fill rate; `RING_BYTES` is one constant |
| Replay garbles a TUI | Prelude modes, resize markers, alt-screen nudge, manual Redraw |
| Missing capability on secondaries | Glob proven in S0, cargo guard on default.json, real-app list |
| Sync command stalls all panes | Every new command is `async` except `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill` |
| Focus stolen over a fullscreen game | Focus rules in section 4; launch restore uses `focused(false)` |

Half-done states: after S4 the app is single-window with reload survival; after S7b Rust writes the session; after S8 the flag exists with nothing behind it; S9 without S10 is the one unsafe pair (closing a secondary would orphan its agents until quit), so S9 and S10 merge to main together.
Out of scope, noted: single-instance plugin (a second launch today means two writers on session.json; worth a separate change), main-window promotion, per-window zoom, cross-window Broadcast.
Security: no new path inputs (cwd still passes pathguard in `pty_spawn`); labels are minted by Rust and validated; all windows share one origin and one capability, so no new trust boundary. Scrollback in the doc keeps the existing redaction.
