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

## TN (terminal noise)

- [ ] New Claude pane opens in Chat; the folder trust prompt is reachable via "Switch to Terminal".
- [ ] Focus mode pane: permission prompt and an AskUserQuestion dialog are still visible in Claude's focus view.
- [ ] Never run through pwsh yet (agent sandbox blocked it): a Claude pane launches with `--settings '<app-data>\claude-view\claude-view-focus.json'`; also with the setup wrapper on (double quoting). Quick check from a plain PowerShell window: `pwsh -NoProfile -Command "claude --settings '<that path>' --version"` prints the version.
- [ ] Focus pane: Ctrl+O shows the full transcript; `/focus off` inside the pane still works.
- [ ] After `/focus` in one pane, a classic pane still shows full output.
- [ ] `<app-data>\claude-view\` holds the two files; nothing under `~/.claude` changed.
