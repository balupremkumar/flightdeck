# Antigravity pane QoL and performance findings (2026-10-06)

Read-only investigation, nothing built, run or edited.
Paths are relative to the repo root unless they start with node_modules or a drive letter.

## Method and caveats

The tag `v0.5.4` does not exist in this clone (`git tag -l` starts at `v0.5.5`).
I used commit `7b0a3bc` ("v0.5.4: version bump") as the 0.5.4 baseline for every `git show` comparison.
Claims about agy's behaviour come from strings inside `%LOCALAPPDATA%\agy\bin\agy.exe` (grep only, the binary was not run).
Anything that needs a live agy session to confirm is marked "not verified".

## 1. Selection and copy in agy panes

### Does agy turn on mouse reporting

Likely yes, not verified at runtime.
agy.exe is a Go program built on Bubble Tea v2 and Charm's ultraviolet renderer (strings `bubbletea/v/v2/tea.(*googleCursedRenderer)`, `charmbracelet/ultraviolet`).
The binary contains the enable sequences `ESC[?1002h`, `ESC[?1003h`, `ESC[?1006h` (SGR mouse), `ESC[?1049h` (alt screen), `ESC[?2004h` (bracketed paste) and `ESC[?2026h` (synchronized output).
It does not contain `?1000h` on its own, which fits Bubble Tea's cell-motion mode (1002 plus 1006).
When any of those modes is on, xterm.js 6.0.0 disables its own selection and forwards drags to the app (`node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts:786`, `.../services/SelectionService.ts:464-470`).
A plain drag in agy therefore goes to agy, not to the selection layer, which matches "cannot highlight".
Bubble Tea programs can switch mouse mode on and off per screen, so "sometimes" is plausible; not verified.
Flightdeck does nothing to strip or override these modes for agy: `src-tauri/src/vendors.rs:597-602` only passes `--add-dir <cwd> --new-project --model gemini-3-pro`, and `src-tauri/src/lib.rs:197-200` only sets TERM, COLORTERM, FORCE_COLOR and CLICOLOR_FORCE.

### Shift+drag override

xterm's built-in override is Shift+drag on Windows (`SelectionService.ts:437-443`, `shouldForceSelection` returns `event.shiftKey` off macOS).
Flightdeck adds nothing to it and shows no hint that it exists.
Conflict found in Flightdeck's own code: the pane wrapper `onMouseDown` at `src/PaneView.tsx:890` treats any Shift+mousedown as "toggle this pane in the bulk pane selection" and calls `e.preventDefault()` without focusing the pane.
xterm calls `event.stopPropagation()` for a forced selection while mouse reporting is on (`SelectionService.ts:469`), so Shift+drag inside an agy pane most likely does not reach React's handler and still selects.
In a pane with mouse reporting off, xterm does not stop propagation (it is used for Shift+click "extend selection", `SelectionService.ts:476`), so Shift+click reaches `PaneView.tsx:890`: it extends the selection and also toggles the bulk selection toolbar and skips focus.
That second part is from code reading only, not verified live.
The same Shift handler exists in 0.5.4 (`PaneView.tsx:806` at `7b0a3bc`), so it is not new.

### Copy-on-select (H2) and right-click

Added in 0.6.0 (commit 637df5f, 2026-10-04).
0.5.4 had none of it: `git show 7b0a3bc:src/Terminal.tsx` has no `copyOnSelect`, and 0.5.4's right-click always opened the pane context menu (`PaneView.tsx:1260-1263` at `7b0a3bc`).
So in 0.5.4 a selection was only copyable through that menu's Copy item, or the browser's native copy event.
Now: `src/Terminal.tsx:846-871` arms on left mousedown and copies on mouseup when the selection text changed and is non-empty.
Defaults are `copyOnSelect: true` and `rightClick: "paste"` (`src/settingsStore.ts:36`).
Right-click rules are in `src/terminalMouse.ts:28-36` and wired at `src/PaneView.tsx:1413-1436`.
Shift+right-click or setting "menu" opens the menu; a right-click over a link opens LinkMenu; for agent vendors (claude, codex, agy) mouse tracking no longer hands right-click to the app (SF3, `terminalMouse.ts:33`); with a selection it copies and clears; otherwise it pastes, through a confirm dialog when the pane is unfocused or waiting on a permission or question (`terminalMouse.ts:21-23`).
Gap: `copyOnSelect` compares `text !== before` (`Terminal.tsx:858`), so re-selecting the same text after the clipboard changed does not copy again.
Gap: there is no feedback when copy-on-select fires (OSC 52 copy does toast, `Terminal.tsx:906-909`).

### Ctrl+Shift+C and Ctrl+C

Flightdeck has no copy keybinding at all (grep for `Ctrl+Shift+C`, `key === "c"` in src finds only CsvTable).
xterm only handles Ctrl+letter with no Shift, mapping Ctrl+C to `0x03` (`node_modules/@xterm/xterm/src/common/input/Keyboard.ts:308-310`).
Ctrl+Shift+C produces no key, so it falls through to the browser's native copy; whether WebView2 copies xterm's selection through the `copy` handler (`CoreBrowserTerminal.ts:334-340`) is not verified.
Plain Ctrl+C with a selection always sends `^C` and cancels the event, so it never copies, and any user input then clears the selection (`SelectionService.ts:140-143`).
The context-menu Copy item calls `copySelection` (`Terminal.tsx:1888-1891`).

### Other ways a selection vanishes (not verified for agy)

xterm clears the selection on any user input, on any resize that changes the row count (`SelectionService.ts:158-162`, xterm issue 5300), and on buffer switch.
Flightdeck's `ResizeObserver` calls `fitSane` on any host size change (`Terminal.tsx:1752-1760`), so a header or banner height change during a drag would drop the selection.

## 2. Ctrl+C reliability

### Keystroke path

keydown on xterm's textarea runs `attachCustomKeyEventHandler` (`src/Terminal.tsx:1283-1325`), which only handles hint mode, Ctrl+Shift+Space and Ctrl+Up/Down; Ctrl+C passes through.
xterm maps it to `0x03`, fires `onData` (`Terminal.tsx:1738`), which calls `invoke("pty_write")`, which takes the global registry mutex and writes to the ConPTY input pipe (`src-tauri/src/lib.rs:728-737`).
`pty_write` is deliberately a plain sync command, so it runs on the main thread.
Cockpit's global capture handler has no Ctrl+C binding (`src/Cockpit.tsx:125-260`).
Side effect: `onData` appends `"\x03"` to the draft buffer because it does not start with ESC (`Terminal.tsx:1742`), so a saved draft can carry a stray control character; minor, not verified in the restore path.

### Where a Ctrl+C can be lost or delayed

1. Main-thread stall (0.5.4, strongest explanation). Every command in 0.5.4 was sync: zero `command(async)` in gitstatus.rs, usage.rs, worktree.rs, ports.rs, ghpr.rs or lib.rs at `7b0a3bc`. The invoke carrying `0x03` queues behind any main-thread work, so a 150 ms to 14 s git or transcript poll delays the interrupt. STATE.md:21-24 measured main-thread stalls of 150 ms to 1.4 s on a 30 s cadence and a keystroke-sized invoke waiting 13.3 s. A user who sees no reaction and presses Ctrl+C again sends two, and agy treats two as quit: the binary contains "Press ctrl+c or ctrl+d twice to exit". Not verified live.
2. agy semantics. The binary contains "Press esc to interrupt generation", "Press ctrl+c to stop" and "Press ctrl+c or ctrl+d twice to exit". So Esc is agy's documented interrupt while it is generating, and Ctrl+C behaviour depends on the screen it is on. Flightdeck's agy adapter says nothing about interrupt keys (`vendors.rs:580-612`). Which screen maps Ctrl+C to what is not verified.
3. Focus. The key only reaches the PTY if xterm's helper textarea has focus. The find box and the context menu take focus (`PaneView.tsx:1468`, `:1531`), and `onMouseDown` on the pane only calls `focusPane` (`PaneView.tsx:893-894`), which for Shift+click returns early without focusing (`:890`). Clicking pane header buttons also moves focus off the textarea; not verified whether each restores it.
4. Selection present: not a loss. `^C` is still sent (see section 1), and the selection is cleared.
5. Bracketed paste or Quiet and Chat views: not relevant to agy. Quiet and Chat are Claude-only (`PaneView.tsx:752-760`, `view` is forced to terminal unless the vendor is Claude).
6. ConPTY translates `0x03` into a console Ctrl+C event only when the child is not in raw input mode; Bubble Tea sets raw mode, but a shell command agy spawns could receive a real CTRL_C_EVENT. Not verified.

## 3. Lag

### Poll inventory (cadence, command, thread)

Thread column: "main" means a sync command on the main thread; "pool" means `command(async)` on Tauri's thread pool (0.5.5+).
In 0.5.4 every row was main.

| What | Where | Cadence | Cost and scaling | Thread now |
| --- | --- | --- | --- | --- |
| git_status (3 git subprocesses: rev-parse, status --porcelain, rev-list) | `src/PaneView.tsx:534-547`, `src-tauri/src/gitstatus.rs:57-77` | 30 s per distinct cwd (cached, shared across panes), visible panes only | `status --porcelain` scales with working tree size and untracked files; no `--no-optional-locks`, no timeout | pool |
| git_diff_summary (`git add -N .` in Flightdeck worktrees, then `git diff --numstat --no-renames`) | `PaneView.tsx:553-574`, `src-tauri/src/worktree.rs:462-464,488` | 30 s per cwd | 11-14 s on the Tappy worktree with 8.5 GB of PNGs; now bounded by `core.bigFileThreshold=4m` (3.4 s there); `add -N` rewrites the index every poll (BACKLOG N1.5) | pool |
| pane_usage | `PaneView.tsx:698-704`, `src-tauri/src/usage.rs:256-267` | 15 s per pane | Claude and Codex read transcripts; agy returns `None` immediately (`usage.rs:256-266`), so agy panes get no chip | pool |
| pane_subagent_count and pane_plans | `PaneView.tsx:755-768` | 15 s, Claude panes only | directory metadata and incremental read | pool |
| pane_usage for every pane of every workspace | `src/LeftPanel.tsx:150-164` | 20 s while the rail is expanded | shares the cache, but walks all workspaces, not only the visible one | pool |
| Explorer: fs_list_dir, git_status, git_diff_summary | `src/Explorer.tsx:777-798` | 10 s while the panel is open | repeats git on the Explorer root | pool |
| workspace_ports (netstat plus process snapshot) | `src/WorkspaceChips.tsx:23-26`, `src-tauri/src/ports.rs:130-137` | port poll, visible workspace only | spawns `netstat -ano`, bounded by a timeout (`ports.rs:25,47`) | pool |
| pr_status (gh CLI, network) | `WorkspaceChips.tsx:27-29`, `src-tauri/src/ghpr.rs:56` | PR poll, visible workspace only | network and gh start-up | pool |
| pane_health (memory chip) | `src/poll.ts:132-198`, `src-tauri/src/lib.rs:878-908` | 30 s, new in 0.6.0 (0.5.4 polled it only with Settings > Diagnostics open, `poll.ts:116`) | cheap per pane (OpenProcess, GetProcessTimes) but holds the registry mutex | main (sync, still) |
| pane_subagents row poll | `src/SubagentTreeView.tsx:78-96` | 4 s, popover open only | transcript scan | pool |
| Home overlay diff and PR cycles | `src/homePoll.ts:20-22,169-170` | 15 s and 60 s, overlay open only | git_diff_summary and pr_status for every workspace target | pool |
| ChatView tick | `src/ChatView.tsx:26,232` | 1 s | Claude chat view only, not agy | pool |
| Window heartbeat | `src/windowBoot.ts:22` | 2 s | trivial | pool |
| Activity sparkline tick, rail relative-time tick | `PaneView.tsx:821`, `LeftPanel.tsx:308` | 4 s, 30 s | React re-render only | n/a |
| Quota gauge | `src/QuotaGauge.tsx:8` | 60 s | plan_usage (network) | pool |
| Session scrollback refresh | `src/session.ts:87` | 20 s | serialises each pane buffer, up to 3 MB JSON per save (BACKLOG N1.8) | save_session is async |
| Linkify path checks | `src/Terminal.tsx:143-253`, `src-tauri/src/pathcheck.rs:131` | hover only, not per output line | batched, 15 s TTL cache (`src/pathcheck.ts:13`), spawn_blocking | pool |

`poll.ts` (`usePoll`, `windowActive`) stands down only when `document.visibilityState === "hidden"` and the pane or window is not visible (`poll.ts:66-103`).
There is no file-system watcher in Rust (grep for `notify::` and `RecommendedWatcher` finds nothing), so repo size only costs through the git, fs_list_dir and transcript polls above.

### Main thread in 0.5.4 versus now

0.5.4: no `command(async)` anywhere (counted per file at `7b0a3bc`), and `paths_exist` did not exist yet.
Now (0.5.5 onwards, commit 9dd8272): 19 read-only pollers moved to the pool, diff summary bounded, slow-call TTL stretched 20x up to 5 minutes (`src/poll.ts:25-56`), and since 0.6.0 `pty_spawn`, `pty_attach` and the windows commands are `async fn`.
Still sync on the main thread in 0.6.1: `pty_write`, `pty_resize`, `pty_kill` (by design, for ordering), `pane_health` (`lib.rs:878`), hooks status and install, `reveal_in_explorer`, `set_attention_overlay`, the update commands, and the mutating worktree commands (`git_worktree_add`, `git_worktree_remove`, `git_worktree_gc`, `git_merge_back`, `git_update_from_base`, `git_pr_handoff`; `worktree.rs:1043-1136`; BACKLOG N1.1).
`pty_write` holds the global registry mutex for the whole write (`lib.rs:728-737`), and a large paste goes through a chunk loop with `yield_now` (`lib.rs:700-725`); if the ConPTY input pipe is full the main thread blocks. Not verified for agy.

### Output volume and rendering for agy

Rust reader appends into a coalescer and a flusher thread emits one `pty://output` event per 16 ms per pane (`lib.rs:388-392`, `src-tauri/src/outbuf.rs`); the buffer is capped at 4 MiB and drops the oldest bytes beyond that (`outbuf.rs:27`), which could cut an escape sequence mid-stream in a pathological flood.
The flusher wakes 60 times a second per pane even when idle (BACKLOG N1.3).
Frontend: base64 decode with a per-byte JS loop (`Terminal.tsx:1341-1346`), coalesce to one `term.write` per animation frame (`:1350-1376`), then per event `appendTail` runs a TextDecoder, `parseShellMarks`, an OSC 9;4 `matchAll`, two regex strips and a split over the last 600 characters (`:1472-1510`); the quiet timer is reset on every event.
Hidden panes buffer up to 256 KB and flush on reveal (`:646`, `:1385-1403`).
Renderer: one WebGL addon per pane with silent DOM fallback on failure or context loss (`:648-658`, `:780`); 0.5.4 also had WebGL (2 `WebglAddon` references at `7b0a3bc`).
Scrollback default is 5000 lines (`settingsStore.ts:34`).
How often agy redraws, its spinner rate and its bytes per second: not verified (needs a live session).
The cursed renderer is diff-based (Bubble Tea v2), which suggests modest volume, but this is an inference.
agy synchronized output (`?2026h`) is supported by xterm 6.0.0; whether the WebGL renderer batches it is not verified.

### Ranked likely causes of "laggy, worse depending on the project"

1. Main-thread blocking by sync commands in 0.5.4, fed by git and transcript polls whose cost scales with the repo. Evidence: zero async at `7b0a3bc`; STATE.md:18-27 (13.3 s keystroke wait, 11-14 s diff, stalls on an exact 30 s cadence even with the workspace hidden). This is the "depends on the project" signature. Fixed in 0.5.5 (9dd8272), so it should disappear on upgrade.
2. agy's own workload on big repos. BACKLOG.md:1319 records an agy run at 10-50% of a core and 3.5 MB/s of reads. Flightdeck cannot fix agy's indexing, only surface it. Not verified beyond that note.
3. Remaining git cost on the pool for large repos: `git status --porcelain` without `-uno` or `--no-optional-locks`, `git add -N .` in worktrees, no per-command timeout, repeated by LeftPanel, Explorer, Home and per-pane polls on distinct cwds. Pool threads and disk contention rather than UI freezes, plus possible `index.lock` collisions with the agent's own git calls (not verified).
4. Sync `pty_write`, `pty_resize` and `pane_health` sharing one registry mutex on the main thread (`lib.rs:728-760,878`). A blocked write or a slow health sample stalls input for every pane. Not verified for agy.
5. Per-pane output pipeline at 60 events per second per pane (base64 plus regex plus xterm parse plus WebGL), multiplied by pane count, and software rendering over RDP (WebGL falls back silently, `Terminal.tsx:779-781`). Not verified.

## 4. Existing BACKLOG coverage

Ids from `BACKLOG.md` and `docs/plans/qol-roadmap-2026-10-04.md`.

| Topic | Id and status |
| --- | --- |
| Cut the lag fix as 0.5.5 | N0.1 (done, shipped as 0.5.5) |
| Mutating git commands off the main thread | N1.1 (BACKLOG.md:1311), open |
| `pty_spawn` async | N1.2 (BACKLOG.md:1312); `pty_spawn` is `async fn` now (`lib.rs:210`), checkbox looks stale |
| Flusher threads idle at 60 wakeups per second | N1.3 (BACKLOG.md:1313), open |
| Transcript polling consolidation | N1.4 (BACKLOG.md:1314), open |
| Skip `git add -N .` when nothing is untracked | N1.5 (BACKLOG.md:1315), open |
| Slow-command flight recorder | N1.6 (BACKLOG.md:1316), open |
| Guard test that polled commands are async | N1.7 (BACKLOG.md:1317), open |
| Session save JSON cost | N1.8 (BACKLOG.md:1318), open |
| Per-pane CPU and IO chip (the agy 10-50% case) | N1.9 (BACKLOG.md:1319), open |
| Heavy-untracked-binaries repo warning | N1.10 (BACKLOG.md:1320), open |
| Truthful agent state instead of the quiet timer | N2.1 to N2.5 (BACKLOG.md:1323-1327) |
| Per-pane launch dials (model, effort) | N3.3 (BACKLOG.md:1332) |
| Settings > Agents "Extra CLI flags" and binary path do nothing | K9 (BACKLOG.md:126) |
| Vendor-specific settings schema | 223 (BACKLOG.md:492), agent presets 68 (BACKLOG.md:221) |
| SQLite persistence | N4.1 / R4 |
| Cold-start and 6-pane steady-state budget gate | N4.5 (BACKLOG.md:1341) |
| WebGL renderer with fallback | QL-736 (BACKLOG.md:1170), done |
| Write-side pty batching and bracketed-paste chunking | QL-759 (BACKLOG.md:1197), chunking done in `lib.rs:700-725`, bracketed paste on the programmatic paste path not done |
| Copy mode with vi keys | QL-760 (BACKLOG.md:1198) |
| Copy last agent message without the mouse | UX-548 (BACKLOG.md:994) |
| OSC 52 clipboard write | QL-758, done |
| Copy-on-select, right-click paste | H2 (roadmap Phase 6), done in 0.6.0 |
| Quick-select hints | QL-754, done |
| Port chips, PR/CI chip | H6, done in Phase 6 |
| Scrollback cap for memory across panes | 277 / UI-49, done (cap and Explorer row cap) |
| Mouse reporting / Shift+drag selection in agent TUIs | not in BACKLOG (only noted at `docs/plans/phase3-fullscreen-probe.md:22` for Claude fullscreen) |
| agy interrupt key, Ctrl+C semantics | not in BACKLOG |

## 5. Proposals

Size: S under a day, M a few days, L a week or more.
"0.6.x fixes" means upgrading from 0.5.4 already fixes or mitigates it.

### Antigravity panes

1. Per-vendor interrupt action. What: an "Interrupt" button and a key (Esc for agy, `^C` for claude and codex) declared in the vendor adapter, plus "Esc to stop" text in the agy pane menu. Why: agy's binary says "Press esc to interrupt generation" and "ctrl+c twice to exit", and Flightdeck's adapter knows neither (`vendors.rs:580-612`). Size S. New.
2. Mouse-reporting policy per vendor. What: a pane setting "Plain drag selects text (hide mouse mode from agy)" that filters DECSET 1000/1002/1003 for agy, with Shift+drag documented as the override when off. Why: agy enables 1002/1003/1006, so plain drags go to the app (section 1). Risk: wheel scrolling inside agy may depend on mouse mode, test first. Size M. New.
3. Selection hint. What: when a plain drag starts in a pane with mouse tracking on, show a one-line "Hold Shift to select text" toast, once per pane. Why: nothing in the UI explains the override. Size S. New.
4. Fix the Shift+click collision. What: ignore the pane-level Shift+mousedown multi-select when the target is inside `.xterm`, and give bulk select another gesture (Ctrl+Alt+click or the pane header). Why: `PaneView.tsx:890` toggles the bulk toolbar and skips focus while Shift+click is xterm's extend-selection. Size S. New.
5. Ctrl+C when text is selected. What: with a selection and copy-on-select off, Ctrl+C copies and clears; with it on, send `^C` as now; make Ctrl+Shift+C always copy. Why: no copy key exists today (section 1) and users expect Windows Terminal behaviour. Needs a ruling because Ctrl+C must stay an interrupt for agents. Size S. New.
6. Right-click and menu paste through xterm. What: replace the raw `pty_write` in `Terminal.tsx:1894` with `term.paste(text)` so bracketed paste (agy enables `?2004h`) is honoured. Why: a multi-line right-click paste into agy currently arrives as bare newlines, which can submit mid-paste. Size S. Partly QL-759.
7. Agy launch options. What: expose model and flags (the hard-coded `--model gemini-3-pro --new-project` at `vendors.rs:599`) through the K9 and N3.3 work. Why: every agy pane launches the same model and a new project, and the Settings fields do nothing. Size M. K9, N3.3.
8. Agy usage chip. What: find where agy keeps its session data and add a `pane_usage` arm. Why: `usage.rs:256-266` returns `None` for agy, so agy is the only agent with no token or context chip. Source of agy session data not verified. Size M. New.
9. Agy state accuracy. What: use agy's own signals (title or OSC 9;4 if it emits them) rather than the 6 s quiet timer (`vendors.rs:606`). Why: "waiting" and "permission" for agy are guesses. Size M. N2.1 family.
10. Selection survives layout churn. What: debounce `fitSane` while the mouse is down and skip row-changing resizes during a drag. Why: xterm drops the selection on any rows change (`SelectionService.ts:158`). Not verified as a real trigger. Size S. New.

### Performance

11. Git poll hardening. What: run poll-side git with `GIT_OPTIONAL_LOCKS=0`, `status -uno` or a time budget, a hard timeout (reuse `run_bounded`, `ports.rs:25-47`), and skip `add -N` when clean. Why: section 3 cause 3. Size S to M. N1.5 plus new.
12. Poll only what is on screen. What: drop the all-workspace `pane_usage` walk (`LeftPanel.tsx:150-164`) to workspaces actually expanded, and share the Explorer git poll with the pane poll. Why: duplicate subprocesses per cwd. Size S. New.
13. Registry mutex and sync commands. What: make `pane_health` async, take it off the registry mutex, and add the N1.7 guard test. Why: `lib.rs:728-760,878`. Size M. N1.7 plus new.
14. Park idle flusher threads. What: drive flushing from a condvar. Why: 60 wakeups per second per pane forever. Size M. N1.3.
15. Slow-command recorder plus CPU and IO chip. What: log any command over 1 s with its cwd, and show agy or claude CPU and IO in the pane header. Why: makes the next "laggy on project X" self-diagnosing and shows when agy itself is the load. Size M. N1.6, N1.9.
16. Per-event output pipeline trim. What: skip `appendTail` regex work when the chunk contains no printable change, and decode base64 with `Uint8Array.fromBase64` or a native path. Why: `Terminal.tsx:1341-1346,1472-1510` run per 16 ms event per pane. Measure first with the main-thread probe. Size S to M. New.
17. RDP and remote-session mode. What: detect `SM_REMOTESESSION`, switch to DOM renderer, lengthen polls, lower scrollback, and show the renderer in Diagnostics. Why: WebGL falls back silently (`Terminal.tsx:779-781`) and the user RDPs to a work laptop. Size M. New.
18. Budget gate. What: add the main-thread probe to CI with a 6-pane agy-style output generator. Why: the 0.5.4 regression was invisible to vitest. Size M. N4.5.

### Whole-app gaps for a multi-agent, many-repo, three-monitor user

19. Copy last agent message and copy mode. UX-548, QL-760. Why: reduces reliance on mouse selection in mouse-capturing TUIs. Size M. In BACKLOG.
20. Needs-you routing across windows. Per-monitor attention summary and focus-return after a game, building on `window_focus_pane`. Why: STATE and roadmap say the user works from summon plus the attention queue. Size M. New, relates to N2.1.
21. Copy-on-select feedback and undo. A small "Copied" flash and a setting to keep or clear the selection after copy. Why: users currently cannot tell whether a selection copied (section 1). Size S. New.
22. Heavy-repo warning. N1.10 in the pane header. Size S. In BACKLOG.
23. Persistence cost. N1.8 and N4.1. Size M to L. In BACKLOG.

### Already fixed or mitigated by upgrading from 0.5.4

- Main-thread stalls from git and transcript polls: fixed from 0.5.5 (items 11 to 13 are the remaining hardening).
- Selection copy and right-click paste: 0.6.0 adds copy-on-select and right-click paste/copy (H2). The mouse-reporting cause of "cannot highlight" in agy is not changed.
- Ctrl+C delayed by a stalled main thread: mitigated by the async fix; the agy key semantics (item 1) are not.
- Terminal remount killing agents on reflow: fixed in 0.5.6 or later by the pane-session registry (roadmap R1, P4).
- Unchanged in 0.6.1 and still open: mouse reporting policy, Shift+click collision, Ctrl+C copy rule, bracketed paste on programmatic paste, `pane_health`, `pty_write` and `pty_resize` on the main thread.

## Top 5 likely causes

1. Sync commands on the main thread in 0.5.4 (fixed in 0.5.5).
2. agy's own CPU and IO on large repos (BACKLOG.md:1319).
3. Remaining git cost on big repos (pool, no timeout, no optional-locks).
4. Registry mutex held by sync `pty_write`, `pty_resize` and `pane_health`.
5. 60 events per second per pane through base64, regex and WebGL, worse under RDP.

## Top 10 proposals

1. Per-vendor interrupt action (Esc for agy).
2. Mouse-reporting policy per vendor.
3. Fix Shift+click collision at `PaneView.tsx:890`.
4. Selection hint toast.
5. Ctrl+C and Ctrl+Shift+C copy rule.
6. Bracketed paste on right-click and menu paste.
7. Git poll hardening (optional locks, timeout, skip `add -N`).
8. Async `pane_health` and registry-mutex cleanup.
9. Slow-command recorder plus CPU and IO chip.
10. RDP and remote-session mode.
