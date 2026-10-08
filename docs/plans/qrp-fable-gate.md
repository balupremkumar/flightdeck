# QRP Fable gate (2026-10-08, branch qol/qrp, diff main..qol/qrp)

Verdict: SHIP AFTER FIXES.
No Critical finding.
Three High findings, all small fixes, two of them in the chrome-zoom change (QRP4) and one in the hooks change (QRP6).
The Rust side (hooks, per-launch settings file, K10 PATH) held up under code review and a live two-pane red team.

## Findings

### High

H1. The release gate's browser e2e fails under the new 120 percent default.
Where: src/ui.ts:544-555 (`applyUiScale` falls back to CSS zoom when `getCurrentWebview().setZoom` rejects), src/main.tsx:90-94 (now always applies the stored or default zoom), tools/release.ps1:129-131 (stops at the first failing script).
Evidence: on the provided dev server `links.mjs` fails "(d) Explorer panel is open after clicking the folder" at the default, and passes when the test pins `flightdeck-uiscale=1` plus `flightdeck-migrated-chrome-scale=1`.
Evidence: on a fresh Vite server (no HMR history) `links.mjs` fails at the default again (Phase A below).
Why: in a plain browser there is no Tauri webview, so the fallback sets `document.documentElement.style.zoom = "1.2"`, the exact CSS zoom that broke xterm click hit-testing in August, and Playwright's mouse coordinates no longer land on the row the script measured.
Smallest fix: make `cssFallback` a no-op outside Tauri (`if (!("__TAURI_INTERNALS__" in window)) return;`), so a browser preview renders at 100 percent and the gate scripts keep their geometry.
Alternative: add `flightdeck-uiscale=1` and `flightdeck-migrated-chrome-scale=1` to every e2e boot string, but that hides the fallback rather than removing it.

H2. Existing users with a stored zoom above 100 percent get a smaller terminal font on first launch.
Where: src/terminalScale.ts:2-5 (`terminalFontPx` divides the pane font by the zoom), src/Terminal.tsx:712 and 1960-1967 (applied at create and on every zoom change), src/ui.ts:503-512 (`migrateChromeScale` only touches a stored "1").
Evidence: the stable app's WebView store (read-only grep of `AppData\Local\ai.flightdeck.app\EBWebView\Default\Local Storage\leveldb`) holds `flightdeck-uiscale` values 1.2, 1.35 and 1.11, never 1.
Why: before this branch a zoom of 1.35 made terminal text 1.35 times larger; now the same stored value divides the font by 1.35, so the terminal drops back to the base size while the chrome stays where it was.
For Balu that is a 17 to 26 percent smaller terminal font after the update, with nothing in the release notes telling him why.
Smallest fix: in `migrateChromeScale`, when a stored zoom z differs from 1, multiply the saved terminal font size by z once (round to a whole pixel) so the on-screen size is unchanged, and keep the one-shot marker.

H3. A Claude turn that ends on a question no longer chimes, toasts or pulses the bell.
Where: src/Notifications.tsx:509-513 (a Stop hook marks the pane silent: `hookSilent.set(target.p.id, "waiting")`), src/Notifications.tsx:566 (`if (hookSilent.get(p.id) === p.state) continue;` skips pulse, chime and OS toast), src/vendors.ts:38 (Claude's quiet threshold is 3 seconds), src/Notifications.tsx:924 (the panel still says "The bell and the feed show approvals, questions and errors").
Evidence: the relay takes 396 to 419 ms wall time (`Measure-Command` on hook-relay.ps1, two runs), so the Stop hook always sets `waiting` before the 3 second heuristic would, and the silent record is in place when the "question" transition is evaluated.
Why: QL-720 rule 3 made Stop silent when Stop meant `idle` (nothing needs you) and hooks were opt-in; with QRP6 every Claude pane now has hooks and Stop lands on `waiting`, so the rule now swallows the one quiet-pane case the owner ruled is a real need.
Smallest fix: in the HOOK_EVENT listener only mark the `idle` kind silent (`if (kind === "idle") hookSilent.set(...) else hookSilent.delete(...)`), or skip the silent check when `attentionKind(p) === "question"`.

### Medium

M1. `home.mjs` fails the gate on a selector collision introduced by the new titles.
Where: e2e/home.mjs:83 (`getByTitle("Home (Ctrl+Shift+H)")`), src/Notifications.tsx:800 and src/PaneView.tsx:974-975 (new titles "Open Home (Ctrl+Shift+H)").
Evidence: "strict mode violation: getByTitle('Home (Ctrl+Shift+H)') resolved to 2 elements" with the zoom pinned, so it is not H1.
Smallest fix: `getByTitle("Home (Ctrl+Shift+H)", { exact: true })` in the script, or word the new titles so the substring differs ("Open Home · Ctrl+Shift+H").

M2. Settings "UI size" Reset disagrees with Ctrl+0 and is permanently visible at the new default.
Where: src/Settings.tsx:1692-1693 (`uiZoom !== 1` shows Reset, sets 1, title "Reset to 100% (Ctrl+0)"), src/ui.ts:475-479 (`resetUiZoom` goes to `DEFAULT_UI_ZOOM` 1.2).
Evidence: at a fresh install the row reads "120%" with a Reset button that drops the chrome to 100 percent, while Ctrl+0 brings it back to 120.
Smallest fix: compare with `DEFAULT_UI_ZOOM`, call `resetUiZoom()`, and title it "Reset to 120% (Ctrl+0)".

M3. The K10 install hint is not a valid command when copied.
Where: src-tauri/src/vendors.rs:583 (`install()` returns "irm https://claude.ai/install.ps1 | iex   (PowerShell, outside Flightdeck)"), src/Settings.tsx:2264-2270 (renders it in `<code>` and copies it verbatim), src/NewWorkspace.tsx:496-497 (interpolates it into a sentence).
Evidence: the PowerShell parser (`Parser::ParseInput`, no execution) reports 1 parse error and reads the tail as `iex (PowerShell, outside Flightdeck)` with a nested command `PowerShell` taking the arguments `outside Flightdeck`; the pane banner uses the clean `CLAUDE_INSTALL_COMMAND` (src/paneMenu.ts:1), so the two surfaces disagree.
K10 was named release-critical in docs/plans/qrp-phase.md:39.
Smallest fix: return the bare command from `install()` and put "run it in PowerShell outside Flightdeck" in the UI copy, as the pane banner already does.

M4. Silent reopen now also runs after a crash, with no in-app way to decline.
Where: src/settingsStore.ts:340-343 (default "reopen"), src/session.ts:617-620 (no prompt on "reopen"), src/main.tsx:76-80 (the crash toast fires after the session has already relaunched), src-tauri/src/persist.rs:179-186 (safe mode only via `--safe-mode` or `FLIGHTDECK_SAFE_MODE`).
Why: the 0.5.3 boot loop was a restored session; with the old "launcher" default the prompt was the escape hatch, now a bad restore relaunches itself every start until the user finds the flag.
Smallest fix: when `crashedLastRun()` is true, fall through to the "Reopen last session?" prompt regardless of the setting.

### Low

L1. Double fire window when hooks are added globally while panes are open.
Where: src-tauri/src/hooks.rs:430-445 (`launch_hooks_value` checks `~/.claude/settings.json` only at spawn), src/Settings.tsx:683 ("Also install in ~/.claude…").
Effect: panes launched before the global install carry both hook sets until restarted, every event arrives twice; the handler is idempotent so nothing breaks, the status line just over-promises.
Also not checked: project-level `.claude/settings.json` hooks in the launched folder.
Fix: none needed for release; mention it in the install confirm text.

L2. The light/dark flip is gone from the cockpit top bar and the comment says it moved to the palette, but no palette action exists.
Where: src/Cockpit.tsx:155 (comment), src/CommandPalette.tsx (no `toggleThemeMode` caller), src/App.tsx:65 (the launcher chrome still has it).
Fix: add an "Toggle light / dark" action to the palette, or correct the comment.

L3. Every Claude turn now pays the relay cost.
Evidence: 396 to 419 ms per hook fire (pwsh -NoProfile start plus ConvertTo-Json), paid at every Stop and before every permission dialog, because Claude waits on hooks.
Fix: none for release; a compiled relay or `powershell.exe -NoProfile` timing can be measured later.

L4. `migrateChromeScale` cannot tell a deliberate 100 percent from the old default, so a user who chose 100 is moved to 120 once.
Where: src/ui.ts:503-512.
The code comment already says so; acceptable.

L5. Hygiene: e2e/_qrp-shoot.tmp.mjs is an untracked leftover in e2e/, and the external fixture folder D:\Dev\ai\vfx used by e2e/viewers.mjs:17 does not exist (the script still passed on a fresh server because the mock serves the content).

L6. Disclosure: measuring the relay appended one test line (`pane: null`, `cwd: C:\x`) to the Canary's `AppData\Roaming\ai.flightdeck.canary\hooks\events.jsonl`; the watcher starts at end of file so it is never replayed, and the stable app has its own folder.

## What was checked and held

- Hooks mark the right pane: two Claude panes on one folder, pane 2 asked for WebFetch permission, only pane 2 read Needs you, the hook line carried `pane: "2"`, the bell badge read 1, Escape cleared it with no Restart button (qrp-redteam run 2).
- Stop maps to `waiting`, never `idle`: a finished turn reads "Idle" in the header with no Restart button (qrp-verify), and `PaneView dead`, Broadcast, the palette and worktree close keep reading `idle` as exited.
- No ~/.claude write: settings.json SHA 73D92929… unchanged across all three live runs, `briefTranscript` absent from ~/.claude.json (brain risk 28).
- Per-launch settings: a pane launched with its own `--settings` keeps it (src-tauri/src/lib.rs:169-179 skips the view file), and loses only the Flightdeck hooks, falling back to the heuristic.
- Relay safety: hook-relay.ps1 writes nothing to stdout and always exits 0, so a PermissionRequest hook never decides for the user and a broken relay cannot stall Claude (src-tauri/src/hooks.rs:66-113).
- `FLIGHTDECK_PANE_MODEL` is set only for the claude vendor and removed otherwise (lib.rs:252-259); pane ids are partitioned per window and never reused in a process (store.ts:132-141), and the watcher starts at end of file (hooks.rs:160-167), so a stale id cannot tag a later pane.
- K10: `path_with_front` is case and trailing-slash insensitive and portable-pty lowercases env keys on Windows, so `PATH` overrides the inherited `Path` (portable-pty 0.8.1 cmdbuilder.rs:26-36).
- Native zoom: `localStorage flightdeck-uiscale = "1.2"`, `document.documentElement.style.zoom = ""`, devicePixelRatio 1.2 in the Canary (qrp-verify), so click hit-testing is untouched in the real app.
- Interrupt agent: Shift+right-click offers it and the turn stopped (screenshot w1b-qrp-rt-4-after-interrupt.png shows the prompt with no output and Idle); plain right-click pastes by design (src/terminalMouse.ts:31-38).
- K11 still holds on this build: k11-verify 7 of 7.
- Sound is one key (`flightdeck-sound-needs-you`) in Settings, the bell panel and the chime (src/needsYouSound.ts:7, src/Settings.tsx:892, src/Notifications.tsx:429-440).
- Ctrl+Shift+F has no other binding in the app (ChatView uses Ctrl+F without Shift).

## Check results

tsc: `npx tsc --noEmit -p .` printed nothing, `TSC_EXIT=0`.
vitest: `Test Files  98 passed (98)`, `Tests  1642 passed (1642)`, `VITEST_EXIT=0`.
cargo: `cargo test --lib` printed `test result: ok. 485 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out`, `CARGO_EXIT=0`.

Browser e2e, provided server http://localhost:1430 (long-lived, HMR history), release.ps1 order, default zoom:
pane-smoke PASS, reflow-keeps-agents PASS, draft-survives-restart PASS, reload-keeps-agents PASS.
links FAIL "(d) Explorer panel is open after clicking the folder" (H1).
home FAIL "strict mode violation: getByTitle('Home (Ctrl+Shift+H)') resolved to 2 elements" (M1).
viewers, review-collapse, chat-view, chat-density, multiwindow-move, multiwindow-close, multiwindow-attention, multiwindow-restore, multiwindow-rtfix, multiwindow-s9, multiwindow-adopt-ack FAIL.
Those eleven were confounded by the server: Cockpit was served importing `/src/store.ts?t=1791433095706` (an HMR timestamp URL) while the scripts import `/src/store.ts`, two module instances, so `useApp.getState().workspaces` was `[]` with six panes mounted (probe output `{"same":true,"ws":[],"active":null,"panes":6}`).
The fresh-server run below is the one that counts.

Browser e2e, fresh Vite on http://localhost:1431, Phase A (default zoom, what release.ps1 sees):
PHASE_A_RESULTS

Browser e2e, fresh Vite on http://localhost:1431, Phase B (same scripts with `flightdeck-uiscale=1` and the migration marker pinned):
PHASE_B_RESULTS

Live Canary (e2e/live, exe target-canary/release/projectsactivefd-scaffold.exe built 17:29, CDP 9333, off-screen, FD_RESULTS_DATE=2026-10-08):
qrp-verify: 8 of 8 PASS, `ALL PASS`, including "a Stop hook fired from this pane and names it" and "UI scale 1.2 stored and applied natively (no CSS zoom)".
k11-verify: 7 of 7 PASS, `ALL PASS`.
qrp-redteam (new, e2e/live/qrp-redteam.mjs) run 2: 12 of 13 PASS; the one FAIL "Interrupt agent stops the turn within 15s" read the pty tail ring, which still held an earlier "esc to interrupt" frame, and the screenshot shows the turn stopped.
qrp-redteam run 1 is kept in results as evidence that Claude Code 2.1.293 runs `Bash(echo ...)` without a prompt in acceptEdits mode, which is why run 2 uses WebFetch.
Foreground guard: 0 Canary foreground samples in all three runs (146, 189 and 189 samples).
Stable app: never touched; `settingsSha` identical before and after each run; `briefTranscript: false`.

Results: e2e/live/results/2026-10-08/w1b-qrp-verify.json, w1b-k11-verify.json, w1b-qrp-redteam.json and the w1b-qrp-rt-*.png shots.

## Fixes applied by Claude (2026-10-08, commit 51366d7 and 45c6a44)

H1, H2, H3, M1, M2, M3, M4 and L2 are fixed as the smallest fixes above describe (H2 carries a pre-0.6.3 zoom over as a terminal font scale instead of rewriting saved fonts).
L1, L3, L4 accepted for release; L5 the leftover shoot script is deleted.
The gate run was stopped before its Phase A/B tables filled in; Claude reran the release browser suite on a fresh server at 45c6a44: all 17 scripts pass (pane-smoke, reflow, draft, links, viewers, review-collapse, chat-view, chat-density, reload, home, and the seven multiwindow scripts).
Two e2e selectors were updated for the new chrome: rail rows are clicked as visible text (the top-bar workspace name is hidden while the rail shows it), and the Chat view checkbox name may carry its tick.
Gates at 45c6a44: tsc 0, vitest 1645, cargo 485.
