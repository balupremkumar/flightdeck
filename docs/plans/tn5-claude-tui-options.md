# TN5: Claude Code options that quieten the interactive TUI

Research for the terminal-noise run (see [tn-terminal-noise.md](tn-terminal-noise.md)).
Target: Claude Code 2.1.289 (native build at `C:\Users\User\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`), researched 4 October 2026.
Read-only research; no Claude settings were changed.

## Answer

The only Claude-side switch that actually collapses tool output is **focus view** (`viewMode: "focus"`, or `/focus` inside a session).
It shows your last prompt, a one-line summary of the turn's tool calls with edit diffstats (`+12 -3`), and the final reply, so full Edit diffs and per-step tool lines disappear.
It only works in the fullscreen renderer, which Flightdeck's "Focus mode" already turns on (`CLAUDE_CODE_NO_FLICKER=1`).
So today Flightdeck's Focus mode gives the fullscreen renderer but not focus view; adding `--settings <file>` with `{"viewMode":"focus"}` to that launch closes the gap.

In the classic renderer there is no setting that collapses Edit diffs.
`verbose: false` (the default, and what `~/.claude/settings.json` already has) is as quiet as classic gets.

## How Flightdeck launches Claude today

`vendors.rs:561-568` builds `pwsh.exe -NoLogo -NoProfile -Command claude`, and `lib.rs:135-140` appends the session args (`--session-id <uuid>`, or staged `--resume`/`--fork-session`).
`lib.rs:162-166` adds the env from `chatlog::claude_env(focus_mode)` (`chatlog.rs:39-45`):

| Pane mode | Env set |
| :- | :- |
| Default | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (classic renderer, native xterm scrollback) |
| Focus mode | `CLAUDE_CODE_NO_FLICKER=1`, `CLAUDE_CODE_DISABLE_MOUSE=1` (fullscreen renderer, no mouse capture) |

No `--settings`, `--verbose` or output-style options are passed.
The pane menu item is `PaneView.tsx:1204-1206` ("Focus mode (Claude fullscreen)"), toggled through `toggleFocusMode` at `PaneView.tsx:721-730`, which restarts the pane.

## Options found

Every option below was checked against the installed binary (settings schema and code strings) as well as the official docs.

| Option | Per-launch | Visible effect | Since | Risk |
| :- | :- | :- | :- | :- |
| `viewMode: "focus"` (setting) | `--settings <file>` with `{"viewMode":"focus"}`; no env var or dedicated flag exists | Prompt, one-line tool summary with edit diffstats, final reply. Full detail via `Ctrl+O` | Focus view 2.1.97, `/focus` 2.1.110, `viewMode` key present in 2.1.289 (changelog does not name the version) | Needs fullscreen. Also adds a system-prompt note telling Claude you only see its final message, so it stops narrating mid-turn and puts everything in the closing reply. Permission prompts are dialogs, not transcript rows, so they still show (confirm in a canary pane) |
| `/focus [on\|off]` (slash command) | Typed in the pane | Same as above, toggled live | 2.1.110 | Sticky and global: it writes `briefTranscript` to `~/.claude.json`, so it leaks into every later fullscreen session that does not set `viewMode` |
| `tui: "fullscreen"` / `CLAUDE_CODE_NO_FLICKER=1` | Env (Flightdeck already does this for Focus mode) | Fixed input box, in-app scrolling, no flicker. Tool output unchanged | `NO_FLICKER` 2.1.89, `tui` and `/tui` 2.1.110 | Conversation lives in the alternate screen, so xterm scrollback and find do not see it (`Ctrl+O` then `[` dumps it to scrollback) |
| `verbose` (setting) / `--verbose` (flag) / `viewMode: "default"\|"verbose"` | `--verbose`, or `--settings` | `false` (default) collapses each tool call to a summary; `true` shows full tool input and output | Long-standing | None for `false`. Never pass `--verbose`: it is the noisy direction |
| `Ctrl+O` | Key | Toggles the transcript viewer (full detail). Since 2.1.110 it no longer toggles focus view | 2.1.110 behaviour | None. This is the "show me everything" escape hatch from focus view |
| `outputStyle: "Concise"` | `--settings` (no `--output-style` flag exists in 2.1.289) | Claude's prose leads with the result, drops narration and recaps. Tool output unchanged | Concise style 2.1.237 | Changes model behaviour, case-sensitive value (`Concise`) |
| `bashEditDiffEnabled: false` / `CLAUDE_CODE_BASH_EDIT_DIFF=0` | Env | Removes the diff printed after a Bash command that changed files (default on in auto and bypassPermissions modes) | 2.1.269 | PostToolUse Bash hooks also stop getting the changed-file list |
| `showThinkingSummaries` | `--settings` | Default (unset) already collapses thinking to a stub | 2.1.89 default change | None; leave unset |
| `spinnerTipsEnabled: false`, `showTurnDuration: false`, `prefersReducedMotion: true` | `--settings` | Hide spinner tips, the "Cooked for" line, shimmer and flash animation | Long-standing | None; small cosmetic gains only |
| `syntaxHighlightingDisabled: true` | `--settings` | Plain diffs and code blocks | Long-standing | Makes diffs harder to read; not a noise fix |
| `maxProseWidth` | `--settings` | Wraps prose narrower in wide panes | 2.1.282 | None; cosmetic |
| `--ax-screen-reader` / `CLAUDE_AX_SCREEN_READER=1` / `axScreenReader` | Flag or env | Flat text, no borders or animation; forces the classic renderer | 2.1.208 | Built for screen readers, changes key behaviour; not shorter |
| `--brief` / `CLAUDE_CODE_BRIEF` | Flag or env | Brief mode with a `SendUserMessage` tool (chat checkpoints view) | Undocumented | Entitlement-gated in the binary (`isBriefEntitled`); not usable here |
| `CLAUDE_CODE_INLINE_TOOLS` | Env | Undocumented, behind a server feature flag | n/a | Internal; do not depend on it |

Options that do **not** exist in 2.1.289, despite appearing in some summaries: `--view-mode`, `CLAUDE_CODE_VIEW_MODE`, `--tui`/`--no-tui`, `--output-style`.
`claude --help` lists none of them and the binary contains none of the strings.
`claude config` is no longer a subcommand (it falls through to the main help).

## Passing settings per launch

`--settings` accepts a file path or a JSON string, and sits above project and user settings in precedence (only managed settings beat it).
It applies to that process only and is never written back to `~/.claude/settings.json`.

Inline JSON does not survive Flightdeck's `pwsh -Command claude ...` wrapper.
Tested: passing `{"viewMode":"focus"}` through `pwsh -NoLogo -NoProfile -Command` fails with `ParserError: Unexpected token ':"focus"'`.
A file path passes cleanly: `pwsh -NoLogo -NoProfile -Command claude --settings <path>\focus.json --version` printed `2.1.289 (Claude Code)`.
A path containing spaces would split into two tokens inside `-Command`, so wrap it in single quotes as part of the arg (`'C:\path with space\focus.json'`) or keep the file under a space-free Flightdeck data folder.

## Recommendation

1. Make Flightdeck's Focus mode mean Claude's focus view, not just its renderer.
   Keep the existing env (`CLAUDE_CODE_NO_FLICKER=1`, `CLAUDE_CODE_DISABLE_MOUSE=1`) and add `--settings <flightdeck data dir>\claude-view-focus.json` containing `{"viewMode":"focus"}`.
   Wire it in `build_command` (`lib.rs:135-140`) next to `plan.extra_args`, driven by the same `focus_mode` bool, so `chatlog::claude_env` and the args stay in step; extend the `lib.rs:893-902` tests to assert the arg.
   Flightdeck writes the file itself at startup (idempotent), so nothing under `~/.claude` is touched.
2. Pin classic panes to `{"viewMode":"default"}` the same way.
   Without it, one `/focus` typed in any fullscreen pane sets the global `briefTranscript`, and classic panes then get the "user only sees your final message" system-prompt note while still printing everything.
   Pinning makes every pane deterministic regardless of what was typed elsewhere.
3. Optional second per-pane toggle, "Concise replies", adding `"outputStyle": "Concise"` to the same settings file.
   It trims Claude's prose, not tool output, so it complements focus view rather than replacing it; keep it opt-in because it changes model behaviour.
4. Do not expose `--verbose`, `--ax-screen-reader`, `--brief`, `CLAUDE_CODE_INLINE_TOOLS` or `syntaxHighlightingDisabled`.
   `CLAUDE_CODE_BASH_EDIT_DIFF=0` is safe but only matters in auto or bypassPermissions panes; leave it for later if Bash-edit diffs show up as noise.

Mouse trade-off: with `CLAUDE_CODE_DISABLE_MOUSE=1` the click-to-expand on a collapsed summary is gone, so `Ctrl+O` (full transcript viewer) is the way to drill in.
`CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` does not help, since it also turns clicks off.

Verify in a canary pane before release: a permission prompt and an `AskUserQuestion` dialog both appear in focus view, `Ctrl+O` opens the full transcript, and `/focus off` inside the pane still works (it updates the in-memory flag settings, so the `--settings` value does not lock it).

## Pane menu tooltip

The menu item at `PaneView.tsx:1204-1206` has no `title` today; other header elements use `title=` for hints.

If recommendation 1 ships (Focus mode = fullscreen renderer plus focus view):

> Quiet Claude view: just your prompt, a one-line summary of each turn's tool work with edit counts, and Claude's final reply. Ctrl+O shows the full transcript. Scroll with PgUp/PgDn. Restarts the pane.

The confirm body at `PaneView.tsx:726` should then read "...relaunches in its quiet focus view." rather than "...in its fullscreen renderer."

If Focus mode stays renderer-only, describe it honestly so it is not mistaken for Claude's focus view:

> Runs Claude in its fullscreen renderer: fixed input box, no flicker, scroll with PgUp/PgDn. Tool output is unchanged; type /focus inside Claude for the quiet view. Restarts the pane.

## Sources

- Local: `claude --help` (2.1.289), and strings in the installed `claude.exe` (settings schema entries for `viewMode`, `verbose`, `tui`, `bashEditDiffEnabled`, the `/focus` command, the focus-mode system-prompt note, and the embedded changelog for 2.1.282 to 2.1.287).
- [Fullscreen rendering](https://code.claude.com/docs/en/fullscreen) (renderer selection, `/focus`, `Ctrl+O` transcript mode, mouse env vars).
- [Settings reference](https://code.claude.com/docs/en/settings-reference) (`viewMode`, `verbose`, `tui`, `bashEditDiffEnabled`, `axScreenReader`, `maxProseWidth`).
- [Settings files and precedence](https://code.claude.com/docs/en/settings) (`--settings` sits below managed, above project and user).
- [Environment variables](https://code.claude.com/docs/en/env-vars) (`CLAUDE_CODE_NO_FLICKER`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_DISABLE_MOUSE`, `CLAUDE_CODE_DISABLE_MOUSE_CLICKS`, `CLAUDE_CODE_BASH_EDIT_DIFF`, `CLAUDE_AX_SCREEN_READER`).
- [Interactive mode](https://code.claude.com/docs/en/interactive-mode) (`Ctrl+O` transcript viewer).
- [Output styles](https://code.claude.com/docs/en/output-styles) (Concise style, v2.1.237).
- [Changelog](https://code.claude.com/docs/en/changelog) (2.1.89 `NO_FLICKER` and thinking summaries, 2.1.97 focus view, 2.1.110 `/focus`, `/tui` and `Ctrl+O` split, 2.1.121 `/focus` hint in classic, 2.1.208 screen reader mode, 2.1.269 `bashEditDiffEnabled`, 2.1.282 `maxProseWidth`).
