# STATE — Flightdeck

Updated: 2026-07-19 (build session 1).

## What this is

The Flightdeck app build. Authoritative specs in `D:\Dev\ai\research\`:
`flightdeck-build-spec.md` (entry point) → `flightdeck-architecture.md`, `flightdeck-build-plan.md`, `flightdeck-design-spec.md`, `flightdeck-ui-mock.html`.
Read the build spec first on resume. This STATE.md is the live build dashboard.

## Current state

- **Rust installed**: rustup, stable-x86_64-pc-windows-msvc, cargo 1.97.1. Installed with `--no-modify-path`, so cargo is NOT on the global PATH — prepend `%USERPROFILE%\.cargo\bin` in every shell that runs cargo/tauri.
- **Project scaffolded**: Tauri 2 + React 19 + Vite 7 + TS, at `projects\active\flightdeck`. Node deps + `@xterm/xterm` + `@xterm/addon-fit` installed. productName/title = Flightdeck, window 1200x800.
- **Phase 0 spike code written** (not yet verified running):
  - `src-tauri/src/lib.rs`: PTY host on `portable-pty` (ConPTY). Commands `pty_spawn/pty_write/pty_resize/pty_kill`; events `pty://output` (base64) + `pty://exit`; per-pane reader thread; strips cross-vendor API keys, inherits the rest of the env (so ~/.claude etc. resolve as in VS Code). Claude launches via `pwsh -Command claude`; agy via `agy.exe --add-dir <cwd> --new-project --model gemini-3-pro`.
  - `src/Pane.tsx`: xterm.js terminal bound to a PTY (spawn on mount, stream output, forward keystrokes + resize, kill on unmount).
  - `src/App.tsx` + `src/App.css`: minimal Onyx-styled cockpit with an "add pane: pwsh / claude / antigravity" toolbar and an auto-grid. cwd hard-set to `D:\Dev\ai\Harness` for testing.
- **PHASE 0 SPIKE PASSED (2026-07-19)**: app compiles + runs. `pwsh`, `claude`, `agy` all render live and interactive on subscription auth (user signed in to each). **agy IS interactive in a ConPTY — the biggest risk is retired; no Electron fallback needed.** Colour fix applied (FORCE_COLOR/COLORTERM/CLICOLOR_FORCE on child env) — Node CLIs were monochrome without it. `npm run tauri dev` is running with a file watcher (edits to src-tauri auto-recompile + restart the window).

## Next steps — Phase 1 (per build-spec §4)

**DONE 2026-07-19 (session 3) — full Deep Cove re-skin IMPLEMENTED.** Claude Design returned the system (project `34702292-...`, file "Flightdeck Design System.dc.html"); handoff brief was at `research\flightdeck-design-handoff.md`. Implemented:
- `src\theme.css` (new) = single token source, dark `:root` + light `:root[data-theme="light"]`. App.css `:root` now only *aliases* legacy names (`--bg-app`→`--bg`, `--tmuted`→`--faint`, etc.) onto it; Board.css local colour block deleted (inherits). No more token duplication.
- `src\fonts.css` (new) + `src\assets\fonts\` = 7 bundled woff2 (Schibsted Grotesk 400/500/600/700 + JetBrains Mono 400/500/600, latin, self-hosted, offline-safe). Killed `Plus Jakarta Sans` (that was the "shimmery" text — never installed, was falling back). Fallback stack = Segoe UI Variable.
- `src\Icons.tsx` rewritten (20 icons, kept `size` prop + `icon-bell` hook). `src\terminal-theme.ts` (new) wired into Terminal.tsx (xterm stays dark in both app themes).
- Pane 3px status top-band (`.pband`) + header dot; premium Kanban (gradient New-task btn, per-card left priority stripe, brand column-accent dots, SVG glyphs); Board colours are token-based so they flip in light mode.
- App icon pack regenerated via `tauri icon` from `src-tauri\icons\icon-master.svg` (swept-delta wing in the Deep Cove gradient).
- Theme toggle in the top bar (half-disc icon) → flips `data-theme` on `<html>`, persisted to `localStorage['flightdeck-theme']`, applied on boot in main.tsx.
- Verified: `npm run build` clean, `npm test` (new vitest, `src\store.test.ts`) 9/9 pass. Reviewer + a Fable design-fidelity pass run; all their findings fixed (Kanban light-theme contrast, `.btn-primary`→gradient, focus rings standardised to `--ice`, localStorage guarded, richer pane-grid empty state).
- NOT yet eyeballed by Balu in the WebView. Dev app is live (HMR'd + Rust recompiled).

**DONE 2026-07-19 (session 3) — bugs fixed from the Fable architecture/bug pass (all blocker + major):**
1. **Orphaned processes on app close (blocker):** `lib.rs` `run()` now uses `.build().run(|_,e|)` with a `RunEvent::ExitRequested` handler that `reap_pane`s every live pane's process tree — closing the window no longer leaves claude/agy/pwsh trees running. (`reap_pane` extracted from `pty_kill`; still taskkill /T the tree. Job Object for hard-crash coverage = future hardening, noted.)
2. **Silent spawn failure + false "running" (blocker):** `Terminal.tsx` wraps `pty_spawn` in try/catch → writes an error line + sets pane `error`. New honest initial state `"starting"` (store.ts, added to `PaneState`) instead of optimistic `"running"`; reader flips it to `running` on first output. `.pband.starting`/`.pdot.starting` styled (azure pulse).
3. **Registry leak on natural exit (major):** the reader thread now prunes its pane from the `Registry` when the read loop ends (was only `pty_kill` from the UI) — no more leaked master/writer/child handles for panes that exit on their own.
4. **Crash never surfaced as error (major):** reader `try_wait()`s the child on EOF, sends `crashed` in `pty://exit`; `PaneView` sets `error` (red) on crash vs `idle` on clean exit.
5. **Early output dropped before pane id known (major):** `Terminal.tsx` buffers `pty://output` arriving while `paneId===0` and replays the matching chunks once spawn resolves.
Minors: added a TODO on the `CROSS_VENDOR_KEYS` allowlist (proxy/enterprise auth vars); `csp:null` + StrictMode dev double-spawn + resize-gap left as noted watch-items. Verified: frontend build clean, `npm test` 9/9, cargo rebuilt clean + app running.

**Recommended next (per Fable arch pass), before a daily-driver:** item 2 below (vendor adapter trait — the load-bearing refactor everything else sits on), then Windows Job Object hardening, then SQLite persistence (needs stable exit/error state first — now done). Full ranked plan captured from the pass.

**DONE 2026-07-19 (session 4) — PHASE 1 (feel & polish) complete + verified.** Full backlog is phased in `BACKLOG.md` (215 items across Phases 1-5; single-user scope, market polish kept, licensing/docs/team/sync/support parked). Phase 1 built:
- **Settings screen** — new `Settings.tsx`/`overlays.css`, ⚙ now opens it (also Ctrl+,). Theme (dark/light) + UI size (Comfortable/Large/Extra = whole-app `zoom`, persisted, boots in `main.tsx`) + keyboard reference. `ui.ts` = small UI store (confirm/toasts/settings flag).
- **Close-workspace confirm** — closing a workspace with live panes now prompts (`ConfirmDialog.tsx`, danger style) so a session isn't lost by accident; toast on close. Reusable confirm + `ToastHost.tsx`.
- **Left panel redesign** — bigger tiles/icons, per-workspace status roll-up (running/waiting/error dot-counts), larger board button.
- **Larger type + icons** app-wide (topbar, panel, board header); dark-mode polish (more surface separation + stronger lines in `theme.css` dark `:root`).
- **Kanban** — larger cards (min-height, padding, 13.5px title), stronger hover lift, wider columns, and a "Drop here" slot that appears in the target column while dragging a card in from another column.
- Shortcuts: Ctrl+, settings, Ctrl+B toggle panel (guarded so it doesn't steal keystrokes inside a terminal). Verified: `npm run build` clean, `npm test` 9/9. NOT yet eyeballed by Balu.
- **Phase 4 (macOS/Linux/signing/Store/auto-update) + Phase 5 (kove.nz pages) are gated** on Balu's hardware/certs/accounts — checklist only, can't be built/tested from here.

**DONE 2026-07-19 (session 4) — PHASE 2, wave 1 (verified: build clean, 9/9 tests, cargo clean, app running):**
- **R1 vendor registry** — `lib.rs` now has a data-driven `VENDORS` table (`VendorSpec{id,label}`) + `probe()` + `agy_path()`; `build_command` consumes it. Adding an agent = one row + a `build_command` arm + a `probe` arm (full trait/dyn-dispatch is a later refinement; this removes the hand-rolled if/else the arch pass flagged).
- **R3 first-run CLI detection** — new `detect_vendors` command probes each vendor (`where claude`, `%LOCALAPPDATA%\agy\bin\agy.exe`, `where pwsh`) and returns installed + resolved path. `NewWorkspace` calls it on mount and shows an amber **"not installed"** chip (with the probe detail as tooltip) next to any pane whose agent is missing. Never blocks launch — capability stays visible.
- **R5 crashed/idle pane relaunch** — `PaneModel.epoch` + `restartPane()` in the store; `PaneView` keys `<Terminal>` on `epoch`, so a bump remounts and respawns the PTY. A **Restart** button appears in the pane header whenever state is `idle` or `error`.
- **K5 resize race fixed** — `Terminal.tsx` pushes one `pty_resize` right after spawn, so a container resize during the spawn round-trip is no longer lost.

**DONE 2026-07-19 (session 4, wave 2) — 8 PARALLEL AGENTS, all integrated + verified** (cargo check clean, `npm run build` clean, vitest 9/9, `cargo test --lib` 3/3, app running).
- **rust-core**: backend split into modules (`vendors` trait+registry with claude/agy/pwsh/**cmd/git-bash/wsl**, `job` = Win32 Job Object w/ KILL_ON_JOB_CLOSE assigned at spawn (R2), `health` = pane_health CPU/mem, `orphans` = recover/kill stray agent trees, `support` = redact() + export_support_bundle (3 unit tests), `gitstatus` = git_status). CSP tightened (researched: with `devUrl` set, CSP only applies to production builds, so dev is unaffected). `dialog:default`→`dialog:allow-open`. Wired `persist.rs` + its 8 commands into `invoke_handler` — persistence commands are now LIVE.
- **persistence**: `persist.rs` + `persist.ts` — atomic JSON session doc, safe mode, restore points, backup/import. `PersistedPane` has NO state field by design (a restored pane is always dead).
- **kanban**: card→pane dispatch (R7), live pane status on cards, detail modal, labels, filter/sort, checklist, WIP limits, keyboard moves, markdown export, `board/` module + `boardStore`.
- **panes**: maximise/solo, drag-reorder, inline rename, portalled overflow menu, per-pane font zoom (mutates xterm options without respawning the PTY).
- **workspaces-nav**: reorder/rename/context-menu/search/Ctrl+1-9/folder-drop/last-active + **CommandPalette** (Ctrl+K/Ctrl+P).
- **settings-theme**: 6 themes (Deep Cove dark/light, Dracula, Gruvbox, Nord, High Contrast), accent picker, colour-blind palette, reduced motion, terminal/shortcut/agent/startup settings, theme import/export.
- **notify-agents**: configurable per-state bell, feed, mute/DND, OS toast + taskbar flash, **Broadcast bar**; extended `ui.ts`.
- **explorer-git**: `Explorer.tsx` file tree (behind a new top-bar toggle), git branch pill, open-in-editor, new-terminal-here.
- **Integration fixes I made** (agents couldn't reach these): lifted `activeView` into `ui.ts` so CommandPalette can leave the Board view; rerouted the topbar theme toggle through `themes.ts` so it no longer discards a Dracula/Nord choice; added `core:window:allow-request-user-attention` so taskbar flash works; rewrote `Cockpit.tsx` to mount Notifications/Broadcast/CommandPalette/Explorer.
- **GAP REVIEW written** — `BACKLOG.md` section I, items **216-284**. Top finding: the Rust vendor trait exists, but the frontend hardcodes the vendor list in 5 places and `board/types.ts` has a `Vendor` union type that structurally blocks new agents. **I1 (216-228) is the priority: make adding an LLM a config drop, not a code hunt.** Second-biggest: testing (only 9 TS + 3 Rust tests).

**Phase 2 REMAINING (next up):** R2 Windows Job Object (needs a `windows`/`windows-sys` dep + unsafe Win32; hard-crash child reaping — clean-exit reaping already ships), **R4 SQLite persistence + restore** (largest single item), R6 CSP/capability hardening (deliberately deferred — a wrong CSP silently breaks the dev app, wants its own verify pass), and the ops items (safe mode, backup/restore, health dashboard, recover-orphans). **Phase 3 not started.**

Spike passed → building the real cockpit. Order:
1. **Cockpit UI to match the mock** — [BUILT 2026-07-19, compiles clean]. Zustand store (`store.ts`), `NewWorkspace` dialog (layout tiles + directory + agent checklist), `Cockpit` (topbar + workspace rail + `Sidebar` Explorer/Panes + pane grid), `PaneView` (dot-status header + branch pill), `Terminal` (xterm↔PTY). `fs_list_dir` Rust command for the Explorer. Frontend (tsc+vite) and cargo both exit 0. NOT yet run in the GUI this build — relaunch `npm run tauri dev` to view. Still inside this task: native folder picker, nested tree + actions, per-vendor state detection beyond running/idle.
1b. **DONE 2026-07-19**: per-pane agent selection in New Workspace (explicit mix, e.g. 3 Claude + 3 agy at the 6-layout), native folder picker (tauri-plugin-dialog), `BACKLOG.md` (local LLM via LM Studio/Qwen design + models-later note). Confirmed: multiple same-vendor panes work (no engine cap).
1c. **DONE 2026-07-19**: live per-pane status — reader emits `pty://state` "running" on output, a monitor thread emits "waiting" after 3s quiet; frontend updates the pane dot + roster. Activity-based v1 (vendor-agnostic).
1d. **DONE 2026-07-19 (session 2)**: multi-workspace (stacked, run in background, switch via left panel — panes stay MOUNTED so PTYs keep running when you switch); per-pane working directory (set in New Workspace, default = workspace dir, overridable via folder picker — because agents root their project at launch cwd, cd-in-terminal won't re-root them); notification bell (top bar: badge + dropdown of waiting panes, click to jump) + amber dot on background workspaces needing you; collapsible left side panel (Workspaces + Board, toggle in top bar); resizable split panes (`react-resizable-panels` v2 — pinned; v4 has a different API — drag any divider); Kanban Board (built by frontend subagent → `Board.tsx`/`Board.css`, 4 cols, drag cards, +New Task). Dropped per Balu: BridgeSwarm, billing, accounts. Store fully rewritten to multi-workspace (`store.ts`); old `Sidebar.tsx` removed.
1e. **DONE 2026-07-19 (session 2b)** — Rust: agy sticky workspace-trust (`ensure_agy_trust` writes each pane's folder into `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces` under an in-process lock → agy runs in ANY folder + multiple agy panes are safe); no-orphan shutdown (`pty_kill` now `taskkill /PID <pid> /T /F` the whole process tree, since Node CLIs spawn children). Terminal xterm theme updated to HUD palette. **DONE via 2 frontend subagents**: (a) full HUD theme overhaul (deep navy #0a0e15 + instrument cyan #22cfe0, replacing magenta) + custom SVG icon set (`Icons.tsx` — 14 line icons incl. radar-beacon `IconBell`, slider `IconSettings`, `IconBrand`) + premium side-panel redesign (monogram tiles, accent active bar + glow, pulsing waiting dot); (b) Kanban polished (real drag ghost, drop-target highlight, inline task composer, card-in animation) + seeded with the REAL Flightdeck build items across all 4 columns. `.btn-primary` is dark-on-cyan for contrast. Integrated build clean, relaunched. Not yet run-verified in the WebView — Balu to eyeball.
2. Vendor adapter trait + registry in Rust (generalise `build_command`). Pattern-based per-vendor detection (add "auth-required"; refine waiting) on top of the activity heuristic. [agy sticky-trust DONE in 1e.]
3. First-run CLI detection (binary probe) + folder open (`dialog.open`) wired to the launcher.
4. SQLite store (schema = architecture §3): workspaces/panes/sessions/scrollback (batched flush ~4KB/2s)/presets/events. Restore on reopen.
5. Windows shutdown (Ctrl+C → Job Object), crashed-pane relaunch, hidden-pane render throttle.
6. Tauri capability manifest hardening.
7. Kanban → pane dispatch: dropping a card into "In Progress" should spawn/assign an agent pane to that task (`Board.tsx` has the `// TODO: dispatch this card to an agent pane` marker). Currently the Board is standalone.
8. Settings screen: Appearance (multiple themes), Terminal, Agents, Shortcuts (NO Account/Billing). The ⚙ button in the top bar is a placeholder.
9. Explorer file-tree: re-add as a panel/section (dropped when the left panel became the workspace switcher). Rust `fs_list_dir` command still exists to build on.
Then Phase 1.5: `kimi-code` adapter (activate when Balu subscribes).

Run/dev command (from project dir, cargo not on global PATH):
`$env:Path="$env:USERPROFILE\.cargo\bin;$env:Path"; npm run tauri dev`

## Watch-list / likely first bugs

- Tauri v2 maps JS camelCase args to Rust snake_case: `Pane.tsx` invokes with `paneId` → Rust `pane_id`. If a command errors with a missing arg, that mapping is the cause — switch the JS keys to snake_case.
- `claude` via `pwsh -Command claude`: if the TUI doesn't render/accept input, try `cmd.exe /c claude` or invoking the `claude.cmd` shim directly.
- `cargo build` needs `../dist` to exist (frontendDist); the build job runs `npm run build` first to create it.

## Key files

- `D:\Dev\ai\research\flightdeck-build-spec.md` — the build, task by task.
- `projects\active\flightdeck\src-tauri\src\lib.rs` — PTY host (spike).
- `projects\active\flightdeck\src\Pane.tsx`, `src\App.tsx` — UI (spike).

## Resume

Prepend `%USERPROFILE%\.cargo\bin` to PATH. Read the build spec, then this STATE. Continue from the first unchecked Next step. Update this file after each meaningful step.
