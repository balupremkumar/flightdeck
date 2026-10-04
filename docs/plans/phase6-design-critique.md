# Phase 6 design critique (Chat density, Settings search)

Reviewed from e2e/shots (all six chat-density shots plus settings-search.png) and src/chat.css, src/overlays.css, src/ChatView.tsx, src/chat/chips.ts, src/theme.css.
Contrast ratios are computed from the theme tokens (WCAG relative luminance), not sampled from the PNGs.
Floor is 4.5:1 for body-size text, 3:1 for outlines and non-text.

## User goal

Glance at a Claude pane, know what it did and what it is doing now, and open detail only when something looks wrong.

## Cold look (5 seconds, Normal density)

First the right-aligned user bubble (only tinted block).
Second the bright mono activity pill.
Third the plain final sentence "All four files are updated...".
The final answer should be first or second, because it is the outcome.
The activity pill beats it because the pill text is high-contrast mono and the answer is a single quiet line below it.

## Primary element

Per turn it is the final answer prose.
Per pane it is the composer (Send), which is disabled while working, so the placeholder is the only live status there.
Secondary is the "Changed N files" row (the one outcome that has a destination: the review pane).
Everything in the activity line is process and should recede.

## Squint test

Activity pill, change row and subagent row are three outlined pills of equal weight and identical shape.
They read as one stack of same-priority objects, though one navigates (change row), one expands inline (activity), and one expands a nested thread (subagent).
Hierarchy is flat where it should step: outcome above process.

## Gestalt ruling: mono on the activity line, UI font on the change row

Half justified.
Mono is right for things that are machine strings (paths, commands, the "now:" command).
It is wrong for the counted sentence "Edited 4 files, ran 3 commands, read 8 files", which is prose, wastes about 12 percent width, and is the reason the tail truncates.
The change row differs in behaviour (opens review), so a different style is justified, but only one of the cues (font) differs while shape, border and caret are identical, so the difference is too weak to teach the behaviour.
Ruling: sentence in UI font, command/path/"now:" in mono, change row gets its own shape and ink (see fix 6).

## Contrast table (computed)

| Pair | Deep Cove dark | Deep Cove light | GitHub light |
| --- | --- | --- | --- |
| --muted narration on --surface | 7.7 | 7.0 | 5.7 |
| --muted on --surface-2 (chip ground) | 7.1 | 6.5 | 5.3 |
| Change row text (--muted) on --surface | 7.7 | 7.0 | 5.7 |
| --faint on --elevated (settings sub line) | 4.3 | 5.1 | 4.55 |
| --faint on selected hit (accent 16 percent tint) | 3.2 | 3.9 | about 4.2 |
| --st-error text on --surface (err chip, err result) | 6.4 | 4.2 | 4.8 |
| --st-running diff-add text on --surface | high | 3.0 | 4.4 |

Other dark themes on the settings sub line (--faint on --elevated): One Dark Pro 2.8, Dracula 2.6.
Narration dim text and the change row pass everywhere checked, so --muted is not the problem; --faint, light-theme red and green are.
Colour is never the only signal in the chat: the change row carries "+74 -13" signs, errors carry the "failed" badge, diff lines carry +/- prefixes.

## Ranked fixes (worst first)

### 1. Disabled composer placeholder is the only live status and is nearly invisible

Evidence: chat-density-normal.png, "Agent is working. You can send when it is waiting for input." is below 3:1 (UA placeholder colour, then `opacity: .6` on the disabled textarea).
Fix in src/chat.css:
```css
.chat-input textarea::placeholder { color: var(--muted); opacity: 1; }
.chat-input textarea:disabled { opacity: 1; background: var(--surface-2); border-color: var(--line); }
```
Result: placeholder is 7.1:1 dark, 6.5:1 light, and the disabled state is shown by the flatter ground, not by fading the text.

### 2. Settings search sub line fails contrast (worst on selected row and on several themes)

Selector: `.set-hit-sub` in src/overlays.css line 448.
Change `color: var(--faint)` to `color: var(--muted)`.
Result: selected row 5.0:1 dark, 5.6:1 light, and One Dark Pro / Dracula pass.
Also change `.set-search::placeholder` from `--faint` to `color-mix(in srgb, var(--muted) 85%, transparent)` only if a theme audit shows it under 4.5:1; it passes in Deep Cove both modes.

### 3. Light themes: error text and diff-add text under 4.5:1

Selectors in src/chat.css: `.chat-chip.err` (line 57), `.chat-result.err` (67), `.chat-detail.err` (70), `.chat-diff .del` (73), `.chat-diff .add` (72).
Add a chat-local ink so tokens elsewhere are untouched:
```css
.chat { --chat-err-ink: color-mix(in srgb, var(--st-error) 80%, var(--text)); --chat-add-ink: color-mix(in srgb, var(--st-running) 55%, var(--text)); }
```
Use `color: var(--chat-err-ink)` on the three `.err` rules and `.chat-diff .del`, and `color: var(--chat-add-ink)` on `.chat-diff .add`.
Result in Deep Cove light: error 5.6:1 (was 4.2), add about 6.2:1 (was 3.0).
Dark themes get slightly paler reds and greens, still above 6:1.
Keep the existing 10 percent tinted line backgrounds.

### 4. The activity line truncates the counts and keeps the narration; reword "+3 more"

Evidence: chat-density-normal.png shows "read 8 files +3 mo..." while "Handing the last piece to ..." still has room.
The counts are the scan target, the dim sentence is a bonus, so the bonus must give way first.
Fix in src/chat.css, append:
```css
.chat-activity > .chat-chip .chat-chip-text { flex: 0 1 auto; font-family: inherit; font-size: 12px; }
.chat-activity > .chat-chip .chat-narr-last { flex: 1 1 0; }
.chat-activity > .chat-chip .chat-now { flex: 0 1 auto; }
```
In src/ChatView.tsx line 321 add `title={activityLabel(...)}` to the button so the full count line is on hover (same string, no new copy).
Ruling on (c): "+3 more" is ambiguous (3 more what? categories or actions?).
Change src/chat/chips.ts line 150 from `${shown} +${rest} more` to `${shown} +${rest} other`.
"+3 other" reads as "three other actions" next to a list of actions, is 1 character shorter, and stays at the end where it is most often clipped, hence the title.
Update the two expectations in src/chat/chat.test.ts (lines 261 and 378).

### 5. Expanded Normal doubles every row with an "ok" line

Evidence: chat-density-normal-expanded.png, each chip is followed by a bare "ok" line, halving density, against the one-line-per-action goal.
Fix in src/ChatView.tsx line 287: only render `call.result.summary` when `failed`, or when it is not a bare success word, or in Verbose.
CSS fallback if frontend prefers: none, this is a render decision.
Result: expanded Normal drops about 40 percent of its height with no information lost; failures still show their summary in red.

### 6. Outcome row and process rows have the same weight and shape

Fix in src/chat.css, change `.chat-files` (line 78) and add:
```css
.chat-files { border-radius: 6px; border-color: var(--line-strong); color: var(--text); margin-top: 6px; }
.chat-files button { color: inherit; }
.chat-files-main { font-weight: 500; }
```
Process pills (`.chat-chip`) stay 999px-rounded and muted.
Result: the change row is the only squared, brighter object in the turn, which marks it as "go to review" and gives the outcome the second step in the hierarchy.
Do not colour the +/- numbers green and red here unless fix 3's ink is used, to match the pane header "+4 -0" convention; if done, keep the signs.

### 7. Settings modal height jumps while searching (ruling on a)

Pin it.
The modal shrinks from 86vh to about 170px on the first keystroke and, because it is centred, the title and search box move vertically while the user is typing in them.
Fix in src/overlays.css line 56, `.set-modal`: add `height: min(640px, 86vh);` (keep max-height).
Add `.set-results, .set-noresults { flex: 1; }` and `.set-noresults { display: grid; place-items: center; }` so the empty result centres in the fixed frame.
Result: search box never moves; scroll area stays the same size in both modes.

### 8. Change row focus ring is clipped

`.chat-files` has `overflow: hidden`, so the 2px `:focus-visible` outline (offset 1px) on its inner buttons is cut off at the pill edge.
Fix in src/chat.css: 
```css
.chat-files button:focus-visible { outline-offset: -2px; border-radius: inherit; }
```
Result: ring visible, 2px, `--ice` (4.6:1 on light surface, high on dark).

### 9. Two identical "Switch to Terminal" buttons

Evidence: chat-density-empty-asking.png has one in the empty state and one in the gate bar, plus the amber gate text repeating the same instruction.
Remove the `.chat-empty-btn` from the empty state (src/ChatView.tsx near line 710) and keep the gate bar, which is the standing location for this action in every blocked state.
Empty-state copy becomes "Claude is asking something in the terminal." with the gate bar below supplying the single action.
Result: one primary action on screen, in the same place as the permission gate.

### 10. Unlinked subagents at the end read as part of the last turn (ruling on d)

Evidence: chat-density-normal.png shows "Subagent: Orphan check" directly under the "Changed 4 files" row with no separator.
Preferred: attach each unlinked subagent to the turn whose time range contains its start; keep the list only for those that fit nowhere.
For the leftover list, in src/chat.css `.chat-unlinked`:
```css
.chat-unlinked { margin-top: 14px; padding-top: 8px; border-top: 1px solid var(--line); }
.chat-unlinked::before { content: "Other subagents"; display: block; margin-bottom: 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
```
Also replace the "quiet" status word with "idle", which is already the status vocabulary elsewhere in the app (--st-idle).

### 11. Jump-to-setting flash (ruling on b)

Visible on light themes: `--accent` #1A6DC7 against #FFFFFF is 5.3:1, well over the 3:1 outline floor, and it is a shape not a colour change.
Two real risks instead.
First, the row sits under the scroll-fade (both the `mask-image` at lines 409 to 412 and the `::after` gradient at 472 to 477 fade the bottom 18 to 22px), so a target near the bottom flashes half faded.
Second, the outline stops abruptly at 1.6s.
Fix in src/overlays.css line 450:
```css
.set-flash { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: var(--r-md); background: color-mix(in srgb, var(--accent) 10%, transparent); }
```
When jumping, call `scrollIntoView({ block: "center" })` on the target before adding `.set-flash`.
Remove the redundant `::after` fade (lines 472 to 477) and keep the mask, since two fades stack and darken the bottom edge.
Keep 1.6s; under reduced motion it is already static.

### 12. Live "now:" feedback is text only

The `now: <command>` text appears and disappears, with no motion cue, and screen readers are not told.
In src/ChatView.tsx ActivityItem add `data-running={now ? "1" : undefined}` on the button, and in src/chat.css:
```css
.chat-activity [data-running] .chat-glyph { animation: chat-pulse 1.4s ease-in-out infinite; }
@keyframes chat-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .chat-activity [data-running] .chat-glyph { animation: none; } }
```
Also set `aria-live="off"` on the line and `role="status"` on a visually hidden span with the "now:" text only when it changes more than once per two seconds, or skip the live region and rely on the pulse for sighted users.
Result: a running turn is distinguishable at a glance from a finished one without reading.

### 13. Observed, outside this change set: pane header crush

In chat-density-empty-asking.png the "NEEDS YOU" pill pushes the pane title to "Cla..." and the branch chip to a bare icon in a 600px pane.
Identity (which agent) loses to status, which is arguable, but the branch chip collapsing to an unlabelled icon is not.
Give the branch chip `min-width: 0` plus a `title` with the branch name (src/panes.css, `.pattn` neighbours) and let the title keep at least 6ch.

## Hick and progressive disclosure

Three levels (line, chips, detail) is the right depth and matches the owner goal.
The Normal / Verbose switch plus a visible Find sit in the same bar with the same border, so Find reads as a third mode; give `.chat-iconbtn` no border until hover to separate "view mode" from "action".
Subagent threads add a fourth level; fix 10 keeps them from competing with the answer.

## Settings search, other notes

The selected hit is pre-highlighted, which is right for Enter-to-jump.
Search input has no visible label, so check it carries `aria-label="Search settings"`.
Add a result count only if the list exceeds one screen; one to five rows do not need it.
Section tag (TERMINAL, azure mono) passes at 6.3:1 dark and 4.8:1 light.
