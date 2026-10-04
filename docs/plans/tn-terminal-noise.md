# TN: terminal noise (plan, 2026-10-04)

Source: BACKLOG.md section TN (Balu, PRIORITY).
Goal: Claude output reads as one line per action, detail on click, and Chat is where Claude panes open.
Lands on `qol/phase-6`, gated with Phase 6, ships in the one 0.6.0 release.

## What it is

- Claude panes open in Chat by default (setting), the terminal stays live underneath (Ctrl+Shift+M).
- Chat Normal density: each run of consecutive tool calls between two pieces of agent prose is ONE line ("Edited 4 files, ran 3 commands, read 6 files"), click to expand into today's chips; a chip expands to its diff/output.
- Subagents are one line each with live counts; expand shows their own activity at the same density.
- Each turn ends with one "Changed 5 files +120 -18" row that opens Review.
- Verbose keeps today's chips.

## What it is not

- Not a re-render of Claude's TUI: Flightdeck cannot change what Claude prints into the terminal (TN5 only looks for Claude-side switches).
- Not a new input surface: the terminal remains the source of truth for permission prompts and the trust prompt.

## Split

| Branch | Owner | Items | Files |
|---|---|---|---|
| `qol/tn-ui` | frontend (general-purpose) | TN1, TN2, TN3 UI, TN4, TN6 | ChatView.tsx, chat/*, chat.css, chatlog.ts, settings store + Settings.tsx (Agents section only), pane creation default, demo mock, e2e/chat-density.mjs |
| `qol/tn-sub` | backend | TN3 Rust | chatlog.rs (or usage.rs reuse), lib.rs registration, cargo tests |
| main checkout | researcher (general-purpose) | TN5 | docs/plans/tn5-claude-tui-options.md |

## TN3 contract (fixed, both sides build to it)

Tauri command `session_subagents`, async, arg `jsonlPath: string` (the parent session JSONL), returns `SubagentLink[]` (camelCase):

```
{ id: string,            // agentId (file stem minus "agent-")
  toolUseId: string|null,// from agent-<id>.meta.json; links to the parent's Agent/Task tool_use id
  agentType: string|null,
  description: string|null,
  jsonlPath: string,     // absolute path of the subagent transcript
  edits: number, commands: number, reads: number, searches: number, other: number, // tool_use counts by class
  finished: boolean,     // same rule as usage.rs: newest assistant line is text only
  lastActivityMs: number }
```

Path validation identical to `session_tail` (pathguard / read scope), incremental per-file scan cached by offset, oldest-first order by spawn.
The subagent transcript itself is read with the existing `session_tail` / `session_record` on `jsonlPath`.

## Gate (Phase 6 gate covers it)

tsc, vitest, cargo test, vite build within perf budget, all e2e/*.mjs, design critique of Normal/Verbose screenshots, TN6 measurement recorded below.

## TN6 measurement

(filled in at merge)
