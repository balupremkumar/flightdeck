# Phase 5 E3: Home view (UX spec)

Status: design only, no code. Source: qol-roadmap-2026-10-04.md E3; research README sections 2 and 5.
Skills applied: ux-psychology, reference-teardown, ux-patterns (dashboard, list), ui-states.

## 0. Grounding (what exists today)

Pane state is `starting|running|idle|waiting|permission|error` (store.ts:8).
`attentionKind(p)` in attention.ts:120 is the only gate for "needs a human": permission, error, MCP input prompt, or a quiet pane whose last line is an open question.
`needsHumanQueue(workspaces, snoozed)` feeds the bell and AttentionQueue.tsx; Home must call the same function so counts never disagree.
`lastLine`, `stateSince`, `lastOutputAt` (attention.ts) give the activity line and time since.
Diff stat (`files/added/deleted`) is local state in PaneView.tsx:296, polled per mounted pane.
PR and CI come from `pr_status` per workspace root (WorkspaceChips.tsx:29, 60 s, active workspace only); `prLabel` in chipState.ts formats it.
Worktree merge status is `status === "merged"` in worktrees.ts:27.
AttentionQueue is an overlay (ui.ts `attentionOpen`, Ctrl+Shift+A, palette "Open attention queue"); there is no view router.
Send-to-pane is `invoke("pty_write", { paneId, data: text + "\r" })` (Broadcast.tsx:104).

## 1. Restatement

What: one screen listing every agent pane across every workspace, grouped by computed state.
Looks like: five columns (Needs you, Working, Ready to review, Idle, Merged), one card per pane, Needs you leftmost and widest.
Used: glance to see who is blocked, answer a question inline, jump into a pane, or dismiss with Escape.
Primary action: "Reply" on the top Needs you card (focus lands in its reply field on open).
Is NOT: a kanban (nothing is dragged), a replacement for the bell or AttentionQueue, a terminal, or a task tracker.

## 2. Teardown (working from knowledge, not current screenshots)

Linear inbox: eye goes to the top unread row, then the preview pane; primary action is open or triage with J/K and one-key actions; steals keyboard triage and "inbox zero" empty state.
GitHub notifications: eye goes to the unread dot, repo, then title; primary action is open; steals grouping by what you must do (review requested, mentioned) rather than by source.
Superset and Claude agent view (from the research): status groups Needs attention / Working / Needs review / Idle, fed from agent state; steals peek-and-reply on the row and no manual movement.
Convention they agree on: most-actionable first, status is computed, one row answers what, which state, what next.
Deliberate deviations: columns not a single list (Balu's ask, and five states fit 940 wide only as a stacked list, see section 4); reply inline because blocked agents are the cost.

## 3. Entry and exit

Home is an overlay sheet (full window minus the titlebar), not a routed view.
Reason: no view router exists, overlays already close through `useOverlayEsc` with correct LIFO, terminals stay mounted and keep streaming, and "never replacing the bell" holds because nothing underneath changes.
State lives in ui.ts as `homeOpen` / `setHomeOpen`, mirroring `attentionOpen`; mount lazily in Cockpit beside `AttentionQueue`.
Entry 1: a Home icon button directly left of the bell in the titlebar, tooltip "Home (Ctrl+Shift+H)".
Entry 2: chord Ctrl+Shift+H, global, not guarded by terminal focus (same reasoning as Ctrl+Shift+A, Cockpit.tsx:173). Confirm the chord is free before build.
Entry 3: palette action "Open Home".
Bell footer link "Open Home" next to the existing "Open attention queue" link (Notifications.tsx:725).
Exit: Escape via `useOverlayEsc(homeOpen, close)` (first Escape closes the reply field's focus-less state only if the field is empty; local textarea handler clears text first, see section 6), the Close button, or opening any pane (Enter on a card closes Home and focuses the pane).
Opening Home while the attention queue is open closes the queue first; they never stack.

## 4. Layout

Tokens: 4 px spacing scale (4/8/12/16/24); card padding 12; column gap 12; sheet padding 16.
Type: column header 12/16 semibold uppercase 0.04em; card title 13/18 semibold; activity line 12/16 mono, 2-line clamp; meta 11/14 muted.
Colour roles: reuse existing pane state tokens; Needs you uses the bell's accent, Working the running dot colour, Merged and Idle muted. Every column has a text label and count, never colour alone.
Card height: auto, min 72; column scrolls independently; Needs you column is 1.4fr, others 1fr.

1440 wide (five columns, ~270 px each):
```
+--------------------------------------------------------------------------------------------+
| Home                        [filter workspaces v]                          3 need you   [x] |
+----------------------+-------------+--------------+-------------+---------------------------+
| NEEDS YOU 3          | WORKING 4   | READY 2      | IDLE 5      | MERGED 3                  |
| [claude] api / fix-x | api / feat  | web / pr-12  | web / main  | api / fix-y               |
|  Approve: rm -rf ... | Editing ... | +84 -12 3f   | idle 2h     |  PR #41 merged            |
|  4m  ! Needs approval| 38s         | PR #12 pass  |             |                           |
|  [Approve] [Open]    |             |              |             |                           |
| [codex] web / q      |             |              |             |                           |
|  Which pkg manager?  |             |              |             |                           |
|  [ reply... ] [Send] |             |              |             |                           |
+----------------------+-------------+--------------+-------------+---------------------------+
| Other windows: Window 2 (2 workspaces): 1 needs you, 3 working                (read-only)  |
+--------------------------------------------------------------------------------------------+
```

940 wide (app minimum): columns become stacked collapsible sections in one scrolling column, same order.
Needs you is always expanded; Working expanded; Ready to review expanded if non-empty; Idle and Merged collapsed to a header row with count.
```
+--------------------------------------------------+
| Home                  [filter v]   3 need you [x] |
| NEEDS YOU 3                                      |
|  [claude] api / fix-x      4m   ! Needs approval |
|   Approve: rm -rf ...        [Approve]  [Open]   |
|  [codex] web / q           9m   ? Asked a question|
|   Which pkg manager?                             |
|   [ reply...                         ] [Send]    |
| WORKING 4                                        |
|  [claude] api / feat  Editing ...            38s |
| READY TO REVIEW 2                                |
|  web / pr-12   +84 -12 3 files   PR #12 pass     |
| IDLE 5 (collapsed)    MERGED 3 (collapsed)       |
| Other windows: Window 2: 1 needs you  (read-only)|
+--------------------------------------------------+
```
Breakpoint: below 1100 wide, switch from columns to stacked sections.

## 5. Column rules

Unit is the pane (agent), not the workspace; a workspace with three panes yields up to three cards.
Shell-only panes (vendor not claude/codex/agy) are excluded; Home is about agents.
Precedence, first match wins:

| Order | Column | Rule |
|---|---|---|
| 1 | Needs you | `attentionKind(p) !== null` and not snoozed (same filter as bell). Sorted as `needsHumanQueue`: permission, error, question, then longest-blocked first. |
| 2 | Working | `state` is `running` or `starting`. Sorted by most recent output. |
| 3 | Merged | worktree `status === "merged"` or PR state MERGED. Newest first, show 5 then "Show all". |
| 4 | Ready to review | not 1-3 and (pane has a worktree diff with files > 0 against base, or an open PR whose checks are not `running`). Sorted failed CI first, then passed, then by diff size. |
| 5 | Idle | everything else, including quiet `waiting` panes with no question (ambient, per UX-601). Sorted longest idle first. |

A pane never appears twice; a card moves column only when the underlying state changes, never by user action.
Merged outranks Ready so a merged PR with a leftover diff does not ask for review.
Snoozed panes: appear in Idle with a "Snoozed 20m" tag, so Home never hides a pane entirely.

Card contents, top to bottom:
Row 1: vendor glyph + name, workspace name / branch (truncate middle, tooltip full), time since `stateSince` (mono, right-aligned).
Row 2: activity line from `lastLine` (2 lines max). In Needs you, the kind label from `KIND_LABEL`.
Row 3 (only when known): diff stat `+added -deleted N files`, then PR chip via `prLabel` (`PR #12 · checks passed`).
Row 4 (Needs you only): actions, see section 6.
Null fields omit their row; no placeholders like "N/A".
Click or Enter on the card body: close Home, `switchWorkspace`, `focusPane`.

Data gap (needs a build decision): diff stat and PR are polled only for the visible workspace.
Home needs a shared poll store keyed by workspace root and pane, running only while Home is open, reusing `cachedInvoke` (PR 60 s, diff 15 s) and `usePoll` hidden-window stand-down.
Until a value arrives the card omits that row (partial, not loading).

## 6. Peek and reply

Needs you cards expand in place; no modal, no navigation.
Permission: buttons `Approve` (sends the affirmative key the pane's prompt expects) and `Open`; Home never guesses a key for a non-standard prompt, it shows only `Open`.
Error: shows the last line and `Open`; no reply field.
Question (`kind === "question"`): shows the full `lastLine` question, then a single-line reply field (auto-grow to 4 lines) and `Send`.
Send calls `pty_write { paneId, data: text + "\r" }`, exactly Broadcast's path.
On send: field disables, card shows "Sent" for the pane's next state change, then moves column by itself when `state` flips to running.
If `pty_write` rejects: field re-enables with the text kept, inline "Could not send to this pane. Try again or open it." with `Open`.
Peek: `Space` on a focused card toggles the last 12 lines of the pane's output (read from the existing tail, no new terminal) for context before replying; not in v1 if the tail is not available without mounting the pane (see open decisions).

Keyboard:
Open Home focuses the first Needs you card's reply field if it is a question, else the card.
`J`/`K` or Down/Up moves between cards (across columns in Needs you, Working, Ready order); `Tab` moves into the card's field and buttons.
`R` focuses the reply field; `Enter` in the field sends; `Shift+Enter` newline; `Esc` in a non-empty field clears it, `Esc` in an empty one closes Home (local handler, not on the overlay stack, per CLAUDE.md).
`Enter` on a card opens the pane; `1`..`5` jump to a column.
Typing never reaches a terminal while Home is open.

## 7. States

Ideal: columns populated, Needs you first and loudest, header shows "3 need you".
Empty (no agent panes anywhere): centred line "No agents running." with the button "New agent" (existing new-pane flow); Home still lists columns as hidden.
Empty column: one muted line each: Needs you "Nothing is waiting on you."; Working "No agents working."; Ready "No finished work to review."; Idle "None idle."; Merged "Nothing merged yet."
Loading (first open, polls not back): cards render immediately from local pane state (no wait); diff and PR rows show a 60x12 skeleton bar with fixed height so nothing jumps; spinner never used.
Partial: one card is a normal full-width card, not a stretched hero; 50+ cards: column scrolls, workspace filter appears above 20 cards, Merged caps at 5; ragged data: long branch truncates middle, missing PR or diff omits its row, no `lastLine` shows "No output yet".
Error: `pr_status` failing or `gh` missing shows a header notice "PR status unavailable (gh not found)" and omits PR chips; panes still sort without PR. `pty_write` failure is per card (section 6). Offline is not an error, local state is all local.
Other windows: if `win://summary` carries per-workspace attention counts, show the footer strip; if it fails or lacks them, hide the strip (local only) with no error.

## 8. Multi-window (Phase 4)

Each window mounts its own Home from its own Cockpit and lists only panes it owns, so Escape and `pty_write` routing need no change.
Other windows' workspaces appear read-only in the footer strip using `win://summary` (S11); a row click calls `window_focus_pane(label, wsId, paneId)` and closes Home.
No replying to another window's pane in v1.
If S12's attention report exposes other windows' needs-you items, show them as a count only, linking to that window.

## 9. Out of v1

Drag between columns, custom columns, or manual status.
Reply to another window's pane, and bulk approve.
Saved filters, search, grouping by workspace, sort options.
Notifications from Home; the bell stays the only alert source.
Embedded terminal or live output stream in cards.
Starting tasks from Home ("New task" lives in the palette, E2).
Merge, close PR, or any git action.
Persisting collapsed sections.

## 10. Open decisions for Balu

1. Chord Ctrl+Shift+H: confirm free, or choose another.
2. Peek (last output lines) requires a tail buffer for unmounted panes; ship without it if none exists.
3. Home needs a new shared PR/diff poll store; accept that cost, or v1 shows PR/diff only for the active workspace.
4. Snoozed panes shown in Idle (this spec) vs hidden like the bell.

## Lead decisions (2026-10-05, reversible)

1. Chord: Ctrl+Shift+H only if free; the plan checks every existing binding and picks a free chord otherwise.
2. Peek: v1 ships it, reading the pane's tail from the Rust per-pane ring (Phase 4 S1-S3), ANSI stripped, so unmounted panes work too.
3. Diff stat and PR/CI: a shared poll store that runs only while Home is open, throttled, reusing the existing async commands and cachedInvoke TTLs.
4. Snoozed panes: shown in Idle, dimmed with a snooze marker; snooze means "do not nag", not "hide".
