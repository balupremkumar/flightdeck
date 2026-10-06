# 0.6.1 Canary: terminal back + agent-driven checklist sweep (plan, 2026-10-06)

Approved by Balu 2026-10-06.
Branch: `qol/terminal-back`.
Checklist under test: [release-0.6.0-checklist.md](release-0.6.0-checklist.md).

## Decisions

- Claude panes open in the terminal again; "Open Claude panes in" is Terminal / Quiet terminal (Claude focus view) / Chat (done, 3 commits).
- Default is Quiet terminal, chosen by Balu 2026-10-06. Any pane switches from its menu ("Quiet terminal" checkbox) and the restart resumes the same conversation (branch `qol/quiet-default`).
- Settings > Agents "Extra CLI flags" and "binary path override" are saved but never passed to the agent; fix backlogged (BACKLOG B, K9).
- Test panes run the cheapest models: Claude Haiku, the cheapest Codex model on the ChatGPT plan.
- Usage chips (Claude and Codex) pass when close to accurate, not exact.
- PR/CI chip items are skipped (no throwaway PR approved).
- Ships as 0.6.1; stable 0.6.0 never goes out with Chat as default.

## Hard rules (Balu is working live in stable 0.5.4 and Power Platform)

- Never run the stable installer, never install an update in stable, never kill a process this sweep did not start.
- Canary only: built with `--no-bundle` into `src-tauri/target-canary` until the final cut, so `latest.json` is untouched and stable shows no banner until then.
- Canary is launched outside this pane's process tree, with the remote-debugging env set on that process only, and moved off-screen at once; all input goes through CDP, never the real mouse, keyboard or SetForegroundWindow.
- Canary sound and notifications muted except for the checks that test them.
- No Flightdeck hooks installed into `~/.claude` from Canary; `~/.claude/settings.json` and `~/.claude.json` hashed before and after; `/focus` reset after its check.
- Heavy work (Rust builds, 10+ pane runs) at below-normal priority.
- Intrusive checks (clipboard, multi-window, Canary + stable together) wait for Balu to say he is away.

## Harness (`e2e/live/`)

- `launch.mjs`: start the Canary exe via CIM `Win32_Process.Create` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`, wait for the port, move the window off-screen, apply test settings (mute, agent flags for cheap models).
- `drive.mjs`: Playwright `connectOverCDP`, helpers for panes, palette, settings, screenshots, `__TAURI_INTERNALS__.invoke`.
- One script per checklist section, each writing `results/<date>/<section>.json` and screenshots.
- `teardown.mjs`: stops only the Canary PID it launched and its pane tree.

## Waves

1. W0: decided, Quiet terminal is the default (Balu 2026-10-06); no screenshot comparison needed.
2. W1, non-intrusive: reload/reattach, restart x20, missing exe, 50 KB paste, TUI memory, TN focus view, Chat, Home, themes and colour files, regression pane id, red team H1/M2/M3/L2, viewers (PDF, images), 10+ WebGL panes, health (fake MCP server for disconnect/elicitation, scripted OSC 9;4), port chip, session search.
3. W2, Codex: trust prompt in a fresh worktree, usage chip vs `/status`, resume.
4. W3, intrusive (Balu away): copy/paste, multi-window block, Canary and stable at once (stable agent PIDs before and after).
5. W4, Balu only: real fullscreen game focus, sleep, cross-DPI drag.

## Failure loop

Triage (Haiku) -> fix on its own branch: TypeScript fixes to Codex `sol` (disjoint files, never the Claude-owned shared files), Rust or shared-file fixes to a Sonnet teammate -> cross-vendor review -> gates -> re-run the failed check.

## Exit

All W1-W3 items pass or carry an accepted reason; checklist ticked with evidence paths; `release.ps1 -Version 0.6.1` cut; Balu installs Canary 0.6.1, then stable.
