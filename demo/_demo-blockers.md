# Interactive demo — blockers, tradeoffs, assumptions

Scoped to `demo/**` only. Nothing here required a change to `src/**` or
`src-tauri/**` — where the real frontend genuinely couldn't be reached from
outside, the workaround lives in the shell page's own JS, not in the app.

## Vendor accents for new agents need no src change (assumption verified)

`vendors.ts`'s `accentCss()` already accepts either a theme token (`"--x"`)
or a literal hex string — the "opencode-local" fallback entry in the
original `mock-tauri.js` already exercises the literal-hex path. Codex
(`#FF9D5C`) and Kimi (`#C792EA`) use literal hex for the same reason: no
existing theme token, and adding one isn't warranted for a demo-only vendor.
Confirmed live in the QA screenshots — four distinct `VendorGlyph` colours
render correctly with zero `src/**` edits.

## Suggestion chips live in the shell footer, not inside a pane

`PaneView.tsx` has no chip slot above its terminal — adding one would mean
editing `src/**`, which is out of scope. Chips instead sit in the shell
page's footer (`demo/site/index.html`) and target whichever pane is
currently focused (`.pane.focused`), via the same mechanism a real
clipboard paste uses: focus the pane's xterm helper textarea and dispatch a
`paste` `ClipboardEvent` carrying `"<prompt>\r"`. xterm.js's own paste
handler picks it up and calls `onData`, which is exactly the code path
Terminal.tsx already wires to `pty_write` — so a chip click and someone
actually typing + pressing Enter are indistinguishable to the app.

Tradeoff: chips are global (one set of 4), not per-pane/per-vendor as the
brief's ideal ("3-4 suggestion chips per pane"). A visitor has to click a
pane to focus it, then a chip. The footer hint text ("Click a pane to focus
it, then a prompt above…") exists specifically to cover this.

## needsTrust is forced off for every mocked vendor

The real trust gate (`trust.ts`) only fires on the "add a pane" path
(`worktrees.ts`'s `ensureTrusted`), not on session hydrate — so it never
appears on boot regardless. Antigravity's registry entry ships with
`needsTrust: false` here (vs. `true` in the real registry) so that if a
visitor adds a 5th pane via the "+" button, they get straight into a working
pane instead of a "Let Antigravity work in this folder?" consent modal that
has nothing to do with the point of a marketing demo.

## `git_diff_summary` / `pane_usage` poll on the real product's own cadence

`PaneView.tsx` polls diff stats and token usage every 30s / 15s
(`GIT_POLL_MS`, unchanged product code) — a diff badge or token chip can
take up to ~30 real seconds to appear after an edit, same as the shipped
app. The QA script's wait times account for this; it is not mock latency.

## Same-document mount, not an iframe

`#root` (the real app's mount point) sits directly inside the window-chrome
frame in `demo/site/index.html` — same document as the shell chrome, no
iframe. Reasons: keyboard focus (typing into a pane, `Ctrl+K`, `Ctrl+B`,
the whole-app zoom shortcuts) needs zero postMessage bridging this way, and
there's no cross-origin isolation need since the shell CSS uses an `fd-`
prefix disjoint from the app's own class names — no cascade collision to
guard against. The one thing this rules out is CSS containment if a future
skin wants an entirely separate stacking context; not needed here.

## `window.__TAURI_EVENT_PLUGIN_INTERNALS__` stub added

`@tauri-apps/api/event`'s `listen()` return value calls
`window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(...)` directly
(not through `invoke`) on unlisten. Neither this file nor the original
`mock-tauri.js` set that global, so every `Terminal.tsx` teardown threw
`Cannot read properties of undefined (reading 'unregisterListener')` into
the console. Fixed here with a one-line no-op stub (real cleanup already
happens via the `plugin:event|unlisten` invoke call alongside it). Did not
touch `mock-tauri.js` — out of scope for this build, and the scripted video
capture never triggers enough pane teardown to hit it.

## `reveal_in_explorer` added (missing from the original mock)

`reveal.ts` calls `reveal_in_explorer`, which doesn't exist in
`mock-tauri.js`'s handler table (a newer Rust command added after that file
was last touched). Added here as a best-effort no-op so "Reveal in
Explorer" in a pane's overflow menu doesn't produce an error toast in the
live demo.
