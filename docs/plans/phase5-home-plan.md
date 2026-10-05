# Phase 5 E3: Home view (implementation plan)

Status: plan only. Inputs: [phase5-home-design.md](phase5-home-design.md) (Lead decisions binding), [phase4-multiwindow.md](phase4-multiwindow.md) red team addendum (binding).
Home is a per-window overlay over this window's `useApp.workspaces`; it never assumes one window.

## Found while grounding (fix first, separate change)

`pty_write` takes the Rust pty id, not `PaneModel.id` (store.ts:122-125 says so; lib.rs:254 allocates pty ids separately).
Broadcast.tsx:105, Review.tsx:592 and CommandPalette.tsx:418 pass the model id, so after any restart or session restore the text goes to the wrong pane or is silently dropped (lib.rs:653 returns Ok for an unknown id).
The design spec's reply path (section 0, "Broadcast.tsx:104") copies this bug; Home must not.
ChatView.tsx:651/663 and Terminal.tsx:792-793 resolve the pty id correctly via `paneSessions.get(modelId)?.ptyId`.

## Files

Add `src/home.ts`: pure model (classification, cards, sort, approve key, key guard), the session-only `replyDrafts` and `mergedPanes` maps, and the `OtherWindowSummary` type.
Add `src/HomeOverlay.tsx` (component `HomeOverlay`; distinct from `home.ts` per CLAUDE.md) and `src/HomeOverlay.css`.
Add `src/homePoll.ts`: the shared diff/PR poll store (zustand) plus `useHomePoll(open, targets)`.
Add `src/home.test.ts`, `src/homePoll.test.ts`, `e2e/home.mjs`.
Add `src-tauri/src/plaintail.rs`: `pub fn plain_lines(bytes: &[u8], max_lines: usize) -> Vec<String>` with cargo tests.
Change `src/paneSessions.ts`: add `writeToPane(modelId: number, data: string): Promise<void>` (rejects when no session or `ptyId` is 0).
Change `src/ui.ts`: `homeOpen` / `setHomeOpen` beside `attentionOpen` (ui.ts:144, :368); each setter closes the other.
Change `src/Cockpit.tsx`: chord after the Ctrl+Shift+A block (Cockpit.tsx:179-183); home-open guard after the Escape block (:106-109); titlebar button before `<Notifications />` (:377); `{homeOpen && <HomeOverlay />}` beside AttentionQueue (:414).
Change `src/settingsStore.ts`: `{ id: "home", label: "Open Home", combo: "Ctrl+Shift+H" }` in FIXED_SHORTCUTS after :176, so the cheat sheet, palette hints and Phase 4 S10 chord picking all see it.
Change `src/CommandPalette.tsx`: `act:home` after :311 and `"act:home": "home"` in ACTION_SHORTCUT_ID (:163).
Change `src/Notifications.tsx`: "Open Home" link beside :725.
Change `src/Review.tsx`: after a full merge (:471, `allSelected`), call `markPaneMerged(pane.id)`.
Change `src-tauri/src/ring.rs` (`PaneRing::tail`), `paneout.rs` (`PaneOut::tail`), `lib.rs` (`pane_tail` command, registered beside `pane_pause` at :996).
Change `demo/mock-tauri-interactive.js`: `pane_tail` handler fed by a per-pty text buffer in the emit wrapper (:33); `pty_spawn` records modelId to pty id (:632).

## Chord

Ctrl+Shift+H is free: no handler matches `h` anywhere in src (grep of `key === "h"`, `KeyH`, ctrl+shift combos: only A, M, R, Space at Cockpit.tsx:179, PaneView.tsx:720, SessionLauncher.tsx:76, Terminal.tsx:1290), and the only Rust global is Ctrl+Alt+F (summon.rs:61).
Not guarded by terminal focus, same reasoning as Cockpit.tsx:173-178; xterm would send ^H, which no shipped TUI binds to the Shift variant.

## Pure functions (home.ts, vitest)

`type HomeColumn = "needs" | "working" | "merged" | "review" | "idle"`.
`interface HomeCtx { now: number; snoozed: Record<number, number>; lastLine: ReadonlyMap<number, string>; stateSince: ReadonlyMap<number, number>; lastOutputAt: ReadonlyMap<number, number>; diff: Record<string, DiffStat | null | undefined>; pr: Record<string, PrInfo | null | undefined>; merged: ReadonlySet<number>; isAgent: (vendor: string) => boolean }`.
`classifyPane(p: PaneModel, ws: Workspace, ctx: HomeCtx): HomeColumn`: precedence needs > working > merged > review > idle, exactly the spec table.
`buildHome(workspaces: Workspace[], ctx: HomeCtx): { columns: Record<HomeColumn, HomeCard[]>; needsCount: number }`.
Needs column is `needsHumanQueue(workspaces, snoozed)` (attention.ts:148) verbatim, including shell panes, so the header count always equals the bell; `isAgent` (vendors.ts:94 `kind === "agent"`) filters only columns 2-5.
`HomeCard { paneId; wsId; column; vendor; title; wsName; branch?; since; activity: string | null; kind: AttentionKind | null; diff?: DiffStat | null; pr?: PrInfo | null; snoozedUntil?: number }`; `undefined` means not fetched (skeleton), `null` means none (omit row).
`prCwd(p: PaneModel, ws: Workspace): string` = `p.worktreePath ?? ws.root`, so the key matches WorkspaceChips.tsx:29 and shares its cache.
`approveKeyFor(vendor: string, tail: string[]): string | null`: Claude/agy numbered menu with the `❯` on `1. Yes` returns `"\r"`; codex approval overlay (CODEX_PROMPT_RE, attention.ts:76) returns `"y"`; literal `(y/n)` returns `"y\r"`; anything else returns null (Open only, never a guess).
`homeKeyAllowed(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): boolean`: while Home is open Cockpit handles only Ctrl+Shift+H, Ctrl+Shift+A, Ctrl+, and zoom; everything else (backtick, bare 1-9, Alt+1-9, Ctrl+Alt arrows, Ctrl+Tab, Ctrl+W, Ctrl+B) returns early so no pane behind Home is focused.
Tests: every precedence pair, snoozed pane lands in Idle with `snoozedUntil`, merged outranks review, shell pane in error counted in needs but not in idle, sort orders per column, ragged nulls, approve fixtures per vendor including a moved cursor (null).

## Shared poll store (homePoll.ts)

Lifecycle: `useHomePoll(open, targets)` runs two `usePoll` loops (poll.ts:75) with `enabled = open`, so it costs nothing while Home is closed and stands down when the window is hidden.
Diff loop every 15 s: `cachedInvoke("git_diff_summary", { cwd: p.cwd, base: p.baseBranch ?? null }, 15000)`, the exact args and TTL of PaneView.tsx:550-553, so visible panes hit the same cache entry.
PR loop every 60 s: `cachedInvoke("pr_status", { cwd: prCwd }, 55000)`, the exact args and TTL of WorkspaceChips.tsx:29.
Throttle: dedupe targets by cwd, order Needs you, Ready, Working, then the rest, run at most 3 invokes concurrently, and drop a cycle if the previous one is still running.
A cwd that rejects is memoised as `null` for the life of the open session (cachedInvoke never caches failures, poll.ts:52), so non-repos are not re-spawned every 15 s.
Never calls `ciTransition` or pushes toasts; the bell stays the only alert source.
No new Rust command for diff or PR: `git_diff_summary` (worktree.rs:1069) and `pr_status` (ghpr.rs:56) are already `#[tauri::command(async)]`.
Gap: `pr_status` returns None for both "no PR" and "gh missing" (ghpr.rs:64), so the spec's "gh not found" header notice is not derivable; v1 omits PR chips silently.
Multi-window: targets come from this window's store only, so polling is already gated to owned panes (addendum item 10, S5).

## Peek: `pane_tail`

`#[tauri::command(async)] fn pane_tail(reg: State<'_, Registry>, model_id: u32, max_bytes: u32) -> Result<PaneTail, String>`, `PaneTail { lines: Vec<String>, seq: u64 }`, serde camelCase.
Lock order per paneout.rs:8-10: `out_for_model` (lib.rs:497) clones the Arc, then `lock_out`, copy `PaneOut::tail(max_bytes.clamp(1024, 65536))`, release, then strip outside the lock.
`PaneRing::tail(max)` copies only the last `max` bytes, starting after the first LF in that window (or at the window start if none); it never clones the 4 MiB body like `snapshot()` (ring.rs:419).
ANSI is stripped Rust side, returning at most 40 lines.
Why Rust: the IPC payload is a few KB of text instead of base64 bytes, the stripper sits beside ring.rs and its fixtures under cargo, and it can apply CR overwrite and treat cursor-addressed redraws (CUP, VPA, CUU/CUD, ED) as line breaks, which Terminal.tsx:1419-1420's CSI/OSC regex does not; a second ad-hoc JS stripper would drift.
`plain_lines` rules: drop CSI, OSC/DCS/APC/PM/SOS to BEL or ST, and two-byte ESC; CR resets the line; BS pops; lossy UTF-8; trim right; drop blank and box-drawing-only lines; collapse consecutive duplicates.
The tail is shown in-app only, never logged or put in the support bundle.

## Reply path and focus

Send: `writeToPane(card.paneId, text + "\r")` resolves the pty id and calls `invoke("pty_write", { paneId: ptyId, data })` (lib.rs:648, stays sync per addendum line 175); no session or rejection shows the inline error with text kept.
Not `sendToPane` (store.ts:138): it is fire-and-forget and cannot surface a failure.
Approve: re-check at click time that the pane is still `permission` and `pane_tail.seq` equals the seq the prompt was rendered from; otherwise re-peek and do not send.
Escape always closes Home through the stack (Cockpit.tsx:106 runs in window capture before any field handler), so the spec's "first Esc clears the field" is replaced by drafts kept per pane in `replyDrafts` and restored on reopen.
`useOverlayEsc(homeOpen, close, { restoreFocus: false })` (ui.ts:638), because its deferred focus restore (:649-654) would steal focus from a pane opened from a card.
Dismiss (Escape, Close, Ctrl+Shift+H): Home restores the element it saved on open.
Open a pane (Enter or click): close Home, `switchWorkspace`, `focusPane`, then next frame `paneSessions.get(id)?.term.focus()` as PaneView.tsx:711 does (chat-view panes leave focus to PaneView).
After Send, focus moves to the next Needs you card; Home stays open.
Home closes itself when the active workspace or its focused pane changes from outside (bell row Notifications.tsx:643, summon :615/:634), so no jump path needs editing.
Cards are keyed and focused by pane id, never index, so a 10 s re-sort (tick as AttentionQueue.tsx:34) never moves focus.

## Multi-window seam

`OtherWindowSummary { label: string; title: string; needsYou: number; working: number }`; `otherWindowSummaries(): OtherWindowSummary[]` returns `[]` in v1 and the footer strip renders nothing.
S11 wires it to `win://summary`; a row click calls `window_focus_pane(label, wsId, paneId)` and closes Home; no remote reply.

## Steps (each 30-60 min, each shippable)

0. Fix the pty id bug: add `writeToPane`, switch Broadcast.tsx:105, Review.tsx:592, CommandPalette.tsx:418. Reproduce first in the mock (restart a pane, broadcast, text lands elsewhere). Tests: paneSessions.test.ts (uses ptyId, rejects without session); e2e step in `e2e/home.mjs` scaffold that restarts a pane then broadcasts.
1. `home.ts` pure model, dark. Tests: `home.test.ts` as listed above.
2. Entry and skeleton: ui.ts state with mutual exclusion, chord, guard, FIXED_SHORTCUTS, palette, bell link, titlebar button, HomeOverlay with five columns from local state, header count, empty and empty-column states, Escape. Tests: ui.test.ts (mutual exclusion), CommandPalette.test.ts (act:home with hint), `e2e/home.mjs` (open by chord, button, palette; count equals bell; Escape closes and restores focus; digits do not move pane focus behind Home).
3. Navigation and layout: J/K, arrows, 1-5, Enter opens pane, self-close on external focus change, stacked sections below 1100 px, snoozed dimmed in Idle, footer seam. Tests: e2e at 940 and 1440 viewports; Enter lands focus in the pane's terminal.
4. Poll store and rows: `homePoll.ts`, diff and PR rows with skeletons, Ready and Merged populated, `markPaneMerged` in Review.tsx. Tests: `homePoll.test.ts` (no invoke while closed, shared cache keys with PaneView/WorkspaceChips, concurrency cap 3, failure memo, no toasts); perfbudget.test.ts gains a Home-open budget.
5. Rust `pane_tail`, dark: ring tail, `plaintail.rs`, command, registration. Tests: cargo (tail bounds, LF alignment, eviction, CR overwrite, CUP redraw, OSC/DCS removal, box-drawing drop, max_lines) and `cargo test` green.
6. Peek UI: Space toggles last 12 lines from `pane_tail(modelId, 16384)`, refetched when the card's state changes; mock handler. Tests: e2e prints lines with `window.__mockPrint` (mock :757) and asserts the peek text.
7. Reply and Approve: question field (auto-grow, Enter sends, Shift+Enter newline, drafts), Sent and failure states, Approve via `approveKeyFor` with the seq guard. Tests: vitest for the send state reducer; e2e prints a question, waits past the quiet timer, replies after a pane restart, asserts the text landed in that pane only; prints a `❯ 1. Yes` prompt and asserts Approve sends Enter.
Real-app check after step 7: Claude and Codex permission prompts approved from Home; one release at the end per release cadence.

## Risks

Approve on a misread prompt runs a command: mitigated by null-unless-certain `approveKeyFor`, the state plus seq guard, and showing the prompt text beside the button.
Ring stripping of alt-screen TUIs can produce fragments; peek is context only, and truncate-on-resize (paneout.rs:90-96) can leave it short, shown as "No recent output".
`lastLine` is capped at 120 chars (Terminal.tsx:1469); the full question needs peek.
`mergedPanes` is session-only, so after a restart a merged worktree pane falls to Idle unless its PR reads MERGED.
Poll fan-out with 50 panes on distinct worktrees: bounded by cwd dedupe, concurrency 3, slow-call TTL stretch (poll.ts:20-28), and running only while open.
Spec deviations for the lead: Escape does not clear the field first; no "gh not found" notice; shell panes in error appear in Needs you so counts match the bell.
