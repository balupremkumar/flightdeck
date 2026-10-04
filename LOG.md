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
