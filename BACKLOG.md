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
- ~~**PR handoff flow**~~ **DONE 2026-07-20 session 8** (Create PR in the Review
  drawer: auto-commit → push -u origin → opens the GitHub/GitLab/Bitbucket
  compare URL; other remotes still push, user opens the PR manually).
- **Merge-conflict resolution surface** (v1 aborts with a message).
- ~~**Per-workspace worktree setup command**~~ **DONE 2026-07-20 session 8**
  (New Workspace field, lockfile-suggested + per-repo memory; runs in-pane via
  a pwsh wrapper before the agent, failure = pane error without agent launch;
  restore re-runs it when a worktree is recreated).
- ~~**Per-pane Explorer rooting / worktree switcher**~~ **DONE 2026-07-20
  session 8** (Workspace/Pane scope toggle; tree, git pill, new-terminal-here
  follow the focused pane's worktree).
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
- ~~R2. Windows Job Object hardening~~ — **SHIPPED wave 2** (`job.rs`: shared Job Object w/ KILL_ON_JOB_CLOSE, every child assigned at spawn — docs were stale, corrected session 8).
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

- ~~K0a. agy trust in worktrees~~ — **FIXED 2026-07-20 session 8**: worktree removal/GC now prunes the dir from agy's `trustedWorkspaces` (case/slash-insensitive, unrelated entries untouched); validated against a real stale entry from the 2026-07-20 E2E run.
- **K0b. MAX_PATH** — worktrees live under `%LOCALAPPDATA%/Flightdeck/worktrees/<hash>/<slug>`; a deep node_modules inside one can trip Windows path limits without `longPathsEnabled`.
- ~~K0c. Fresh worktrees have no build artifacts~~ — **FIXED 2026-07-20 session 8** (worktree setup command, Tier 0 list above).
- ~~K1. Settings ⚙ does nothing~~ — **FIXED session 4** (Settings screen + Ctrl+,).
- ~~K2. No Job Object~~ — **SHIPPED wave 2** (see R2; stale claim corrected session 8).
- ~~K3. `csp:null`~~ — **STALE: CSP was tightened in wave 2** (tauri.conf.json has a full policy; applies to production builds only). Session 8: release exe boots under it; full visual verify of the prod UI still pending a free screen (fullscreen game was up).
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
218. ~~User-definable agents via a manifest file~~ — **DONE 2026-07-20** (JSON manifests in `<app-data>/vendors/`, ManifestVendor adapter, env-override strip exemption, hex/token accents, shipped example; see STATE session 7).
219. ~~**Per-vendor auth state**~~ **DONE 2026-07-20 session 8** — `auth()` on the adapter trait (credential-file presence, never read): "not signed in" chip in New Workspace, signed-in/run-login in Settings > Agents (login opens a pane, the CLI drives its own flow); manifests get an optional `authFile`.
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
- ~~UI-1. **Attention Queue**~~ **DONE 2026-07-20** (v1 bell 2026-07-20; v2 standalone overlay session 8 — Ctrl+Shift+A / palette / bell "See all", keyboard-driven, shared ranking in attention.ts).
- ~~UI-2. Richer status vocabulary~~ **v1 DONE 2026-07-20** ("permission" state from output-pattern detection, ranked first in the attention queue; per-vendor patterns = #220 full; "stalled" still open).
- ~~UI-3. **Per-pane token/cost** chip~~ **DONE 2026-07-20 session 8** (real numbers from Claude Code's own session transcript, incremental jsonl scan; no-transcript agents get no chip — never an estimate). [Paneflow]
- UI-4. **Dashboard / overview** — all workspaces/panes/health at a glance; Settings > Diagnostics exposing the already-built pane_health / recover_orphans / support-bundle (375/376/377 ⭐ — biggest built-vs-shipped gap).
- ~~UI-5. **Merge-conflict resolution surface**~~ **DONE 2026-07-20 session 8** (in-drawer panel: conflicted file list, both-branches-intact note, "Create PR instead"; full local resolution UI not planned — PR flow owns conflicts).
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
- ~~UI-14. Press/:active states~~ **DONE 2026-07-20**.
- UI-15. Designed tooltips for the collapsed rail (297).
- UI-16. Drag affordances: card grab cursor, Explorer resize hover cue (298/299).
- UI-17. Keyboard path for pane font-zoom controls (300).
- ~~UI-18. Toast pause-on-hover~~ **DONE 2026-07-20**.
- UI-19. Scroll-fade cues on Settings/palette lists (302/303).
- UI-20. One shared drop-target visual grammar (304).

### K-D. Information honesty (QOL §3)
- ~~UI-21. Absolute timestamps on hover~~ **DONE 2026-07-20** (feed rows also gained relative age).
- ~~UI-22. Roll-up: separate "starting" from "running"~~ **DONE 2026-07-20**.
- ~~UI-23. Changed-file count on plain panes~~ **DONE 2026-07-20** (diff badge on any repo pane, vs HEAD).
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
- ~~UI-42. Changelog "what's new"~~ **DONE 2026-07-20** (Settings > About, collapsible). Version-visibility beyond About (366) still open.
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

## M. Session-8 deep-dive polish pool (2026-07-20) — UI-100..249

150 new QOL/UX/interaction items from a code-grounded product sweep, beyond
QOL-AUDIT 285-384 and §K. ONE FLAT POOL by Balu's instruction — no phases,
grouped by surface only for navigation; work in any order, all at once.

### New Workspace / launcher
- ~~UI-100. Enter in the directory field submits Create when the form is valid.~~ **DONE 2026-07-20 session 8** (Enter submits)
- ~~UI-101. Recent-folders dropdown on the directory field (last 8 roots).~~ **DONE 2026-07-20 session 8** (recent-folders dropdown)
- UI-102. Path autocomplete while typing (fs_list_dir-driven suggestions).
- ~~UI-103. Live path validation: red outline + "folder not found" before Create.~~ **DONE 2026-07-20 session 8** (live path validation (warn, never block))
- ~~UI-104. Duplicate-slot button (copy a row's vendor + dir).~~ **DONE 2026-07-20 session 8** (duplicate/remove slot)
- ~~UI-105. Drag to reorder slots so pane order matches intent.~~ **DONE 2026-07-20 session 8** (reorder slots)
- ~~UI-106. Setup field shows its source ("suggested from package-lock.json").~~ **DONE 2026-07-20 session 8** (setup source shown)
- UI-107. Isolation toggle gets a "how isolation works" explainer popover.
- ~~UI-108. Remember last layout count per repo (like the setup command).~~ **DONE 2026-07-20 session 8** (layout remembered per repo)
- ~~UI-109. Warn when two non-isolated slots share the same dir (agents trample).~~ **DONE 2026-07-20 session 8** (same-folder collision warning)
- ~~UI-110. Esc closes New Workspace when other workspaces exist (overlay parity).~~ **DONE 2026-07-20 session 8** (Esc closes)
- UI-111. "not installed"/"not signed in" chips open a help popover with the
  install command + copy button, not tooltip-only.
- ~~UI-112. Create button shows per-slot progress ("worktree 2 of 4…").~~ **DONE 2026-07-20 session 8** (per-slot progress)
- ~~UI-113. Drop a folder anywhere on the launcher to fill the directory field.~~ **DONE 2026-07-20 session 8** (drop folder to fill)
- UI-114. First-run launcher footer: version + "what's new" link.

### Pane header / grid
- ~~UI-115. Status-dot tooltip: state + how long it's been in it (stateSince).~~ **DONE 2026-07-20 session 8** (status-dot duration tooltip)
- ~~UI-116. Double-click empty header area toggles maximise.~~ **DONE 2026-07-20 session 8** (double-click maximise)
- ~~UI-117. Middle-click a pane header closes the pane (same confirm rules).~~ **DONE 2026-07-20 session 8** (middle-click close)
- ~~UI-118. Diff badge pulses subtly when its counts change.~~ **DONE 2026-07-20 session 8** (diff badge pulse)
- ~~UI-119. Branch pill click copies the branch name (toast).~~ **DONE 2026-07-20 session 8** (branch pill copies)
- ~~UI-120. cwd chip click reveals the folder in the OS (now menu-only).~~ **DONE 2026-07-20 session 8** (cwd chip reveals)
- UI-121. Focused pane border tints with the vendor accent (ties UI-51).
- UI-122. Ctrl+Alt+arrows move pane focus spatially in the grid.
- ~~UI-123. Ctrl+W closes focused pane, Ctrl+Shift+W the workspace (guarded).~~ **DONE 2026-07-20 session 8** (Ctrl+W / Ctrl+Shift+W)
- ~~UI-124. Alt+1..9 focuses pane N in the active workspace.~~ **DONE 2026-07-20 session 8** (Alt+1-9 focus)
- UI-125. Error pane's Restart tooltip shows the last exit code.
- ~~UI-126. "Launching…" overlay gains a second line after 20s ("still starting —~~ **DONE 2026-07-20 session 8** (slow-start copy)
  check sign-in?").
- ~~UI-127. Setup phase gets its own overlay label ("Running setup: npm ci")~~ **DONE 2026-07-20 session 8** (setup-phase overlay)
  distinct from "Launching".
- UI-128. Scroll-to-bottom FAB + "new output" count pill when scrolled up.
- ~~UI-129. Mini bell icon on a pane header when that pane is in the queue.~~ **DONE 2026-07-20 session 8** (pane attention chip)
- UI-130. Shift+click selects multiple panes for bulk restart/close/broadcast.
- UI-131. Maximise/solo transition animates scale (reduced-motion aware).

### Terminal
- ~~UI-132. Custom right-click menu: copy/paste/clear/select-all/find.~~ **DONE 2026-07-20 session 8** (terminal context menu)
- ~~UI-133. Multi-line paste confirm (togglable) before feeding shells.~~ **DONE 2026-07-20 session 8** (multi-line paste confirm)
- ~~UI-134. Clear-scrollback action (overflow menu + palette).~~ **DONE 2026-07-20 session 8** (clear scrollback)
- ~~UI-135. BEL character pulses the pane (agent rang the terminal bell).~~ **DONE 2026-07-20 session 8** (BEL pulse)
- UI-136. OSC 9;4 progress protocol → real progress strip on the pane band
  (Windows Terminal convention; npm/winget already emit it).
- ~~UI-137. Persist last find query per pane; reopen with it prefilled.~~ **DONE 2026-07-20 session 8** (find query remembered)
- UI-138. Font preview in Settings > Terminal font picker.
- UI-139. Cursor-style setting shows a live preview glyph.
- UI-140. Per-vendor default font-zoom remembered across panes.

### Attention queue / notifications
- ~~UI-141. Queue rows show the pane's last output line as context.~~ **DONE 2026-07-20 session 8** (queue shows last output line)
- ~~UI-142. Split bell badge: approvals (gold) vs errors (red) counts.~~ **DONE 2026-07-20 session 8** (split bell badge)
- ~~UI-143. Snooze a pane from the queue (mute it 10m).~~ **DONE 2026-07-20 session 8** (snooze)
- UI-144. Feed groups consecutive transitions of the same pane.
- ~~UI-145. Auto-DND while a pane is maximised (focus mode).~~ **DONE 2026-07-20 session 8** (auto-DND in focus mode)
- ~~UI-146. Optional auto-open queue when ≥3 approvals are pending.~~ **DONE 2026-07-20 session 8** (auto-open queue (opt-in))
- UI-147. Taskbar overlay badge with the queue count (Tauri set_overlay_icon).
- ~~UI-148. aria-live polite region announces queue additions for screen readers.~~ **DONE 2026-07-20 session 8** (aria-live queue announcements)

### Left panel / workspaces
- ~~UI-149. Tile mini-grid preview: tiny squares mirroring pane layout + states.~~ **DONE 2026-07-20 session 8** (tile mini-grid preview)
- ~~UI-150. Tile badge: worktree count + dirty-worktree count.~~ **DONE 2026-07-20 session 8** (worktree badge)
- UI-151. Drag a pane onto another workspace tile to move it.
- ~~UI-152. Auto-collapse the panel under a window-width threshold.~~ **DONE 2026-07-20 session 8** (narrow-window auto-collapse)
- UI-153. Workspace colour derived from repo-path hash, overridable.
- ~~UI-154. "Open repo on GitHub" context item when origin exists.~~ **DONE 2026-07-20 session 8** (open repo on host)
- UI-155. Sort-by-last-active toggle.
- ~~UI-156. Ctrl+Tab cycles workspaces most-recent-first.~~ **DONE 2026-07-20 session 8** (Ctrl+Tab MRU)

### Board ↔ agents
- ~~UI-157. Card stores the PR URL after handoff; badge links to it.~~ **DONE 2026-07-20 session 8** (card keeps its PR link)
- UI-158. "Send to agent…" (choose vendor) from the card context menu.
- UI-159. Card auto-moves to Done when its linked pane's branch merges.
- UI-160. Card shows linked pane's token usage.
- ~~UI-161. Board search box (parity with palette filtering).~~ **DONE 2026-07-20 session 8** (board search (already shipped))
- ~~UI-162. Dispatched worktree/branch named from the card title~~ **DONE 2026-07-20 session 8** (task-named branches)
  (flightdeck/fix-login-badge, not flightdeck/p1x2).
- UI-163. Card can't enter Done while its linked pane has unmerged diff
  (honesty gate, overridable).
- UI-164. Priority-stripe legend popover ("what the colours mean").

### Review drawer
- UI-165. Side-by-side split-diff toggle (unified-only today).
- ~~UI-166. Word-level intra-line diff highlighting.~~ **DONE 2026-07-20 session 8** (word-level diff (worddiff.ts, 8 tests))
- UI-167. Collapse file list by directory when >15 files.
- UI-168. Include/exclude files from a merge (partial merge-back).
- ~~UI-169. Copy-patch-to-clipboard button.~~ **DONE 2026-07-20 session 8** (copy patch)
- UI-170. Auto-refresh diff while the drawer is open ("changed since opened" pill).
- UI-171. Lightweight syntax highlighting in the patch by file extension.
- ~~UI-172. j/k file navigation to match the n/p hunk keys.~~ **DONE 2026-07-20 session 8** (j/k file nav, n/p hunks)
- ~~UI-173. "Open in editor" on each file row.~~ **DONE 2026-07-20 session 8** (open-in-editor per file row)
- ~~UI-174. Commit list of the branch above the file list (what merge brings).~~ **DONE 2026-07-20 session 8** (branch commit list)
- ~~UI-175. "Reopen PR page" after a handoff (remember URL per branch).~~ **DONE 2026-07-20 session 8** (reopen PR)
- ~~UI-176. Post-merge follow-up offer: close pane + clean worktree in one click.~~ **DONE 2026-07-20 session 8** (post-merge cleanup offer)
- ~~UI-177. Base-drift pill ("main moved +4 since fork") in the drawer header.~~ **DONE 2026-07-20 session 8** (base-drift pill)
- ~~UI-178. "Update from base" button (merge base INTO the agent branch).~~ **DONE 2026-07-20 session 8** (update from base)
- UI-179. Conflict panel: open both versions in editor, per file.

### Settings
- ~~UI-180. Search/filter box inside Settings.~~ **DONE 2026-07-20 session 8** (settings search)
- UI-181. Palette deep-links to Settings sections ("Settings: Terminal").
- UI-182. Export/import ALL settings (not just the theme).
- ~~UI-183. Reset-everything-to-defaults with confirm.~~ **DONE 2026-07-20 session 8** (scoped reset-all)
- UI-184. Launch-on-Windows-login toggle (registry Run key).
- UI-185. Diagnostics: CPU sparkline per pane (last 60s).
- UI-186. Diagnostics: total footprint roll-up vs system RAM.
- ~~UI-187. Diagnostics: worktrees list with disk size + open/clean actions.~~ **DONE 2026-07-20 session 8** (worktree inventory + cleanup)
- UI-188. Vendors folder file-watcher: manifests hot-reload, no reopen.
- ~~UI-189. Invalid manifest files listed with their parse error in~~ **DONE 2026-07-20 session 8** (manifest parse errors surfaced)
  Settings > Agents (currently skipped silently).
- ~~UI-190. Shortcut editor warns on conflicting bindings.~~ **DONE 2026-07-20 session 8** (shortcut conflict detection)
- ~~UI-191. Restore-points browser (backend list/restore built, zero UI).~~ **DONE 2026-07-20 session 8** (restore-points browser)
- ~~UI-192. One-file backup/import buttons (backend built, zero UI).~~ **DONE 2026-07-20 session 8** (backup export/import)
- UI-193. Theme picker shows mini preview thumbnails per theme.
- UI-194. Custom accent: Kove preset swatches + recently-used row.

### Lifecycle / trust
- ~~UI-195. Quit confirm itemises what's live ("3 running, 1 dirty worktree"),~~ **DONE 2026-07-20 session 8** (itemised quit guard)
  not a generic sentence.
- ~~UI-196. Subtle autosave tick ("saved 12s ago") in Settings > About.~~ **DONE 2026-07-20 session 8** (autosave tick in About)
- UI-197. Non-clean-exit sentinel: next launch offers the support bundle.
- ~~UI-198. Session-restore failure names the workspace and reason.~~ **DONE 2026-07-20 session 8** (restore failures name the workspace)
- ~~UI-199. Worktree-GC toast gains "view details" (which branches were kept).~~ **DONE 2026-07-20 session 8** (GC toast names what it reaped)
- ~~UI-200. Focus-follows-attention option: auto-jump to a pane on approval~~ **DONE 2026-07-20 session 8** (follow-attention (opt-in))
  prompt (opt-in, default off).

### Broadcast
- ~~UI-201. Up-arrow recalls previous broadcast messages.~~ **DONE 2026-07-20 session 8** (broadcast history recall)
- UI-202. Saved snippets/templates for common prompts.
- ~~UI-203. Target presets ("all Claude", "all in repo X").~~ **DONE 2026-07-20 session 8** (broadcast target presets)
- ~~UI-204. Enter sends / Shift+Enter newline, stated in the placeholder.~~ **DONE 2026-07-20 session 8** (Enter/Shift+Enter stated)

### Command palette
- ~~UI-205. Pane results show live state dots.~~ **DONE 2026-07-20 session 8** (palette state dots)
- ~~UI-206. "Restart all errored panes" action.~~ **DONE 2026-07-20 session 8** (restart all errored)
- ~~UI-207. "Open review for focused pane" action.~~ **DONE 2026-07-20 session 8** (review focused pane)
- UI-208. Empty query shows recent panes + top actions instead of nothing.

### Explorer
- UI-209. Optional in-app file preview (read-only peek) instead of OS open.
- UI-210. Changed-file dot markers in the tree (from the diff summary).
- ~~UI-211. File context menu: copy path / copy relative path / reveal.~~ **DONE 2026-07-20 session 8** (Explorer context menu)
- ~~UI-212. Remember expanded folders per workspace.~~ **DONE 2026-07-20 session 8** (expanded folders remembered)
- ~~UI-213. Auto-refresh on filesystem changes (watcher), not manual only.~~ **DONE 2026-07-20 session 8** (Explorer auto-refresh (timer + focus))

### Accessibility
- ~~UI-214. Honour the OS prefers-reduced-motion query as the default.~~ **DONE 2026-07-20 session 8** (OS reduced-motion default)
- ~~UI-215. Focus-visible outlines on every custom clickable (tiles, dh-x, chips).~~ **DONE 2026-07-20 session 8** (focus-visible outlines)
- UI-216. Launcher tiles + slot rows keyboard-operable (role, tabindex, Enter).
- ~~UI-217. forced-colors (Windows High Contrast) media-query support.~~ **DONE 2026-07-20 session 8** (forced-colors support)
- ~~UI-218. Hit-target audit: nothing interactive under 24×24.~~ **DONE 2026-07-20 session 8** (24px hit targets)
- ~~UI-219. Second channel for colour-only status signals (shape/icon per state).~~ **DONE 2026-07-20 session 8** (glyph as second channel for vendor identity)

### Microcopy / consistency
- ~~UI-220. One shared relTime/forMins util (three near-identical copies exist:~~ **DONE 2026-07-20 session 8** (shared formatter)
  LeftPanel, Broadcast, attention.ts).
- UI-221. Tooltip style policy: sentence case, no trailing period, applied app-wide.
- ~~UI-222. Numbers localised via toLocaleString everywhere (only the token~~ **DONE 2026-07-20 session 8** (localised numbers)
  tooltip does it today).
- ~~UI-223. Empty states name the shortcut that fixes them ("Ctrl+K → add pane").~~ **DONE 2026-07-20 session 8** (empty states name shortcuts)
- UI-224. Typographic quotes/dashes pass over all user-facing strings.

### Perceived performance / internals with visible effect
- ~~UI-225. Bundle split (manualChunks) — kills the 933KB build warning and~~ **DONE 2026-07-20 session 8** (bundle split)
  speeds first paint.
- ~~UI-226. React.memo pass on PaneView/LeftPanel rows (store churn re-renders~~ **DONE 2026-07-20 session 8** (PaneView memoised (drag path proven))
  every pane every second).
- ~~UI-227. Pause usage/git polls for hidden panes (IntersectionObserver exists,~~ **DONE 2026-07-20 session 8** (hidden panes stop polling)
  polls ignore it).
- ~~UI-228. Pause all polls while the window is minimised (battery).~~ **DONE 2026-07-20 session 8** (polls pause when minimised)
- ~~UI-229. Batch pty output writes per animation frame (one write per event today).~~ **DONE 2026-07-20 session 8** (batched pty writes)

### Worktree / git depth
- UI-230. Worktree disk-size line in the pane overflow menu.
- ~~UI-231. Token chip context-limit awareness: amber ≥70%, red ≥90% of the~~ **DONE 2026-07-20 session 8** (context-window colour thresholds)
  window, tooltip suggests /compact.
- UI-232. Workspace tile tooltip: token roll-up across its panes.
- UI-233. Optional costPerMTok field in vendor manifests → real $ on the chip
  for API-key local/proxy vendors.
- ~~UI-234. Explorer + PaneView share one git_status cache per cwd (dedupes the~~ **DONE 2026-07-20 session 8** (shared git_status cache)
  6-per-cycle subprocess storm; supersedes UI-47's narrower phrasing).

### Vendor / agent depth
- UI-235. Per-vendor spawn counts on the New Workspace summary line get icons.
- ~~UI-236. Vendor glyphs (not just colours) in chips, selects, and palette rows.~~ **DONE 2026-07-20 session 8** (vendor glyphs)
- ~~UI-237. Per-vendor "waiting" quiet-threshold defaults (agy idles differently~~ **DONE 2026-07-20 session 8** (per-vendor quiet thresholds)
  from claude).
- ~~UI-238. Manifest schema published as JSON Schema in the vendors folder~~ **DONE 2026-07-20 session 8** (manifest JSON Schema shipped)
  ($schema line in the example → editor autocomplete).
- ~~UI-239. "Test launch" button per vendor in Settings (spawns a throwaway pane~~ **DONE 2026-07-20 session 8** (per-vendor test launch)
  in the home dir).

### Visual system
- ~~UI-240. One pulse-timing token for all animated dots (pband/pdot/lp dots~~ **DONE 2026-07-20 session 8** (pulse-cadence token)
  currently drift out of phase).
- ~~UI-241. Shadow/elevation scale tokens (--shadow-1..3) replacing per-file values.~~ **DONE 2026-07-20 session 8** (elevation tokens)
- ~~UI-242. Dim non-focused pane headers slightly when one pane is maximised.~~ **DONE 2026-07-20 session 8** (focus-mode dimming)
- UI-243. Empty pane-grid state offers recent workspaces, not only "add pane".
- ~~UI-244. Board column header shows WIP as "3/5" fraction, not only a red flip.~~ **DONE 2026-07-20 session 8** (WIP fraction (already shipped))
- ~~UI-245. Consistent overlay z-index scale documented in a comment block~~ **DONE 2026-07-20 session 8** (z-index scale + 2 layering bugs fixed)
  (scrim stack: toast > confirm > palette > queue > drawer > settings).
- ~~UI-246. Chip component unification: slot-warn/agent-chip/rv-branch/pdiff all~~ **DONE 2026-07-20 session 8** (shared .chip base)
  become one .chip base class with variants.
- ~~UI-247. Motion durations tokenised (--t-fast/--t-med) instead of scattered~~ **DONE 2026-07-20 session 8** (motion tokens)
  .12s/.14s/.16s literals.
- UI-248. Icon stroke-width audit: all SVGs at 1.6 except three outliers.
- UI-249. Print/export-friendly board view (media print CSS) for standups.

---

## Bugs found in testing (Balu adds below)

_(add items here; reference the IDs above where relevant)_
