# Flightdeck quality-of-life review, 2026-10-08

Scope: v0.6.2 (main at 672cae6), browser rig only (Vite on :1420 plus `demo/mock-tauri-interactive.js`), no app code changed, no installed Flightdeck touched.
Captured at 1920x1080 dark, 2560x1440 dark and 1920x1080 light.
Sizes below are computed-style values read from the DOM, not CSS source.
Screenshots: `docs/plans/qol-review-2026-10-08/` (name pattern `<surface>-<width>-<theme>.png`).
Rig: `C:\Users\User\AppData\Local\Temp\claude\D--Dev-ai-projects-active-flightdeck\d6514310-da4b-40d6-af14-22a30e1402fe\scratchpad\rig\` (`lib.mjs`, `shoot.mjs`, `data/measures-*.json`).

Builds on: `docs/plans/ui-audit-2026-10-07.md` (34 fixes, 24 critiques), `docs/plans/bug-sweep-2026-10-07.md` (U1 to U8), `docs/plans/k12-header-mock.html`, the three October research dossiers and the August market dossier.
Existing IDs are cited instead of duplicated.

## 1. Verdict

The app is functionally sound and the design system underneath it is good, but the chrome was built for a 10 px world and for a reviewer, not for someone who runs six agents and never reads a diff.
Nothing in the chrome is bigger than 14.5 px; the things Balu looks at most (branch, chips, badges, the needs-you pill) sit at 9 to 10.5 px with 17 to 22 px targets, and `--faint` text measures 4.17:1 on dark, under the AA floor.
Every surface carries facts for a reader who reviews (ctx tokens, model, sparkline, diff counts, Ready to review, Viewed checkboxes); for an agentic owner these are noise, and removing them is the biggest clarity win available, cheaper than any redesign.
Attention is routed by a 3 s silence timer, so idle shells and quiet agents light the rail amber and fill the feed, while the one thing that matters (the question being asked) is shown as its last line, not the question.
The next phase should be mostly subtraction plus a size floor, with three agent-first additions (truthful state from hooks, queued follow-ups, run summaries) that turn Home into the surface Balu actually lands on.

States seen (ui-states pass): Preview and the session picker have honest error states with a Retry ("This file isn't there any more"); Home, the bell and Quick open have empty states with a next step; the launcher's disabled Create button has no reason text; the pane grid has no loading state beyond the launching overlay; the Review drawer's empty state is plain text (audit 21).
Nothing animates that should not, and the Needs you pulse is the only motion in the chrome (review-animations pass: no findings beyond keeping the pulse on the badge rather than the text, as the K12 mock already says).

## 2. Ranked improvements

Size: S under half a day, M about a day, L multi-day.
`NEXT` marks the top 10 for the next phase; `BUG` marks a defect to fix in the next release regardless.
Evidence names a screenshot in the review folder or a `file:line`.

### Top bar

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR1 `NEXT` | Make the bar 48 px, text 15 px, glyphs 20 px, targets 36 px, and ship the chrome 120 percent default (UC0) with the terminal untouched | Balu: "the top bar is just too small"; measured 44 px bar, 13.5 px workspace name, 17 px glyphs in 32x30 targets, 11 px port chips, 10.5 px quota text | M | UC0, K8, K12, audit 15, research 4 and 9 | `topbar-1920-dark.png`, `App.css:94-98`, `quotagauge.css:1` |
| QR2 | Replace the two-row 5h/wk gauge with one text pill ("78% · resets 1h 54m") that opens a popover with both windows, reset times and the source; hide nothing, explain on click | 10.5 px text on a 54x4 px track with a native tooltip as the only explanation; Balu cannot tell what it means | S | audit 7 to 9 and 11 to 14, research 34 and 35 | `quota-1920-dark.png`, `quota-hover-1920-dark.png` (nothing visible on hover), `QuotaGauge.tsx:34`, `quota.ts:49-61` |
| QR3 | Label the right cluster at 1600 px and wider (Home, Needs you, Files, Broadcast) and move the theme toggle into Settings | Six unlabeled glyphs of equal weight; recognition over recall | S | audit 10, 12, 15, 18 | `topbar-right-1920-dark.png`, `Cockpit.tsx:420-454` |
| QR4 | Port chips and PR chip: 12.5 px text, 28 px tall, the port kill button 28 px, PR state as dot plus "#12 checks running" | Measured 11 px text and a 17x20 px kill target next to a 130 px open target | S | | `topbar-1920-dark.png`, `measures-2560-dark.json` (wsc-x 17x20) |
| QR5 | Settings glyph reads as a hamburger menu; use a gear with a label | Balu could not name what several top-bar glyphs do | S | audit 11 | `topbar-right-1920-dark.png` |
| QR6 | The "add a pane" glyph beside the workspace name: label it "+ Pane" and put its dropdown on the overlay stack (`useOverlayEsc`), it currently closes only on mouse-leave and ignores Escape | Unlabeled, and it breaks the project's own overlay rule (CLAUDE.md); during the rig it stayed open through the palette, quick open and Explorer | S | new bug, candidate K17 | `addpane-menu-1920-dark.png`, `Cockpit.tsx:400` (`onMouseLeave` only), measured `addpaneEscClosed=false` |
| QR7 | When the rail is expanded, drop the workspace name from the bar (it duplicates the highlighted rail row); keep it only in the collapsed rail state | Less chrome, no information lost | S | | `cockpit-4panes-1920-dark.png`, `cockpit-rail-collapsed-1920-dark.png` |

### Pane header

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR8 `NEXT` | Rebuild the 43 px header (measured: 12.5 px base, eleven items from grip to close) around four things: state word plus name, folder and branch, one primary action (Needs you pill when blocked), and Find / More / Close; ctx, model, sparkline, process and diff count leave the row by default (see section 3); this revises the K12 mock, which kept a Context gauge and a diff button | Balu reopened the header contents on 2026-10-08: ctx "doesn't mean anything to me", activity and last output "not needed", diffs never used | M | K12, UC, audit 1 to 6, research 14 to 23 | `paneheader-4panes-1920-dark.png`, `k12-header-mock.html` sections 2 and 4 |
| QR9 `BUG` | Fix the chip collision: at pane widths under about 560 px (three columns at 1920, or two columns at 110 percent zoom) the branch chip and the ctx chip render on top of each other | The fold rules in `panes.css:66-71` go by container width, but the chips' min-widths add up past the fold points; a 6-pane layout on a 1080p screen is unreadable today | S | new bug, candidate K18 | `paneheader-6panes-1920-dark.png`, `cockpit-6panes-1920-dark.png`, `zoom-hud-1920-dark.png` |
| QR10 | Replace the sparkline (it reads as a dotted text cursor "........ǀ") with a state word: Working, Idle 4m, Needs you | Balu named activity and last output as not needed; the widget is 11 px tall with a 9.5 px label | S | audit 5, research 18, K12 | `paneheader-4panes-1920-dark.png`, `panes.css:108-117` |
| QR11 | Remove the "63k ctx" and "opus 4.6" chips from the row; show them in a Details block at the top of the pane menu | Balu's words; 10 px mono chips with 6.6:1 contrast but no meaning to him | S | K12, audit 6 | `PaneView.tsx:1059,1091`, `paneheader-4panes-1920-dark.png` |
| QR12 | Terminal / Chat toggle: either a labelled segmented control at 28 px, or move Chat into the pane menu since Terminal is the default again | Measured 22x22 icon-only buttons; two glyphs after the diff count that Balu could not name | S | K12, audit 4 and 7, research 20 | `measures-2560-dark.json` (pview-toggle-btn 22x22), `panes.css:753` |
| QR13 | Type floor in the row: branch 10.5 px, chips 10 px, Needs you 9.5 px, vendor glyph letters 7 px inside a 16 px disc; raise to 12 px minimum, 13 px values, 20 px glyph | Windows 11 floor is 12 px regular; the glyph letters ("CL", "AN", "CO", "KI") are not readable at 7 px | S | K12, UC, audit 1 and 2, research 1 to 5 | `measures-2560-dark.json` (vglyph 7px, ptok 10px, branch-name 10.5px, pattn 9.5px), `panes.css:78-93` |
| QR14 | Needs you pill: the one filled amber element in the row, 28 px tall, 13 px bold, carrying the question on hover and opening Home on click; measured today 73x17 px at 9.5 px uppercase with an outline only | Von Restorff: the thing that needs Balu should be the loudest thing in the row; the K12 mock section 4 already has this right | S | K12 mock section 4, research 26 | `paneheader-waiting-1920-dark.png`, `panes.css:373-382` |
| QR15 | Split Close from Find / Maximise / More with a divider and 12 px of space; keep the confirm | Destructive action sits in a row of four identical 28 px glyphs | S | audit 6 | `paneheader-4panes-1920-dark.png` |
| QR16 | Double-clicking the pane name to rename also maximises the pane | Confirmed by the sweep; one real-mouse check still owed | S | K13 | `PaneView.tsx:912-917, 963` |
| QR17 | Pane menu: 21 items plus four inline controls in a 220 px column measured 936 px tall (29 px rows at 12 px), clipped on 1080p; group into View, Session, Folder, Danger, and move font size, ligatures, clipboard and quiet threshold to Settings | Hick's law; the menu is the only place several per-pane settings live | M | K14, audit 20, 26, 27 | `panemenu-clip-1920-dark.png`, `measures-1920-dark.json` (panemenu), `panes.css:222-235` |

### Side panel and rail

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR18 `NEXT` | Replace the rail badge cluster (amber "4" on the avatar, a grid glyph, coloured dots and counts at 9 to 11 px) with one line of words per workspace: "1 needs you · 3 working" | Balu cannot read what the badges mean; a count by state is what Superset and agent view converged on | M | audit 14, research 28, N2 family | `rail-1920-dark.png`, `LeftPanel.tsx:717-723`, `leftpanel.css` (lp-stat 11 px, lp-badge 10 px, needy badge 9 px) |
| QR19 | Stop counting idle shells and quiet agents as "waiting": in the mock all four acme-api panes go amber the moment they print a prompt, so the rail reads "4 waiting" when nothing needs Balu | The state comes from a 3 s silence timer (`Terminal.tsx:1543-1553`), not from the agent; it feeds the rail, the feed and Home | M | U2, N2.1, AG12 | `rail-1920-dark.png`, `notifications-clip-1920-dark.png` |
| QR20 | Collapsed rail: show the state dot and a tooltip with the roll-up line, and distinct tints for two workspaces of one repo | Initials alone ("AA", "AW") cannot tell two checkouts of the same repo apart | S | U5 | `rail-collapsed-1920-dark.png` |
| QR21 | Rail header: "WORKSPACES 2" at 11.5 px uppercase with an unlabeled collapse arrow and a plus; label both and drop the uppercase | audit 13 | S | audit 13, 19 | `rail-1920-dark.png`, `App.css:152-153` |
| QR22 | Let the rail be resized by drag (236 px fixed today), remembered per screen; at 2560 the rail looks like a strip | At 2560 everything in the rail is proportionally smaller and the workspace name is the only readable item | S | | `cockpit-4panes-2560-dark.png` |
| QR23 | Explorer: file names split from their extensions, the branch chip truncates to "mas", the filter placeholder clips; widen the default to 300 px and let names ellipsise in the middle | Cosmetic but constant | S | U3, audit 24 | `explorer-1920-dark.png`, `Explorer.tsx:843-844` |

### Icons and hit targets

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR24 `NEXT` | A 28 px target floor and an 18 px glyph floor across the chrome, driven by two tokens; measured offenders: port kill 17x20, view toggle 22x22, diff chip 74x19, Needs you 73x17, bell links 14 px tall, launcher step buttons 20x20, isolation "?" 16x16, Browse 49x17, find bar buttons 22x22, Explorer row icons 13 px | Balu: "the icons are really small half the time"; WCAG 2.5.8 is 24 px, Windows says frequent targets bigger than the minimum | M | K8, U4, U6, audit 3 and 4, research 5 | `measures-1920-dark.json`, `measures-2560-dark.json` (targets lists), `panes.css:339`, `App.css:140` |
| QR25 | Vendor glyph: 16 px disc with 7 px letters; use 20 px and the vendor colour dot as the primary cue, letters only at 24 px and up | Not readable at any screen size | S | K8 | `paneheader-4panes-1920-dark.png`, `panes.css:78-93` |
| QR26 | Contrast: `--faint` text measures 4.17:1 on the dark surfaces (Settings row subtitles, notification times, menu headers, launcher footer, "Layout" labels); on light the diff "+78" is 3.02:1, the branch chip 4.27:1, the "signed in" agent chip 3.02:1 and the vendor glyph 4.44:1; lift the tokens to 4.5:1 in both themes | AA floor; this is where small chrome fails first, and light is worse than dark | S | audit 31, research 31 | `measures-2560-dark.json` (cr 4.17 rows), `measures-1920-light.json` (cr 3.02 rows), `theme.css` (`--faint:#71839A`) |
| QR27 | One tooltip pattern (label plus shortcut) on every icon-only button and a visible hover background | Today some have titles, some aria-labels, some neither | S | audit 30, research 37 | `Cockpit.tsx:384-454`, `PaneView.tsx:1192-1196` |
| QR28 | Chrome density switch (Compact = today, Comfortable = default) on top of the chrome-scale token, so the 2560 screen is not just a shrunken 1920 | At 2560 the same 10 px chips are physically smaller; JetBrains Compact Mode and Warp density are the pattern | M | UC0, audit 33 and 34, research 7 and 8 | `cockpit-4panes-2560-dark.png` next to `cockpit-4panes-1920-dark.png` |

### Notifications and attention

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR29 `NEXT` | Turn the Recent feed off by default and record only approvals, questions, errors and finished runs; the mock shows twelve "Waiting · just now" rows for six panes, including shells | Balu: "how the notifications work"; the feed is noise under the current waiting rule | S | U2, UX-601 ruling | `notifications-clip-1920-dark.png`, `ui.ts:241` (notifyOn.waiting true), `Notifications.tsx:866-876` |
| QR30 | Needs-you rows show the pane's last line ("3. No, tell Claude what to do differently") instead of the question; use `permissionPrompt()` from `home.ts:112`, which Home already gets right ("Do you want to run this command?" plus the command) | The feed, the OS toast and the attention queue all use the last line | S | | `notifications-clip-1920-dark.png` versus `home-1920-dark.png`, `Notifications.tsx:346-348, 520-527` |
| QR31 | Bell badge: 9 px numerals in a 16 px disc; make it 12 px bold in a 20 px disc, and one badge (errors fold into the count with a red ring) | Smallest text in the bar | S | | `bell-1920-dark.png`, `Notifications.css:18` |
| QR32 | One place for alert settings: today sound lives in Settings > Agents (`flightdeck-sound-needs-you`, default on) and again in the bell's own settings panel (`notify.sound`, default off), two stores with different defaults | Two toggles that disagree | S | | `Settings.tsx:886`, `ui.ts:242`, `Notifications.tsx:882-900` |
| QR33 | Three surfaces answer "who needs me" (bell dropdown, attention queue overlay, Home); make the bell a count that opens Home, retire the attention queue overlay | Hick's law and consistency; Home already has peek, reply and Approve | M | competitor table 1, QL-7xx | `home-1920-dark.png`, `notifications-1920-dark.png`, `Cockpit.tsx:41, 467` |
| QR34 | Toasts: the "details" link and the close "x" are 10.5 px and 14 px; raise to 12 px and 24 px, and keep the pause-on-hover | Error toasts are the ones read in a hurry | S | | `toasts-clip-1920-dark.png`, `review.css` toast section |

### Settings

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR35 `NEXT` | Settings is a 558x575 px modal scrolling 6255 px with 50 rows in 11 sections and no section navigation; make it a full-height panel with a left section list, about 760 px wide at 1920, sections as pages | U1; eleven screens of scrolling to reach About | M | U1, UI-180, audit none | `settings-1920-dark.png`, `settings-01` to `settings-11` shots, `measures-1920-dark.json` (settingsInfo) |
| QR36 | Collapse the rows an agentic owner never touches under an Advanced disclosure per section: Preview text size, Preview line height, Preview reading width, Chat detail, Theme file, VS Code theme, Updates Canary channel, Revert to an earlier version, Releases folder, Pane health, Memory ceiling, Error log | Progressive disclosure; keeps them reachable through Settings search and the palette | S | research 17 (NN/g progressive disclosure) | `settings-*.png`, `Settings.tsx` row list |
| QR37 | Put "Chrome size" and "Terminal font" at the top of Appearance as two separate controls with a live preview, and scope Ctrl+= to chrome | UC0; today "UI size" and the Ctrl+= HUD scale both | M | UC0, research 9 to 12 | `zoom-hud-1920-dark.png`, `Settings.tsx:1632-1676`, `ui.ts:534` |
| QR38 | Hide "Extra CLI flags" and "binary path override" until they are wired | They save and do nothing | S | K9 | `Settings.tsx:2024-2026` |
| QR39 | Section headers are 11 px uppercase mono with 0.18 em tracking and the Reset buttons 10.5 px; use 13 px semibold sentence case and 12 px buttons | Windows typography guidance: sentence case, no tracking games under 12 px | S | | `settings-1920-dark.png`, `overlays.css:68, 75` |
| QR40 | Agents section: the five-way "Default vendor" segment squeezes its label into a 50 px column ("Default / vendor / Pre- / selected / for new / panes"); stack wide controls under their label | Layout defect visible on every vendor count above three | S | | `settings-05-agents-1920-dark.png`, `Settings.tsx:1908` |

### Launcher, Home and palette

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR41 | Reopen the last session silently with an undo toast instead of the "Reopen last session?" dialog over the launcher on every boot (Startup > On launch already has the setting) | Balu runs the same fleet daily; the dialog is a daily click | S | | `reopen-dialog-1920-dark.png`, `Settings.tsx:2101` |
| QR42 | Launcher: inline reason on the disabled Create button, fold worktree, setup command and per-pane rows under Customise, footer to 12 px | audit 16 to 19 | S | audit 16 to 19, 22 to 25 | `launcher-1920-dark.png`, `measures-1920-dark.json` (launcher) |
| QR43 | Home columns for an agentic owner: Needs you, Working, Done (changes ready), Idle, Merged; "Ready to review" assumes a manual review step, and the card's diff row becomes the run summary (QR55) | Balu never reviews by hand; the column name tells him to | S | competitor table 1 | `home-1920-dark.png`, `home.ts:17-21` |
| QR44 | Home opens on boot when any pane needs you, and the bell click opens Home (pairs with QR33) | One landing surface | S | | `home-1920-dark.png` |
| QR45 | Home at 2560: five fixed columns stretch to 380 px each with 11 px meta text and 14 px names, so a six-card board is mostly empty space; cap the board at about 1600 px, centre it, and scale card text with the chrome token | The surface Balu should land on is the one that scales worst | S | | `home-2560-dark.png` next to `home-1920-dark.png` |
| QR46 | Palette: a one-line description and the shortcut on every entry, and the current view's commands first | research 37; the palette is the answer to "what does this do" | S | research 37 | `palette-1920-dark.png`, `palette-search-1920-dark.png` |
| QR47 | Quick open with no recent files is a 680 px empty panel; size to content and show the last ten files the agents touched | U6 | S | U6 | `quickopen-1920-dark.png` |

### Terminal and chat

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR48 | Keep the Chat view but hide its toggle by default; keep its composer and the H4 queue as the base for QR53 | Balu is back on Terminal; the composer is the one piece worth keeping | S | TN1, H4 ruling | `chat-1920-dark.png`, `ChatView.tsx:459` |
| QR49 | Default the terminal minimum contrast to 4.5 (the setting exists, "1 is off, 4.5 matches VS Code") | Dim agent output is the readability complaint in every theme | S | research (VS Code) 7 | `Settings.tsx` "Minimum contrast" row, `settingsStore.ts:24` |
| QR50 | Context menu: add "Interrupt agent" (Esc for Antigravity, Ctrl+C for Claude and Codex) and "Send selection to another pane" | AG1; the menu is Copy / Paste / Select all / Find / Clear today | S | AG1, AG2 | `ctxmenu-1920-dark.png`, `PaneView.tsx:1538-1545` |
| QR51 | Confirm on Close reads "Close & end session" in red; add what will be lost ("Claude will stop mid-task; the worktree stays") and offer "Close and keep the worktree" | Destructive copy should say the consequence | S | | `close-confirm-1920-dark.png` |

### Agent-first additions

Detail and grounding in section 4.

| ID | What | Why | Size | Existing | Evidence |
|---|---|---|---|---|---|
| QR52 `NEXT` | Claude hooks on by default (Notification, PermissionRequest, Stop) with a one-time consent, so pane state is what Claude says, not a silence guess | Fixes QR19, QR29 and the rail at the root; `hooks.rs` exists, install is an opt-in row in Settings > Diagnostics | M | N2.1, QL-720 | `src-tauri/src/hooks.rs:55, 495`, `Notifications.tsx:176-182, 316-319` |
| QR53 `NEXT` | Queued follow-ups for Terminal panes: type the next instruction while the agent works; Flightdeck sends it when the Stop hook fires, with a "Queued 1" chip and take-back | Hands-off running of six agents means never waiting for a prompt to come back | M | H4 (Chat only today), NH1 | `ChatView.tsx:22, 459-527`, `chat/queue.ts` |
| QR54 `NEXT` | Auto-approve rules per workspace: "Always allow" writes to the repo's `.claude/settings.local.json` permissions, plus a per-pane autonomy dial (Ask / Auto-edit / Full) mapped to `--permission-mode` | Approvals are the only reason Balu is interrupted; the mechanism is Claude's own, so Flightdeck never presses keys | M | | `src-tauri/src/chatlog.rs:878` (already passes `--permission-mode acceptEdits` for the test launch), `home.ts:238` |
| QR55 `NEXT` | Run summary on Stop: "Changed 5 files (+120 -18), ran 3 commands, 42 tests passed, 7 min" on the Home card, in the OS toast and in the pane's Done state; built from the transcript the Chat view already parses (TN4) | Replaces diff review for an agentic owner; it is what he checks instead | M | TN4, N5 | `ChatView.tsx` turn rollup, `chatlog.rs` |
| QR56 | Phone notification: per-pane Remote Control toggle (`/remote-control`) and an optional push (ntfy or Pushover URL in Settings) on needs-you and finished | The loudest demand in the market scan; costs nothing against the subscription rule | S to M | competitor table 13, market 17 | `Notifications.tsx:520` (osToast path) |
| QR57 | Session search across all projects from the palette (Ctrl+Shift+F); the backend exists with an `allProjects` flag but is buried inside "Resume a past session" | "Which session touched X last week" | S | competitor table 8, research 18 | `SessionLauncher.tsx:25, 130`, `session-launcher-1920-dark.png` |
| QR58 | Worktree hygiene: remove a worktree automatically after merge-back or PR merge (with a 24 h grace), warn in the pane when untracked binaries pass 500 MB, move "Worktrees on disk" from Settings > Diagnostics to Home | Eight worktrees a day pile up; the Tappy 8.5 GB case cost 11 s per poll | M | N1.10, competitor table 6 | `Settings.tsx:722` (worktree table), `PaneView.tsx:1254` |
| QR59 | "Jump to the agent that has waited longest" on one key (Ctrl+Shift+J) and on the bell click, using the queue's existing longest-first order | wmux's most-cited feature | S | QL-7xx attention queue | `AttentionQueue.tsx:27, 98` |
| QR60 | Chain: "when this pane finishes, send X to pane Y" and "Continue in Codex" seeded with the run summary | Cline parent-done-starts-child, Superset handoff | L | competitor table 15, market 14 | section 4 |

## 3. Remove or hide

Treat these as first-class improvements.
"Breaks" lists what stops working or needs a new home; "nothing" means the code path is display only.

| What goes | Where it moves | Breaks |
|---|---|---|
| "63k ctx" chip in the pane header | Details block at the top of the pane menu (Folder, Branch, Model, Context, Last output) | Nothing; the ctx warning colours (70 and 90 percent) can colour the state word instead |
| Model chip ("opus 4.6") | Same Details block | Nothing |
| Activity sparkline and "idle 4m" label | Gone; the state word (Working, Idle 4m, Needs you) replaces it | Nothing; `lastOutputRef` keeps feeding the idle age |
| Process chip (`.pproc`) | Gone; already mostly retired (`panes.css:27-30`) | Nothing |
| Plan, memory and subagent chips (`.pplan`, `.pmem`, `.psub`) | Subagents becomes a pane menu item ("Subagents…"); plan and memory warnings become one line in the Details block | The subagent tree popover is opened from the chip today (`PaneView.tsx:1102`); move the trigger |
| Diff count chip ("+78 -3") | Gone from the row; "Review changes…" stays in the pane menu; the run summary (QR55) carries the counts | Nothing; the Review drawer still opens from the menu and from the Chat rollup |
| Review drawer "Viewed" checkboxes, "3 left to review", Collapse all / Expand all | Keep inside the drawer, hidden behind a "Review mode" toggle that is off by default | Nothing; `reviewstate.ts` keeps the state |
| Home column "Ready to review" | Renamed "Done" with the run summary; merge-back and PR actions stay on the card | `home.ts:17-21` label and the e2e `home.mjs` text matches |
| Terminal / Chat toggle in the header | Pane menu checkbox plus Settings > Agents default | `e2e/pane-header-600.mjs` and `chat-view.mjs` click the toggle; update selectors |
| 5h / wk gauge (two rows, two bars) | One text pill with a click popover (QR2) | `QuotaGauge.tsx` layout; the hover tooltip string becomes the popover body |
| Theme toggle in the top bar | Settings > Appearance (already there) | Nothing; the palette keeps "Toggle theme" |
| Workspace name in the top bar while the rail is expanded | Rail row only; returns when the rail is collapsed | `e2e/home.mjs:178` reads `.topbar .ws`; keep the element, hide it by CSS |
| Notifications "Recent" feed | Off by default (setting stays) | `Notifications.test.ts` feed cases run with the setting on |
| Attention queue overlay (Ctrl+Shift+A) | Home (peek, reply, Approve already there) | The shortcut remaps to Home; `AttentionQueue.tsx` can stay lazy-loaded until removed |
| "Reopen last session?" dialog | Silent reopen plus an undo toast; "On launch" setting keeps the choice | `e2e/pane-smoke.mjs` relies on the launcher appearing in a fresh context, unaffected |
| Pane menu items: Save scrollback (redacted), Copy last command, Export this workspace, Import workspace, Pane groups, Session snapshots, Save as Claude default | Command palette only | Nothing; they are palette commands already or can be |
| Settings rows listed in QR36 | Advanced disclosure per section | Settings search must still index collapsed rows |
| Chat view Normal / Verbose segment and Find button in the pane | Settings > Agents "Chat detail" (exists) and Ctrl+F | Nothing |

## 4. Agent-first additions

Each item names where the idea is already proven and what Flightdeck already holds.

### QR52 Truthful state from hooks, on by default

Today every pane state is a guess: 3 s of silence means "waiting", and a regex over the last line upgrades it to "permission" (`Terminal.tsx:1543-1553`, `attention.ts:125-126`).
Flightdeck already installs Claude Code's Notification, PermissionRequest and Stop hooks (`hooks.rs:55`) and relays them as `hook://event`, and `Notifications.tsx:176-182` already turns them into exact states, but the install is an opt-in row under Settings > Diagnostics.
Superset and Claude agent view both derive state from hooks, not screen scraping, and that is why their "needs attention" counts are trusted.
Make the install a first-run consent ("Flightdeck adds three lines to ~/.claude/settings.json so it knows when Claude needs you; undo in Settings") and default it on for Claude panes.
Shell panes never raise attention at all.
Codex and Antigravity keep the regex path until their adapters grow a signal (AG12, N3.2).

### QR53 Queued follow-ups

Claude Desktop, claude.ai/code, Conductor 0.52, Emdash 1.2.4 and Amp all let the user type the next instruction while the agent is working.
Flightdeck has this in the Chat view only (`ChatView.tsx:459`, `chat/queue.ts`, H4), and Balu runs Terminal.
Add a one-line composer under the Terminal view (hidden until Ctrl+Enter or a header button), a "Queued 1" chip in the header with take-back, and send on the Stop hook (QR52) with a fallback to the silence timer.
This is the feature that lets six agents run without Balu watching for the prompt to return.

### QR54 Auto-approve rules and an autonomy dial

The GitHub Copilot app (Interactive / Plan / Autopilot), JetBrains Air (Ask / Auto-Edit / Plan / Full Access) and claude-squad ("autoyes") all expose one control for how much an agent may do unasked.
Claude Code's own mechanism is `--permission-mode` plus the `permissions.allow` list in `.claude/settings.local.json`; Flightdeck already passes `--permission-mode acceptEdits` for its test launch (`chatlog.rs:878`), and the launcher's per-pane rows are the natural place for the dial (N3.3).
"Always allow in this workspace" on a Home card writes the rule into the repo's local settings file, so the next identical prompt never appears; Flightdeck never synthesises a keystroke for it, which keeps the UX-601 ruling intact (Approve stays agents-only and one click at a time).
Show the dial on the pane header's Details block and on the Home card, and log every rule written in the feed.

### QR55 Run summaries instead of diffs

Balu's own words: "I have never used the diffs".
What he needs when a run ends is the shape of what happened: files changed with counts, commands run, tests passed or failed, elapsed time, and whether a PR or merge-back is pending.
Flightdeck already computes most of this per turn for the Chat view (TN2 to TN4: "Edited 4 files, ran 3 commands", "Changed 5 files (+120 -18)") and already polls the diff summary for Home cards.
Surface the same rollup as the Done card's body, as the OS toast text on Stop ("Claude finished: 5 files, 42 tests passed"), and as the first line of the pane's Idle state.
Cursor's verification artifacts and agent view's attach-recap are the market versions; Flightdeck's is cheaper because the data is already parsed.

### QR56 Phone notifications

Claude Remote Control (`/remote-control`, since 2.1.51) continues a local session from the Claude app and keeps the session on the subscription.
A per-pane "Remote control" toggle in the pane menu sends the command, surfaces the URL and QR code, and that is the whole feature.
A second, optional channel is a push URL (ntfy or Pushover) in Settings > Notifications, called from the same place the OS toast fires (`Notifications.tsx:520`), with the same text as QR30 and QR55.
Happy Coder (21.9k stars) and Omnara prove the demand; the local-first version avoids their privacy problem.

### QR57 Session search across projects

`search_claude_sessions` already takes `allProjects` and `regex` (`SessionLauncher.tsx:130`), but the only way to reach it is pane menu > Resume a past session > Search content.
Expose it as a palette command and Ctrl+Shift+F, searching every project, with results that open the transcript viewer at the hit.
Codex extended search, agent view filters and VS Code's cross-conversation search are the comparables.

### QR58 Worktree hygiene

Claude Desktop auto-archives after a PR merges and removes the worktree; Pane and Emdash handle port collisions per worktree.
Flightdeck has worktree creation, inventory (`PaneView.tsx:1254`), gc and a Diagnostics table (`Settings.tsx:722`), but nothing acts on its own.
Add: automatic removal 24 h after merge-back or PR merge (undo from the feed), a header warning when untracked binaries pass 500 MB with an "add to .gitignore" action (N1.10), and move the worktree table to Home under a "Disk" line.

### QR59 Jump to the longest-waiting agent

wmux's Ctrl+Shift+B is the one feature its users name.
Flightdeck's attention queue already sorts longest-first (`AttentionQueue.tsx:27`); bind one key and the bell click to "focus that pane", and show "waiting 4 min" on the rail roll-up (QR18).

### QR60 Chaining and handoff

Cline starts a child task when its parent completes; Superset and Codex hand a thread to another agent or environment with its context.
Flightdeck's version: on a Home card, "When done, send to…" picks another pane and a prompt (or the run summary) to deliver on Stop; "Continue in Codex" spawns a Codex pane in the same worktree seeded with the summary.
This is the large item in the set and should wait for QR52, QR53 and QR55, which it is built from.

## 5. Open questions for Balu

Each with a recommendation, in plain words.

1. Diffs: should the Review drawer go completely, or stay reachable from the pane menu with the header chip, the Home column and the Viewed checkboxes removed?
   Recommendation: keep it in the menu, remove everything else; it costs nothing to keep and the merge-back button lives there.
2. Chat view: keep it hidden behind a menu item, or delete it?
   Recommendation: keep it hidden; its composer and queue are the base for queued follow-ups (QR53).
3. Hooks: is Flightdeck allowed to write three hook entries into `~/.claude/settings.json` by default, with a one-time consent screen?
   Recommendation: yes; it is the only way the rail, feed and Home become truthful, and the entries are removable from Settings.
4. Auto-approve: is Flightdeck allowed to write "always allow" rules into a repo's `.claude/settings.local.json` when you click it on a Home card?
   Recommendation: yes, per workspace only, never into the global file, and every write is logged in the feed.
5. Quota: one number in the top bar ("78%, resets 1h 54m") with a popover, or nothing in the bar and the figure on Home only?
   Recommendation: one number in the bar; it changes when you start a run.
6. Chrome size: 120 percent chrome with the terminal unchanged (UC0) as the default, or 110 percent?
   Recommendation: 120 on the 2560 monitor; the three sizes in QR13 are set so 120 lands on 14 to 16 px.
7. Shell panes: should a pwsh pane ever light the bell or the rail?
   Recommendation: never; a shell prompt is not a question.
8. Phone: Claude's own Remote Control toggle first, or a push service (ntfy) first?
   Recommendation: Remote Control first (one command, no account), push later if you want "finished" pings away from the desk.
9. Home as the boot screen when something needs you, with the bell opening Home and the attention queue overlay retired?
   Recommendation: yes; three surfaces for one question is two too many.
10. Pane menu: move the per-pane font, ligatures, clipboard and quiet threshold into Settings and shrink the menu to about twelve items?
    Recommendation: yes; the menu clips on 1080p today (K14).

## Light theme notes

The light pass (`*-1920-light.png`) reproduces every size and layout finding above, including the chip collision (`paneheader-6panes-1920-light.png`).
The terminal stays dark inside a light chrome (U8), which is intended, but the pane header, rail and bell all sit on near-white, so the 9 to 10.5 px chips lose their outline contrast; the same floor fix covers both themes.
Home in light leaves an empty white band under its columns (`home-1920-light.png`), because the overlay keeps a fixed height whatever the card count; size it to content (pairs with QR45).

## What this review could not inspect

- Real hover tooltips: Playwright does not render native `title` tooltips, so the quota gauge hover and icon tooltips are judged from their strings.
- Rendered zoom at 120 percent in the real webview: the browser rig applies CSS zoom, and the K12 header overlap at 110 percent (QR9) needs one live confirm on Canary.
- Real mouse drags, Shift+click selection, and the Windows toast and taskbar flash (both OS-side).
- Codex and Antigravity panes with live state; the mock drives their prompts, not their real TUIs.
- The Preview drawer with real content: the mock serves only its own fixture paths and the rig's path escaping missed them, so Preview was captured in its error state only (`preview-1920-dark.png`); the error state itself is good.
- Light theme was captured at 1920 only; 2560 light was skipped.
- The pane header's own hover states (repo and branch "click to copy" affordances) and the subagent tree popover.
