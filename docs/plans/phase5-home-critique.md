# Phase 5 Home design critique (overlay, 1440 and 940)

Reviewed from home2-1440.png, home2-940.png, src/HomeOverlay.tsx, src/HomeOverlay.css, src/home.ts, src/theme.css.
Contrast is computed from theme tokens (WCAG luminance), not sampled. Floor 4.5:1 text, 3:1 outlines.
Screenshot theme has a pale grey accent (Approve and Send render grey); that is the theme, not a bug.

User goal: open Home, see who is blocked on me, clear it without leaving.
Cold look at 1440: gold column head and left stripe first, "Do you want to run this command?" second, Approve third. Needs you wins; the goal is served.
Squint: the gold "PR #12 checks running" lines in four other cards compete with Needs you (fix 4). Idle and Merged cards weigh the same as live ones.

## Blockers

1. Focus ring on cards is clipped in the five-column layout.
   `.hm-col` in HomeOverlay.css (line 33) has `overflow-y: auto`, which also clips x. The 2px ring plus 1px offset on `.hm-card:focus-visible` (line 54) sits outside the card, so left, right and top edges are cut. The first card is focused on open, so the keyboard user's first view is a broken ring.
   Fix: `.hm-col { padding: 4px; margin: -4px; }` (the ring needs 3px; the negative margin keeps the grid alignment). Same for the reply field and buttons, which share the clip.
2. Approve shows the question but not the command it approves.
   Evidence: home2-1440.png, the card reads "Do you want to run this command?" with no command. `permissionAsk` (src/home.ts) returns the question line only; one click then sends a keystroke blind.
   Fix: for permission cards render the 2 lines above the question (the tool request) in `.hm-act`, `-webkit-line-clamp: 3`; if `permissionAsk` finds no request line, auto-open the peek on that card. Approve stays disabled until one of the two is shown. Verify against a real Claude prompt where the command sits above the question.

## Should fix

3. Approve appears late and shoves Open sideways (mis-click).
   HomeOverlay.tsx line 395: `canApprove` needs the tail, so Approve mounts after the fetch and Open moves under the cursor.
   Fix: always render Approve on permission cards, `disabled` with `title="Reading the prompt"` until the key is known. Raise `.hm-btn` to `min-height: 28px; padding: 5px 12px` and `.hm-actions { gap: 12px }` so a consequential button is not 8px from Open.
4. Gold means "needs you" but `.hm-pr.running` (line 75) also uses `--st-waiting`.
   Change to `color: var(--muted)`; keep the words. Gold then appears only in the Needs you head, stripe, tag and count. Same row: in Needs cards move `.hm-meta` last (DOM order: r1, where, act, tags, peek, reply, actions, meta) so a stale "PR #41 merged" no longer sits between the ask and the action.
5. Light-theme text fails: `.hm-diff .add`, `.hm-diff .del`, `.hm-pr.passed`, `.hm-pr.failed`, `.hm-err`, `.hm-sent`, `.hm-kind.error` (Deep Cove light: green about 2.9, red about 4.0 on --surface-2).
   Add on `.hm-panel`: `--hm-err-ink: color-mix(in srgb, var(--st-error) 80%, var(--text)); --hm-ok-ink: color-mix(in srgb, var(--st-running) 55%, var(--text));` and use them on those rules. Same inks as phase 6 fix 3 (5.6 and 6.2).
6. `--faint` text fails on dark themes that raise --elevated or --surface-2: `.hm-since`, `.hm-n`, `.hm-colempty`, `.hm-foot`, `.hm-act.none`, `.hm-snooze`.
   Deep Cove dark: on --elevated 4.3 (colempty, foot). Dracula 2.6, Gruvbox 2.4, Nord 3.0. Change all six to `var(--muted)`.
7. Name loses the width contest. `.hm-r1` holds glyph, name, Peek pill (about 44px) and since (about 54px); in a 245px column the name gets about 80px, so a real title ("fix auth middleware") clips at about 10 characters.
   Fix: move `.hm-since` into the `.hm-where` row, right-aligned (`display: flex; justify-content: space-between`), and move Peek per fix 8. The name then has about 180px.
8. Peek pill on every card: agree it is noise (five identical outlined pills, equal weight to the title). Reject hover-only: it hides a keyboard and screen-reader tab stop, and Space already peeks.
   Fix: keep it always visible on Needs cards (peeking informs the decision). On other columns `.hm-col:not(.needs) .hm-peekbtn { opacity: 0 }` and `.hm-card:hover .hm-peekbtn, .hm-card:focus-within .hm-peekbtn, .hm-peekbtn[aria-expanded="true"] { opacity: 1 }` with `transition: opacity var(--dur-fast) var(--ease-standard)`. Opacity only, no layout shift. Add `aria-label="Peek at {name}"`.
9. Duplicate accessible names: every card has "Approve", "Open", "Peek". Add `aria-label={`Approve ${name}`}` and `Open ${name}` (HomeOverlay.tsx lines 412, 416, 371). Give each card `role="group"` and `aria-label={name + ", " + KIND_LABEL}`.
10. Manual rename equal to a process name is ignored (agree, real bug).
    `cardName` (src/home.ts line 83) cannot tell a user title from PaneView's auto-title, since both land in `title`. Fix: PaneView sets `titleManual: true` on the pane when the user renames; `HomeCard` carries it; `cardName` returns the title when `titleManual`, before the `isProcessTitle` test. Add a test for title "claude" with the flag.

## Nice

11. Empty column sits flush (agree). Gap under the head is the same 8px as the card gap, so "No agents working." reads as a stray caption.
    `.hm-colempty { padding: 12px; min-height: 72px; border: 1px dashed var(--line); border-radius: var(--r-md); color: var(--muted); }` (72 matches the card min-height, so a card arriving does not shift the column).
12. Dead space below cards at 1440: reject filling it (top-anchored columns are correct for a kanban). Instead let the panel hug content: `.hm-panel { flex: 0 1 auto; width: 100%; align-self: flex-start; min-height: min(480px, 100%); max-height: 100%; }` and `.hm-body { flex: 0 1 auto; }`. Panel grows downward only; scrim shows the terminals beneath.
13. Idle and Merged recede: `.hm-col.idle .hm-card, .hm-col.merged .hm-card { background: transparent; }` and `.hm-col.merged .hm-name { color: var(--muted); }`.
14. Snoozed uses `opacity: .6` (line 58), which drops every line under 4.5:1. Replace with `.hm-card.snoozed .hm-name, .hm-card.snoozed .hm-act { color: var(--muted); }`; the pill already says snoozed.
15. 940 stacked: Needs cards run 870px wide with 40 percent empty. `.hm-panel.stacked .hm-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }` shows Working and Ready above the fold. Also fold chevrons shift only some labels: put `.hm-chev` after the count (`margin-left: auto`) so every section label starts at the dot; give `.hm-fold` `min-height: 24px`.
16. `.hm-card` transitions `border-color`, outside the opacity/transform rule in the file header. Harmless (120ms, global reduced-motion rule at theme.css line 559 covers it); either amend the header comment or drop the transition.
17. `.hm-field::placeholder { color: var(--muted); opacity: 1; }` (same fix as phase 6 fix 1); `.hm-field:disabled` keep at `.6` only while sending.

## Five states

Empty: present with CTA ("New agent"). Loading: fixed-size skeletons for diff, PR and peek, no jump; Approve is the exception (fix 3). Partial: ellipsis plus title on name and where; fix 7 for width. Error: send, approve and peek failures keep the draft and give a next step; copy fine. Ideal: good.
Not verified: no shot with a long name, a snoozed card, or a light theme. Capture those after fixes 5, 7, 14.

## Outside Home (pre-existing)

A. Top bar PR chip cuts mid-word ("checks runni") with no ellipsis in both shots. Add `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0` to the chip's text span and a `title` with the full string.
