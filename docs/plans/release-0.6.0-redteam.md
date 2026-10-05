# 0.6.0 pre-release red team (Fable reviewer, 2026-10-06)

Scope: `git diff v0.5.7..main` at 5d53cdd (204 commits, 231 files).
Focus: what the Sonnet pass ([[projects/active/flightdeck/docs/plans/phase4-5-redteam|Phase 4+5 red team]]) skipped: test quality, scrollback redaction in the v2 doc and support bundle, flag-off leakage, plus release blockers.
Result: High 1, Medium 4, Low 4.
Release call: H1 blocks the preview flag as is; M2/M3 affect every user's session doc and are fixed before 0.6.0.

## High

### H1. Pane-id partition seeded from the window's own view (flag on). CONFIRMED.
Files: `src/store.ts:126-135, 419-421`, `src-tauri/src/persist.rs:437-445` (`main_view`), `src-tauri/src/lib.rs:324-335` (supersede reaps).
Main hydrates only its own workspaces, so its `pseq` can sit below ids still live in a secondary.
Scenario: main has ws 1 (panes 1-4) and ws 2 (panes 5-6); move ws 2 to fw-1; quit; relaunch with reopen; add a pane in main; it gets id 5; `pty_spawn(model 5)` supersedes fw-1's pane 5 and `reap_pane` kills that agent.
Same after a main reload (ErrorBoundary, Settings import/reset), a declined restore while secondaries restore, and symmetrically in a secondary.
Fix: `window_boot` returns the max local id per partition from the full session doc plus live `by_model` keys; `setWindowOrdinal` seeds `wseq/pseq/gseq` from it.
Test: vitest, hydrate main's view of a doc where fw-1 holds pane 5, `addPane` must not mint 5; e2e restore variant asserting no kill on supersede.

## Medium

### M1. Sonnet fix 3 incomplete: pane added during the `ws_transfer` await is released and killed. CONFIRMED (timing-dependent).
`src/windowMove.ts:96-110`, `src/paneSessions.ts:295-300`, `src/Terminal.tsx:1634/1661`.
The drain re-check is right, but the source stays interactive while `ws_transfer` awaits window creation or the 3 s ack; `releaseWorkspace` re-reads the store and releases a pane added in that gap; it lands in neither window.
Fix: release only the snapped pane ids (or block pane creation on a moving workspace), leaving extras in the source.
Test: `windowMove.test.ts`, `ws_transfer` handler adds pane 3 mid-await; pane 3 not disposed, `pty_kill` never called.

### M2. Scrollback redaction misses real serialised output. CONFIRMED.
`src/transcript.ts:71-76` splits on `\n` and space only.
SerializeAddon emits `\r\n` and SGR codes glued to runs, so row-final tokens end in `\r`, coloured keys arrive as `\x1b[32msk-ant-...`, and tab, NBSP and `KEY=` glue are not separators.
The session doc, its 10 snapshots, backups and `export_backup` carry keys in practice.
Rust `support::redact` only sees cwd/vendor/log and is fine.
Fix: tokenise on ANSI/CR-aware boundaries and splice `[REDACTED]` over the original ranges.
Test: `redactText("\x1b[32msk-ant-api03-...\x1b[0m\r\nnext")` and `redactText("KEY=abc123...\r")` contain no key.

### M3. Unredacted session doc fields: `draft`, `summary[].lastLine`, `title`. CONFIRMED.
`src/session.ts:228`, `:50-61`, `src-tauri/src/persist.rs:65`.
Fix: run them through `redactText` in `toDraft`/`summarize`.
Test: `toDraft` with `draft: "sk-ant-..."` serialises without the key.

### M4. Test quality. CONFIRMED.
- `e2e/multiwindow-rtfix.mjs:5` claims finding 3 coverage; only the finding 2 section exists.
- `e2e/home.mjs:269` `check(true, ...)` cannot fail.
- `src/session.test.ts:217-221` asserts the `KEY=` redaction gap as expected, locking the defect in.
- `home.mjs`, `multiwindow-*.mjs`, `reload-keeps-agents.mjs` are not in `.github/workflows/ci.yml` or the release gate.
- e2e `until()` returns `null` on timeout and callers dereference it, so a timeout is a TypeError, not a labelled failure.
- The bus `merge()` never models the `AdoptQueue`/`main_adopt_done` ack path; fix 6 has unit tests only.

## Low

- **L1. Heartbeat and watcher run with the flag off.** `windowBoot.ts:32-34`, `lib.rs:1175`, `Cockpit.tsx:315`. All no-ops with one window; `session.json` gains a `windows` array that 0.5.7 ignores on downgrade. No behaviour change. Accepted.
- **L2. Read scope covers `%USERPROFILE%\.claude` wholesale, including `.credentials.json`.** `readscope.rs:101-104`. PLAUSIBLE; no exfil path today (CSP self). Fix: deny `.credentials.json` and key files under that root.
- **L3. Judge reaps a secondary stalled over 8 s that cannot answer flush in 500 ms.** `windows.rs:1186`. Accepted trade-off.
- **L4. `merge_all` vs a secondary closing mid-merge.** Verified, no defect.

## Sonnet fixes verified

| # | Verdict |
|---|---|
| 1 | Correct (`Judge::tick`, two misses, flush first). Residual L3. |
| 2 | Correct (`AdoptLedger`, ack before release, e2e covers it). |
| 3 | Incomplete, see M1. |
| 4 | Correct (`redirty_on_err` on both paths). |
| 5 | Correct (`CloseGuard`). |
| 6 | Correct, unit tests only (see M4). |
| 9 | Correct (`isTop()` guard, e2e). |
| 10 | Correct (`approveGuarded`, no await before write). |

## Fix plan

Round 1: H1 (agent A), M2 + M3 + the `session.test.ts` gap (agent B).
Round 2: M1 + M4 e2e items (agent C), L2 (agent D).
L1, L3 accepted; L4 no defect.

## Fix status (2026-10-06, all Sonnet, failing test first)

- H1: 83e603d. `window_boot` returns an id floor from the doc, slices, registry and live `by_model`; e2e `multiwindow-restore.mjs` section C.
- M1: f259b6e + 4d6d03c. Only snapped panes are released; a pane added mid-move goes to another workspace, or a freshly minted one (never the moved id, which `windowBoot.ts:114` would skip on merge-back).
- M2/M3: d233a7d. ANSI/CR-aware tokeniser, `draft`/`title`/`lastLine` redacted.
- M4: c59e783 (rtfix #3a/#3b, home check, labelled `until()` timeouts, CI and release wiring) and d233a7d (`KEY=` test). Open: the bus does not model the `AdoptQueue` ack, fix 6 stays unit-tested only.
- L2: bc02097. Deny `.credentials.json`, `*.key`, `*.pem` under `~/.claude` in `check_read` and the asset protocol (forbid); asset path hand-checked on the Canary.
- Gate on qol/rel-060: tsc 0, vitest 1491, cargo 446, vite build OK, e2e 21/21.
