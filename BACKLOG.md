# Flightdeck backlog

Parked and planned work, not yet scheduled unless marked.
Read before generating new ideas so lists don't get regenerated.
IDs are stable so bugs/notes can reference them.
Scope decision (Balu 2026-07-19): **single-user tool for now.** Licensing, docs suite, team/collab, sync/accounts, and support/feedback are PARKED (see "Parked" at the bottom) — add later if productised for others. Market polish is kept (this ships as a public showcase — a Cursor alternative).

---

## PHASED PLAN (top = highest priority)

Item IDs reference the detailed catalogue in sections A–H below.

### Tier 0 (market table-stakes) — SHIPPED 2026-07-19 (session 6, commit fcf717f)
Per-agent **git worktree isolation** + **Review drawer** (diff/merge surface).
See STATE.md session 6 + section J below for the market landscape. v1 scope:
local merge-back (auto-commit → --no-ff, conflict aborts cleanly). Follow-ups:
- **PR handoff flow** (v2 merge path — what most rivals ship; sidesteps conflict UI).
- **Merge-conflict resolution surface** (v1 aborts with a message).
- **Per-workspace worktree setup command** (fresh worktrees have no
  node_modules — agents can't build/test until `npm ci`; Conductor/Superset
  solve this with setup scripts).
- **Per-pane Explorer rooting / worktree switcher** (Explorer still shows the
  main checkout, not the focused pane's worktree).
- **WSL isolation** (excluded in v1: worktree `.git` file embeds a Windows
  gitdir path WSL git can't resolve).
- **Attention Queue** (ranked "needs you now" vs the bell feed), richer status
  vocabulary (blocked-on-permission / stalled), per-pane token/cost — the
  visual gaps vs Paneflow/Warp.

### Phase 1 — Feel & polish (do first; what you notice immediately)
The session-3 requests + the supporting polish that makes them land.
- Settings screen so the ⚙ actually works [U8 / R8 / K1] — host for themes, type-scale, shortcuts.
- Larger type pass across the app [U3 / 113 / 86].
- Bump icon sizes app-wide, incl. the Kanban header button [U4 / U6 / 87 / K8].
- Left / workspace panel redesign — richer tiles + status roll-up [U5 / 114 / 31 / 32 / 33].
- Dark-mode polish pass, up to light-mode quality [U7 / 115 / 94].
- Larger Kanban cards [U1 / 1].
- Premium drag-drop: lift + tilt, column highlight, siblings FLIP to make room, settle on drop, edge auto-scroll [U2 / 2 / 3 / 5].
- Close-workspace / close-pane confirm when a session is live [U9 / 39 / 118].
- Motion system + toasts + confirm dialogs + empty/loading/error states everywhere [U10 / 116 / 119 / 120 / 117 / 25].

### Phase 2 — Reliability backbone (trustworthy for daily use)
- Vendor adapter trait + registry [R1 / 61] — foundational.
- Windows Job Object hardening (reap children even on hard crash) [R2 / 96 / K2].
- First-run CLI detection + inline "Run login" [R3 / 62].
- SQLite persistence + restore on reopen [R4 / 78 / 79].
- Crashed-pane relaunch + hidden-pane render throttle [R5 / 50 / 125].
- Capability manifest + CSP hardening [R6 / 97 / K3]; resize-gap fix [K5].
- Safe mode, autosave/restore points, one-file backup, health dashboard, recover-orphans tool [199 / 200 / 201 / 202 / 203 / 204].

### Phase 3 — Product depth (makes it a real tool)
- Kanban: card→pane dispatch [R7 / 11], live agent progress on card [12], detail view [7], labels [8], filter [16], sort [17], checklist [20], WIP limits [13], reorder-within [4], custom columns [14], collapse [6], multiple boards [15], persist [28], undo/redo [29].
- Panes: maximise/solo [46], drag-rearrange [47], rename [48], overflow menu [49], search scrollback [52], clickable paths [53], split [54], live process name [58], zoom [51], quiet-threshold [55].
- Workspaces: reorder [34], groups [35], rename [37], context menu [38], search [41], Ctrl+1..9 [42], drop-folder-to-create [43], templates [45], last-active [44].
- Agents: broadcast bar [67], presets [68], cross-pane handoff [69], run history [70], auto-name [71], Kimi [R10/63], Codex [64], Local LLM [65/66 + section E].
- Notifications: OS toast + taskbar flash [73], configurable bell [72], error rings bell [77], feed [75], mute/DND [76].
- Navigation: command palette [103], fuzzy jump [104], cheat-sheet [105].
- Explorer/git: file-tree [R9/107], real git status in header [108], diff viewer [109], open-in-editor [110], new-terminal-here [111].
- Settings depth: multiple themes [85], terminal settings [88], shortcut editor [89], agents settings [90], accent picker [92].

### Phase 4 — Cross-platform & shippable build (a downloadable product)
- ~~macOS [165], Linux [166], ARM64 [167]~~ — **PARKED (Balu 2026-07-20): Windows-first, revisit only if going to market demands it.** High-DPI/multi-monitor [168/169] and shell selection per pane [170] stay (Windows-relevant).
- Signed installer [127], auto-update [128], winget/choco [129], MSIX/Store [130], portable [131], delta [133], rollback [134].
- Signed/notarized binaries [158], secret redaction [159], app lock [160], audit log [161], capability review [162], encrypted-at-rest [164].
- Local-only trust badge [157], OSS attributions [155], local crash log + log-export [152-local / 204].
- CLI companion [175], URL scheme [176], editor integration [177], GitHub repo picker [171], Slack/Discord notify [173], webhooks [174].
- a11y: screen-reader labels [207], keyboard-only [208], colour-blind statuses [209], whole-UI zoom [210].
- Extensibility basics: theme import/export [191], vendor-adapter SDK [190], plugin API [189].

### Phase 5 — Market polish & showcase (sell it / show it)
- Press kit: icon set, store screenshots, hero shots [211].
- Motion + optional sound-design language [212].
- Light onboarding checklist ("get to your first fleet") [213].
- Product + case-study/pricing page on kove.nz, positioned as a Cursor alternative [214].
- Interactive web demo / sandbox for the landing page [215].

### Parked — not now (single-user; revisit if productised for others)
- **Cross-platform: macOS [165], Linux [166], ARM64 [167]** (Balu 2026-07-20: Windows-first for now).
- Licensing & monetization [144-150].
- Full onboarding/docs suite [135-143] — keep only the light checklist [213].
- Team & collaboration [179-184].
- Sync & account [185-188].
- Support & feedback [194-198].
- Cloud telemetry/analytics [151] and cloud crash reporting; keep local-only equivalents.
- i18n / localization / RTL [205 / 206].
- Enterprise SSO/SAML [163], MDM/policy.
- Full extension/theme marketplace [192 / 193] beyond import/export.

---

## A. Committed roadmap (prioritised, from STATE.md + the Fable architecture pass)

Order is dependency-driven; the vendor adapter is the load-bearing refactor everything else sits on.

- **R1. Vendor adapter trait + registry** — generalise `build_command` in `lib.rs` into a per-vendor contract (launch cmd, detection, status patterns). Foundational; do before more vendors get hand-rolled.
- **R2. Windows Job Object hardening** — put every spawned child in a Job Object with kill-on-close so even a hard crash of Flightdeck.exe reaps children (clean-exit reaping already shipped).
- **R3. First-run CLI detection** — binary probe (installed + logged in) per vendor; inline "Run login" on an amber slot; folder-open wiring.
- **R4. SQLite persistence** — workspaces/panes/layout/presets/scrollback/events survive a full restart; restore on reopen (needs the exit/error state fix, now done).
- **R5. Crashed-pane relaunch + hidden-pane render throttle.**
- **R6. Capability manifest hardening + CSP tightening** (currently `csp:null`).
- **R7. Kanban -> pane dispatch** — dropping a card into In Progress spawns/assigns an agent pane and streams progress back to the card (`Board.tsx` TODO marker).
- **R8. Settings screen** — make the ⚙ button work (see U8). Appearance/Terminal/Agents/Shortcuts, no billing.
- **R9. Explorer file-tree** — re-add as a collapsible panel; Rust `fs_list_dir` is ready and unused.
- **R10. Phase 1.5 — kimi-code adapter** — behind R1's trait, activate on subscribe.

---

## B. Open known issues / watch-items (not yet fixed)

- **K0a. agy trust in worktrees untested (D9)** — `ensure_agy_trust` appends every pane cwd to `trustedWorkspaces` permanently; per-session worktree paths will accumulate. Test whether agy honors parent-dir trust of the fixed worktrees root; else GC trust entries on worktree removal.
- **K0b. MAX_PATH** — worktrees live under `%LOCALAPPDATA%/Flightdeck/worktrees/<hash>/<slug>`; a deep node_modules inside one can trip Windows path limits without `longPathsEnabled`.
- **K0c. Fresh worktrees have no build artifacts** — no node_modules/target until the setup-command follow-up ships (Tier 0 list above).
- ~~K1. Settings ⚙ does nothing~~ — **FIXED session 4** (Settings screen + Ctrl+,).
- **K2. No Job Object** — clean window-close now reaps child process trees, but a hard crash of Flightdeck.exe itself could still orphan children. -> R2.
- **K3. `csp:null`** — acceptable for local-only today, tighten with R6.
- **K4. StrictMode dev double-spawn** — dev-only; each pane briefly launches two real CLI processes under `npm run tauri dev`. Benign in production build. Watch item.
- **K5. Resize dropped in a narrow startup gap** — a container resize landing between mount and spawn isn't forwarded to the PTY; self-corrects on next resize. Low.
- ~~K6. Close-workspace has no active-session warning~~ — **FIXED session 4** (ConfirmDialog; session 6 added worktree cleanup to the same flow).
- **K7. Dark mode lags light mode visually** -> U7.
- **K8. Icons / the Kanban icon button are too small** -> U4/U6.

---

## C. Session-3 change requests (Balu, 2026-07-19)

- **U1. Kanban cards larger** — bigger padding, type, min-height; more presence.
- **U2. Kanban drag-drop more animated** — manual drag (you drag the card). Wanted: card lift + tilt on pickup, target-column highlight, sibling cards shift to make room (FLIP), smooth settle on drop, auto-scroll near edges.
- **U3. Larger type across the app** — deliberate large-type / quality moments (headers, section titles, empty states), not the current uniformly-small chrome.
- **U4. Increase icon sizes overall.**
- **U5. Left / workspace panel redesign** — make it look better (richer tiles, hierarchy, status roll-up).
- **U6. Kanban icon button too small** — enlarge the board glyph + header controls.
- **U7. Dark-mode polish pass** — bring dark up to light-mode quality (depth, contrast, surface separation, glow restraint).
- **U8. Settings screen must work** — wire the ⚙ to a real Settings surface. -> R8.
- **U9. Close-workspace confirmation** — warn before closing a workspace with active/running sessions so a session isn't lost by accident; same for closing a live pane. Quality-of-life.
- **U10. General QoL sweep** — confirm dialogs, toasts, micro-interactions, consistency (see section D / Q).

---

## D. Feature ideas (100+)

### Kanban / Board (D)
1. Larger cards (padding, type, min-height). [U1]
2. Premium manual-drag animation: lift + tilt + cursor-follow. [U2]
3. Drop-zone: target column highlights, cards FLIP to make room. [U2]
4. Reorder cards within a column, not just across.
5. Auto-scroll a column while dragging near its edges. [U2]
6. Collapse / expand columns.
7. Card detail view (description, checklist, links, notes).
8. Card labels / tags with colours.
9. Card assignee = agent avatar.
10. Due dates + age indicator on cards.
11. Card -> pane dispatch (drop into In Progress spawns an agent). [R7]
12. Live agent progress on the card (state dot + last line).
13. WIP limits per column.
14. Customise columns (rename, add, remove, reorder).
15. Multiple boards (per workspace / project).
16. Board filter (priority, agent, tag, text).
17. Board sort (priority, age, manual).
18. Swimlanes (group by agent or priority).
19. Card templates.
20. Card checklist / subtasks with a progress bar.
21. Card comments / activity log.
22. Archive cards + an archive view.
23. Bulk / multi-select card actions.
24. Keyboard card moves (select + arrows).
25. Success micro-animation when a card reaches Complete.
26. Empty-column call-to-action.
27. Board density toggle (compact / comfortable).
28. Persist board to disk. [R4]
29. Undo / redo for board actions.
30. Card -> markdown export.

### Workspace / left panel (W)
31. Larger rows + icons. [U4/U5]
32. Redesigned workspace tiles (project colour, richer monogram/avatar). [U5]
33. Per-workspace status roll-up (N running / waiting / error).
34. Drag to reorder workspaces.
35. Workspace groups / folders.
36. Pin / favourite workspaces.
37. Inline rename.
38. Workspace context menu (close, rename, reveal, duplicate).
39. Close-workspace confirm when sessions are active. [U9]
40. Collapse-to-rail polish + tooltips.
41. Workspace search / filter.
42. Keyboard workspace switch (Ctrl+1..9).
43. Drag a folder onto the panel to create a workspace.
44. Per-workspace last-active timestamp.
45. Workspace templates (preset layout + agents).

### Panes / terminal (P)
46. Maximise / solo a pane (focus mode).
47. Drag to rearrange grid positions.
48. Pane rename / custom label.
49. Pane overflow menu (restart, close, maximise, copy cwd, reveal).
50. Restart a crashed / idle pane in place. [R5]
51. Per-pane font size / zoom.
52. Search within terminal scrollback.
53. Clickable file paths + URLs in the terminal.
54. Split a pane (new pane rooted at a subfolder).
55. Configurable quiet-threshold for the waiting heuristic.
56. Pane activity sparkline (output rate).
57. Save / copy full scrollback to file.
58. Live process name in the pane header (VS Code style).
59. Ligatures toggle for the mono font.
60. Copy-on-select / paste polish.

### Agent orchestration (A)
61. Vendor adapter trait + registry. [R1]
62. First-run CLI detection + inline "Run login". [R3]
63. Kimi adapter. [R10]
64. Codex adapter (ChatGPT Plus/Pro).
65. Local LLM pane (LM Studio / Qwen). [see section E]
66. Claude-drives-Qwen MCP offload. [see section E]
67. Broadcast bar (message all panes) with target chips.
68. Agent presets (model, flags) per vendor.
69. Cross-pane handoff (pipe one pane's output to another).
70. Agent run history per workspace.
71. Auto-name a pane by its task / branch.

### Notifications / status (N)
72. Configurable bell (which states notify).
73. OS toast + taskbar flash when unfocused and a pane needs you.
74. Optional sound cue on waiting / error.
75. Notification history / feed.
76. Per-workspace mute / do-not-disturb.
77. Error state rings the bell (now that `error` exists).

### Persistence / sessions (S)
78. SQLite persistence of everything. [R4]
79. Scrollback persistence + restore.
80. "Reopen last session" prompt on launch.
81. Named session snapshots.
82. Export / import a workspace config.
83. Crash recovery (relaunch panes that died while away).

### Settings / customization (T)
84. Settings screen — make ⚙ work. [R8/U8]
85. Multiple themes (Deep Cove, Dracula, Gruvbox, Light, ...).
86. Type-scale / density control (larger type everywhere). [U3]
87. Icon-size control. [U4]
88. Terminal settings (font, size, cursor, scrollback limit).
89. Keyboard shortcut editor.
90. Agents settings (default vendor, flags, binary paths).
91. Startup behaviour (reopen last vs launcher).
92. Accent-colour picker.
93. Reduced-motion honour toggle.
94. Dark-mode refinement pass. [U7]

### Window / OS / shell (O)
95. Custom frameless title bar with native caption buttons.
96. Windows Job Object for hard-crash child cleanup. [R2]
97. Tighten CSP + capability manifest. [R6]
98. Global hotkey to summon Flightdeck.
99. System-tray icon + quick actions.
100. Remember window size / position.
101. Multi-window support.
102. Auto-update.

### Command palette / navigation (C)
103. Command palette (Ctrl+P): actions, panes, workspaces.
104. Fuzzy jump to any pane / workspace.
105. Keyboard cheat-sheet overlay.
106. Recent commands.

### Explorer / files / git (E)
107. Explorer file-tree panel (re-add). [R9]
108. Real git branch / status per pane header (not hardcoded "main").
109. Diff viewer for a pane's repo.
110. Open file in editor from the tree.
111. "New terminal here" from a folder.
112. Git-ignored dimming.

### Polish / QoL / accessibility (Q)
113. App-wide larger type + icon pass. [U3/U4]
114. Left-panel redesign. [U5]
115. Dark-mode visual refinement. [U7]
116. Motion system: consistent hover / press / enter-exit micro-interactions. [U10]
117. Loading skeletons.
118. Confirm dialogs for destructive actions (close workspace / pane with a live session). [U9]
119. Toasts for background events. [U10]
120. Empty / error / loading states on every surface.
121. Full keyboard nav + visible focus order.
122. High-contrast / accessibility audit.
123. First-run onboarding tour.
124. About / version / changelog panel.
125. Hidden-pane render throttle (perf). [R5]
126. Virtualise long boards / lists (perf).

---

## E. Local LLM integration (LM Studio / Qwen) — designed 2026-07-19, not built

Balu runs **LM Studio** locally (OpenAI-compatible server on `http://127.0.0.1:1234/v1`) and wants a local model (e.g. Qwen2.5-coder) usable inside Flightdeck.
This does NOT break the "no paid-API-billing" rule: a local model is free (own machine), not metered cloud billing.
Reuse the Harness plumbing: `Harness/bin/local-run.ps1`, the `local-model` skill, POLICY rule 9 (loopback-only bind).

**DECISION (Balu 2026-07-20): mode A must be a real CLI experience.**
**OpenCode is the frontrunner** pane CLI against LM Studio's OpenAI-compatible
endpoint; evaluate alternatives (Crush, aider --local, mods) before building
anything; a custom-built thin REPL is the last resort only. **Priority:
LOWER — schedule after Tier 1 (persistence) + the #218 manifest,** then the
local adapter becomes a manifest entry rather than code.

Two modes (build B first, most leverage):

**A. Local model as its own pane.**
A `local` vendor adapter launching a small OpenAI-compatible chat CLI pointed at LM Studio (`OPENAI_BASE_URL=http://127.0.0.1:1234/v1`, dummy key).
Candidates: `llm`, `mods`, `aider` local, OpenCode/Crush at the local endpoint, or a tiny built-in REPL.
Lifecycle: ensure server up + model loaded (reuse `local-run.ps1`), unload on pane close.

**B. Claude as the shell, Qwen inside it ("Claude drives Qwen").**
A small stdio MCP server exposing `local_complete(prompt, system?)` -> LM Studio `/v1/chat/completions`.
Register it in the Claude pane's MCP config so Claude offloads bounded cheap subtasks (summaries, triage, commit messages, boilerplate) to Qwen while it keeps the reasoning.
Guardrails: loopback bind only, opt-in per session, model unloaded when done.
Recommended model: Qwen2.5-coder. Engine stays model-agnostic (endpoint + model id are config).

---

## F. Dropped from v1 (per Balu 2026-07-19)

- **BridgeSwarm** (multi-agent role orchestration): not needed. *(Session-6 note:
  "BridgeSwarm" is literally a shipping BridgeMind product — roles
  builder/reviewer/scout/coordinator, file ownership, quality gates, shared
  mailbox, inside their BridgeSpace ADE. Keeping this dropped is now a
  positioning decision against our closest competitor, not just scope trimming —
  re-decide deliberately if Flightdeck goes to market. See section J.)*
- **Billing / accounts / multi-user**: personal tool; only if ever productised.

---

## G. Add more models later (standing note)

New agents slot in behind the `VendorAdapter` trait (R1) + the launcher's vendor list; no core changes.
Queued: **Kimi** (`kimi-code`, OAuth only), **Codex** (`codex`, ChatGPT sub), **Local** (LM Studio, section E).
Keep the vendor registry data-driven: adding one = implement the adapter + add a launcher row.

---

## H. Market / product-readiness features (127+)

What a buyer expects out of the box when Flightdeck is sold, not just used personally.
Framed for a productised release (some assume the "if productised" path that F parks for the personal tool).

### Distribution & install
127. Signed installer (Authenticode) + SmartScreen reputation build-up.
128. Auto-update with stable / beta channels, in-app "update available" + release notes.
129. winget + Chocolatey packages.
130. MSIX / Microsoft Store listing.
131. Portable (no-install) build.
132. Enterprise install (MSI, per-machine, silent flags).
133. Delta / differential updates.
134. Update rollback + version pinning.

### Onboarding & docs
135. Interactive first-run guided tour.
136. Sample / demo workspace to explore without real agents.
137. In-app searchable help centre.
138. Contextual tooltips + "?" affordances.
139. In-app "What's new" changelog on update.
140. Shortcut cheat-sheet + printable key map.
141. Educational empty states (teach features in place).
142. Docs website + getting-started guide.
143. Short video / GIF walkthroughs.

### Licensing & monetization (subscription-safe framing)
144. License-key activation + offline activation fallback.
145. Free trial with clear expiry + upgrade prompt.
146. Tier gating (Free / Pro / Team) via feature flags.
147. Manage-subscription portal link (no card capture in-app).
148. Seat management for the Team tier.
149. Grace period + read-only mode on lapse (never destroy data).
150. Local usage dashboard (panes / hours), subscription-safe.

### Telemetry, privacy, trust
151. Opt-in anonymous analytics, off by default, clear toggle.
152. Consented crash reporting with symbolication.
153. In-app privacy policy + data-handling statement.
154. "Export my data" / "Delete my data" controls.
155. Third-party / OSS license attributions screen.
156. EULA / Terms acceptance on first run.
157. "Local-only" trust badge (nothing leaves the machine).

### Security
158. Code-signed + notarized binaries (Win + mac).
159. Secret redaction in all logs / exports.
160. Optional app lock (PIN / OS biometric).
161. Audit log of sensitive actions (spawns, key strips).
162. Published least-privilege capability review.
163. SSO / SAML for Team (enterprise).
164. Configurable data dir + optional encryption at rest.

### Cross-platform & environment
165. macOS build (swap ConPTY for a Unix PTY layer).
166. Linux build.
167. Native ARM64 (Windows-on-ARM / Apple Silicon).
168. High-DPI + multi-monitor correctness.
169. Per-display scaling + remembered layout per monitor.
170. Shell selection per pane (pwsh / cmd / git-bash / WSL).

### Integrations
171. GitHub / GitLab auth + repo picker in the launcher.
172. Kanban sync with an issue tracker (GitHub Issues / Jira / Linear).
173. Slack / Discord / Teams notifications on pane events.
174. Outbound webhooks on pane / board events.
175. CLI companion (`flightdeck open <folder> --pane claude`).
176. Custom URL scheme (`flightdeck://…`) deep links.
177. Editor integration (open in VS Code / JetBrains, jump to file:line).
178. Focus-time / calendar integration (auto-DND in meetings).

### Team & collaboration
179. Shared workspace-preset / board-template library.
180. Presence on shared boards.
181. Card comments / @mentions with notifications.
182. Role-based access (viewer / editor / admin).
183. Team activity feed.
184. Hand off a live pane / session stream to a teammate (read-only).

### Sync & account
185. Cloud sync of settings / themes / shortcuts across machines.
186. Account profile + avatar.
187. Device management (view / revoke active devices).
188. Import settings from another machine (file / QR).

### Extensibility / marketplace
189. Plugin / extension API (custom panels + commands).
190. Vendor-adapter SDK + community adapters.
191. Theme marketplace + import / export theme files.
192. User-scripted command-palette actions.
193. Shared prompt / snippet library across panes.

### Support & feedback
194. In-app bug report with (consented) attached logs.
195. Support contact + status-page link.
196. Community links (Discord / forum).
197. Feature-request voting board.
198. Self-diagnostics ("Run checks") with guided fixes.

### Reliability / ops / data safety
199. Safe mode (launch without restoring sessions).
200. Autosave + session restore points / versioning.
201. One-file backup & restore of all app data.
202. Health dashboard (CPU / mem per pane, orphan detector).
203. "Recover orphaned processes" tool (find + kill strays).
204. Redacted log-export bundle for support.

### Accessibility / i18n
205. Localization / multi-language.
206. RTL layout support.
207. Screen-reader labels app-wide.
208. Certified keyboard-only operability.
209. Colour-blind-safe status-palette option.
210. Whole-UI zoom (not just the terminal).

### Market polish
211. Marketing press kit (icon set, store screenshots, hero shots).
212. Consistent motion + optional sound-design language.
213. Onboarding checklist ("get to your first fleet").
214. Product + pricing page (ties into kove.nz).
215. Interactive web demo / sandbox for the landing page.

---

## I. Gap review — post wave-2 (2026-07-19)

Written after 8 parallel agents landed Phase 1 + much of Phase 2/3.
Organising theme per Balu: **adding a new LLM/agent must be trivial**, and the app should be gold-plated.

### I1. Extensibility — make adding an agent a CONFIG drop, not a code hunt
STATUS CORRECTION (2026-07-19, session 6 audit): **216, 217 and 227 are DONE** —
the frontend reads the runtime registry via `src/vendors.ts` (`useVendors` /
`detect_vendors`), `board/types.ts` has `Vendor = string`, and vendors.rs has
conformance tests. The old "five hardcoded lists" claim was stale. What remains
of I1 is 218-226 + 228, and **218 is now the headline market differentiator**
(rivals hardcode ~3 vendors; "add any LLM via config, no recompile" is our edge).
Residual cosmetics: hardcoded default ids (`Board.tsx` dispatch fallback
`"claude"`, `Settings.tsx` `defaultVendor`, `vendors.ts` `defaultCycle`
`["pwsh"]`, `Explorer.tsx` `vendor = "pwsh"`) and the per-vendor CSS token
`--agent-claude` (6 themes) with no generic accent scheme for new vendors.
216. ~~Single source of truth for vendors~~ — **DONE** (`src/vendors.ts`, all UI lists map the registry).
217. ~~Kill the `Vendor` union type~~ — **DONE** (`board/types.ts:11` is `string`).
218. **User-definable agents via a manifest file** — a TOML/JSON vendor manifest (id, label, exe, arg template, cwd handling, env allow/deny, probe command, icon, colour) loaded at runtime so adding an agent needs NO recompile. This is the real "easy to add any LLM" unlock.
219. **Per-vendor auth state** — extend probe beyond "installed" to `not-installed | installed-not-logged-in | ready`, with a per-vendor `login` command surfaced as an inline "Run login" action.
220. **Per-vendor status patterns** — replace the one-size activity heuristic with per-adapter output patterns (waiting/auth-required/error), falling back to the heuristic.
221. **Per-vendor capability metadata** — supports MCP? model selection? headless? resume? Drives which UI affordances show for that pane.
222. **Per-vendor branding** — icon + accent per agent, registry-driven, so panes/cards/chips identify the agent visually.
223. **Vendor-specific settings schema** — each adapter declares its own settings (model, flags), rendered generically in Settings > Agents.
224. **Local LLM adapter (LM Studio)** — vendor + lifecycle (ensure server up, load model, unload on close). See section E.
225. **MCP offload server** — `local_complete` stdio MCP so Claude can hand cheap subtasks to a local model. See section E.
226. **Kimi + Codex adapters** — once 218/219 land these should be manifest entries, not code.
227. ~~Adapter conformance tests~~ — **DONE** (vendors.rs test module: registry coverage, unique ids, env-strip, cwd targeting, presentation fields).
228. **`CROSS_VENDOR_KEYS` per-adapter** — each adapter declares the env it must strip, instead of one hand-maintained global list that already has a TODO on it.

### I2. Architecture debt
229. **Board is in-memory only** — `board/boardStore.ts` loses every task on restart. Wire it to the new persistence layer (it already exposes `getBoardState`/`setBoardState`).
230. **Settings that persist but nothing reads** — terminal settings, agent settings, startup behaviour, and shortcut rebinds all save to localStorage and are inert. Wire each consumer (`Terminal.tsx`, `NewWorkspace.tsx`, `Cockpit.tsx` keydown).
231. **Persistence is JSON, not SQLite** — upgrade for scrollback + querying + restore points at scale.
232. **Scrollback not persisted** — reopening loses all agent output.
233. **Pane grid layout not persisted** — resizable panel sizes reset every launch.
234. **`activeView` + panel expanded state not persisted.**
235. **No React error boundary** — one component throw blanks the whole cockpit.
236. **Silent `.catch(() => {})` everywhere** — IPC failures vanish with no user feedback and no log. Introduce a single error channel (toast + log).
237. **No structured logging** — nothing to attach to a bug report.
238. **Single window only** — no second window / detached pane.
239. **`view`/theme/scale state split across localStorage keys** — consolidate into one prefs document owned by the persistence layer.

### I3. Testing & CI (biggest quality gap — 9 tests total today)
240. **Rust has zero tests** — no `#[test]` anywhere. Cover: vendor registry/probe, env stripping, job object, orphan detection, persist round-trip + atomic write, crash-vs-clean exit classification.
241. **Board store tests** (move, reorder, dispatch link, filter/sort).
242. **UI store tests** (confirm, toasts, notify rules, mute/DND).
243. **Themes tests** — every theme defines every token (a missing token silently breaks a surface).
244. **Persistence round-trip tests** incl. corrupt-file and safe-mode paths.
245. **Component render smoke tests** for every screen in both themes.
246. **E2E test** — launch app, create workspace, spawn a pane, assert output (the real user path).
247. **CI pipeline** — build + test + clippy + tsc on every change.
248. **Lint/format gates** — eslint + rustfmt + clippy, enforced.
249. **Contrast/a11y automated check** across all 6 themes.

### I4. Product gaps carried from wave 2 (explicitly skipped by agents)
250. Terminal scrollback search (needs `@xterm/addon-search`).
251. Clickable paths/URLs (needs `@xterm/addon-web-links`).
252. Ligatures toggle (needs `@xterm/addon-ligatures`).
253. Activity sparkline per pane. 254. Save scrollback to file. 255. Configurable quiet-threshold.
256. Live process name in pane header (needs backend).
257. Hidden-pane render throttle (backend/reader-thread level).
258. Kanban: custom columns, 259. collapse/expand columns, 260. multiple boards, 261. archive + view, 262. multi-select bulk actions, 263. undo/redo, 264. edge auto-scroll while dragging.
265. Workspace groups/folders + 266. workspace templates (both need a `Workspace` model change).
267. Diff viewer (needs a diff-capable Rust command).
268. Real `.gitignore` parsing (current dimming is a name-match heuristic).
269. Keyboard cheat-sheet overlay.
270. Taskbar flash — needs `core:window:allow-request-user-attention` in the capability manifest.

### I5. Error handling & observability
271. Surface spawn/IPC failures as actionable toasts, not silent no-ops.
272. Per-pane error detail panel (exit code, last output, one-click restart).
273. Health dashboard UI on top of the new `pane_health` command.
274. Orphan-process warning on launch ("3 stray agents found — reap?").
275. Crash log written to disk + attachable to a report.

### I6. Performance
276. Virtualise the notification feed, board columns, and file tree.
277. Cap/rotate xterm scrollback to bound memory across 6 live panes.
278. Throttle `pty://output` event rate under heavy agent output (currently every read emits).
279. Measure + budget: cold start, 6-pane steady-state CPU/memory.

### I7. UX / a11y
280. Full keyboard operability audit + visible focus order everywhere.
281. Screen-reader labels on all icon-only buttons.
282. Onboarding: first-run tour + a demo workspace.
283. Consistent empty/loading/error treatment audited across every surface.
284. Motion audit — one easing/duration system, honoured by the reduced-motion toggle.

---

## J. Market landscape snapshot (researched 2026-07-19, session 6)

Category: desktop cockpits for running parallel AI coding agents. Ranked by
closeness to Flightdeck:

1. **BridgeMind / BridgeSpace** (bridgemind.ai) — closest full-concept rival,
   ahead of us: up to 16 agents in terminal grids, BridgeBoard (agent-dispatching
   Kanban = our R7), BridgeSwarm (role orchestration), BridgeMemory (shared agent
   memory), built-in editor + browser, BridgeMCP, BridgeVoice. Cross-platform.
   Community moat ~86k YouTube / ~13k Discord.
2. **Paneflow** (paneflow.dev, OSS Rust/GPUI) — closest on cockpit+review:
   side-by-side per-worktree diff columns + hunk nav, Attention Queue, tab-dot
   status, read-only MCP bridge (list/read/search_pane, untrusted-wrapped),
   markdown panes, per-pane token/cost, CLI/JSON-RPC control plane.
3. **Superset** (superset.sh) — 10+ agents per-worktree, diff/file editor, chat,
   in-app browser + port management. Free 3 agents / $30·mo Pro.
4. **Conductor** (Mac) — the polish bar: status + diffs + PRs + browser preview;
   per-repo worktree setup scripts.
5. **Warp 2.0** — vertical-tab pane per agent w/ status badge
   (thinking / blocked-on-permission / done), review pane, mobile remote.
6. First-party threats: Claude Code **Agent Teams + Dynamic Workflows**,
   **Cursor parallel agents** (worktree-based), OpenAI **Codex** app/cloud
   agents, **Google Antigravity's own Agent Manager** (first-party manager for
   our own `agy` vendor's users), GitHub **Copilot coding agent** / VS Code
   agent sessions.
7. Also: Vibe Kanban (OSS, community-run), Claude Squad (tmux TUI), Crystal
   (OSS, deprecated → Nimbalyst), Clave, Parallel Code.

**Table-stakes across the category:** per-agent worktree isolation (SHIPPED),
diff review + merge/PR (SHIPPED v1), live agent status (have), multi-vendor
(have). **Our realistic wedge:** local-first/no-account privacy, the I1 #218
config-drop agent manifest (unbuilt), focused single-user polish. Rival feature
categories to watch: setup scripts, PR-based merge, session resume/checkpoint,
cloud/remote execution.

---

## K. UI ENHANCEMENTS — consolidated master list (2026-07-20)

One place for every open UI/UX item, gathered from QOL-AUDIT.md (285-384),
BACKLOG sections D/Q, and the session-6 market visual-gap analysis. Balu flags
keeps/drops against THIS list. Already fixed (wave 4 + session 6, excluded):
285, 292, 319, 328, 336, 348, 365, 368, 371 (error boundary), and 355 is
partially done ("Preparing worktrees…" busy state).

### K-A. Competitive visual gaps (from the market research — highest leverage)
- UI-1. **Attention Queue** — ranked "needs you now" surface (vs the bell feed). [Paneflow]
- UI-2. **Richer status vocabulary** — blocked-on-permission / stalled badges on panes + cards. [Warp]
- UI-3. **Per-pane token/cost estimate** chip. [Paneflow]
- UI-4. **Dashboard / overview** — all workspaces/panes/health at a glance; Settings > Diagnostics exposing the already-built pane_health / recover_orphans / support-bundle (375/376/377 ⭐ — biggest built-vs-shipped gap).
- UI-5. **Merge-conflict resolution surface** (v1 aborts with a message).
- UI-6. **In-app browser + port management** for dev-server previews. [Superset]
- UI-7. **Agent transcript / run-history browser.**
- UI-8. **Markdown/notes panes.** [Paneflow]
- UI-9. **Onboarding**: first-run tour + demo workspace + "not installed" guidance with install links (287/288/290/291/123/135-136/282).

### K-B. First-five-minutes (QOL §1, open)
- UI-10. First-launch vs closed-all-workspaces framing copy (286, partially done).
- UI-11. Human copy on failed spawn instead of raw JS error (289).
- UI-12. "Launching…" copy for the starting state — slow agent looks stuck (293 ⭐).
- UI-13. Explorer toggle dead-click feedback outside terminals view (294).

### K-C. Micro-interactions (QOL §2)
- UI-14. Press/:active states on all icon buttons (295/296).
- UI-15. Designed tooltips for the collapsed rail (297).
- UI-16. Drag affordances: card grab cursor, Explorer resize hover cue (298/299).
- UI-17. Keyboard path for pane font-zoom controls (300).
- UI-18. Toast pause-on-hover (301).
- UI-19. Scroll-fade cues on Settings/palette lists (302/303).
- UI-20. One shared drop-target visual grammar (304).

### K-D. Information honesty (QOL §3)
- UI-21. Absolute timestamps on hover everywhere (305/306/307/310).
- UI-22. Roll-up: separate "starting" from "running" (308).
- UI-23. Branch pill changed-file count (309) — partially covered by the new diff-stat badge on isolated panes; plain panes still lack it.
- UI-24. WIP-limit breach explanation in place (312).
- UI-25. Unified dirty-dot + empty-state signals (313/314); proc-chip tooltip (311).

### K-E. Error & edge paths (QOL §4)
- UI-26. Rename length guard (315); 9-pane min-width guard (316); full-cwd reveal (317).
- UI-27. Distinguish non-repo / git-missing / git-timeout (318); git_status timeout (321).
- UI-28. Theme-flip debounce (320); degenerate pane-size guard (322).
- UI-29. Explorer virtualisation for huge dirs (323); close-last-pane prompt (324).

### K-F. Keyboard & a11y (QOL §5 + BACKLOG 121/122/207-210)
- UI-30. Focus traps: Settings + CardDetail (325/326); Esc on Notifications + pane menu (329/332).
- UI-31. Keyboard paths: card select/move, workspace context menu, stable pane-header tab order (331/333/334); rename aria-labels (330); Broadcast close affordance (327).
- UI-32. Full keyboard-nav + focus-order audit; screen-reader labels; colour-blind status audit (121/122/207-209).

### K-G. Visual coherence (QOL §6)
- UI-33. Token gaps: .btn-danger #fff, High-Contrast --glow, radius scale, shared .icon-btn (335/337/338/339).
- UI-34. Terminal-vs-chrome palette cross-check per theme (340).
- UI-35. Board empty-glyph → real icon (341); dead .bell CSS cleanup (342); shared signal-thickness scale (343/344).

### K-H. Copy polish (QOL §7)
- UI-36. One destructive-warning phrase; toast house style; shared create/save verbs (346/349/353/354).
- UI-37. Board subtitle overpromise (345); broadcast exclusion reasons (347); explorer error tone (350); "not installed" as actionable sentence (351 ⭐); palette empty-state hint (352).

### K-I. Perceived performance (QOL §8)
- UI-38. Restart/dispatch/spawn progress states ("restarting…", "dispatching…", "spawning 3 of 6…") (359/360/363).
- UI-39. Workspace-switch crossfade (358); theme-switch transition (361).
- UI-40. Broadcast per-chip progress (357); hidden-pane flush chunking (362); palette debounce (364); shared skeleton primitive (356).
- UI-41. Motion system: one easing/duration language + reduced-motion honoured everywhere (116/284); loading skeletons (117); empty/error/loading treatment audit (120/283); success micro-animations (25).

### K-J. Trust signals (QOL §9)
- UI-42. Changelog / "what's new" surface (367); version visibility beyond About (366).
- UI-43. OS-toast permission explainer (369); min-window-size + small-resize test (370).
- UI-44. Quit-with-live-sessions confirmation — the one unguarded destructive action (373).
- UI-45. Icon check across OS surfaces (372); friendly probe-detail copy (374).

### K-New. Session 2026-07-20 additions (Balu-requested)
- UI-50. ⭐ **Custom accent colour picker** — Balu doesn't like being limited to
  the 5 `ACCENTS` presets. Any colour via hex/wheel input; auto-derive the
  dark-safe/light-safe `ice`/`azure`/`accent`/`grad` variants (HSL
  lightness/saturation shifts) so one chosen colour themes the whole app in
  both modes; persisted alongside the preset choice. Extend
  `applyAccent()`/`ACCENTS` in `src/themes.ts` — presets stay as quick picks,
  custom becomes a sixth "your colour" tile. HIGH priority.
- UI-51. Per-vendor accent overrides riding the same derivation pipeline
  (ties to I1 #222 branding) — pick a colour per agent, chips/cards/pane
  accents follow.

### K-K. Backend-built, UI-missing (QOL §10, minus Diagnostics = UI-4)
- UI-46. Persistence wiring UX: "reopen last session?" prompt, safe-mode banner, quit warning (378 ⭐/379 — lands with Tier 1 R4).
- UI-47. Shared git_status cache (380); Browse denied-folder feedback (381).
- UI-48. Job-Object trust copy in Settings (382); auto-title panes from live process (383); "copy scrollback (redacted)" action (384).
- UI-49. Virtualise notification feed / board columns / file tree (126/276); xterm scrollback cap (277).

---

## L. Naming (parked 2026-07-20)

Balu dislikes "Flightdeck" but is keeping it for now. Researched shortlist for
a later rename — all Kove-aligned (cove/harbour; the design system is already
"Deep Cove"):
- **Moorage** — where a fleet ties up; verified: no software/AI product found.
  Front-runner. "Moorage — by Kove", tagline "moor your agents".
- **Berth** — each agent gets its own berth (literal pane/worktree metaphor);
  only collision is berthtech.com (Nigerian services co); generic-word
  trademark risk.
- **Covework** — tightest Kove tie, zero collisions found; reads like a
  "cowork" typo until the brand lands.
Taken / ruled out: Superset (superset.sh = direct competitor), Flotilla,
Slipstream, Tasman, Keelson, Harbourmaster, Homeport, Headland, Deep Cove
(crowded), Manifold, Ensemble, Plural, Constellation.
**Before any rename: IPONZ trademark search + domain check (.nz/.dev/.app).**

---

## Bugs found in testing (Balu adds below)

_(add items here; reference the IDs above where relevant)_
