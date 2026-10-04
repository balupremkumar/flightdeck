# Phase 2: open understood formats inside Flightdeck (plan of record, 2026-10-04)

Source: [[projects/active/flightdeck/docs/plans/qol-roadmap-2026-10-04|QoL roadmap]] rows 2.1-2.5 and its locked decisions.
Locked: viewers read workspace roots, `D:\Dev\ai` and `~/.claude` only; viewers are read-only; first wave JSON + JSONL, CSV/TSV, Mermaid; images wave 2.
Cadence: no per-phase release (memory flightdeck-release-cadence); gate, merge to main, go straight to Phase 3.

## Streams (parallel, file ownership)

V1 read scope (Sonnet backend): `src-tauri/src/readscope.rs` (new), lib.rs read commands, `src/readscope.ts` (new) to push roots.
Scope applies to FILE CONTENT reads only (`fs_read_text_file`, `fs_read_file_base64`, any new viewer read command); directory listing (`fs_list_dir`, used by New Workspace to browse anywhere) stays unscoped.
Allowed: every open workspace root (frontend pushes the list on change via `set_read_roots`), the vault `D:\Dev\ai` if it exists, `%USERPROFILE%\.claude`, and the app's own data dir.
Check on the canonicalised path (so `..` and junctions cannot escape), after the pathguard UNC check.
Outside scope returns a typed error `outside-read-scope`; Preview shows "This file is outside your workspaces" with Open externally / Reveal / Copy path.
Every existing caller must keep working: ConfigDoctorView (~/.claude and project .claude), Explorer text reads, Preview, markdown images.

V2a viewer registry + JSON/JSONL (Sonnet frontend): owns `src/Preview.tsx`, new `src/viewers/` folder (registry.ts, JsonTree.tsx, JsonlView.tsx), preview.css.
Registry: extension -> viewer id list (default first), "Reopen with" menu (useOverlayEsc) remembering the choice per extension in localStorage, always-visible toolbar gains a word-wrap toggle and Ctrl+F find-in-viewer (QL-702) with match count and next/prev.
JSON tree: lazy chunk, collapsible, expand-all/collapse-all, copy value/path, handles 5 MB without freezing (virtualise or cap initial expansion depth), falls back to text with the parse error position on invalid JSON.
JSONL: one row per line, each row collapsible as a JSON tree, row count, invalid lines flagged, Claude session JSONL gets a "type" chip column if present.

V2b CSV + Mermaid components (Sonnet frontend): owns new `src/viewers/CsvTable.tsx`, `src/viewers/MermaidBlock.tsx` and their tests only; no edits to Preview.tsx or markdown.ts (lead wires them through the V2a registry).
CSV/TSV: papaparse (or a small RFC 4180 parser if smaller), header row detection, virtualised rows (@tanstack/react-virtual or simple windowing), sortable columns, column width resize, cell copy, row count, 5 MB smooth.
Mermaid: lazy-loaded `mermaid` chunk (must not enter the main bundle; perf budget 436 KB app chunk), renders ```mermaid fences, theme follows app light/dark, securityLevel "strict", render errors show the source with the error.

V3 wave 2 (after V2a merges): CodeMirror 6 read-only highlighting for Python, PowerShell, YAML, TOML, SQL, C#, HTML, JS/TS, Rust, JSON, Markdown; log colouring; follow file on disk change (QL-704, Rust mtime poll or watcher, async); markdown TOC (QL-703); preview pinned as a split beside the panes (QL-708); images and SVG via the asset protocol scoped to the same read roots (CSP + capability change: boot gate critical); PDF probe via WebView2.

## Gates

vitest, tsc, cargo, build with perf budget (every viewer a lazy chunk), e2e: new `e2e/viewers.mjs` opening a JSON, JSONL, CSV and a Mermaid markdown file from the mock and asserting each viewer renders; existing four e2e tests; Fable red team; design critique of the viewer screenshots.
