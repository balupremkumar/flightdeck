# QOL / shippability audit — Flightdeck

100 fit-and-finish items: the layer between "feature exists" (BACKLOG.md tracks that) and "feature feels shipped." Everything here assumes the BACKLOG's roadmap items land as planned — this is what's still missing once they do. IDs continue the BACKLOG sequence (215 items → 216-284 gap review → 285-384 here). ⭐ marks the 15 highest-leverage items — cheap to fix, disproportionate effect on first impression or trust.

---

## 1. First-five-minutes experience

285. ⭐ New Workspace defaults the directory field to `D:\Dev\ai\Harness` (`NewWorkspace.tsx:31`) — a hardcoded dev path from this machine ships to every user. Default to empty with a "Choose a folder to get started" placeholder, or the OS home dir.
286. No welcome/empty-state copy distinguishes "first ever launch" from "closed all workspaces" — `LauncherChrome` (`App.tsx`) shows the identical New Workspace dialog both times, no framing of what the app does.
287. Vendor "not installed" warning (`NewWorkspace.tsx:133`) is tooltip-only — a user with zero CLIs installed gets no upfront guidance or install link before hitting Create.
288. No sample/demo workspace to explore without real agent CLIs — a user with nothing installed yet can't experience anything but an error pane on first click.
289. Failed spawn (`Terminal.tsx:257`) writes the raw JS error string into the terminal — not human copy telling the user to check install/login for that vendor.
290. Layout tiles (1/2/4/6, `NewWorkspace.tsx`) have no one-line explainer of what a "pane" is — assumes the visitor already knows the multi-agent-cockpit concept.
291. Nothing hints Ctrl+K/Ctrl+B/Ctrl+, exist until the user opens Settings > Shortcuts — no in-context nudge on first use.
292. ⭐ Kanban board seeds with Balu's actual Flightdeck dev backlog (`boardStore.ts` `seedCards()`) — every new install opens Board to someone else's task list. Ship an empty board or a generic onboarding template.
293. ⭐ "starting" pane state is only a pulsing dot, no copy anywhere says "launching…" — a slow agent (auth prompt, npm postinstall) looks stuck with zero explanation.
294. Explorer topbar toggle is a dead click before a workspace exists or while on the Board view (`Cockpit.tsx:93` gates render on `active && view==="terminals"`) — no feedback that the toggle did nothing.

## 2. Micro-interactions

295. Topbar icon buttons (`.tb-ic`, `App.css:90`) have hover but no `:active` press state — clicks feel unacknowledged.
296. Board "New Task" and Broadcast "Send" buttons (`Board.css`, `Broadcast.css`) same gap — hover only, no press feedback.
297. Collapsed workspace rail relies on native `title` tooltips (`LeftPanel.tsx` `.lp-ic`) with browser-default timing/styling — clashes with the rest of the app's designed chrome.
298. Kanban card grip (`.card-grip`, `CardItem.tsx`) doesn't change cursor to `grab` on card hover — unclear the whole card, not just the grip, is draggable.
299. Explorer resize handle (`.ex-resize`, `Explorer.tsx`) has no hover colour cue, only a `.dragging` state — undiscoverable without trial.
300. Pane overflow menu's font-zoom +/− buttons (`PaneView.tsx` `.pmenu-zoom`) are mouse-only, 22×22 hit targets, no keyboard path.
301. Toasts auto-dismiss on a flat 3500ms timer (`ToastHost.tsx`) with no pause-on-hover — a broadcast partial-failure toast can vanish while being read.
302/303. Settings modal body and Command Palette results list both scroll (`overlays.css` `.set-body`, `.cmdp-list`) with no scroll-fade/shadow cue — no signal there's more content below the fold.
304. Drop-target visuals differ by surface with no shared grammar: panes use an inset ring, workspaces use background+left-bar, cards use an insert-line — three different "you can drop here" languages in one app.

## 3. Information honesty

305. Workspace "Xm ago" (`LeftPanel.tsx` `relTime`) has no tooltip with the absolute timestamp.
306. Broadcast "Last sent Xm ago" (`Broadcast.tsx` `relTime`) same gap.
307. Notification feed rows (`Notifications.tsx`) show state/vendor/workspace but no time at all — every item looks equally fresh.
308. Workspace roll-up (`LeftPanel.tsx` `rollup()`) buckets "starting" into the "running" count — a workspace reading "3 running" may really be "3 still launching."
309. Git branch pill (`PaneView.tsx`) shows a dirty dot but never a changed-file count — "1 file" and "40 files" look identical.
310. Kanban live-status chip (`CardItem.tsx`) shows relative time only ("2m ago"), no absolute time anywhere in the app for any timestamp.
311. Process-name chip (`.pproc`) shows a raw exe name ("node") with no tooltip explaining what it means to a non-technical user.
312. Kanban WIP-over state (`.col-count-over`, `Board.tsx`) turns red but doesn't explain why in-place, and doesn't warn on the drop that breached it.
313. Explorer's git dirty dot (`.ex-dirty-dot`) and PaneView's inline dirty dot use different sizes/positions for the identical signal.
314. "empty" workspace stat (`LeftPanel.tsx:339`) shares the idle grey with no icon — can't tell "never populated" from "emptied out."

## 4. Error & edge paths

315. No max-length guard on pane/workspace rename (`store.ts`) — a very long name can overflow `.pname`'s fixed 220px max-width in a crowded grid.
316. 9-pane custom layout (`NewWorkspace.tsx` `MAX_COUNT=9`) uses a plain `sqrt` grid (`PaneGrid.tsx` `rows()`) with no minimum-pane-width guard or warning before terminals become unreadably small.
317. Long cwd paths in the pane overflow menu / dirbtn truncate to a tooltip only — no quick way to see/select the full path without "Copy working directory."
318. Non-repo, git-missing, and git-timeout all collapse to the same "no pill" outcome (`PaneView.tsx` git poll catch) — loses diagnostic signal on why.
319. ⭐ Settings' Terminal > Scrollback value is persisted (`getTerminalSettings()`) but never read by `new XTerm({...})` in `Terminal.tsx` — the setting is a lie; scrollback is actually unbounded.
320. Terminal theme MutationObserver (`Terminal.tsx` `themeObserver`) fires on every `data-theme` change with no debounce — rapid theme-flipping thrashes `term.options.theme` repeatedly.
321. `git_status` invoke has no timeout — a network-drive or huge-monorepo cwd can hang a 30s poll cycle indefinitely.
322. Dragging a pane divider to its `minSize=10` (`PaneGrid.tsx`) can collapse a terminal near-zero width; xterm's `fit()` only try/catches "not measured yet," not a genuinely degenerate size.
323. `fs_list_dir` has no pagination/virtualisation in `Explorer.tsx` — a directory with thousands of entries renders every row into the DOM at once.
324. Closing the last pane leaves an empty, un-badged workspace open with no prompt to close the now-pointless workspace.

## 5. Keyboard completeness

325. Settings modal (`Settings.tsx`) has no focus trap — Tab can escape `.set-modal` into the app behind the scrim.
326. CardDetail (`board/CardDetail.tsx`) same gap, plus its title input isn't auto-focused on open (Command Palette's input is — inconsistent pattern).
327. Broadcast's only keyboard-reachable close is Esc; the visible `.bc-x` close button has no keyboard-parallel affordance called out.
328. ⭐ Settings has no Escape-key handler at all (confirmed: only `ov-x` click + scrim mousedown) — every other overlay (ConfirmDialog, CommandPalette, Broadcast, CardDetail) closes on Esc; Settings breaks the pattern.
329. Notifications feed/settings panel (`Notifications.tsx`) closes only on `onMouseLeave` — no Esc handler, unusable by keyboard/touch once opened by click.
330. Rename inputs (pane + workspace) have no `aria-label` distinguishing them from a generic text field for screen readers.
331. Kanban keyboard card-move requires a prior mouse click to select a card (`Board.tsx`) — no pure-keyboard path to select the first card and start moving it.
332. Pane overflow menu (`.pmenu`, portalled) closes on `onMouseLeave` only — no Esc handler for a keyboard user who opened it via Tab+Enter.
333. Workspace context menu (`.lp-menu`) only opens via right-click — no keyboard-reachable equivalent (Shift+F10, or a visible "…" button).
334. Pane header tab order shifts unpredictably per pane state (conditionally-rendered git pill, restart button) — never audited for a stable left-to-right sequence.

## 6. Visual coherence sweep (all 6 themes)

335. `.btn-danger` hardcodes `color:#fff` (`overlays.css:144`) instead of a token — every other surface resolves through `--on-accent`/`--on-warn`; this one won't adapt to a future inverted theme.
336. ⭐ Zero custom scrollbar styling anywhere (confirmed: no `scrollbar` rule in any `src/*.css`) — Settings, Explorer, Kanban columns, Notification feed, Command Palette, and pane scrollback all show the raw OS scrollbar against hand-tuned chrome.
337. High Contrast's `--glow` (`theme.css`) is a literal hex pair (`#FFD400`/`#000`), not built from a token — can't be touched consistently if High Contrast's accent is ever made adjustable.
338. The same "22×22 icon button, transparent, hover tint" pattern is hand-rolled separately in `Board.css`, `panes.css`, and `App.css` instead of one shared `.icon-btn` class.
339. No documented radius scale — pills at 999px, cards/menus at 8-10px, inputs at 5-7px, all chosen per-component with no `--radius-*` tokens in `theme.css`.
340. Dracula/Gruvbox/Nord terminal ANSI palettes (`terminal-theme.ts`) are hand-authored independently of those themes' app-chrome tokens (`theme.css`) — never cross-checked that terminal cursor/selection reads well against that theme's pane header.
341. Board's empty-column glyph is a literal "▢" text character (`Board.tsx:386`) while every other empty state uses a real SVG from the icon set — visually off-brand.
342. `App.css` still defines `.bell`/`.bell-menu`/`.bi-dot` etc. that look superseded by `Notifications.css`'s `.ntf-*` classes — dead CSS risking accidental collision.
343. Card priority stripe (`CardItem.tsx`) uses an inline raw-px `borderLeft: 2px solid` while the icon set's stroke width (1.6) is the app's other "signal thickness" — no shared scale.
344. `.pband` (pane status band) and `.col-accent` (Kanban column band) are the same "coloured bar = state" idiom but only one animates — no shared "signal chrome" component ties them together visually.

## 7. Copy polish

345. Board subtitle "drag a card to In Progress and an agent picks it up" (`Board.tsx:290`) overpromises — it dispatches to `card.agent ?? first installed agent`, not intelligent pickup.
346. Destructive-action copy alternates between "can't be brought back" (panes, workspaces) and "can't be undone" (board reset, card delete) for the same class of warning — pick one phrase.
347. Broadcast's placeholder text never explains *why* a pane was excluded (dead vs manually deselected) — only discoverable by hovering each chip.
348. ⭐ Settings > About is one flat sentence with no version number or build date (`Settings.tsx:438`) — nothing a user could quote in a bug report.
349. Toast copy has no house style: "Copied working directory." (past, full stop) vs "Restarting pane" (present continuous, no stop) vs "Sent to 4 panes" (past, no stop).
350. Explorer's error state ("Couldn't read this folder.") reads apologetic against the flat NZ-plain tone everywhere else.
351. ⭐ "not installed" chip in New Workspace is lowercase with no instruction — should read as a real sentence with an actionable next step, not a fragment.
352. Command palette's empty state ("No matches for…") gives no hint of what CAN be searched (workspaces/panes/actions) — dead end for a confused first search.
353. "Add" (card composer) vs "New Task" (board header) vs implicit-autosave (CardDetail) — three different mental models for "create/save a card" with no shared verb.
354. `ConfirmDialog`'s default label falls back to generic "Confirm" (`ConfirmDialog.tsx:32`) if a caller forgets `confirmLabel` — safe today, but a silent trap for the next dialog added.

## 8. Perceived performance

355. "Create Workspace →" has no loading/disabled state during the spawn round-trip — dialog closes instantly, terminal body is a blank canvas with no placeholder before first PTY output.
356. Explorer's `SkeletonRows` is well-built but no other async surface (Board, Settings, Notifications) has an equivalent shared skeleton primitive to reuse later.
357. Broadcast send shows one aggregate "Sending…" with no per-chip progress until the whole `Promise.allSettled` resolves (`Broadcast.tsx`).
358. Workspace switch is an instant `display:none/flex` cut with zero crossfade — jarring on a large 6-9 pane grid.
359. Pane restart (epoch bump) remounts `<Terminal>` to a blank body for one paint with no "restarting…" placeholder text.
360. Kanban's card→pane dispatch (`Board.tsx` `dispatchToPane`) shows no "dispatching…" state on the card between drop and the pane actually existing.
361. Theme switch snaps every surface instantly — even a short (100-150ms) colour transition, respecting the existing reduced-motion flag, would make the six-theme system feel deliberate.
362. Hidden-pane reveal (`Terminal.tsx` `flushHidden`) can write up to 256KB synchronously in one burst — visible stutter right when switching to a chatty background pane, undermining the feature meant to keep switching smooth.
363. Multi-pane workspace creation spawns every PTY at once with no stagger or "spawning 3 of 6…" indicator — a slow agent looks indistinguishable from a hung one during the pile-up.
364. Command Palette recomputes fuzzy scores over the full item list on every keystroke (`CommandPalette.tsx`) with no debounce — fine today, no perf guard as workspace/pane count grows.

## 9. Trust / ship signals

365. ⭐ Window title never reflects pane state (e.g. "● Flightdeck — 2 waiting") — the app's core value (know what needs you) is invisible from the taskbar/alt-tab.
366. No version number shown anywhere in the UI beyond Settings' one-line About sentence (see 348) — no way to identify which build is running.
367. No changelog/"what's new" surface at all — even a static view in Settings would signal active development.
368. ⭐ Taskbar flash silently no-ops (missing capability, per its own code comment in `Notifications.tsx`) while the Settings checkbox for "OS toast + taskbar flash" looks fully functional — a deceptive UI state, not just a missing feature.
369. OS toast permission (`Notification.requestPermission()`) fires on first trigger with zero in-app explanation — reads as a random unexplained system prompt.
370. No documented/enforced minimum window size — small-resize reflow (topbar icon wrap, pane grid below minSize) has never been tested.
371. ⭐ No React error boundary (tracked architecturally at BACKLOG 235) — flagging here specifically as a **ship-blocking trust risk**: one component throw blanks the entire cockpit, including every visible live terminal, for a tool whose entire pitch is "trust me with your multi-agent session."
372. App icon/branding hasn't been manually verified across every OS surface (taskbar, alt-tab thumbnail, Start tile) beyond assuming `tauri icon` regeneration nailed every size.
373. Whole-app quit (OS window X) has zero confirmation regardless of live sessions, while closing one pane or one workspace both confirm — the single most destructive action in the app is the only unguarded one.
374. Vendor "not installed" tooltip detail (`vendors.ts` `VendorInfo.detail`) exposes raw shell-probe output (e.g. a `where` command's literal stdout) as user-facing copy — reads unfinished.

## 10. Backend capabilities the UI wastes

375. ⭐ `pane_health` (`health.rs` — CPU%/memory per pane) is invoked nowhere in the frontend, not even as a hover tooltip on the process-name chip.
376. ⭐ `recover_orphans`/`kill_orphans` (`orphans.rs`) have zero UI surface — a user who force-quit once has no in-app way to find/clean stray agent process trees.
377. ⭐ `export_support_bundle` (`support.rs`, fully redacted and unit-tested) has no Settings button — the one feature built to make bug reports easy is invoke-only.
378. ⭐ `persist.ts`'s full client (save/load session, restore points, backup/import, safe mode) is implemented against `persist.rs` but imported by zero components — closing Flightdeck today silently discards every workspace/pane/board card with no warning that nothing survives a restart.
379. `is_safe_mode`/`has_previous_session` are unused — even a "reopen last session?" prompt needs these wired first; today they're dead code paths.
380. `git_status` is polled independently per-pane and per-Explorer for the same cwd (`PaneView.tsx` + `Explorer.tsx` each run their own 30s interval) — no shared cache, so a 6-pane workspace on one repo fires 6+ redundant git subprocess calls per cycle.
381. `fs_list_dir`'s permission-denied path shows a lock icon in Explorer but has no equivalent in New Workspace's folder Browse — picking a denied folder there just silently fails.
382. Job Object hardening (`job.rs`, shipped per STATE.md wave-2) has zero visible confirmation anywhere in the UI — an invisible reliability win that could double as a trust signal with one line of Settings copy.
383. `procname.rs`'s live process name feeds the pane header chip but never auto-suggests a smarter pane title (e.g. defaulting rename to the live process name instead of the static vendor label).
384. `support::redact()` (well-tested) is isolated inside `export_support_bundle` — no "copy scrollback (redacted)" sibling action exists in the pane overflow menu despite the backend groundwork already being done.

---

## Ship gate — minimum before calling this v1.0

Not everything above; these are the items that actively undermine trust or correctness if shipped as-is:

- **371** — a React error boundary. Non-negotiable: one bad render can't be allowed to blank a live multi-agent session.
- **378 + 373** — either wire persistence (BACKLOG R4) or, at minimum, warn on quit that nothing survives a restart. Silent data loss with zero warning is the worst version of this gap.
- **285 + 292** — kill the hardcoded dev-machine defaults (New Workspace directory, Kanban seed data). Five-minute fixes, first thing every new user sees.
- **319** — either wire the Scrollback setting into xterm or remove it from Settings. A setting that does nothing is worse than no setting.
- **328** — Escape must close every overlay, no exceptions. Settings is the one hole.
- **368** — either land the `allow-request-user-attention` capability (BACKLOG 270) or hide the taskbar-flash checkbox until it's real. Don't ship a control that lies about what it does.
- **336** — scrollbar styling pass across all six themes; it's the single most visible "this wasn't finished" tell in a polished dark-UI app.
- **375, 376, 377** — at minimum, one Settings > Diagnostics section exposing health, orphan recovery, and support-bundle export. All three are built and tested; leaving them invoke-only is the biggest built-vs-shipped gap in the app.
- **365, 366** — dynamic window title + a real version number. Cheapest possible trust signals, currently both zero.

Everything else in this file is real polish, worth doing, but won't make v1.0 look unfinished if it slips to v1.1.
