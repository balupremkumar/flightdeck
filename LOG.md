# Flightdeck session log

Append-only session history.
STATE.md stays the dashboard; older "Superseded" blocks there predate this file.

## 2026-08-14 — Docker panel planning session (no code)

Balu asked for the latest and whether VS Code-style Docker functionality exists or could be added.
Findings: zero Docker code in the repo; the v1 spec's "no Docker" ruling (flightdeck-build-plan.md:221) rejected containers as an agent sandbox only, so a container manager panel doesn't reverse it.
Scoped with Balu: container manager panel (list, start/stop/restart/remove, logs, shell-into-container).
Explored extension points (Explorer.tsx panel pattern, gitstatus.rs shell-out pattern, VendorAdapter registry) and wrote a full implementation plan: parameterized vendor ids `docker-exec:<ref>`/`docker-logs:<ref>` through `vendors::find()` so logs and shells are ordinary panes; bounded docker CLI calls through a new docker.rs; five-state panel UI; ~26 new tests; E2E checklist.
Balu approved the plan then parked it: filed as BACKLOG.md DK-1, full plan checked in at `docs/plans/docker-panel-dk1.md`.
No code changed. STATE.md's standing next steps (0.5.4 verify list, cut 0.5.5 as the first real in-app updater test) are untouched.

## 2026-09-19 — Lag root cause + fix, full roadmap

Balu reported the app going stuttery whenever the Antigravity pane was in use.
Reproduced against the live 0.5.4 with a WM_NULL main-thread probe (30 s cadence stalls) and against a canary dev build with a WebView2 remote-debugging probe (a trivial invoke waited 13.3 s behind git_diff_summary).
Cause: all Tauri commands were sync, so they ran on the main thread; the Tappy worktree's diff summary takes 11-14 s because git re-inflates 8.5 GB of committed PNGs per numstat.
Fixed by marking the read-only pollers `(async)`, bounding the summary with core.bigFileThreshold=4m and --no-renames, and stretching the poll cache TTL for slow calls. Verified: 2-3 ms invokes while the diff runs, diff 3.4 s.
Agy itself was working (generating Tappy images: 10-50% CPU, 3.5 MB/s reads), which is legitimate and unrelated.
Roadmap written from the Idea Ledger (daily AI Pulse routine), BACKLOG sections A/I/K/DK-1 and the review findings: BACKLOG.md section N.
Uncommitted at session end; Balu to review, commit and cut 0.5.5.

## 2026-10-04 night: Phase 6 + TN merged to main
Resumed the QoL run. TN (terminal noise) built: Chat default for Claude panes, one activity line per burst of tool work with narration folded in (real busy turn 16 -> 4 rows), subagent lines, per-turn change row, Focus mode turns on Claude's focus view via a Flightdeck-owned --settings file.
Phase 6 finished: Settings search, all-projects regex session search, MCP health chip, hook-driven permission state, OSC 9;4 busy, copy-on-select and right-click paste, Claude theme match, Catppuccin, queued-prompt chip, port and PR/CI chips.
Phase 4 S1-S3 (ring, reattach after reload, reaper) merged with Fable red-team fixes (unbounded ring on LF-free TUIs, wrong-agent attach, poison-tolerant locks).
Phase 6 Fable red team: 4 should-fix (dead busy signal, right-click paste could answer a permission prompt, dead right-click on classic Claude panes, sticky MCP chip), all fixed; design critique 13 fixes applied.
Flakes fixed: Vite watched .claude/ agent worktrees (mid-test reloads); preview-split fixed sleep.
Rulings: subagents on explicit cheap models; red team Sonnet per phase, one Fable before release; side-chat parked (BACKLOG NH1); report and stop after each phase.
main af0412d..4d50752 pushed. Gate: tsc 0, vitest 1339, cargo 364, build OK, 13 e2e PASS. Resume: docs/plans/RESUME-2026-10-05.md.

## 2026-10-06: v0.6.0 cut and shipped
Balu ran release.ps1 for 0.6.0; all gates passed and both installers (stable + Canary) landed in releases\ with latest.json.
Version bump committed (6168417), tagged v0.6.0, main and tag pushed.
Balu installed Canary 0.6.0; first look clean. Next: the hand checklist (docs/plans/release-0.6.0-checklist.md), then stable.

## 2026-10-06 (afternoon to night): 0.6.1 Canary rework
- Balu rejected 0.6.0's Chat default (terminal hidden). Rulings: Quiet terminal default, switchable in Settings and per pane; workspace drag-out/drag-back in 0.6.1 with multiple windows on by default; CLI flags wiring backlogged (K9).
- Built on qol/rel-061: terminal-back, quiet-default (switch resumes the session), sound toggle (Codex), drag-out D1-D6 + D8 (Rust core Sonnet, rail drag Codex, ghost Sonnet), Reopen-session fix (null title/draft, 0.6.0 regression from RT-060 M3), agent pane titles (Codex), natural exit detection (ptyexit.rs, pre-0.6.0 bug).
- Live harness e2e/live/ drives a real Canary via WebView2 CDP, launched off-screen with FLIGHTDECK_HARNESS_NO_SHOW + WS_EX_NOACTIVATE and an fgwatch foreground guard; two ~1 s focus grabs in W1a traced to CDP input on panes, harness changed to synthetic events.
- Sweep: W0 done, W1a 7 PASS, W1b partial PASS (reopen, Quiet defaults, per-pane switch). Resume: docs/plans/RESUME-2026-10-07.md.

## 2026-10-06 (afternoon, Balu away): 0.6.1 live sweep continued
Rebuilt the Canary from rel-061; gate re-run.
W1b-B3 Quiet prompts PASS by evidence; W1c exit 9/9.
Scripted drag (W3) found that a workspace dropped into another window vanished: every window heard `win://adopt` (global `listen()` targets Any) and the source acked first. Fixed with `listenHere()` (138d2e3); the same scoping applied to focus-pane, summon and flush.
Restore found two more: Cancel on "Reopen last session?" still recreated secondary windows (71828c1), and a reload or quit while the prompt was open erased main's saved workspaces, already true in 0.6.0 (fcaf53d).
Fable red team on the 0.6.1 delta: H1 (Quiet switch could resume another process's conversation) and M1 (exited pane switch started fresh), fixed in b8cf0db; four lows written up.
AdoptQueue ack now has e2e (5951389).
Final: tsc 0, vitest 1556, cargo 482, e2e 22/22; live W3 drag 19/19, windows 9/9, restore 15/15.
Incident: typing `/focus` in a Canary Claude pane wrote `briefTranscript: true` into the real `~/.claude.json`; the classifier blocked the fix and further Claude-pane live runs (brain risks 28). Balu to clear it.

## 2026-10-06 (17:30): Claude-pane checks resumed
Balu cleared briefTranscript. B3 re-run ALL PASS; B4 found the H1 fix left staged-arg panes unpinned and relied on a /clear record Claude 2.1.291 never writes; reworked (bb6c4c4) to follow the launch session_id stamped in the pane's own transcripts, then B4 ALL PASS live.
Antigravity copy, interrupt and lag investigated (docs/plans/antigravity-qol-findings.md); refined list in BACKLOG section AG.

## 2026-10-06 (18:10): live scripts finished by Claude
Three Codex Sol jobs for the remaining live scripts stopped on the repo's stop-on-any-failure rule without writing code (about 15% of the Codex window); discarded. Claude wrote and ran W1b-E (red team), W1c sweep, W1b-D (Home): all pass except Home offering Approve on a shell (y/n) prompt, put to Balu.

## 2026-10-06 (19:40): v0.6.1 cut
Balu ran the real-mouse drag checks (all pass, drag ships on); Home Approve limited to agent panes after a live check found Approve on a shell (y/n) prompt. main fast-forwarded to rel-061 (57444f5); release.ps1 -Version 0.6.1 passed every gate including the boot gate. Bump committed, tag v0.6.1 local; push waits for Balu.

## 2026-10-06 (20:00): session closed
v0.6.1 pushed (cb058df, tag v0.6.1). Balu installs stable 0.6.1 next session. Codex stop-rule investigation moves to a separate project via D:/Dev/ai/handovers/2026-10-06-codex-stop-rule-investigation.md (analytics added).

## 2026-10-07: 0.6.1 bug reports, sweep, UI clarity research (paused)
Balu on stable 0.6.1 reported the Quiet terminal wheel bug (K11) and a too-small pane header (K12); asked for chrome at ~120% with terminals at 100% (UC0) and a ~50-item UI simplification list.
K11 root-caused from code (alt screen + CLAUDE_CODE_DISABLE_MOUSE, xterm turns wheel into arrow keys) then live-confirmed on a --no-bundle 0.6.1 Canary build (installed Canary was still 0.5.4); PageUp/Ctrl+Home scroll Claude's transcript, so wheel-to-PageUp is the likely fix.
Sweep found K13-K16 (rename dblclick maximises, pane menu clips, Review omits untracked, one ~1 s focus grab). Research dossier research/flightdeck-ui-clarity-2026-10. UI audit agent told to wrap up at pause. No code changed.

## 2026-10-08: v0.6.2 (K11)
- Live probe on the 0.6.1 Canary: Claude in Quiet view parses SGR (and X10) wheel reports even with DISABLE_MOUSE, one line per report; PageUp scrolls about half a screen.
- d1a414a: Quiet panes send SGR wheel reports (3 lines per 120 px notch). f96c0a3: Terminal default again, one-off migration of a stored Quiet default. Verified live (e2e/live/k11-verify.mjs): 150 to 122 on wheel-up, draft intact, no History picker, migration and new-pane default PASS.
- Release run 1 failed at cargo test: the gate ran inside a Quiet pane and inherited CLAUDE_CODE_NO_FLICKER. Real bug (Terminal panes of a Flightdeck launched from a Quiet pane ran in alt screen); fixed 4417d7e. Run 2 passed every gate; v0.6.2 cut, 672cae6, tag local, not pushed.
- K12 header mock: docs/plans/k12-header-mock.html (design agent, critiqued). Ruling appended to brain/rulings.md (Terminal default again).
