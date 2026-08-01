# Runsheet — Flightdeck v0.5.1 (2026-08-01)

> **v0.5.1 supersedes 0.5.0.** Only change: the bell dropdown now closes on a click
> outside it (or Esc, or the bell) instead of when the mouse drifts off. Everything
> below still applies; expect 0.5.1 in step 0.

Fifteen minutes, ordered by risk. Anything that fails: note the step number and what you saw.
Everything below was built and gated but NEVER run in a real GUI, because you were using the app
while it was built. This is its first human contact.

## 0. The update itself (highest risk — first real silent install)

1. Launch Flightdeck. It should offer v0.5.0 (startup check, or Settings > About > Check for updates).
2. Read the release notes shown BEFORE the install button. They should describe the bell change.
3. Click install and restart. **Watch it.** Expected: app closes, installer runs silently, app reopens on 0.5.0.
4. Confirm the version in Settings > About reads 0.5.0.

**If nothing happens, or it closes and doesn't come back:** that is the known risk (unsigned installer,
Defender). Reopen the app and check Settings > About — there should now be a red banner naming the
failure, the installer's exit code, and a "Show me the installer" button. Run
`releases\Flightdeck_0.5.0_x64-setup.exe` by hand. If Windows Security blocked it, it will be in
Protection history. Tell me the banner text; that is exactly the diagnostic it was built for.

## 1. The bell (your complaint — the main thing to judge)

5. With several agents running and none blocked: the bell should be **dark. No badge, no count, no glow.**
   Hover it — the tooltip should read something like "Nothing needs you · 3 panes quiet".
   If it is lit while nothing is actually asking you anything, the fix has failed. That is the one to report.
6. Let an agent hit an approval prompt. The bell should light, once, with a count.
7. Open it. Each row should lead with **what the agent actually said**, then workspace › pane, the kind
   (Needs approval / Error / Asked you a question), and how long. Grouped by urgency.
8. Click a row: it should jump you to that pane. There is deliberately **no inline approve** — see below.
9. Let a pane just go quiet with nothing pending. It must NOT ring, badge or count. It should still show
   its quiet state on the pane dot and workspace tile.

## 2. Click to open (the headline feature)

10. **Set your editor first:** Settings > Editor. Pick VS Code (or whatever you use). Ctrl+click does
    nothing sensible until this is set.
11. In any agent pane, find a file path in the output. It should be underlined and clickable.
12. Plain click → opens the in-app preview. Ctrl+click → opens your editor.
13. Click a path with a line number (`src/foo.ts:42`) → preview should land on that line, editor should too.
14. Preview a `.md` file: headings, tables, code blocks, task lists should render. Toggle raw/rendered.
15. In a rendered README, click a relative link to another file — it should open that file in the preview.
16. Click a path that no longer exists → should tell you it is missing, not fail silently.
17. Ctrl+F in a pane → scrollback search, with a match count, Enter/Shift+Enter to move.

## 3. Navigation

18. Ctrl+P → quick open. Type part of a filename. (Ctrl+K is still the command palette — they are
    separate now; if Ctrl+P opens both, that is a bug.)
19. Press `?` → keyboard cheat sheet.
20. Open two overlays (e.g. Review drawer, then a confirm inside it). Press Escape ONCE.
    Exactly one should close. Press again for the next. **If two close at once, report it.**
21. Backtick (`` ` ``) with focus outside a terminal → jumps to the pane with the newest output.

## 4. The things most likely to be subtly wrong

22. Type something into a pane but **do not press Enter**. Restart the app. Your unsent text should
    come back.
23. Close a pane that has unsent text → should warn you first.
24. Board: add a custom column, archive a card, then undo. Drag a card near the edge — it should autoscroll.
25. Pane menu → transcript browser, and save scrollback to a file (and the redacted variant).
26. Review drawer: click a diff line → preview at that line. Select lines → send back to the agent.
    Try "explain this diff".
27. Switch to a light theme with colour-blind mode on — status colours should still be distinguishable
    (this was fixed today and never seen rendered).
28. Settings > Diagnostics → CPU and memory should colour when high.

## Known and deliberate (not bugs)

- **No inline approve in the bell.** The prompts come in three response shapes and the row only shows a
  short tail, so approving blind was the wrong affordance. It jumps you to the pane instead.
- Two icons (Board, Settings) were rebuilt by geometry, not by eye. If they look off at 16px, say so.
- The "Recent" feed still lists quiet panes as history. Correct by design; tell me if it reads as nagging.
- ~~The bell dropdown closes on mouse-leave.~~ FIXED in 0.5.1 — click outside, Esc, or the bell itself.
- Zoom floor is 85%, not 80%.
- The installer is unsigned. See docs/SIGNING.md.

## If you want to roll back

Every previous installer is in `releases\`. 0.4.1, 0.4.0, 0.3.0 are all there.
