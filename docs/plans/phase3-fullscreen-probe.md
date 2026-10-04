# Phase 3 probe: Claude Code fullscreen mode inside Flightdeck

Recommendation: NO-GO as a default, conditional GO as an opt-in per-pane toggle (default off) after a 30 minute live test.
Probe date 2026-10-04, claude 2.1.289, xterm.js 6.0.0. Nothing was run interactively, so every runtime claim below is from docs plus code reading.

## 1. How it is enabled, and per-process scoping
Setting `tui`: "fullscreen" or "classic" in settings.json, or `/tui fullscreen` (writes the setting and relaunches).
Env var `CLAUDE_CODE_NO_FLICKER=1` forces fullscreen, `CLAUDE_CODE_NO_FLICKER=0` or `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` forces classic.
Docs also list a per-session CLI flag `--tui fullscreen|classic` and `--view-mode focus|verbose|default`, but `claude --help` here does not show them, so verify before relying on them.
Env vars are the safest per-pane scope: Rust already sets TERM and COLORTERM per spawn (src-tauri/src/lib.rs ~143), so one more `cmd.env(...)` leaves ~/.claude untouched.
Precedence table in the docs: NO_FLICKER env beats the saved `tui` setting.
Risk: the default is fullscreen when the setting is unset and the account first used Claude Code on or after 2026-05-06, or the session does not fetch feature flags.
So a Flightdeck pane may already be in the alternate screen today; check this first (section 5, test 1).
If it is, the real work is a classic opt-out (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`), not an opt-in.
Focus view: `/focus` toggles and persists; `viewMode: "focus"` setting or `--view-mode focus` starts in it; it requires the fullscreen renderer.

## 2. What it gives, and mouse conflicts
Collapsed tool results, click a result to expand and click again to collapse, Ctrl+O transcript mode with `/` search, `[` dumps the full conversation to native scrollback, `v` opens it in $EDITOR.
`/focus` shows last prompt, one-line tool summaries with diffstats, and the final reply, which is the biggest clutter reduction.
`/diff` opens a side panel in fullscreen.
Flat memory, no flicker, fixed input box.
It captures the mouse (DECSET mouse tracking), so xterm.js stops doing native selection unless Shift is held.
Claude does its own selection and auto-copies on release (via PowerShell Set-Clipboard on Windows, so it spawns a process per copy).
Link opening is Ctrl-click, and Claude's own handler opens URLs and file paths itself.
Claude defers to the host terminal's link handler only in VS Code and similar xterm.js terminals, which it detects from the terminal identity (TERM_PROGRAM or XTVERSION).
Flightdeck sets no TERM_PROGRAM and xterm.js 6.0.0 has no XTVERSION reply (only DA1 and DA2 are registered in InputHandler.ts), so Claude cannot know it is inside xterm.js.
Expected result: Ctrl-click on a link fires both Claude's opener and Flightdeck's link provider (double open), and plain click on a result expands it.
A related double-open bug exists upstream for OSC 8 links: https://claudeissues.com/issue/76110-bug-ctrl-click-on-a-link-in-claude-codes-output-opens-2-duplicate-browser-tabs-x
Right-click: Flightdeck's capture-phase contextmenu handler (Terminal.tsx ~248) calls preventDefault and shows LinkMenu; right-click is not reported to Claude as a click action, so this likely still works, but the hover resolver reads buffer rows that will now hold TUI cells (see 3).
Mouse can be turned off with `CLAUDE_CODE_DISABLE_MOUSE=1` (keeps flicker-free render, loses click-to-expand, wheel and URL click) or `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` (keeps wheel, drops clicks).
Windows note from the docs: ConPTY hosts can leave stale fragments; `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` fixes it at higher output cost.

## 3. Flightdeck features that degrade on the alternate screen
xterm.js keeps no scrollback on the alt buffer (buffer.active becomes the alt buffer, baseY is 0).
TranscriptView (src/transcript.ts, reads term.buffer.active) would show only the current screenful, so it needs `buffer.normal` or a fallback, and even then the normal buffer holds only what ran before the TUI started.
Scrollback search (search addon) searches the active buffer, so it finds nothing beyond the visible screen; Claude's own Ctrl+O then `/` replaces it.
Scrollback restore via serialize addon (paneSessions.ts, session.ts) snapshots the active buffer; on restore the alt screen would be saved as one static screen and the next launch re-enters the TUI over it.
Park and unpark in paneSessions.ts keeps viewportY and atBottom, which are meaningless with no scrollback; harmless but unused.
OSC 133 command marks (Terminal.tsx ~998, nextMarkLine ~1034) are only emitted by shell integration, not by claude, so they are unaffected for agent panes.
Link provider (Terminal.tsx buildLinks, ~170 to 245) reads buffer rows: still works on visible rows, but TUI rows are cell-painted, so the `isWrapped` stitching and the Ink hard-wrap heuristic (hardWrapLink) are the wrong model, and links inside side panels or boxes will be mis-stitched.
Attention and permission detection (Terminal.tsx ~1308 to 1320, attention.ts PERMISSION_PATTERNS) reads the raw output tail (outTail with ANSI stripped), not the buffer; the incremental cell-diff writes of fullscreen mode fragment that tail, so "Do you want to" may arrive split by cursor moves and be missed, and the "last meaningful line" becomes noise.
This is the highest-risk item because a missed permission prompt means an agent silently blocks.
OSC 9;4 progress parsing (~1300) is unaffected if Claude still emits it (setting `terminalProgressBarEnabled`).
Selection and copy: native xterm selection and Flightdeck copy shortcuts need Shift-drag; Claude copies by its own path.
Wheel scrolling goes to Claude, not xterm, so Flightdeck's scroll-to-bottom button and sticky-scroll logic (~1099, ~1225) do nothing useful.
Resize: fullscreen redraws on SIGWINCH-equivalent resize; Flightdeck's park-at-last-rect trick avoids spurious resizes and should be fine.

## 4. Go / no-go and smallest safe implementation
No-go as a default: attention detection, transcript, search and restore all rely on classic output shape.
Conditional go for an opt-in toggle, because /focus and click-to-expand are real clutter wins.
Smallest safe implementation:
1. Per-pane flag `claudeFocus` (default false) in the pane model, shown as a pane menu toggle "Claude focus mode (relaunch)".
2. On relaunch, Rust adds `CLAUDE_CODE_NO_FLICKER=1` and `CLAUDE_CODE_DISABLE_MOUSE=1` to the spawn env, plus `--view-mode focus` only if the flag is confirmed to exist in `claude --help` on the installed version.
3. For all other panes always set `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, so a Claude default flip to fullscreen can never silently break classic panes.
4. Set `TERM_PROGRAM=vscode`-style identification is NOT recommended (it makes Claude defer links but also changes other behaviour); prefer mouse disabled, which removes the double-open and selection conflicts entirely.
5. In focus panes, suppress or mark as unreliable: TranscriptView, scrollback restore (do not serialize the alt buffer), and link hover; keep attention detection on but add a buffer-text fallback that scans the visible alt-screen rows for PERMISSION_PATTERNS.
Cost: with mouse off the user loses click-to-expand and wheel, keeping Ctrl+O, /focus and PgUp/PgDn.

## 5. What to test
1. Launch a plain pane today and read `/tui` output to learn which renderer is the current default; also run it with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`.
2. Permission prompt detection: trigger a Bash permission prompt in a focus pane and confirm the attention queue flips to "permission" within the quiet timer, on 3 prompt shapes.
3. Ctrl-click a URL and a file path with mouse on: count browser tabs and editor opens (expect double).
4. Right-click a path in a Claude message: LinkMenu appears, no Claude side effect.
5. Shift-drag selection and Ctrl+C copy, then Claude's own selection copy: no clipboard stall.
6. Park and unpark a focus pane, restart the app, confirm no garbled restore.
7. Resize, split and zoom the pane with the WebGL renderer: no stale fragments (try `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` if so).
8. TranscriptView, scrollback search and OSC 9;4 progress in a focus pane: record which are blank.

## Sources
https://code.claude.com/docs/en/fullscreen
https://code.claude.com/docs/en/settings-reference (tui, viewMode, `--tui`, `--view-mode`)
https://code.claude.com/docs/en/terminal-config
https://claudeissues.com/issue/76110-bug-ctrl-click-on-a-link-in-claude-codes-output-opens-2-duplicate-browser-tabs-x
Local: node_modules/@xterm/xterm/src/common/InputHandler.ts (DA1 and DA2 only, no XTVERSION).
