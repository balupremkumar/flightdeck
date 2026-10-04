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

Target: a realistic multi-file edit turn renders in at most 5 rows below the prompt in Normal.
Real tool steps are separated by short sentences ("Now I'll update the tests."), so folding only runs of consecutive steps was not enough.
Normal now also absorbs narration into the activity line.
Narration is an assistant text of at most 200 characters, one paragraph, with no code block, list, table or heading.
The turn's closing reply (the last assistant text with no step after it) and any long or structured prose stay visible and still split runs.

Mock turn (vitest TN6 and e2e/chat-density.mjs): 6 Edits over 4 files, 3 Bash, 8 Reads, 2 Grep, one subagent, plus short narration sentences.
Verbose renders 14 rows below the prompt.
Normal renders 3 rows: the activity line, the closing reply and the change row.

Real transcript (7852afef, 70 turns, top-level calls only):

| Turn | Verbose rows | Normal before narration fold | Normal after |
| --- | --- | --- | --- |
| 31 (21 calls, 5 files) | 16 | 10 | 4 |
| 33 (15 calls, 4 files) | 17 | 10 | 4 |
| All 31 turns with 5+ calls | 361 | 246 | 106 |

Rows include the change row.
The line shows the counts label, then the latest narration sentence as dim text (full text in the title); expanding it interleaves chips and narration in original order.
