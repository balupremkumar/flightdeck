# Flightdeck 0.6.0 release notes (draft)

## Reload and restore

- Reloading the window (Ctrl+R) reattaches running panes instead of restarting them.
- After a reload, a pane's scrollback history is the last 4 MiB.
- Broadcast, Review "send to agent" and palette "New task" now reach the right pane after a restore.

## Multiple windows (preview)

- Workspaces can live in their own windows. It is a preview behind a setting: Settings > Windows > "Multiple windows (preview)", off by default, takes effect after a restart.
- A hung window is detected and its workspaces return to the main window.

## Chat view

- New Claude panes open in Chat by default, with a setting to open in the terminal instead.
- Normal detail folds tool steps into one activity line; Verbose shows everything.
- Subagents show as one line each.
- Each turn has a change row with total lines added and removed; click it to open Review.
- A message sent while Claude is working shows as queued and clears when Claude picks it up.
- Claude panes use focus view settings supplied by Flightdeck.

## Health and attention

- Permission requests and MCP input requests ring the bell straight away when hooks are installed.
- An MCP server that disconnects shows a chip on that pane.
- Long commands that report progress (winget, builds) stay "running" instead of flipping to "waiting".
- Dev servers started in a pane show a port chip, with a button to stop them.
- A PR chip shows CI status, with one toast when checks finish. It stays hidden when gh is missing.

## Terminal

- Copy on select, and right-click to copy or paste, with settings for both.
- Right-click on an agent pane that has a pending prompt asks before pasting.
- Shift+right-click opens the pane menu when an app has taken the mouse.

## Settings and themes

- Settings has a search box across every setting.
- Catppuccin Mocha theme preset.
- Optional "Match Claude's colours" so Claude's diff colours follow the app theme, with a colour-blind-safe variant.
- Chat detail and where Claude panes open are set under Agents.

## Sessions

- Session search covers all projects, with regex.
- Resuming from an all-projects result checks the folder still exists.

## Fixes

- Pane header keeps its branch label at narrow widths.
- Right-click paste and MCP notices no longer misfire on prompts and TUI borders.

Hand checks: docs/plans/release-0.6.0-checklist.md
