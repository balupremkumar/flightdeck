# Flightdeck demo assets

## `walkthrough.mjs` — the product walkthrough (current)

Records an ~80s walkthrough of the **real Flightdeck UI** to
`out/flightdeck-walkthrough.webm`.

Everything on camera is the actual application: real components, real CSS, real
state machine. Only the *backend* is simulated — `mock-tauri.js` installs a fake
`window.__TAURI_INTERNALS__` that answers every command the frontend calls and
streams scripted agent output over the real `pty://` events.

That distinction is the point. The previous reel (below) was a hand-drawn
recreation, which looked right the day it was built and then quietly drifted:
worktrees, the review drawer and the attention queue all landed afterwards and
none of them were in it. A recording of the real UI cannot misrepresent the
product, because it *is* the product.

**Recording:**

```
npm run dev          # from the project root — serves the real frontend
cd demo
node walkthrough.mjs # add --slow for a calmer cut
```

Scenes: first-run launcher → workspace setup (isolation + setup command) →
per-repo trust consent → four live agents → diff badges → an agent blocked on
approval → attention queue → review drawer (split diff, word-level highlighting,
partial merge) → merge/PR → board → diagnostics → close.

**Captions and cursor** are injected by the script, so the video is finished on
export — no editing pass, and re-recordable in one command after a UI change.

**Honesty guards.** Scenes that narrate a specific state only play if that state
is genuinely on screen: the "one agent needs you" caption waits for a real
`.pattn.permission`, and the attention-queue caption only fires if the overlay
actually opened. If a scene can't be demonstrated it is skipped with a warning
rather than narrated over the wrong frame. The recorder also syntax-checks
`mock-tauri.js` before spending a take — a broken mock fails silently otherwise,
and you get 80 seconds of an app with no agents in it.

**Reviewing a take:** `node _frames.mjs 20 44 56` writes frames to
`../e2e-shots/frame-*.png`. Watch the output before shipping it; several real
bugs were found this way (see the git log for the walkthrough commit).

## `reel.html` + `reel.js` — superseded

The original motion-graphics recreation, kept for reference. It predates
worktree isolation, the review drawer, the attention queue and the board's agent
dispatch, so it **understates the product** — don't ship it. Recorded via
`npm run record`.

## Other rigs

- `e2e-session8.mjs` — the E2E assertion suite (26 checks).
- `visual-check.mjs`, `visual-check-worktrees.mjs` — screenshot rigs for manual QA.
