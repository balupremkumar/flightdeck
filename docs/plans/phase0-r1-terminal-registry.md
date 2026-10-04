# Phase 0 / R1: terminal session registry

Fix for R1 (layout reflow kills running agents).
Roadmap item P4 in [qol-roadmap](qol-roadmap-2026-10-04.md).

## Cause (confirmed in code)
`rows(n)` (src/PaneGrid.tsx:12) reshapes rows by pane count, and each row is its own horizontal `PanelGroup` (:136-165), so a pane that changes row gets a new parent and React remounts PaneView, then Terminal.
Terminal's mount effect (src/Terminal.tsx:596-1415, deps `[vendor, cwd]`) owns the xterm and the PTY, so its cleanup (:1374-1411) runs `pty_kill` (:1404) and `term.dispose()` (:1406), and the next mount runs `pty_spawn` (:1275).
Same path on close (siblings shift rows), cross-row drag, and `movePaneToWorkspace` (pane changes PaneGrid).

## Approach
Move ownership of the xterm and the PTY out of React into a module-level registry keyed by `PaneModel.id`.
React components only attach and detach a persistent DOM host; they never create or kill.
Tradeoffs considered:
- Registry at Terminal level (chosen) vs reverse-portal of the whole PaneView: the registry is the multi-window foundation and keeps PTY lifetime out of React entirely; PaneView-local state is handled by step 11.
- Kill via explicit funnels plus an orphan sweep (chosen) vs kill purely by "pane gone from store": funnels keep kill intent explicit; the sweep stops leaks from any future path.
- Keep react-resizable-panels and accept reparenting (chosen) vs flat CSS grid: grid rejected, loses draggable dividers.

## (1) Module: `src/paneSessions.ts`
Name chosen so it cannot case-collide (no `PaneSessions.tsx`, `session.ts` is distinct). Never add a component with the same lowercase name.
Per entry (Map<number, PaneSession>, key = PaneModel.id):
```ts
interface PaneSession {
  modelId: number;
  gen: string;                 // `${epoch}|${vendor}|${cwd}`; mismatch = restart
  term: XTerm;
  host: HTMLDivElement;        // term.open(host) once; this node is what moves
  addons: { fit; search; webLinks; unicode11; webgl?; serialize?; ligatures? };
  ptyId: number;               // Rust id, 0 until pty_spawn resolves
  handlers: PaneHandlers;      // onExit/onState/onProc/onBell/onLine/onScrollAway/onProgress/onCwd/onSetupConsumed; replaced every render
  live: { osc52; quietMs; fontSize; ligatures };  // was osc52Ref/quietThresholdRef/fontSizeRef
  api: { jumpMark; showHints; remeasure };        // was jumpMarkRef/showHintsRef/remeasureOverlaysRef
  owner: symbol | null;        // current attach token
  saved: { viewportY; atBottom; hadFocus };
  disposers: (() => void)[];   // unlisten x4, scrollDisp, writeDisp, io, ro, themeObserver, rafs, timers, marks, overlays, pathLinks
  disposed: boolean;
}
export function acquire(modelId: number, spec: SpawnSpec, handlers: PaneHandlers): PaneSession; // idempotent; gen mismatch => dispose(old) then create
export function attach(modelId: number, container: HTMLElement): symbol;  // move host in, fit, restore scroll + focus
export function detach(modelId: number, token: symbol): void;            // park host if token is still owner; NEVER kills
export function dispose(modelId: number): void;                          // pty_kill + full teardown; idempotent
export function get(modelId: number): PaneSession | undefined;
export function sweepOrphans(liveIds: ReadonlySet<number>): void;
```
`SpawnSpec = { vendor, cwd, epoch, setup?, initialDraft?, restoredScrollback?, fontSize }`; setup, draft and scrollback are consumed only at creation.
The registry knows nothing about workspaces, grids or windows.
Phase 4 note: a JS heap cannot span webviews, so cross-window move will be "detach here, adopt existing ptyId there"; leave room for `spec.adoptPtyId` later, and prefer Rust keying PTYs by PaneModel.id then.

## (2) Reparenting
- Create `host` (div, 100% x 100%) and `term.open(host)` once at creation; WebGL loads after open, as today (:649-653).
- `attach`: `container.moveBefore?.(host, null)` (Chromium 133+, WebView2 has it; keeps the node connected, preserves focus), fall back to `appendChild`. Then `fit.fit()` (guarded), `term.refresh(0, term.rows - 1)`, restore `saved.viewportY` (or `scrollToBottom` if `atBottom`), `term.focus()` if `hadFocus`.
- `detach(token)`: if `owner === token`, record `saved`, move host into a body-level park div (`position:fixed; left:-10000px; visibility:hidden; pointer-events:none`, sized to the host's last rect so nothing reflows or sends `pty_resize`). Stale tokens are ignored, so effect ordering cannot park a host the new owner holds.
- Observers move from the React `el` to `host`: IO (:1126) then reports hidden while parked or in a `display:none` workspace (existing hidden-buffer path), RO (:1349) keeps its <24px guard. The `mousedown` hintBlur (:825, :1389) also moves to `host`.
- Overlays, decorations, path-link tooltip and sticky strip live in `term.element`, so they travel with the host.
- WebGL: moving a canvas does not lose its context. The real risk is Chromium's cap (~16 live contexts per page) once many panes exist across workspaces. Keep `onContextLoss`: dispose the addon, clear `addons.webgl`; on the next `attach` try one fresh `WebglAddon` (one retry per attach, no loop), else stay on DOM. If glyphs look stale after a move, call `term.clearTextureAtlas()` in attach.

## (3) What leaves the effect cleanup
Everything in Terminal.tsx:1374-1410 moves to `dispose()`: observers, rafs, timers, overlays, marks (:1393), disposables, the four unlistens (:1399-1402), `publishPaneProgress` (:1403), `pty_kill` (:1404), `term.dispose()` (:1406).
The post-spawn guard `if (disposed) pty_kill` (:1298) stays, reading `entry.disposed`.
The new React cleanup does `detach(modelId, token)` and nothing else.
Kill triggers (the only ones):
- `closePaneWithCleanup` src/worktrees.ts:179: call `dispose(pane.id)` before `closePane` at :180. Covers PaneView.tsx:222/:230, PaneOps.tsx:62/:170, worktrees.ts:199/:208 (closePaneGuarded, used by Cockpit.tsx:217, CommandPalette.tsx:201, Review.tsx:383).
- `closeWorkspaceWithCleanup` src/worktrees.ts:187: `dispose` every `ws.panes[i].id` before `closeWorkspace` at :189. Covers worktrees.ts:215/:223 (Cockpit.tsx:215, PaneGrid.tsx:122), LeftPanel.tsx:302/:305, session.ts:405 (adoptSession).
- Restart: `restartPane` (store.ts:258) bumps epoch; `acquire` sees a new `gen` and disposes then recreates. Callers PaneView.tsx:1085/:1120, PaneOps.tsx:57/:157, CommandPalette.tsx:176/:269. Keep `key={pane.epoch}` (PaneView.tsx:1315) as is.
- Safety net: `sweepOrphans` on a `useApp.subscribe`; any entry whose id is in no workspace is disposed and logged via applog as "missed close path". The 700ms worktree-removal delay (worktrees.ts:183, :191) still follows the kill.

## (4) rows(): yes, append-stable within tiers
No pure function of n keeps both 3-in-a-row and a 2x2 four, and 4 is the default workspace.
Use index-contiguous rows with a column cap by tier: cap 2 for n<=4, 3 for n<=9, 4 for n<=16, then `ceil(sqrt(n))`.
Result: 1 `[0]`, 2 `[0,1]`, 3 `[0,1][2]`, 4 `[0,1][2,3]`, 5 `[0,1,2][3,4]`, 6 `[0,1,2][3,4,5]`, 7-9 rows of 3.
Adds are stable except at 4->5 and 9->10; those, closes and cross-row drags still reparent, which is now harmless.
Add `id={String(pane.id)}` and `order` to cell Panels (and row Panels) so react-resizable-panels keeps sizes sane across reshapes.

## (5) StrictMode
main.tsx:75 wraps in StrictMode, so dev runs mount, cleanup, mount.
`acquire` is idempotent per `(modelId, gen)` and cleanup only detaches, so the second mount reuses the entry: one spawn, zero kills.
Use `useLayoutEffect` for acquire/attach/detach so the move lands before paint (no blank frame), and in one commit old detach runs before new attach.
HMR: preserve the Map through `import.meta.hot.data` in paneSessions.ts, or a hot reload of that module orphans live PTYs.

## (6) Checklist (each step ends green on `npm test`, `tsc`, `npm run build`)
1. Gate first: new `demo/reflow-smoke.mjs` (Playwright, dev server + mock-tauri-interactive.js), wrapping invoke to count `pty_spawn`/`pty_kill` by id. Scenarios: 3->4->5, close one, cross-row drag, move to other workspace. Assert zero kills, spawns equal panes created, a typed marker still in pane 3's `.xterm-rows`, ElementHandle of pane 3's `.xterm` still `isConnected` and identical. Must fail today. Add to tools/release.ps1 beside pane-smoke.
2. paneSessions.ts skeleton: types, Map, `get`, `dispose` (kill once, idempotent), HMR preserve. Vitest with mocked invoke: dispose kills once, second dispose no-op.
3. Move creation part A (Terminal.tsx:597-1024: XTerm, addons, OSC 52, overlays, marks, key handler) into `createSession`, `el` to `host`, refs to entry fields, props callbacks to `entry.handlers.x?.()`. Test: build + pane-smoke.
4. Move part B (:1026-1372: write queue, hidden buffer, IO/RO, theme observer, listeners, spawn) the same way. Test: pane-smoke, output streams in mock.
5. Move teardown (:1374-1410) into `dispose`. Vitest: every disposer called, `pty_kill` with the entry's ptyId.
6. `attach`/`detach` with park div, owner token, moveBefore fallback, scroll/focus save-restore, WebGL refresh/retry. Vitest: stale token ignored; detach never invokes `pty_kill`.
7. Rewire Terminal.tsx: new `paneId` prop (PaneView passes `pane.id`), layout effect acquire+attach, cleanup detach, handlers synced each render, live-prop effects (:1418-1448) write `entry.live`/addons, imperative handle via `get(paneId)`. Test: reflow-smoke passes the 3->4->5 scenario; dev StrictMode shows one spawn per pane.
8. `gen` restart path. Test (reflow-smoke): restart = exactly 1 kill + 1 spawn, old scrollback gone, draft re-typed.
9. Explicit `dispose` in worktrees.ts:180 and :189. Test: close pane = exactly 1 kill with that pane's pty id; close workspace = one per pane.
10. `sweepOrphans` subscription + applog warning. Vitest: removing a pane via `useApp.setState` directly disposes it and logs.
11. Lift PaneView live prefs (fontSize, ligatures, osc52, quietSec; PaneView.tsx:248-264) to seed from `entry.live`, so a PaneView remount keeps them. Test: zoom pane 3, go 4->5, zoom unchanged.
12. `rows()` tiers + Panel `id`/`order`. Vitest table for n=1..17; reflow-smoke 2->3->4 shows no reparent (handle identity and parent unchanged).
13. Real-app pass (restart-app skill): live claude in pane 3, do 3->4->5, cross-row drag, move workspace; same process (pty://proc / Task Manager PID), marks jump, focus kept.

## (7) Risks and how the gates catch them
- Leak: entry never disposed (new close path skips the funnel). Sweep disposes and logs it; step 10 vitest covers it; applog shows "missed close path" in the field.
- Double kill or kill of the wrong PTY: dispose idempotent and keyed by modelId; reflow-smoke asserts kill ids.
- Hidden workspaces: still mounted with `display:none`; IO on host buffers (256KB cap, :504) and flushes on reveal; moving a pane into a hidden workspace attaches to a 0x0 container, RO guard skips fit. reflow-smoke moves to a background workspace and back.
- Restart semantics: restart must still give a clean pane; scrollback restore only when `epoch === 0` (PaneView.tsx:1320), applied only at creation. Step 8.
- vendor/cwd change: folded into `gen`, so it behaves as restart, the only intended kill outside close. Nothing should write OSC 9;9 into `PaneModel.cwd` (see Terminal.tsx:494-498) or every `cd` becomes a restart.
- Stale callbacks: handlers are captured at creation today; the registry must call `entry.handlers` (latest), else events route to an unmounted PaneView. Step 7 test: state badge updates after a reshape.
- Vitest mocks xterm, so it cannot see reparenting, WebGL or focus. The real gates are reflow-smoke.mjs and pane-smoke.mjs on the mock, plus step 13 on the real app; `tsc`/build catch case collisions.

## Separate bug found (fix in its own commit)
Terminal.tsx:1323 calls `setPaneDraft(paneId, ...)` with the Rust pty id, but the store matches `PaneModel.id` (store.ts:254).
Both counters start at 1 (lib.rs:189-193, store.ts:98), so it only goes wrong after a restart or out-of-order spawn, then the draft lands on the wrong pane or nowhere.
Use `entry.modelId` once the registry exists.
