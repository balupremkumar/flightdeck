# Video production blockers / workarounds

Scoped to `demo/**` only — nothing here required a change to `src/**` or `src-tauri/**`.

## Native HTML5 drag-and-drop hangs under headless Chromium automation

The board beat (dragging a card into "In Progress") needed a real drag gesture
against `Board.tsx`'s native HTML5 DnD handlers (`draggable`, `onDragStart`,
`onDragOver`, `onDrop`).

Two standard approaches were tried and both **hang indefinitely** in headless
Chromium under Playwright automation:

- `locator.dragTo(target)` — Playwright's built-in helper.
- A manual `mouse.move → mouse.down → mouse.move (stepped) → mouse.up`
  sequence.

Both stall past a 2-minute timeout with no error — this is a known class of
issue where headless Chromium's native drag session doesn't resolve without a
real OS-level drag loop.

**Workaround**: `Board.tsx`'s drag handlers only read React state set inside
`onDragStart`/`onDrop` (`dragId`, `dragOverCol`, etc.) — they never inspect
the `DataTransfer` payload itself. So `demo/showcase.mjs`'s `dragCardToColumn()`
dispatches real `DragEvent`s (`dragstart` → `dragenter` → `dragover` → `drop`
→ `dragend`) directly via `element.dispatchEvent(new DragEvent(...))`, with a
short **real** wait between each dispatch so React's state update flushes and
re-renders before the next handler reads a fresh closure. Dispatched
synchronously back-to-back (no waits), the card never moves — `dragId` is
still `null` in the next handler's closure because React batches the state
update to a microtask that hasn't flushed yet.

The visible cursor + card-lift motion on camera is the rig's own cursor
actor, driven in lockstep with the dispatch sequence — it's not relying on
the (hung) native drag visuals at all.

## Trust prompt is mandatory, not optional — cost a full disposable test render

`walkthrough.mjs` (the previous baseline) treated the "consent, once per
repo" `.confirm-modal` as an optional, defensive check ("if it happens to
appear"). It is **not optional**: creating a workspace with an Antigravity
slot (`needsTrust: true` in `vendors.ts`/mock) always opens "Let Antigravity
work in this folder?", and pane creation is blocked entirely — zero panes
spawn — until it's dismissed. A single fixed `hold(900)` then one-shot
`.confirm-modal .btn-primary` check missed the window often enough in
practice that an entire first test render produced a workspace with **0
panes**, silently failing every downstream beat (`.pdiff` diff badge,
`.pattn.permission` attention state, the review drawer) for the rest of the
video with no hard error — each one just logged "not found" and the scene
carried on emptily. Root-caused with a throwaway probe (poll for
`.confirm-title` every 200ms instead of a fixed wait — appears reliably
within ~200-400ms of the Create click, confirmed panes: 4 and `.pdiff`/
`.pattn.permission` populated correctly once actually dismissed).

Fixed in `showcase.mjs`: the create-workspace step now polls for
`.confirm-modal .btn-primary` (up to ~3.5s) instead of a single timed check,
before continuing. No scene/caption was built around this beat — it isn't
part of the locked story — it's just reliably dismissed now.

## Mock content upgraded

`mock-tauri.js`'s `pwsh` script was `npm ci` output only — reused verbatim
across any pwsh pane. For the "four differentiated panes" beat it's now a
green `vitest run` (3 files, 23 tests, all green), so the fourth pane in the
grid scene reads as real work rather than a generic install log. Nothing
else in the mock was changed; the claude / claude-approval / agy /
agy-refactor scripts were already distinct.
