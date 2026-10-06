# 0.6.0 hand checklist (collected from each phase gate)

Real-app checks only Balu can do, on the Canary first.
Each phase's red team adds its items here; the final release note links this file.

## Carried from the resume note

- [ ] Phase 4 multi-window with the flag on.
- [ ] WebGL with 10+ panes.
- [ ] Single-instance focus while a fullscreen game is in front.
- [ ] PDF opens in the viewer (WebView2).
- [ ] Asset-protocol images render in Preview.
- [ ] Codex: trust prompt skipped in a fresh worktree, usage chip matches /status, resume works.

## Phase 4 S1-S3 (reattach after reload), from the red team

- [ ] Reload (Ctrl+R) with a Claude pane mid-stream: last 20 lines identical before and after, nothing doubled or missing.
- [ ] Resize the window, touch nothing, reload with an idle pwsh pane: the prompt is still visible.
- [ ] Reload with 10+ panes with long histories: no visible stall, memory steady.
- [ ] Run vim, lazygit or htop in a pane for 10 minutes: Flightdeck memory stays flat.
- [ ] Reload, pick the launcher, wait 10 s, open the same folder with the same agent: it starts fresh, not last session's agent.
- [ ] Restart one pane 20 times quickly: it never shows the old agent.
- [ ] A pane whose agent exe is missing, then reload: the pane shows the exit, not a stuck "running".
- [ ] Reload while an agent draws full-screen with mouse on: mouse clicks still reach the agent.
- [ ] Canary and stable open at once: neither kills the other's agents.
- [ ] Paste 50 KB into a pane: arrives in order.

## Phase 6 health (G2 MCP chip, G3 hook state, OSC 9;4)

- [ ] With Claude hooks on, a permission request rings the bell straight away (hook path, not the 3 s quiet timer).
- [ ] An MCP server that disconnects shows the MCP chip on that pane, tooltip names the server; it clears within 30 min.
- [ ] An MCP elicitation ("An MCP server needs your input") shows as needs-you.
- [x] A long command that prints progress (winget, a build showing a taskbar progress bar) keeps the pane "running", not "waiting". PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1c-sweep.json): OSC 9;4 with a 4 s silent stall stayed running in 16 of 16 samples.

## Phase 6 red team hand checks

- [ ] Hooks installed: a permission prompt still appears (relay never answers) and the delay before it is barely noticeable.
- [ ] Real MCP input dialog: the pane shows needs-you (the dialog's last line may be its options, not the prompt text).
- [ ] MCP disconnect chip clears when the pane restarts.
- [ ] A user `~/.claude/settings.json` viewMode does not override the pane's `--settings` view.
- [ ] `npm ci` in a pwsh pane with a 4 s+ stall: pane stays Running while the progress bar shows.
- [ ] Session search, All projects + regex `(`: error shown, no hang; `.*` returns within about 2 s.
- [ ] Chat Normal: Claude asks a short question then calls AskUserQuestion: the question is readable without expanding.
- [ ] Three subagent lines open, window minimised 30 s: no polling; close the pane while expanded: polling stops.
- [ ] Right-click a Focus pane sitting on a permission prompt with "1" on the clipboard: a confirm appears, nothing is answered.

## Phase 6 F3, H4, H6

- [ ] Settings > Appearance "Match Claude's colours" on, restart a Claude pane: `<app-data>\claude-view\claude-view-*-<theme>.json` exists and Claude's diff colours follow the app's light/dark; colour-blind-safe on gives the daltonized variant.
- [x] Catppuccin Mocha looks right in the theme picker. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1c-sweep-catppuccin.png): surfaces switch to #1E1E2E; a custom accent is kept by design.
- [ ] Chat pane mid-turn: type and press Enter: "1 queued" shows and clears only when Claude picks the prompt up (not straight away).
- [ ] Chat pane mid-turn while a permission prompt is just appearing: the queued text does not answer the prompt.
- [ ] `npm run dev` in a pane: "localhost:5173 · node" chip within about 10 s; click opens the browser; × confirms, stops it, chip goes.
- [x] A port opened outside the panes never shows a chip. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1c-sweep.json).
- [ ] Branch with a PR and running CI: chip says "checks running"; when CI ends exactly one toast, no bell.
- [ ] No gh, logged out, or no PR: no chip, no error.
- [ ] Long workspace name plus several ports: the topbar chip row clips cleanly.
- [ ] Match Claude's colours on, then colour-blind-safe on: the theme file is rewritten with the daltonized variant and Claude's diff colours change after a pane restart.
- [ ] Chat pane: the "queued" chip stays while Claude is mid-turn and clears only when Claude picks the prompt up.
- [x] Port chip appears for a dev server started in the pane, and the kill button stops that process. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1c-sweep.json): node server on :5197 in a pane, chip within 30 s, kill removed process and chip.
- [ ] PR chip toast fires exactly once when CI finishes.
- [ ] gh not installed: no PR chip and no error.

## Phase 6 copy and paste (H2)

- [ ] Select text in a pane, paste in Notepad: it matches.
- [ ] Right-click with no selection pastes; with a selection it copies and clears it.
- [ ] Multi-line clipboard on right-click shows the confirm dialog.
- [ ] vim with mouse on, or htop: right-click goes to the app; Shift+right-click opens the pane menu.
- [ ] UI size not 100%: dragging a selection still lands on the dragged cells.
- [ ] Settings > Right-click: Menu behaves exactly as before.

## TN (terminal noise)

- [ ] New Claude pane opens in Quiet terminal (focus mode on) by default; with Settings > Agents set to Terminal it opens in the full terminal, and set to Chat it opens in Chat and the folder trust prompt is reachable via "Switch to Terminal".
- [ ] Pane menu "Quiet terminal" checkbox switches a pane either way, after a turn has happened the restart reopens the same conversation (history visible, Chat view follows it), and a pane with no turn yet restarts plain.
- [x] Quiet terminal pane: permission prompt and an AskUserQuestion dialog are still visible in Claude's focus view. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-b3-prompts.json): Bash permission prompt with its options and AskUserQuestion option rows visible in Quiet; both declined with Esc.
- [ ] Never run through pwsh yet (agent sandbox blocked it): a Claude pane launches with `--settings '<app-data>\claude-view\claude-view-focus.json'`; also with the setup wrapper on (double quoting). Quick check from a plain PowerShell window: `pwsh -NoProfile -Command "claude --settings '<that path>' --version"` prints the version. PARTIAL live 2026-10-06: Quiet pane command line carries --settings '<app-data>claude-viewclaude-view-focus.json' (w1b-b1-defaults.json); plain PowerShell `claude --settings '<path>' --version` prints 2.1.290. Setup-wrapper variant not run (Claude panes paused, see resume note).
- [x] Focus pane: Ctrl+O shows the full transcript; `/focus off` inside the pane still works. PASS live 2026-10-06: Ctrl+O (w1b-b2-switch.json); /focus toggles focus view off in the pane (w1b-b3-prompts.json). Never type /focus on Balu's machine again: turning it ON writes briefTranscript into ~/.claude.json (brain risks 28).
- [x] After `/focus` in one pane, a classic pane still shows full output. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-b3-prompts.json): classic pane still shows "Read 1 file" after /focus in another pane.
- [ ] `<app-data>\claude-view\` holds the two files; nothing under `~/.claude` changed.

## Phase 4 multi-window (flag on by default since 0.6.1)

The flag is on unless Settings > Windows > "Multiple windows (preview)" was switched off and the app restarted.
With the flag off, none of these commands exist and the app behaves as one window.

- [x] Capability: a `fw-*` window can run panes, read files and use the dialogs (no "not allowed" errors in the console). PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-drag.json): fw-* windows run panes, no pageerror in any window.
- [ ] Window creation is async: opening a second window does not freeze the first or any pane.
- [x] Storage events: a setting changed in one window shows in the other without a reload. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-windows.json): accent changed in main applied in fw-1 without a reload.
- [ ] A secondary window restored at launch never steals focus (test with a fullscreen game in front).
- [x] Emit to a destroyed window: close a secondary while its agent is printing; no error, main keeps running. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-windows.json): fw-1 closed (WM_CLOSE) while its pwsh printed 300 lines; output reached line 300, same ptys, no pageerror.
- [x] Heartbeat: kill one `msedgewebview2` renderer of a secondary; within about 10 s its workspaces are back in main with agents alive. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-windows.json): secondary renderer crashed via CDP Page.crash; main survived, workspace back in main in 11 s, agent alive.
- [ ] Claude Code TUI replay on the main screen: move a workspace with a live Claude pane, the last 20 lines match and nothing is doubled.
- [ ] Claude Code TUI replay on the alt screen (vim, lazygit): the screen redraws cleanly after a move.
- [ ] Ctrl+R on a live Claude pane reattaches with its history (reload survival, works with the flag off too).
- [x] Move workspace to new window, then back: agents keep running, no restart, no duplicate panes. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-drag.json): out and back by drag, same pty ids, history intact, no duplicate panes.
- [x] Close a secondary window: its workspaces merge back into main. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-windows.json).
- [x] Close the main window: the whole app quits, secondaries included. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-windows.json): Quit confirm, process gone in about 1 s with its secondary.
- [ ] Taskbar badge reflects attention across all windows.
- [ ] Summon (Ctrl+Alt+F) reaches the right window, including with a fullscreen app on screen.
- [x] Turn the flag off and restart: every workspace is in main. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-windows.json).
- [ ] Taskbar badge shows the same number on both windows.
- [ ] The bell footer row jumps to the pane in window 2.
- [ ] Click an OS toast: the right window and pane take focus.
- [ ] With a fullscreen game up, nothing steals focus on attention, output or launch restore.
- [ ] Summon lands on the global top pane.
- [ ] Drag a window across monitors with different DPI: terminals remeasure.
- [ ] A secondary reopens at its saved size and position on launch.
- [ ] Flag off with a v2 session doc: everything opens in one window.
- [ ] Sleep the PC for 30 s with two windows open: neither window is closed on wake.

## Phase 5 Home

- [x] Ctrl+Shift+H opens Home, as does the button beside the bell and the palette entry "Open Home". PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-d-home.json): titlebar button and palette "Open Home" (shortcut covered by e2e/home.mjs).
- [x] The Home count matches the bell count. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-d-home.json): 2 and 2.
- [x] Cards sit in the right columns (Needs you, Working, Ready to review, Idle, Merged). PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-d-home.json): Claude permission and pwsh y/n in Needs you, idle Claude with a diff in Ready to review.
- [x] Peek (Space on a card) shows the last lines of that pane, including a pane not currently mounted. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-d-home.json): peek button shows the idle pane tail (Space key covered by e2e/home.mjs).
- [ ] Reply to a question lands in that pane only, also after restarting the pane.
- [x] Approve on a Claude permission prompt answers it; on an unfamiliar prompt only Open is offered. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-d-home.json): Approve answered a real Claude Bash prompt; a pwsh Read-Host (y/n) card offers only Open (Approve limited to agent panes, ruled by Balu 2026-10-06).
- [ ] Escape closes Home and keeps typed drafts; reopening restores them and focus returns to where it was.
- [x] At the 940 px minimum width the columns become stacked sections and nothing is clipped. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-d-home.json): stacked, 0 cards clipped.

## Regression: wrong pane id after a restore

- [x] After restoring a session (or restarting a pane), Broadcast, Review "send to agent" and palette "New task" all reach the right pane. PARTIAL live 2026-10-06 (e2e/live/results/2026-10-06/w1b-e-redteam.json): Broadcast after a restore reached exactly workspace A panes (logic check fixed after the run); Review send and palette New task not run live.
- [ ] Before the fix they used the saved id and wrote to the wrong pane or nowhere.

## 0.6.0 Fable red team fixes

- [x] H1, flag on: move a workspace to a second window, quit, relaunch with reopen, add a pane in main: the agent in the second window keeps running. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-e-redteam.json): after relaunch and Reopen a new pane in main left every pty alive; second window kept its pane.
- [x] M2/M3: paste a fake key (`sk-ant-api03-` plus 30 letters) into a Claude pane so it shows in colour, and type one into a pane's input without sending; quit; `session.json` and the newest `snapshots\*.json` hold `[REDACTED]`, not the key. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-e-redteam.json): printed and unsent keys absent from session.json and the newest snapshot, [REDACTED] present.
- [x] L2: in DevTools, `fetch(convertFileSrc("<home>\\.claude\\.credentials.json"))` fails (403), while a Claude transcript still opens in the viewer. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w1b-e-redteam.json): fs_read_text_file on .credentials.json returns denied-secret-file; repo file reads.

## 0.6.1 drag-out windows

Plan: docs/plans/drag-windows-d3.md section 6.
The scripted checks run on the Canary with `drag_debug_script` and do not touch the mouse; the OS-cursor checks need the real mouse and Balu away from other work (a real press moves the foreground).

Scripted (Canary, live, user mouse untouched):

- [x] Scripted tear to empty desktop opens a new window at that point with the workspace, agents still running, no restart. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-drag.json S1): window at cursor minus grab offset on DISPLAY3, same ptys.
- [ ] Scripted tear onto a second monitor point on a 150% monitor: window lands on that monitor at the right size, title bar on screen, window-state plugin does not move it. NOT RUN: all three monitors here are the same DPI (2560x1440 at x -2560, 0, 2560).
- [x] Scripted drop onto another Flightdeck window moves the workspace in, appended and active, and that window comes forward; output intact. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-drag.json S2/S4a). Was FAILING before 138d2e3: the source acked the target's win://adopt and the workspace vanished.
- [x] Scripted release back over the source, and a scripted Escape: nothing moves, ghost gone, no stuck hover outline. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-drag.json S3a/S3b).
- [x] Scripted drag of a secondary's only workspace to a new spot moves that window instead of recreating it; into another window it moves and the empty secondary closes. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-drag.json S4b/S4c).
- [x] Scripted drag of the only workspace of main: main shows the launcher and the whole window is a drop target. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-drag.json S2): launcher shown; "whole window is a drop target" not separately checked.
- [ ] Ghost: appears only after the 8 px tear, follows the point, flips its line between "new window", "move into this window" and "cancel", and is destroyed on drop, cancel, timeout and source close (no `drag-ghost` window left in the process). PARTIAL live 2026-10-06 (w3-drag.json): ghost visible while torn and while held, destroyed on drop, cancel and Escape; mode-line flips not asserted.
- [ ] Ghost focus: with fgwatch running, Canary never becomes foreground during a scripted drag, except the new or target window the drop opens. PARTIAL: foreground recorded (w3-drag-foreground.jsonl) but not asserted, because drops legitimately raise their window.
- [ ] A pane still starting: dragging its workspace out shows one toast, no ghost, nothing moves. NOT RUN.
- [x] Drag with Settings > Windows > "Drag workspaces between windows" off: the old rail drag runs and no ghost or drag_arm happens. PASS live 2026-10-06 (e2e/live/results/2026-10-06/w3-drag.json S5).

Real mouse (OS cursor):

- [x] Press, drag and release across the window edge with the real mouse: new window opens under the cursor. PASS 2026-10-06, Balu with the real mouse, recorded by e2e/live/w4-assist.mjs (e2e/live/results/2026-10-06/w3-assist.json).
- [x] Ghost is smooth, sits clear of the cursor, never flickers, never takes focus from the window you are in, and clicks fall through it. PASS 2026-10-06, Balu: looked right; ghost visible during the drag in e2e/live/results/2026-10-06/w3-assist.json.
- [ ] Release over a different app that overlaps a Flightdeck window: counts as desktop, a new window opens.
- [ ] Two monitors at different DPI (100% and 150% or 200%): ghost size, cursor offset and the new window size look right on both; the ghost flips away from the monitor edge.
- [x] Escape mid-drag cancels with the real mouse and nothing moves. PASS 2026-10-06, Balu with the real mouse, recorded by e2e/live/w4-assist.mjs (e2e/live/results/2026-10-06/w3-assist.json).
- [ ] Explorer folder dragged onto the rail still creates a workspace.
- [x] Plain click on a tile still opens the workspace after the drag change; a short wiggle (under 4 px) is a click, not a drag. PASS 2026-10-06, Balu with the real mouse, recorded by e2e/live/w4-assist.mjs (e2e/live/results/2026-10-06/w3-assist.json).
- [x] Rail reorder by dragging inside the window works with the real mouse (it may never have worked with the old HTML5 drag, see below). PASS 2026-10-06, Balu with the real mouse, recorded by e2e/live/w4-assist.mjs (e2e/live/results/2026-10-06/w3-assist.json).
- [ ] Multiple windows on by default: a fresh profile (no `flightdeck-multiwindow` key) shows the window commands and drag without visiting Settings; switching it off and restarting returns to one window.

Possibly dead HTML5 drag (D0 finding):

- [ ] Drag a pane header onto another pane or a rail tile with the real mouse and record whether it ever works. wry keeps its own drag-drop handler on Windows (`dragDropEnabled` is on in tauri.conf.json), which blocks HTML5 drag and drop, so pane reorder and pane-to-tile drops may have been dead already. If dead, note it for a follow-up; do not fix in 0.6.1.
