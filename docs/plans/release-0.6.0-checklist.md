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
- [ ] A long command that prints progress (winget, a build showing a taskbar progress bar) keeps the pane "running", not "waiting".

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
- [ ] Catppuccin Mocha looks right in the theme picker.
- [ ] Chat pane mid-turn: type and press Enter: "1 queued" shows and clears only when Claude picks the prompt up (not straight away).
- [ ] Chat pane mid-turn while a permission prompt is just appearing: the queued text does not answer the prompt.
- [ ] `npm run dev` in a pane: "localhost:5173 · node" chip within about 10 s; click opens the browser; × confirms, stops it, chip goes.
- [ ] A port opened outside the panes never shows a chip.
- [ ] Branch with a PR and running CI: chip says "checks running"; when CI ends exactly one toast, no bell.
- [ ] No gh, logged out, or no PR: no chip, no error.
- [ ] Long workspace name plus several ports: the topbar chip row clips cleanly.

## Phase 6 copy and paste (H2)

- [ ] Select text in a pane, paste in Notepad: it matches.
- [ ] Right-click with no selection pastes; with a selection it copies and clears it.
- [ ] Multi-line clipboard on right-click shows the confirm dialog.
- [ ] vim with mouse on, or htop: right-click goes to the app; Shift+right-click opens the pane menu.
- [ ] UI size not 100%: dragging a selection still lands on the dragged cells.
- [ ] Settings > Right-click: Menu behaves exactly as before.

## TN (terminal noise)

- [ ] New Claude pane opens in Chat; the folder trust prompt is reachable via "Switch to Terminal".
- [ ] Focus mode pane: permission prompt and an AskUserQuestion dialog are still visible in Claude's focus view.
- [ ] Never run through pwsh yet (agent sandbox blocked it): a Claude pane launches with `--settings '<app-data>\claude-view\claude-view-focus.json'`; also with the setup wrapper on (double quoting). Quick check from a plain PowerShell window: `pwsh -NoProfile -Command "claude --settings '<that path>' --version"` prints the version.
- [ ] Focus pane: Ctrl+O shows the full transcript; `/focus off` inside the pane still works.
- [ ] After `/focus` in one pane, a classic pane still shows full output.
- [ ] `<app-data>\claude-view\` holds the two files; nothing under `~/.claude` changed.
