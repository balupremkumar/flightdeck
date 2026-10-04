> DRAFT, planning only (2026-09-29). Not approved; Balu's open decisions pending. Companion: D:\Dev\ai\research\openai-third-provider-plan-2026-09-29.md

# Flightdeck: Codex CLI as the third agent vendor

Planning only, 2026-09-29. No repo files changed.
Repo: `D:\Dev\ai\projects\active\flightdeck` (HEAD 65ab7e9, v0.5.4 shipped, 0.5.5 cut pending).
Effort scale: S = under an hour, M = a half day, L = a day or more.

## 0. Decisions this plan takes (Balu can overturn)

1. Build `codex` as a **built-in adapter** in `src-tauri/src/vendors.rs`, not a JSON manifest.
   BACKLOG item 226 said Codex "should be a manifest entry", but a manifest cannot express the four things that make an agent feel native: a `prepare()` trust hook, an install hint, session resume, and usage metering.
   A manifest drop is still the zero-code spike for day one (section 3, item T0).
2. Satisfy Codex's "Trust this folder?" prompt with a **launch-time config override** (`-c 'projects."<cwd>".trust_level="trusted"'`), not by editing `~/.codex/config.toml`.
   No TOML crate exists in `src-tauri/Cargo.toml` (deps: tauri, serde, serde_json, portable-pty, base64), and an override needs no prune on worktree removal.
   This needs a live confirmation (item T4); the fallback is the agy pattern with a `toml_edit` dependency.
3. Auth probe = `~/.codex/auth.json` present, else run `codex login status` and read the exit code.
   Codex's credential store can be `keyring` on Windows, so the file heuristic alone would read a signed-in user as "not signed in".
4. Launch through `pwsh.exe -NoLogo -NoProfile -Command codex`, exactly like Claude (`vendors.rs:343-351`), because `npm i -g @openai/codex` installs a `codex.cmd` shim.
5. Do not pass `--yolo`, `--full-auto` or any sandbox flag. Codex's own defaults apply (workspace-write + on-request in a git repo). `--full-auto` is deprecated.

## 1. How `agy` was added: the template

Commits (from `git log -S agy`): f19ba26 registry, 6df9aaa #219 auth probe, 29d39b0 UI-237 quiet thresholds, fc2403f UI-9 install hints, ae69e9d + 4d1da7e K0a trust, 70e4c7b glyphs, 1c3c01a UI-3 usage chip, 4fd71a1 #218 manifests, 0341d98 UX-586 hot reload.

| Concern | Where agy lives | Notes |
|---|---|---|
| Adapter | `src-tauri/src/vendors.rs:362-399` (`struct Agy`), registered at `:851-859` (`registry()`), builtin id list at `:798` | One impl + one line in registry |
| Trait surface | `vendors.rs:262-326` (`VendorAdapter`: id, label, probe, command, root_exe, prepare, short, kind, accent, needs_trust, install, quiet_seconds, env_strip, auth) | `detect()` at `:880-903` maps it to `VendorInfo` (`:44-72`) |
| Detection | `Agy::probe` `:368-375` checks a fixed path via `agy_path()` `:100-105`; Claude uses `which()` `:75-98` (`where` with CREATE_NO_WINDOW) | |
| Auth probe (#219) | `Agy::auth` `:391-398`, `cred_file_present` `:138-142`; default `:319-325` | Existence heuristic only, never parses credentials |
| Install hint (UI-9) | `Agy::install` `:376-378`; consumed by `Settings.tsx:2024-2034, 2238-2263` popover and `NewWorkspace.tsx:491-500` slot warning | |
| Launch | `Agy::command` `:379-384`; `lib.rs:115-148 build_command` appends staged args, wraps setup, strips env, forces colour; `lib.rs:170-172` calls `prepare` then spawns | |
| Trust (K0a) | `ensure_agy_trust` `:192-198`, `prune_agy_trust` `:203-212`, `AGY_TRUST_LOCK` `:128`, JSON helpers `:144-190`; `worktree.rs:357-359` prunes on removal; frontend `src/trust.ts:62-89 ensureTrusted`, called from `worktrees.ts:114` and `:140`; Settings revoke list `Settings.tsx:1290` area | `needs_trust()` `:387` drives the once-per-repo confirm |
| Idle detection (UI-237) | `Agy::quiet_seconds` `:390` = 6; `PaneView.tsx:258-263` seeds from `vendorMeta().quietSeconds`, override key `flightdeck-vendor-quiet` `:44-56`; `Terminal.tsx:1198-1206` quiet timer; `attention.ts:53-92` decides waiting vs ambient from the tail | |
| Usage metering (UI-3) | `usage.rs` is Claude-only: `pane_usage` `:139-144`, `usage_for` `:134-137`, `apply_usage` `:67-87`, `newest_transcript` `:121-129`; agy returns None ("no chip, never an estimate") | `PaneView.tsx:629-647` polls `pane_usage`; `:652` `isClaude` gates subagent + plan chips |
| Resume (QL-764) | `SessionLauncher.tsx:27 RESUME_VENDOR = "claude"`, `resumeArgs` `:60-62`, `launchResume` `:183-207` stages args via `stage_launch_args` (`usage.rs:428-436`, `take_at` `:414-425`); `list_claude_sessions` `:362-366`, `search_claude_sessions` `:1161`; pane menu gate `PaneView.tsx:1175` | agy has no resume; the launcher refuses non-Claude panes at `SessionLauncher.tsx:261-265` |
| Orphans | `orphans.rs:87-95` matches `root_exe()` names; `lib.rs:514` collects them | agy.exe is a root; Claude's root is pwsh.exe |
| Worktrees | vendor-agnostic; `worktrees.ts:110-157` only touches vendor for trust | |
| Broadcast | `Broadcast.tsx:66-70` presets derive from vendors in the pool (`:234-243` "only X" buttons); `:91-115` history keyed by vendor | nothing hardcoded |
| Prompt history | `prompthistory.ts:75-109` keyed by vendor id | nothing hardcoded |
| Glyph | `VendorGlyph.tsx:12-23 vendorInitials` from `short` | "Codex" gives "CO" for free |
| Accent | `theme.css:65` `--agent-claude` (and per theme at `:260, 284, 301, 317, 331, 370`), `themes.ts:440` token list; agy borrows `--accent`; manifests may use hex; `vendors.ts:121-149 accentCss / vendorColor` | |
| Board | `board/boardStore.ts:17 ACCENT_CYCLE`, `:503` palette entry "Indigo" `--agent-claude`; `palette.ts:12` reads registry | optional |
| Frontend fallback | `src/vendors.ts:37-41 FALLBACK` (used only before the backend answers and in vitest) | |
| Settings | `Settings.tsx:2003-2095` Agents section: default vendor, install/auth chips, test launch (`:1612-1636`), flags + binary path (inert, BACKLOG 230), colour | registry-driven |
| Demo/mock | `demo/mock-tauri.js:196-220` VENDORS (already lists a `codex` entry with `#FF9D5C`), `demo/mock-tauri-interactive.js:49, 64` | pane-smoke uses the mock |
| Env strip | `vendors.rs:21-30 BASE_ENV_STRIP` already strips `OPENAI_API_KEY` and `CODEX_API_KEY` | |
| Tests | `vendors.rs:905-1270` conformance suite (`:925-934` trust, `:937-948` quiet, `:1193-1216` trust round trip); `src/trust.test.ts`, `src/vendorglyph.test.ts:24`, `src/prompthistory.test.ts:61-64`, `src/store.test.ts` | |
| Hooks | `hooks.rs` and `Notifications.tsx:273-274 isClaudePane` are Claude-only | Codex equivalent is `notify` in config.toml (later) |

## 2. Codex CLI facts (verified 2026-09-29 by a research agent; official sources only)

`developers.openai.com/codex/*` now redirects to `learn.chatgpt.com/docs/*`. "src@v0.158.0" = `github.com/openai/codex/tree/rust-v0.158.0/codex-rs/...`.

| Fact | Value | Source |
|---|---|---|
| Package / version | npm `@openai/codex` 0.158.0; `bin/codex.js` shim launches native `codex.exe` from `@openai/codex-win32-x64`; latest release rust-v0.158.0 published 2026-09-28 | registry.npmjs.org/@openai/codex/latest; api.github.com/repos/openai/codex/releases/latest |
| Windows install | `npm install -g @openai/codex`, or `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"`; native PowerShell supported, Windows 11 recommended, ConPTY required; WSL2 optional. `docs/install.md` in the repo is stale (says WSL2) | github.com/openai/codex README; learn.chatgpt.com/docs/windows/windows-sandbox; /docs/windows/wsl |
| `codex --version` | expected `codex-cli 0.158.0` (inferred from `cli/Cargo.toml`, not run) | src@v0.158.0 |
| Login | `codex login` opens the browser, OAuth callback on localhost:1455; `codex login --device-auth` for headless (must be enabled in ChatGPT security settings); API key via stdin `codex login --with-api-key` | learn.chatgpt.com/docs/auth; `cli/src/login.rs` src@v0.158.0 |
| Auth status | `codex login status`: exit 0 + stderr "Logged in using ChatGPT" (or "...an API key"), exit 1 + "Not logged in" | `cli/src/login.rs:443-505` src@v0.158.0; learn.chatgpt.com/docs/developer-commands?surface=cli |
| Credential store | `cli_auth_credentials_store = file \| keyring \| auto \| ephemeral`; `file` writes `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`); `codex logout` removes it | learn.chatgpt.com/docs/auth |
| Plans | pricing page: Free, Go, Plus, Pro, Business, Edu, Enterprise; README: Plus, Pro, Business, Edu, Enterprise; TUI onboarding text: Plus, Pro, Business, Enterprise | learn.chatgpt.com/docs/pricing; README; `tui/src/onboarding/auth.rs` src@v0.158.0 |
| First-run screens | welcome, sign-in choice (ChatGPT / device code / API key / Bedrock), then "Trust this folder? 1. Trust and continue 2. Quit" | `tui/src/onboarding/` snapshots src@v0.158.0 |
| Trust storage | `[projects."<path>"] trust_level = "trusted"` in `~/.codex/config.toml`; untrusted folders open restricted | `core/src/config/edit.rs:65` src@v0.158.0; learn.chatgpt.com/docs/config-file/config-reference |
| Sessions | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`; older than 7 days compressed to `.jsonl.zst`; JSONL lines `{timestamp, ordinal?, type, payload}` with types session_meta, response_item, turn_context, token_usage_record, event_msg, compacted, ... | `rollout/src/lib.rs`, `recorder.rs:1731-1734`, `rollout/src/compression.rs`, `history/src/rollout_payload.rs` src@v0.158.0 |
| Token usage in rollouts | `event_msg` TokenCount: `info.total_token_usage` / `last_token_usage` {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}, `model_context_window`, plus `rate_limits` {primary, secondary: {used_percent, window_minutes, resets_at}, credits, plan_type}; also `token_usage_record` lines | `rollout/src/policy.rs`, `protocol/src/protocol.rs:2239-2398` src@v0.158.0 (internal format, not a documented contract) |
| Resume | `codex resume` (picker filtered to cwd), `codex resume --last`, `codex resume <SESSION_ID>` (uuid or name), `--all`, `--include-non-interactive`; `codex exec resume <id>`; no fork | `cli/src/main.rs:350-372` src@v0.158.0; developer-commands page |
| Non-interactive | `codex exec "<prompt>"` with `--json` (events thread.started, turn.started, turn.completed{usage}, turn.failed, item.*, error), `-o/--output-last-message`, `--output-schema`, `--skip-git-repo-check`, `--ephemeral`, `-m`, `-s`, `-C`, `--add-dir`, `-c key=value`; default sandbox read-only; `CODEX_API_KEY` honoured | `exec/src/cli.rs`, `exec/src/exec_events.rs` src@v0.158.0; learn.chatgpt.com/docs/non-interactive-mode |
| Sandbox / approvals | `-s read-only \| workspace-write \| danger-full-access`; `-a on-request \| never` (`on-failure` aliases on-request, `untrusted` now internal); `--dangerously-bypass-approvals-and-sandbox` (`--yolo`); `--approve-for-me`; `--full-auto` deprecated with a warning; git repos default workspace-write + on-request, network off | `utils/cli/src/*.rs`, `protocol/src/protocol.rs:986` src@v0.158.0; learn.chatgpt.com/docs/agent-approvals-security |
| Windows sandbox | `[windows] sandbox = "elevated"` (low-privilege sandbox users, needs admin, `/setup-default-sandbox`) or `"unelevated"` (ACL-based); known issues: error 1385, "writable by Everyone" warnings | learn.chatgpt.com/docs/sandboxing; /docs/windows/windows-sandbox |
| AGENTS.md | `~/.codex/AGENTS.override.md` else `~/.codex/AGENTS.md`; then repo root down to cwd; 32 KiB cap (`project_doc_max_bytes`); CLAUDE.md is NOT read unless listed in `project_doc_fallback_filenames` | learn.chatgpt.com/docs/agent-configuration/agents-md; `config/src/config_toml.rs:74` src@v0.158.0 |
| Config | `~/.codex/config.toml`: model, model_reasoning_effort, approval_policy, sandbox_mode, `[mcp_servers.<id>]` command/args/env or url, `projects.<path>.trust_level`, `notify` (command gets a JSON payload), `hide_agent_reasoning`, `model_provider`, `cli_auth_credentials_store`, `windows.sandbox`, `tui.notifications`; `-c key=value` overrides; `-p profile`; `codex mcp add/list/get/remove/login/logout` | config-reference and developer-commands pages |
| Usage / limits | TUI `/status` shows token usage, context window, "5h limit" and "Weekly limit" bars; no CLI usage command or endpoint; published 5-hour ranges: GPT-6 Sol Plus 15-150 messages, Pro 5x 70-700, Pro 20x 300-3,000; Business = Plus; weekly numbers unpublished | `tui/src/status/snapshots` src@v0.158.0; learn.chatgpt.com/docs/pricing |
| Windows quirks | `CODEX_HOME` must already exist if set; never share `CODEX_HOME/.sandbox-secrets/`; winget required for the sandbox setup but no official winget ID for the CLI found | `utils/home-dir/src/lib.rs` src@v0.158.0; windows-sandbox page |

Unverified: exact `--version` string; whether `--full-auto` still exists; whether the Free plan really includes Codex (three sources disagree); weekly limit sizes; whether `-c projects.<path>.trust_level` suppresses the onboarding trust screen (item T4 tests it).

Local state today: `where codex` finds nothing, `~/.codex` does not exist, only `@anthropic-ai/claude-code@2.1.284` is installed globally.

## 3. Touchpoint plan for the `codex` vendor

Legend: NOW = buildable and testable before purchase; LOGIN = needs a signed-in Codex.
Every NOW item is testable to the "installed / not signed in" boundary by running `npm install -g @openai/codex` today (free).

### Phase A: registry, detection, launch (NOW, total M)

| # | Change | File:line | Effort | Gate |
|---|---|---|---|---|
| T0 | Optional spike: drop `%APPDATA%\ai.flightdeck.app\vendors\codex.json` (`{"id":"codex-spike","label":"Codex CLI","exe":"codex","probe":"codex","authFile":"~/.codex/auth.json","quietSeconds":4,"accent":"#FF9D5C"}`) to see the not-signed-in flow with zero code. Delete before A1 (id must not collide). | manifest folder (`vendors.rs:499-515` format) | S | manual |
| A1 | `struct Codex` after `Agy`: id `codex`, label `Codex CLI`, short `Codex`, accent `--agent-codex`, `probe` = `which("codex")` with a not-found detail naming the npm command, `install` = (`npm install -g @openai/codex`, `https://developers.openai.com/codex/cli`), `command` = pwsh `-NoLogo -NoProfile -Command codex` (Claude pattern `:343-351`), `root_exe` = `pwsh.exe`, `quiet_seconds` = 4 (starting guess), `needs_trust` = true, `prepare` no-op. | `vendors.rs:399` insert; `registry()` `:851-859` add `Box::new(Codex)` after `Agy`; builtin list `:798` add `"codex"` | S | cargo test --lib |
| A2 | Trust override in `command()`: append `-c` and `projects."<cwd escaped>".trust_level="trusted"` (TOML string, backslashes doubled, quotes escaped). Pure helper `codex_trust_override(cwd) -> String` so it is unit-testable. `needs_trust = true` makes `trust.ts:62-89` ask once per repo, same as agy, and no prune is needed because nothing is written to the user's config. | `vendors.rs` new fn near `:192`; `Codex::command` | S | cargo test --lib (new test `codex_command_carries_trust_override`) |
| A3 | Auth probe: `auth()` = if `~/.codex/auth.json` non-empty (`cred_file_present`) then ok; else run `cmd.exe /c codex login status` with CREATE_NO_WINDOW and a 3 s wait, exit 0 = ok, exit 1 = none ("no Codex sign-in, the pane will show the ChatGPT sign-in screen on first launch"), spawn failure = unknown. Pure `parse_login_status(code: Option<i32>) -> &'static str`. Honour `CODEX_HOME` when set so tests can point at a temp dir. | `vendors.rs` near `:352-359` (Claude auth) | S | cargo test --lib (temp CODEX_HOME with and without auth.json; parse table) |
| A4 | Add `OPENAI_BASE_URL` to `BASE_ENV_STRIP` (an ambient base URL can redirect Codex to a metered or wrong endpoint; the manifest exemption at `:730-737` keeps the LM Studio example working). | `vendors.rs:21-30` | S | `every_adapter_strips_at_least_the_base_keys` `:984`, `manifest_env_exemption_is_exact` `:1258` |
| A5 | Conformance tests: extend `only_trust_granting_adapters_declare_needs_trust` `:925-934` with codex; `quiet_seconds_are_sane_per_vendor` `:937-948` unchanged; new tests from A2/A3. | `vendors.rs` tests | S | cargo test --lib |
| A6 | Frontend fallback row `{ id: "codex", label: "Codex CLI", short: "Codex", accent: "--agent-codex", ... }`. | `src/vendors.ts:37-41` | S | tsc, vitest |
| A7 | Theme token `--agent-codex` in all seven theme blocks (warm orange family, light-safe pair; the demo uses `#FF9D5C` dark) and in the token list. | `theme.css:65, 260, 284, 301, 317, 331, 370`; `themes.ts:440` | S | tsc; `themes.test.ts` if it enumerates tokens |
| A8 | Glyph test: `vendorInitials("codex")` = "CO" once the fallback row exists. | `vendorglyph.test.ts:24` | S | vitest |
| A9 | Board palette: add `{ name: "Ember", colorVar: "--agent-codex" }` (optional, keeps ACCENT_CYCLE untouched). | `board/boardStore.ts:503` | S | vitest |

Definition of done A: with `npm i -g @openai/codex` installed and no login, Settings > Agents shows "Codex CLI / not signed in" with a Run login popover; New Workspace slot shows the "not signed in" warning; `test launch` opens a pane that reaches Codex's sign-in screen (proves launch, colour forcing, pwsh shim, glyph, accent); uninstalling shows "not installed" with the npm hint. Gates green: `npx tsc --noEmit`, `npx vitest run`, `cargo test --lib`, `demo/pane-smoke.mjs` (mock already carries a codex row at `demo/mock-tauri.js:207-209`, no change).

### Phase B: live behaviour (LOGIN, total M)

| # | Change | File:line | Effort | Gate |
|---|---|---|---|---|
| B1 | Verify A2: with trust override, a fresh repo opens straight into the prompt with no "Trust this folder?" screen. If it still prompts, fall back to editing `~/.codex/config.toml` via a `toml_edit` dependency, mirroring `ensure_agy_trust` `:192-198` + `prune_agy_trust` `:203-212` + `worktree.rs:357-359`. | `vendors.rs` | S verify, M fallback | manual E2E, then cargo test |
| B2 | Calibrate `quiet_seconds` against real streaming (Codex shows reasoning by default; if it looks idle mid-thought raise to 6 like agy). | `vendors.rs` Codex impl | S | manual, `quiet_seconds_are_sane_per_vendor` |
| B3 | Attention patterns: capture Codex's approval prompt text ("Allow command?" style) and add it to the waiting regex list so a Codex approval rings the bell rather than reading as ambient quiet. | `attention.ts:53-92` | S | `attention.test.ts` |
| B4 | Six-pane launch test: three Codex panes in one repo at once (trust once per repo, no interleaved prompts, no 1385 sandbox error). | none | S | manual |
| B5 | Windows sandbox decision (section 5); if `elevated` is chosen, run `/setup-default-sandbox` once outside Flightdeck. | user config, not code | S | manual |

Definition of done B: a Codex pane in a fresh worktree accepts a prompt, edits a file, the Review drawer shows the diff, the pane goes waiting on an approval prompt and the attention queue picks it up.

### Phase C: session resume for Codex (LOGIN to verify, code NOW, total M)

| # | Change | File:line | Effort | Gate |
|---|---|---|---|---|
| C1 | New `src-tauri/src/codexsessions.rs`: walk `$CODEX_HOME/sessions/YYYY/MM/DD/` newest-first (skip `.zst`), read the first line (`session_meta`, take `payload.cwd`, id, timestamp), keep those whose cwd matches the pane cwd case-insensitively, cap like `LIST_CAP`. Title = first user message from the first `response_item` lines. Command `list_codex_sessions(cwd)`. Path-parameterised for tests, same as `usage.rs::list_sessions` `:345-360`. | new file; register in `lib.rs:646-700` invoke list | M | cargo test --lib with fixture rollouts |
| C2 | Resume args per vendor: replace `RESUME_VENDOR` with `resumeArgsFor(vendor, id, fork)`: claude `["--resume", id, "--fork-session"?]`, codex `["resume", id]`, fork unsupported (hide the fork button for codex). Staged through the existing `stage_launch_args` `usage.rs:428-436`; `build_command` `lib.rs:122-125` appends after `codex` so pwsh runs `codex resume <id>`. | `SessionLauncher.tsx:27, 60-62, 183-207, 261-265, 299, 325`; `PaneView.tsx:652, 1175` | M | `SessionLauncher.test.ts` |
| C3 | Transcript search: Codex rollouts are not slugged by cwd, so either skip deep search for codex (show the Tab hint only for claude) or index by C1's cwd match. MVP: skip. | `SessionLauncher.tsx:325` | S | vitest |
| C4 | Worktree removal leaves Codex sessions whose cwd no longer exists; the launcher lists them under the cwd they were made in, so nothing to prune. Document in a code comment. | `codexsessions.rs` | S | none |

Definition of done C: pane menu shows "Resume session" on a Codex pane, the launcher lists that folder's Codex sessions newest first, choosing one opens a new pane running `codex resume <uuid>` and the conversation continues.

### Phase D: usage metering for Codex (code NOW with fixtures, verify LOGIN, total M)

| # | Change | File:line | Effort | Gate |
|---|---|---|---|---|
| D1 | `pane_usage` becomes vendor-aware: `pane_usage(vendor, cwd)`; claude path unchanged; codex path = newest rollout for cwd (C1 helper) scanned incrementally with the same `FileState` machinery (`usage.rs:48-115`), applying `event_msg` TokenCount lines: `context_tokens` = `last_token_usage.input_tokens + cached_input_tokens`, `output_tokens` += `last_token_usage.output_tokens`, `turns` += 1, `model` from the nearest `turn_context` line. Fill the QL-765 split fields. | `usage.rs:59-144`; `PaneView.tsx:641-647` pass vendor | M | cargo test --lib with a fixture rollout; `PaneView.test.ts` |
| D2 | Bonus chip data: `rate_limits.primary/secondary.used_percent` and `resets_at` from the same line into two optional fields (`planUsedPercent5h`, `planUsedPercentWeek`); tooltip only, no new UI surface. | `usage.rs` PaneUsage; `PaneView.tsx` tooltip | S | same |
| D3 | `contextWindowFor(model)` in `SessionLauncher.tsx` gets `model_context_window` from the rollout instead of a model table when present. | `SessionLauncher.tsx` | S | vitest |
| D4 | Format drift guard: the rollout schema is internal; a parse miss must return None (no chip), never a wrong number. Test a line with unknown shape. | `usage.rs` | S | cargo test --lib |

Definition of done D: a live Codex pane shows the ctx chip with numbers matching the TUI `/status` output, and the tooltip shows 5h and weekly used percent.

### Phase E: hooks parity (LOGIN, later, M)

Codex `notify` (config.toml, command receives a JSON payload) can drive the same relay as Claude hooks (`hooks.rs`, `Notifications.tsx:273`).
Install/uninstall would edit `~/.codex/config.toml`, which needs a TOML crate; park until B1 decides whether that crate arrives anyway.

## 4. Cross-model workflow in Flightdeck

Grounded in what exists: Broadcast (`Broadcast.tsx`, per-vendor presets and history), Review drawer send-to-agent (`Review.tsx:487-530`, `reviewprompt.ts`), pane groups and snapshots (`PaneOps.tsx`), pane rename (`store.ts:270-274`), snippets with `{{placeholders}}` (`prompthistory.ts:47-66`), `defaultCycle()` (`vendors.ts:156-161`), worktree isolation per pane.

### MVP (after Phase B)

| # | Feature | What changes | Effort |
|---|---|---|---|
| X1 | Three-vendor default workspace: with codex installed, `defaultCycle()` already yields claude, agy, codex; a 3-slot New Workspace is one pane per vendor, each in its own worktree. | nothing | 0 |
| X2 | Broadcast one prompt to all three: exists. Add an "agents only" preset next to the "only X" buttons so shells are excluded in one click. | `Broadcast.tsx:234-243` | S |
| X3 | Cross-review: the Review drawer's "explain this diff" already embeds the patch in the prompt (`buildExplainPrompt`). Add a target picker (any live agent pane in the workspace, default = a pane of a different vendor) so the author's diff goes to the reviewer pane, plus a `buildCrossReviewPrompt(file, patch, authorVendor)` in `reviewprompt.ts` ("another agent wrote this, list defects only, no praise"). Uses `sendToPane` from `store.ts:121` (the PaneOps pattern) rather than raw `pty_write`. | `Review.tsx:487-530`, `reviewprompt.ts`, `reviewprompt.test.ts` | M |
| X4 | Role labels: a "Set role" submenu in the pane menu writing the existing title (Builder, Reviewer, Explorer, Tester); the header already renders title + glyph, Broadcast and the attention queue already print `title || vendorShort`. | `PaneView.tsx` menu near `:1170` | S |
| X5 | Trio snippet pack: three shipped snippets (Implement, Review the other agent's patch, Compare approaches) with `{{task}}` placeholders, seeded once into `flightdeck-broadcast-snippets` if empty. | `prompthistory.ts:15-25` | S |

### Later

- Auto cross-review: when the author pane's Stop hook (Claude) or `notify` (Codex) fires, offer a one-click "send diff to reviewer" toast. Needs Phase E.
- Headless reviewer: `codex exec --json -s read-only "review this patch"` piped into the Review drawer as structured findings (item types agent_message, file_change). New backend command, L.
- Fleet usage strip: per-vendor 5h/weekly bars (Codex from rollouts; Claude has no equivalent file) in the left panel. M, after D2.
- Consensus view: same prompt to three panes, side-by-side last-message compare. Needs per-pane last-message capture beyond `lastLine`. L, not now.

## 5. Risks and open decisions for Balu

1. **Plan tier.** Plus gives 15-150 messages per 5 hours on GPT-6 Sol; three parallel Codex panes on one plan share that window. Business = Plus. Pro 5x is the next step. Recommendation: Plus first, read the real `used_percent` from D2 for two weeks, then decide.
2. **Free-tier test path.** The pricing page says Free includes Codex; the README and TUI text do not. Try a free ChatGPT sign-in before purchase; if it works, Phases B to D can be verified two weeks early.
3. **Sandbox on Windows.** `elevated` needs admin setup and has known 1385 failures; `unelevated` is ACL-based and weaker. Flightdeck should not pick for him. Decision: which `[windows] sandbox` value goes in his `~/.codex/config.toml`, and whether worktrees under the app-data folder trigger the "writable by Everyone" warning.
4. **Trust mechanism.** `-c` override (no file writes, no crate) vs editing config.toml (needs `toml_edit`, needs prune). B1 decides. Either way the once-per-repo confirm in `trust.ts` stays.
5. **Auth probe cost.** `codex login status` spawns a process on every `detect()` (Settings open, New Workspace, manifest hot reload). Cache the result for the detect call and only run it when auth.json is absent. If keyring is never used, drop the fallback.
6. **Usage metering gaps.** Rollout format is internal and Codex ships weekly (0.158 on 28 Sep); a schema change silently drops the chip (by design, never a wrong number). Files older than 7 days become `.zst`, so the launcher only lists recent sessions unless a zstd crate is added. No fork. Weekly limit sizes are unpublished.
7. **Root process ambiguity.** Claude and Codex both root at pwsh.exe; the orphan scanner is unaffected, but `procname` sampling will show node/codex churn; QL-743 already smooths that.
8. **CLAUDE.md is invisible to Codex.** Each repo needs an AGENTS.md, or Balu adds `project_doc_fallback_filenames = ["CLAUDE.md"]` to `~/.codex/config.toml` (32 KiB cap across files). Personal setup, not Flightdeck code.
9. **Settings flags and binary path are inert** (BACKLOG 230). A Codex user will expect "extra CLI flags" to work for `-m` or `-s`. Not in scope; note it so it is not mistaken for a Codex bug.
10. **Version pinning.** Do not depend on `--full-auto` (deprecated) or `-a untrusted` (removed from the CLI). The plan only uses `codex`, `codex resume <id>`, `codex login status`, `-c`.
11. **CODEX_HOME.** Flightdeck must never set it; if the ambient shell sets it to a missing folder Codex errors at start. Detection reads it if set.

## 6. Build order and effort

1. Phase A (NOW, M): A1 to A9 in one commit "Codex adapter: detection, auth probe, launch, theme token". Install the CLI, run the Definition of done A checklist, all four gates.
2. Phase C code (NOW, M): C1 and C2 with fixture rollouts (write two fixture files by hand from the src@v0.158.0 shapes). Gate: cargo test, vitest, tsc.
3. Phase D code (NOW, M): D1 to D4 with the same fixtures.
4. Purchase (or free sign-in). Phase B (LOGIN, S to M): B1 to B5, then re-verify C and D live and adjust the fixtures to match real rollout lines.
5. MVP workflow X2 to X5 (M total), then a v0.5.x cut through `tools/release.ps1` (tsc, vitest, pane-smoke, cargo check, cargo test --lib, tauri build, boot gate).
6. Later items and Phase E go to BACKLOG.md under section A (items 64 and 226 get updated to point here).

Estimated total to a shippable third vendor: about three working sessions before purchase plus one after.
