# Phase 1: links that always land (plan of record, 2026-10-04)

Source: [[projects/active/flightdeck/docs/plans/qol-roadmap-2026-10-04|QoL roadmap]] rows 1.1-1.6, locked decisions at its top.
Locked: plain click opens the in-app viewer, Ctrl+click opens the editor, folders go to the Explorer panel; viewers read-only; UNC never linked.

## Streams and file ownership (parallel, no shared files)

L0 fixtures (Haiku): mine real link-bearing lines from recent Claude session JSONLs into `src/__fixtures__/agent-links.txt` (sanitised, no secrets), one per line with the expected target.
L1 matcher (Sonnet): owns `src/linkify.ts`, `src/linkify.test.ts`. Rows 1.2a-h plus `~`, backticks/emphasis/brackets, URL trailing `)`/`]`, Git Bash `/c/` and WSL `/mnt/d/`, suffixes `#L12`, `, line 12`, `12:5-20`, bare filenames and extensionless folders only as UNVERIFIED candidates, spaces when delimited (quotes, backticks, markdown link target), column kept, wikilinks `[[path|alias]]` and `[[path]]` emitted as `kind: "wikilink"`.
L2 resolver (Sonnet backend): owns `src-tauri/src/pathcheck.rs` (new), its registration in `lib.rs`, and `src/pathcheck.ts` (new). Contract below.
L3 terminal links (Sonnet frontend): owns `src/Terminal.tsx` link provider, `src/paneSessions.ts` if needed, new `src/LinkMenu.tsx`. Rows 1.3b, 1.3d, 1.3e, 1.4a-c. Uses the L2 contract (stub until merged).
L4 preview links (Sonnet frontend): owns `src/markdown.ts`, `src/Preview.tsx`, `src/CommandPalette.tsx`. Row 1.4d-e, folder paths arriving at Preview redirect to Explorer, binary/unknown files get a friendly "open externally" state instead of garbled text, and "New task" sends its text to the agent once the pane is ready.
L5 readability (after L3 merges, Sonnet): owns `src/Settings.tsx`, theme CSS. Rows 1.5a-c: xterm `minimumContrastRatio` 4.5 with slider, separate terminal / preview / UI font sizes, line height, preview prose width.

## L2 contract (`src/pathcheck.ts`)

```ts
export interface PathHit { input: string; path: string; isDir: boolean }
/** For each raw path, try it as absolute, else against each base in order;
 *  returns the first that exists, or null. Async, cached ~2s, batched. */
export function resolveExisting(raws: string[], bases: string[]): Promise<(PathHit | null)[]>;
```
Rust: `#[tauri::command] async fn paths_exist(raws: Vec<String>, bases: Vec<String>) -> Vec<Option<PathHit>>`, runs on `spawn_blocking`, never follows UNC (`\\` or `//` prefixes return None), expands `~` to the user profile, maps `/c/x` and `/mnt/c/x` to `C:\x`, caps at 200 inputs per call.
Base order supplied by callers: pane worktree, pane last-known cwd, workspace root, `D:\Dev\ai` vault root (setting, default the vault if it exists).

## Gates

vitest per stream; tsc; L1 against the L0 fixture file; e2e (lead runs on :1420 after the 0.5.5 release gate finishes); Fable red team of the phase; design critique of the link menu; release only on Balu's word.
