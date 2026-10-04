# Flightdeck QoL roadmap (2026-10-04, red-teamed, awaiting Balu's picks)

Status: DECISIONS LOCKED 2026-10-04 (brain/rulings.md). Nothing built yet.

## Locked decisions (override anything below that conflicts)

Releases: manual install only; auto-update check off, a "Check for updates" button that only notifies.
Every installer archived forever in `releases\archive\<version>`.
App data auto-backed-up on a new version's first launch; revert restores the matching backup.
Canary before stable; a release is cut only when Balu asks (phases end release-ready, not released).
Testing: agents plus a 5-step hand check; Fable red-teams each phase.
Git: merge origin/main into local main.
Viewers read workspace roots, D:\Dev\ai and ~/.claude only; plain click opens the in-app viewer, Ctrl+click the editor, folders go to Explorer; viewers read-only.
First viewer wave: JSON + JSONL, CSV/TSV, Mermaid. Images move to wave 2.
Board deleted now (end of Phase 0): cards exported to markdown, "New task" becomes a palette command, Board code and its dependants removed. Home view only after multi-window.
Clutter: Review collapse, one-day Claude fullscreen trial, then Chat view.
Windows: commands and monitor restore first, Chrome-style drag last.
Themes: GitHub (incl. high contrast), One Dark Pro, Tokyo Night. Sounds: needs-you only.
Extras: plan quota gauge, pane colour and name. Port chips and PR/CI chip parked.
Codex vendor after all QoL phases.
Vault: [[projects/active/flightdeck/STATE|Flightdeck STATE]] | [[projects/active/flightdeck/BACKLOG|Backlog]]

Evidence:
- Idea Ledger (AI Pulse artifact), 53 open entries, 13 tagged Flightdeck, plus archive.
- Codebase audit, history digest (STATE, BACKLOG, rulings, memory), Fable red team.
- [[research/flightdeck-competitor-qol-2026-10/README|Competitor QoL scan]] (30 products).
- [[research/vscode-qol-for-flightdeck-2026-10/README|VS Code and terminal QoL scan]].
- Two live repros run this session (R1, R2).

## Reproduced this session

R1. Pane reflow kills running agents.
Playwright against the real frontend with the interactive Tauri mock: adding a 4th pane to a 3-pane workspace sends pty_kill to pane 3 and spawns a fresh agent; a 5th pane does it again.
Closing a pane (4 to 3) and dragging a pane across rows hit the same path.
Cause: `src/PaneGrid.tsx:12-20` reshapes rows by pane count, each row is its own PanelGroup keyed by index (`:138-141`), so a pane that changes row remounts; `src/Terminal.tsx:1404` kills the PTY on unmount and `:1275` spawns a new one.

R2. Links break on common shapes (vitest probe of `linkify()` plus code read).
Unquoted spaced paths (`...\Kove Clients\STATE.md`) split into two links, the second resolved against the wrong folder.
`~/.claude/...` drops the tilde.
Wikilinks and bare filenames (`README.md`) are not linked.
Backtick and `**` wrappers stay in the span, so the existence check fails and the link shows "not found".
URLs swallow a trailing `)`.
Folders open Preview and show "Windows blocked reading this file".
Images and PDFs are read as text.
Wrapped xterm rows are not joined; column numbers are dropped.
Claude panes never report cwd (OSC 9;9 only reaches pwsh panes), so relative paths resolve against the spawn folder.
UNC paths are clickable, a credential-leak class Claude Code deliberately avoids (`src/linkify.ts:35`).

## What history says (drives the ordering)

Breakages came from mount and boot paths that vitest cannot see (xterm is mocked): 0.5.2 invisible window, 0.5.3 proposed-API crash loop, missing Tauri capabilities.
So every phase that touches panes, CSP or capabilities goes through pane-smoke, boot gate and canary.
Sync Tauri commands have stalled every pane before; anything that reads big files (JSONL, viewers) must be async.
The bell rebuild (UX-601) is the most load-bearing daily surface; nothing replaces it, only adds beside it.
Balu verifies by hand from lists, often late, and runs 3-6 panes across several workspaces with a fullscreen game on the main screen; summon plus the attention queue is how he reaches panes.
In-app update has never succeeded; 0.5.5 was never cut.

## Phase 0: stabilise (before any feature)

P1. Reconcile local main with origin (1 ahead, 3 behind; lag fix 9dd8272 and BACKLOG section N only on origin), rerun gates.
P2. CI: add `tsc` + build (catches the case-collision class) and a Playwright-on-mock lane; R1 becomes its first test.
P3. Cut 0.5.5 and prove the in-app updater end to end.
P4. Fix R1 properly: xterm instance and PTY id held in a registry keyed by pane id, reattached on remount, killed only from the explicit close path; `rows()` made append-stable. Keeps the draggable dividers. This is also the foundation for multi-window.
P5. UNC paths: not auto-linked, or confirm first.
P6. Hard-coded releases path (`src/updater.ts:14`, `src-tauri/src/updates.rs:58`), per ruling.
Cut 0.5.6 with P4-P6 through canary.

## Phase 1: links that always land

A1. Resolver overhaul: VS Code suffix set (`#L12`, `, line 12`, `(12,5)`, `12:5-20`), strip backticks, emphasis and brackets, `~` expansion, Git Bash and WSL path mapping, spaces when delimited or verified on disk, `file://` and OSC 8 decoded, column honoured, wrapped rows joined.
A2. Candidate resolution through one async read-only Rust `fs_stat_many` with a cache: pane worktree, last known cwd, workspace root, vault root. Fix the real gap: Claude panes need a cwd signal.
A3. Folder click reveals and expands it in the Explorer panel.
A4. Right-click on any link: Open in preview, Open in editor, Reveal in Explorer, Copy path, Send path to focused agent (via `useOverlayEsc`).
A5. Wikilinks resolve against the vault; markdown preview linkifies bare paths, decodes `%20`, honours `#anchor` and `#L12`.
A6. Readability quick wins ride along: xterm `minimumContrastRatio` 4.5 with a slider; separate sizes for terminal, preview and UI; line height; max prose width.
Gate: 3-5 of Balu's real failing lines become vitest cases first.

## Phase 2: open understood formats inside Flightdeck

Decision first: QL-750 (scope file reads to workspace roots), because the asset protocol and CSP widen what the webview can load.
B1. Viewer registry: default viewer per extension, "Reopen with", remembered choice, always-on toolbar (Open in editor, Reveal, Copy path, wrap, Ctrl+F).
B2. First wave, each a lazy chunk inside the perf budget: JSON tree, JSONL (session logs), CSV/TSV table, Mermaid in markdown, images and SVG via the asset protocol (removes the 10 MB cap).
B3. Second wave: code highlighting for Python, PowerShell, YAML, TOML, SQL, C#, HTML (CodeMirror 6 read-only), log colouring, follow on disk change, markdown TOC, compare two files.
B4. Preview pinned as a split, not only a drawer.
B5. Probes only: PDF via WebView2 (can be policy-disabled), HTML render.
B6. Your call: quick-edit in the viewer bends the hand-off-to-editor rule.

## Phase 3: less clutter in the chat

The diffs you see are Claude Code's own terminal UI; Flightdeck does not draw them.
C1. Review drawer, additive: collapse per file, auto-collapse large files, collapse all, collapse unchanged regions, Viewed checkbox that unmarks on change, hide whitespace, scope to last turn.
C2. One-day probe: Claude Code fullscreen mode (its own Ctrl+O and click-to-expand) inside Flightdeck. Risky: it uses the alternate screen, which breaks scrollback search, transcript, restore and attention heuristics, and it may fight Flightdeck's link clicks.
C3. Chat view per Claude pane, read from the session log: tool calls collapsed into chips ("Edited 3 files +42 -7"), auto-collapse diffs over N lines, Normal/Verbose, find that expands, sticky last-prompt header, per-turn file changes, clickable paths.
Two prerequisites: a pane-to-session id handshake (today two Claude panes in one folder show the same log) and async incremental parsing.
C4. Command output folding in pwsh panes via OSC 133 marks.

## Phase 4: separate windows, merge back

Architect plan first: Rust owns session state (windows share localStorage and would overwrite each other's autosave), per-window event channels, capability labels beyond "main", one summon hotkey and taskbar badge.
D1. Commands: "Move workspace to new window", "Merge all windows".
D2. Windows reopen on their monitors with their layouts.
D3. Drag a workspace or pane out to another screen and back, Chrome and Windows Terminal style (last, highest risk).

## Phase 5: the Board

Evidence: built as optional against the spec, about 2,600 lines with tests, one global manual board, unused. In 2026 the boards that survive are computed from agent state; manual kanbans died.
E1. Hide behind a setting for one release (saved `view: "board"` falls back to the cockpit), export cards to markdown, then delete.
E2. Keep its one good idea: "New task" in the palette spawns a pane with the prompt.
E3. Optional, later: a Home view across workspaces with computed columns (Needs you, Working, Ready to review, Idle, Merged), peek and reply to free-text questions, beside the bell, never replacing it.

## Phase 6: extras

F1. VS Code theme import plus GitHub, One Dark Pro, Tokyo Night, Catppuccin presets.
F2. Per-pane colour and name.
F3. Opt-in matching Claude Code theme so its diff colours match the app.
H1. Sounds per event (done, needs you, error).
H2. Copy-on-select and right-click paste in the terminal.
H3. Settings search.
H4. Queued-prompt visibility; side-chat and task chips as buttons.
H5. Widen session search (QL-771, shipped) across all projects with regex.
H6. Port chips per workspace with kill; PR/CI chip with a CI-finished toast; plan quota gauge.
H7. Windows tail already in backlog (QL-781..791).

## From the Idea Ledger (Flightdeck-tagged), triaged

Keep:
G1. Pricing and context refresh for Opus 5.5 ($4/$20, 1M context) and Sonnet 5.5, verified against the official page before editing `usage.rs`.
G2. MCP health per pane: disconnect notice, session stuck on a pending MCP prompt.
G3. Hook-driven truthful state (Stop, PermissionRequest) plus OSC 9;4 progress as an extra busy signal (BACKLOG N2).
G4. ConfigDoctor shows which instruction files each agent reads and runs `claude plugin validate`.
G5. Codex vendor (existing plan; Codex now lives in ChatGPT Desktop; Gemini CLI retired 2026-06-18, check agy).
G6. Cross-pane "you should know" watchdog, later.
Park: Copilot computer-use pane, Drawgent canvas steering, OpenRig spec, agentproto widgets, credential pane (conflicts with no stored credentials), 706K form model, Tev1 routing gate, Phoenix decision spans, shared-memory MCP, Remote Control toggle.

AI Pulse itself: no in-app surface.
The ledger is a private claude.ai artifact the machine cannot read, the weekly radar already syncs it to `D:\Dev\ai\IDEAS.md`, and the status pipeline idea is a routines job (routines BACKLOG 9).
Cheapest touch: pin IDEAS.md in Preview once B4 lands.
Side finding: IDEAS.md does not exist on disk, so the radar sync step is not running.
