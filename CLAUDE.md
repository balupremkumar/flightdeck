# Flightdeck — architecture notes

## Overlay Escape handling

Every dismissible overlay (modal, drawer, dropdown, context menu, popover) closes on Escape through the shared stack in `src/ui.ts`, not its own `window.addEventListener("keydown", ...)` listener.

Use the hook: `useOverlayEsc(open, onClose)`, imported from `./ui`.
Call it unconditionally on every render, passing whether the overlay is currently open and the function that closes it.
It registers on the shared stack while `open` is true, and unregisters on unmount or when `open` goes false, restoring focus to whatever had it before the overlay opened (pass `{ restoreFocus: false }` to opt out — e.g. a transient dropdown whose trigger already holds focus).

Cockpit.tsx has exactly one global Escape listener, which calls `closeTopOverlay()`.
That closes only the most-recently-opened overlay and does nothing else.
Do not add a second global Escape listener anywhere else in the app.

Why this exists: before the stack, every overlay listened for Escape independently.
With two overlays open at once, one Escape press fired every listener and closed more than the top one.
The stack fixes that by construction — `pushOverlay`/`popOverlay` are plain LIFO, so whichever overlay opened last (e.g. a confirm dialog opened from inside an already-open drawer) is on top and consumes the next Escape first, with no manual ordering/priority code needed anywhere.

What does NOT go on the stack: a local `onKeyDown` on an input/row that handles Escape to cancel just that widget (an inline rename field, a find box, a filter box, a raw key-combo capture field).
Those aren't overlays, must keep working even when nothing is registered on the stack, and should stay exactly as a plain local handler.

See the overlay-stack comment block in `src/ui.ts` (search `UX-542/543`) for the full mechanics, and `Broadcast.tsx` / `Notifications.tsx` for reference usages.
