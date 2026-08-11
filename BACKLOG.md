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

- ~~K0a. agy trust~~ — **FULLY CLOSED 2026-07-20 session 8** (consent prompt + GC). **FIXED 2026-07-20 session 8**: worktree removal/GC now prunes the dir from agy's `trustedWorkspaces` (case/slash-insensitive, unrelated entries untouched); validated against a real stale entry from the 2026-07-20 E2E run. **Consent half (Balu approved):** Flightdeck was answering agy's own trust question on the user's behalf, which is right for a repo you work in and wrong for one you just cloned. `src/trust.ts` now asks once per REPO ROOT (so six panes and every worktree share one decision) before any trust is granted, gated ahead of worktree creation so declining leaves nothing behind. `needs_trust` is a vendor-adapter property, not a hardcoded "agy" check. Revoke list in Settings > Agents. 8 tests.
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
- ~~UI-4. **Dashboard / overview** — all workspaces/panes/health at a glance; Settings > Diagnostics exposing the already-built pane_health / recover_orphans / support-bundle (375/376/377 ⭐ — biggest built-vs-shipped gap).~~ **ALREADY SHIPPED — stale §K entry, verified against code 2026-07-20 session 8** (Settings > Diagnostics (pane health, orphans, support bundle, worktrees))
- ~~UI-5. **Merge-conflict resolution surface**~~ **DONE 2026-07-20 session 8** (in-drawer panel: conflicted file list, both-branches-intact note, "Create PR instead"; full local resolution UI not planned — PR flow owns conflicts).
- UI-6. **In-app browser + port management** for dev-server previews. [Superset]
- UI-7. **Agent transcript / run-history browser.**
- UI-8. **Markdown/notes panes.** [Paneflow]
- ~~UI-9. **Onboarding**: first-run tour + demo workspace + "not installed" guidance with install links (287/288/290/291/123/135-136/282).~~ **DONE 2026-07-20 session 8** (install guidance (copy command / get it) for missing agents)

### K-B. First-five-minutes (QOL §1, open)
- ~~UI-10. First-launch vs closed-all-workspaces framing copy (286, partially done).~~ **2026-07-20 session 8** (first-launch framing distinct from closed-everything)
- ~~UI-11. Human copy on failed spawn instead of raw JS error (289).~~ **DONE 2026-07-20 session 8** (human spawn-failure copy)
- ~~UI-12. "Launching…" copy for the starting state — slow agent looks stuck (293 ⭐).~~ **ALREADY SHIPPED — stale §K entry, verified against code 2026-07-20 session 8** ('Launching…' overlay incl. slow-start and setup-phase copy)
- ~~UI-13. Explorer toggle dead-click feedback outside terminals view (294).~~ **DONE 2026-07-20 session 8** (already fixed (verified: toggle is disabled with a reason))

### K-C. Micro-interactions (QOL §2)
- ~~UI-14. Press/:active states~~ **DONE 2026-07-20**.
- ~~UI-15. Designed tooltips for the collapsed rail (297).~~ **DONE 2026-07-20 session 8** (designed rail tooltips)
- ~~UI-16. Drag affordances: card grab cursor, Explorer resize hover cue (298/299).~~ **DONE 2026-07-20 session 8** (drag affordances)
- ~~UI-17. Keyboard path for pane font-zoom controls (300).~~ **DONE 2026-07-20 session 8** (Ctrl+= / Ctrl+- / Ctrl+0 font zoom)
- ~~UI-18. Toast pause-on-hover~~ **DONE 2026-07-20**.
- ~~UI-19. Scroll-fade cues on Settings/palette lists (302/303).~~ **DONE 2026-07-20 session 8** (scroll-fade cue on Settings)
- ~~UI-20. One shared drop-target visual grammar (304).~~ **DONE 2026-07-20 session 8** (one drop-target colour grammar)

### K-D. Information honesty (QOL §3)
- ~~UI-21. Absolute timestamps on hover~~ **DONE 2026-07-20** (feed rows also gained relative age).
- ~~UI-22. Roll-up: separate "starting" from "running"~~ **DONE 2026-07-20**.
- ~~UI-23. Changed-file count on plain panes~~ **DONE 2026-07-20** (diff badge on any repo pane, vs HEAD).
- ~~UI-24. WIP-limit breach explanation in place (312).~~ **DONE 2026-07-20 session 8** (WIP breach explained in place)
- ~~UI-25. Unified dirty-dot + empty-state signals (313/314); proc-chip tooltip (311).~~ **DONE 2026-07-20 session 8** (one .dirty-dot class)

### K-E. Error & edge paths (QOL §4)
- ~~UI-26. Rename length guard (315); 9-pane min-width guard (316); full-cwd reveal (317).~~ **DONE 2026-07-20 session 8** (full selectable cwd in the pane menu)
- ~~UI-27. Distinguish non-repo / git-missing / git-timeout (318); git_status timeout (321).~~ **DONE 2026-07-20 session 8** (git-missing vs not-a-repo distinguished)
- ~~UI-28. Theme-flip debounce (320); degenerate pane-size guard (322).~~ **2026-07-20 session 8** (theme-flip coalescing + degenerate pane-size guard)
- ~~UI-29. Explorer virtualisation for huge dirs (323); close-last-pane prompt (324).~~ **DONE 2026-07-20 session 8** (close-workspace exit from the empty grid)

### K-F. Keyboard & a11y (QOL §5 + BACKLOG 121/122/207-210)
- ~~UI-30. Focus traps: Settings + CardDetail (325/326); Esc on Notifications + pane menu (329/332).~~ **DONE 2026-07-20 session 8** (focus traps (Settings + CardDetail), E2E-verified)
- ~~UI-31. Keyboard paths: card select/move, workspace context menu, stable pane-header tab order (331/333/334); rename aria-labels (330); Broadcast close affordance (327).~~ **DONE 2026-07-20 session 8** (focus implies card selection — completes the keyboard move path)
- UI-32. Full keyboard-nav + focus-order audit; screen-reader labels; colour-blind status audit (121/122/207-209).

### K-G. Visual coherence (QOL §6)
- ~~UI-33. Token gaps: .btn-danger #fff, High-Contrast --glow, radius scale, shared .icon-btn (335/337/338/339).~~ **DONE 2026-07-20 session 8** (glow tokenised, shared .icon-btn base, radius scale (btn-danger already token-driven))
- UI-34. Terminal-vs-chrome palette cross-check per theme (340).
- ~~UI-35. Board empty-glyph → real icon (341); dead .bell CSS cleanup (342); shared signal-thickness scale (343/344).~~ **DONE 2026-07-20 session 8** (dead bell CSS removed; lost radar-ping restored)

### K-H. Copy polish (QOL §7)
- ~~UI-36. One destructive-warning phrase~~ **CLOSED 2026-07-20 session 8 — premise didn't hold**: "can't be brought back" (ending a live agent process) and "can't be undone" (discarding stored data) describe genuinely different things, and each is already used consistently within its class. Collapsing them to one phrase would be less accurate, not more. Toast house style + shared verbs (the rest of 346/349/353/354) remain open.
- ~~UI-37. Board subtitle overpromise (345); broadcast exclusion reasons (347); explorer error tone (350); "not installed" as actionable sentence (351 ⭐); palette empty-state hint (352).~~ **DONE 2026-07-20 session 8** (actionable not-installed sentence)

### K-I. Perceived performance (QOL §8)
- ~~UI-38. Restart/dispatch/spawn progress states ("restarting…", "dispatching…", "spawning 3 of 6…") (359/360/363).~~ **DONE 2026-07-20 session 8** (dispatch/restart progress states)
- ~~UI-39. Workspace-switch crossfade (358); theme-switch transition (361).~~ **DONE 2026-07-20 session 8** (workspace crossfade)
- ~~UI-40. Broadcast per-chip progress (357); hidden-pane flush chunking (362); palette debounce (364); shared skeleton primitive (356).~~ **DONE 2026-07-20 session 8** (theme transition)
- UI-41. Motion system: one easing/duration language + reduced-motion honoured everywhere (116/284); loading skeletons (117); empty/error/loading treatment audit (120/283); success micro-animations (25).

### K-J. Trust signals (QOL §9)
- ~~UI-42. Changelog "what's new"~~ **DONE 2026-07-20** (Settings > About, collapsible). Version-visibility beyond About (366) still open.
- UI-43. OS-toast permission explainer (369); min-window-size + small-resize test (370).
- ~~UI-44. Quit-with-live-sessions confirmation — the one unguarded destructive action (373).~~ **ALREADY SHIPPED — stale §K entry, verified against code 2026-07-20 session 8** (quit guard, itemised)
- UI-45. Icon check across OS surfaces (372); friendly probe-detail copy (374).

### K-New. Session 2026-07-20 additions (Balu-requested)
- ~~UI-50. ⭐ **Custom accent colour picker** — Balu doesn't like being limited to~~ **ALREADY SHIPPED — stale §K entry, verified against code 2026-07-20 session 8** (custom accent picker)
  the 5 `ACCENTS` presets. Any colour via hex/wheel input; auto-derive the
  dark-safe/light-safe `ice`/`azure`/`accent`/`grad` variants (HSL
  lightness/saturation shifts) so one chosen colour themes the whole app in
  both modes; persisted alongside the preset choice. Extend
  `applyAccent()`/`ACCENTS` in `src/themes.ts` — presets stay as quick picks,
  custom becomes a sixth "your colour" tile. HIGH priority.
- ~~UI-51. Per-vendor accent overrides riding the same derivation pipeline~~ **ALREADY SHIPPED — stale §K entry, verified against code 2026-07-20 session 8** (per-vendor accent overrides)
  (ties to I1 #222 branding) — pick a colour per agent, chips/cards/pane
  accents follow.

### K-K. Backend-built, UI-missing (QOL §10, minus Diagnostics = UI-4)
- ~~UI-46. Persistence wiring UX: "reopen last session?" prompt, safe-mode banner, quit warning (378 ⭐/379 — lands with Tier 1 R4).~~ **ALREADY SHIPPED — stale §K entry, verified against code 2026-07-20 session 8** (reopen prompt, safe-mode banner, quit warning)
- ~~UI-47. Shared git_status cache (380); Browse denied-folder feedback (381).~~ **ALREADY SHIPPED — stale §K entry, verified against code 2026-07-20 session 8** (shared git_status cache (superseded by UI-234))
- UI-48. Job-Object trust copy in Settings (382); auto-title panes from live process (383); "copy scrollback (redacted)" action (384).
- ~~UI-49. Virtualise notification feed / board columns / file tree (126/276); xterm scrollback cap (277).~~ **DONE 2026-07-20 session 8** (Explorer row cap with honest notice)

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
- ~~UI-102. Path autocomplete while typing (fs_list_dir-driven suggestions).~~ **DONE 2026-07-20 session 8** (path autocomplete from the parent listing)
- ~~UI-103. Live path validation: red outline + "folder not found" before Create.~~ **DONE 2026-07-20 session 8** (live path validation (warn, never block))
- ~~UI-104. Duplicate-slot button (copy a row's vendor + dir).~~ **DONE 2026-07-20 session 8** (duplicate/remove slot)
- ~~UI-105. Drag to reorder slots so pane order matches intent.~~ **DONE 2026-07-20 session 8** (reorder slots)
- ~~UI-106. Setup field shows its source ("suggested from package-lock.json").~~ **DONE 2026-07-20 session 8** (setup source shown)
- ~~UI-107. Isolation toggle gets a "how isolation works" explainer popover.~~ **DONE 2026-07-20 session 8** (isolation explainer popover)
- ~~UI-108. Remember last layout count per repo (like the setup command).~~ **DONE 2026-07-20 session 8** (layout remembered per repo)
- ~~UI-109. Warn when two non-isolated slots share the same dir (agents trample).~~ **DONE 2026-07-20 session 8** (same-folder collision warning)
- ~~UI-110. Esc closes New Workspace when other workspaces exist (overlay parity).~~ **DONE 2026-07-20 session 8** (Esc closes)
- ~~UI-111. "not installed"/"not signed in" chips open a help popover with the~~ **2026-07-20 session 8** (install / sign-in popovers)
  install command + copy button, not tooltip-only.
- ~~UI-112. Create button shows per-slot progress ("worktree 2 of 4…").~~ **DONE 2026-07-20 session 8** (per-slot progress)
- ~~UI-113. Drop a folder anywhere on the launcher to fill the directory field.~~ **DONE 2026-07-20 session 8** (drop folder to fill)
- ~~UI-114. First-run launcher footer: version + "what's new" link.~~ **DONE 2026-07-20 session 8** (first-run launcher footer (version + orientation))

### Pane header / grid
- ~~UI-115. Status-dot tooltip: state + how long it's been in it (stateSince).~~ **DONE 2026-07-20 session 8** (status-dot duration tooltip)
- ~~UI-116. Double-click empty header area toggles maximise.~~ **DONE 2026-07-20 session 8** (double-click maximise)
- ~~UI-117. Middle-click a pane header closes the pane (same confirm rules).~~ **DONE 2026-07-20 session 8** (middle-click close)
- ~~UI-118. Diff badge pulses subtly when its counts change.~~ **DONE 2026-07-20 session 8** (diff badge pulse)
- ~~UI-119. Branch pill click copies the branch name (toast).~~ **DONE 2026-07-20 session 8** (branch pill copies)
- ~~UI-120. cwd chip click reveals the folder in the OS (now menu-only).~~ **DONE 2026-07-20 session 8** (cwd chip reveals)
- ~~UI-121. Focused pane border tints with the vendor accent (ties UI-51).~~ **DONE 2026-07-20 session 8** (focused pane ring takes the vendor colour)
- ~~UI-122. Ctrl+Alt+arrows move pane focus spatially in the grid.~~ **DONE 2026-07-20 session 8** (Ctrl+Alt+arrows walk pane focus)
- ~~UI-123. Ctrl+W closes focused pane, Ctrl+Shift+W the workspace (guarded).~~ **DONE 2026-07-20 session 8** (Ctrl+W / Ctrl+Shift+W)
- ~~UI-124. Alt+1..9 focuses pane N in the active workspace.~~ **DONE 2026-07-20 session 8** (Alt+1-9 focus)
- ~~UI-125. Error pane's Restart tooltip shows the last exit code.~~ **DONE 2026-07-20 session 8** (restart tooltip names how it exited)
- ~~UI-126. "Launching…" overlay gains a second line after 20s ("still starting —~~ **DONE 2026-07-20 session 8** (slow-start copy)
  check sign-in?").
- ~~UI-127. Setup phase gets its own overlay label ("Running setup: npm ci")~~ **DONE 2026-07-20 session 8** (setup-phase overlay)
  distinct from "Launching".
- ~~UI-128. Scroll-to-bottom FAB + "new output" count pill when scrolled up.~~ **DONE 2026-07-20 session 8** (scroll-to-tail button with unseen-line count)
- ~~UI-129. Mini bell icon on a pane header when that pane is in the queue.~~ **DONE 2026-07-20 session 8** (pane attention chip)
- UI-130. Shift+click selects multiple panes for bulk restart/close/broadcast.
- ~~UI-131. Maximise/solo transition animates scale (reduced-motion aware).~~ **DONE 2026-07-20 session 8** (maximise animates in)

### Terminal
- ~~UI-132. Custom right-click menu: copy/paste/clear/select-all/find.~~ **DONE 2026-07-20 session 8** (terminal context menu)
- ~~UI-133. Multi-line paste confirm (togglable) before feeding shells.~~ **DONE 2026-07-20 session 8** (multi-line paste confirm)
- ~~UI-134. Clear-scrollback action (overflow menu + palette).~~ **DONE 2026-07-20 session 8** (clear scrollback)
- ~~UI-135. BEL character pulses the pane (agent rang the terminal bell).~~ **DONE 2026-07-20 session 8** (BEL pulse)
- ~~UI-136. OSC 9;4 progress protocol → real progress strip on the pane band~~ **DONE 2026-07-20 session 8** (OSC 9;4 progress rendered into the pane status band)
  (Windows Terminal convention; npm/winget already emit it).
- ~~UI-137. Persist last find query per pane; reopen with it prefilled.~~ **DONE 2026-07-20 session 8** (find query remembered)
- ~~UI-138. Font preview in Settings > Terminal font picker.~~ **DONE 2026-07-20 session 8** (font preview)
- ~~UI-139. Cursor-style setting shows a live preview glyph.~~ **DONE 2026-07-20 session 8** (cursor preview)
- ~~UI-140. Per-vendor default font-zoom remembered across panes.~~ **DONE 2026-07-20 session 8** (per-vendor font zoom remembered)

### Attention queue / notifications
- ~~UI-141. Queue rows show the pane's last output line as context.~~ **DONE 2026-07-20 session 8** (queue shows last output line)
- ~~UI-142. Split bell badge: approvals (gold) vs errors (red) counts.~~ **DONE 2026-07-20 session 8** (split bell badge)
- ~~UI-143. Snooze a pane from the queue (mute it 10m).~~ **DONE 2026-07-20 session 8** (snooze)
- ~~UI-144. Feed groups consecutive transitions of the same pane.~~ **DONE 2026-07-20 session 8** (feed collapses repeat transitions)
- ~~UI-145. Auto-DND while a pane is maximised (focus mode).~~ **DONE 2026-07-20 session 8** (auto-DND in focus mode)
- ~~UI-146. Optional auto-open queue when ≥3 approvals are pending.~~ **DONE 2026-07-20 session 8** (auto-open queue (opt-in))
- ~~UI-147. Taskbar overlay badge with the queue count (Tauri set_overlay_icon).~~ **2026-07-20 session 8** (taskbar badge count)
- ~~UI-148. aria-live polite region announces queue additions for screen readers.~~ **DONE 2026-07-20 session 8** (aria-live queue announcements)

### Left panel / workspaces
- ~~UI-149. Tile mini-grid preview: tiny squares mirroring pane layout + states.~~ **DONE 2026-07-20 session 8** (tile mini-grid preview)
- ~~UI-150. Tile badge: worktree count + dirty-worktree count.~~ **DONE 2026-07-20 session 8** (worktree badge)
- ~~UI-151. Drag a pane onto another workspace tile to move it.~~ **2026-07-20 session 8** (drag a pane to another workspace (identity preserved))
- ~~UI-152. Auto-collapse the panel under a window-width threshold.~~ **DONE 2026-07-20 session 8** (narrow-window auto-collapse)
- ~~UI-153. Workspace colour derived from repo-path hash, overridable.~~ **DONE 2026-07-20 session 8** (repo-hash tile colour)
- ~~UI-154. "Open repo on GitHub" context item when origin exists.~~ **DONE 2026-07-20 session 8** (open repo on host)
- ~~UI-155. Sort-by-last-active toggle.~~ **DONE 2026-07-20 session 8** (sort by last active)
- ~~UI-156. Ctrl+Tab cycles workspaces most-recent-first.~~ **DONE 2026-07-20 session 8** (Ctrl+Tab MRU)

### Board ↔ agents
- ~~UI-157. Card stores the PR URL after handoff; badge links to it.~~ **DONE 2026-07-20 session 8** (card keeps its PR link)
- ~~UI-158. "Send to agent…" (choose vendor) from the card context menu.~~ **DONE 2026-07-20 session 8** (send to agent)
- ~~UI-159. Card auto-moves to Done when its linked pane's branch merges.~~ **DONE 2026-07-20 session 8** (driven from merge-back success in Review.tsx — the diff-goes-to-zero heuristic was rejected because it fires identically on `git reset --hard`)
- ~~UI-160. Card shows linked pane's token usage.~~ **DONE 2026-07-20 session 8** (card token usage)
- ~~UI-161. Board search box (parity with palette filtering).~~ **DONE 2026-07-20 session 8** (board search (already shipped))
- ~~UI-162. Dispatched worktree/branch named from the card title~~ **DONE 2026-07-20 session 8** (task-named branches)
  (flightdeck/fix-login-badge, not flightdeck/p1x2).
- ~~UI-163. Card can't enter Done while its linked pane has unmerged diff~~ **DONE 2026-07-20 session 8** (Done gated on unmerged diff)
  (honesty gate, overridable).
- ~~UI-164. Priority-stripe legend popover ("what the colours mean").~~ **DONE 2026-07-20 session 8** (priority legend)

### Review drawer
- ~~UI-165. Side-by-side split-diff toggle (unified-only today).~~ **DONE 2026-07-20 session 8** (side-by-side diff (splitdiff.ts, 8 tests))
- ~~UI-166. Word-level intra-line diff highlighting.~~ **DONE 2026-07-20 session 8** (word-level diff (worddiff.ts, 8 tests))
- ~~UI-167. Collapse file list by directory when >15 files.~~ **DONE 2026-07-20 session 8** (file list grouped by directory)
- ~~UI-168. Include/exclude files from a merge (partial merge-back).~~ **2026-07-20 session 8** (partial merge — selected files only, unselected work survives)
- ~~UI-169. Copy-patch-to-clipboard button.~~ **DONE 2026-07-20 session 8** (copy patch)
- ~~UI-170. Auto-refresh diff while the drawer is open ("changed since opened" pill).~~ **DONE 2026-07-20 session 8** (diff staleness pill)
- ~~UI-171. Lightweight syntax highlighting in the patch by file extension.~~ **DONE 2026-07-20 session 8** (syntax highlighting)
- ~~UI-172. j/k file navigation to match the n/p hunk keys.~~ **DONE 2026-07-20 session 8** (j/k file nav, n/p hunks)
- ~~UI-173. "Open in editor" on each file row.~~ **DONE 2026-07-20 session 8** (open-in-editor per file row)
- ~~UI-174. Commit list of the branch above the file list (what merge brings).~~ **DONE 2026-07-20 session 8** (branch commit list)
- ~~UI-175. "Reopen PR page" after a handoff (remember URL per branch).~~ **DONE 2026-07-20 session 8** (reopen PR)
- ~~UI-176. Post-merge follow-up offer: close pane + clean worktree in one click.~~ **DONE 2026-07-20 session 8** (post-merge cleanup offer)
- ~~UI-177. Base-drift pill ("main moved +4 since fork") in the drawer header.~~ **DONE 2026-07-20 session 8** (base-drift pill)
- ~~UI-178. "Update from base" button (merge base INTO the agent branch).~~ **DONE 2026-07-20 session 8** (update from base)
- ~~UI-179. Conflict panel: open both versions in editor, per file.~~ **DONE 2026-07-20 session 8** (open conflicted file)

### Settings
- ~~UI-180. Search/filter box inside Settings.~~ **DONE 2026-07-20 session 8** (settings search)
- ~~UI-181. Palette deep-links to Settings sections ("Settings: Terminal").~~ **2026-07-20 session 8** (palette deep-links to Settings sections)
- ~~UI-182. Export/import ALL settings (not just the theme).~~ **DONE 2026-07-20 session 8** (export/import all settings)
- ~~UI-183. Reset-everything-to-defaults with confirm.~~ **DONE 2026-07-20 session 8** (scoped reset-all)
- ~~UI-184. Launch-on-Windows-login toggle (registry Run key).~~ **2026-07-20 session 8** (DROPPED — Balu: the installer's desktop/Start entries are enough)
- ~~UI-185. Diagnostics: CPU sparkline per pane (last 60s).~~ **DONE 2026-07-20 session 8** (CPU sparkline)
- ~~UI-186. Diagnostics: total footprint roll-up vs system RAM.~~ **DONE 2026-07-20 session 8** (memory roll-up)
- ~~UI-187. Diagnostics: worktrees list with disk size + open/clean actions.~~ **DONE 2026-07-20 session 8** (worktree inventory + cleanup)
- UI-188. Vendors folder file-watcher: manifests hot-reload, no reopen.
- ~~UI-189. Invalid manifest files listed with their parse error in~~ **DONE 2026-07-20 session 8** (manifest parse errors surfaced)
  Settings > Agents (currently skipped silently).
- ~~UI-190. Shortcut editor warns on conflicting bindings.~~ **DONE 2026-07-20 session 8** (shortcut conflict detection)
- ~~UI-191. Restore-points browser (backend list/restore built, zero UI).~~ **DONE 2026-07-20 session 8** (restore-points browser)
- ~~UI-192. One-file backup/import buttons (backend built, zero UI).~~ **DONE 2026-07-20 session 8** (backup export/import)
- ~~UI-193. Theme picker shows mini preview thumbnails per theme.~~ **DONE 2026-07-20 session 8** (theme thumbnails)
- ~~UI-194. Custom accent: Kove preset swatches + recently-used row.~~ **DONE 2026-07-20 session 8** (Kove accent swatches)

### Lifecycle / trust
- ~~UI-195. Quit confirm itemises what's live ("3 running, 1 dirty worktree"),~~ **DONE 2026-07-20 session 8** (itemised quit guard)
  not a generic sentence.
- ~~UI-196. Subtle autosave tick ("saved 12s ago") in Settings > About.~~ **DONE 2026-07-20 session 8** (autosave tick in About)
- ~~UI-197. Non-clean-exit sentinel: next launch offers the support bundle.~~ **DONE 2026-07-20 session 8** (clean-exit sentinel offers the support bundle)
- ~~UI-198. Session-restore failure names the workspace and reason.~~ **DONE 2026-07-20 session 8** (restore failures name the workspace)
- ~~UI-199. Worktree-GC toast gains "view details" (which branches were kept).~~ **DONE 2026-07-20 session 8** (GC toast names what it reaped)
- ~~UI-200. Focus-follows-attention option: auto-jump to a pane on approval~~ **DONE 2026-07-20 session 8** (follow-attention (opt-in))
  prompt (opt-in, default off).

### Broadcast
- ~~UI-201. Up-arrow recalls previous broadcast messages.~~ **DONE 2026-07-20 session 8** (broadcast history recall)
- ~~UI-202. Saved snippets/templates for common prompts.~~ **2026-07-20 session 8** (broadcast snippets)
- ~~UI-203. Target presets ("all Claude", "all in repo X").~~ **DONE 2026-07-20 session 8** (broadcast target presets)
- ~~UI-204. Enter sends / Shift+Enter newline, stated in the placeholder.~~ **DONE 2026-07-20 session 8** (Enter/Shift+Enter stated)

### Command palette
- ~~UI-205. Pane results show live state dots.~~ **DONE 2026-07-20 session 8** (palette state dots)
- ~~UI-206. "Restart all errored panes" action.~~ **DONE 2026-07-20 session 8** (restart all errored)
- ~~UI-207. "Open review for focused pane" action.~~ **DONE 2026-07-20 session 8** (review focused pane)
- ~~UI-208. Empty query shows recent panes + top actions instead of nothing.~~ **DONE 2026-07-20 session 8** (palette empty state says what's searchable)

### Explorer
- UI-209. Optional in-app file preview (read-only peek) instead of OS open.
- ~~UI-210. Changed-file dot markers in the tree (from the diff summary).~~ **DONE 2026-07-20 session 8** (changed-file dots)
- ~~UI-211. File context menu: copy path / copy relative path / reveal.~~ **DONE 2026-07-20 session 8** (Explorer context menu)
- ~~UI-212. Remember expanded folders per workspace.~~ **DONE 2026-07-20 session 8** (expanded folders remembered)
- ~~UI-213. Auto-refresh on filesystem changes (watcher), not manual only.~~ **DONE 2026-07-20 session 8** (Explorer auto-refresh (timer + focus))

### Accessibility
- ~~UI-214. Honour the OS prefers-reduced-motion query as the default.~~ **DONE 2026-07-20 session 8** (OS reduced-motion default)
- ~~UI-215. Focus-visible outlines on every custom clickable (tiles, dh-x, chips).~~ **DONE 2026-07-20 session 8** (focus-visible outlines)
- ~~UI-216. Launcher tiles + slot rows keyboard-operable (role, tabindex, Enter).~~ **ALREADY SHIPPED — stale §K entry, verified against code 2026-07-20 session 8** (launcher tiles keyboard-operable)
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
- ~~UI-230. Worktree disk-size line in the pane overflow menu.~~ **DONE 2026-07-20 session 8** (worktree disk size in the pane menu)
- ~~UI-231. Token chip context-limit awareness: amber ≥70%, red ≥90% of the~~ **DONE 2026-07-20 session 8** (context-window colour thresholds)
  window, tooltip suggests /compact.
- ~~UI-232. Workspace tile tooltip: token roll-up across its panes.~~ **2026-07-20 session 8** (workspace token roll-up)
- UI-233. Optional costPerMTok field in vendor manifests → real $ on the chip
  for API-key local/proxy vendors.
- ~~UI-234. Explorer + PaneView share one git_status cache per cwd (dedupes the~~ **DONE 2026-07-20 session 8** (shared git_status cache)
  6-per-cycle subprocess storm; supersedes UI-47's narrower phrasing).

### Vendor / agent depth
- ~~UI-235. Per-vendor spawn counts on the New Workspace summary line get icons.~~ **DONE 2026-07-20 session 8** (vendor glyphs on the summary line)
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
- ~~UI-243. Empty pane-grid state offers recent workspaces, not only "add pane".~~ **DONE 2026-07-20 session 8** (recent folders offered from an emptied workspace)
- ~~UI-244. Board column header shows WIP as "3/5" fraction, not only a red flip.~~ **DONE 2026-07-20 session 8** (WIP fraction (already shipped))
- ~~UI-245. Consistent overlay z-index scale documented in a comment block~~ **DONE 2026-07-20 session 8** (z-index scale + 2 layering bugs fixed)
  (scrim stack: toast > confirm > palette > queue > drawer > settings).
- ~~UI-246. Chip component unification: slot-warn/agent-chip/rv-branch/pdiff all~~ **DONE 2026-07-20 session 8** (shared .chip base)
  become one .chip base class with variants.
- ~~UI-247. Motion durations tokenised (--t-fast/--t-med) instead of scattered~~ **DONE 2026-07-20 session 8** (motion tokens)
  .12s/.14s/.16s literals.
- ~~UI-248. Icon stroke-width audit: all SVGs at 1.6 except three outliers.~~ **2026-07-20 session 8** (CLOSED as not-a-defect — every stroke is already 1.6, no outliers)
- ~~UI-249. Print/export-friendly board view (media print CSS) for standups.~~ **DONE 2026-07-20 session 8** (print CSS)

---

## Bugs found in testing (Balu adds below)

_(add items here; reference the IDs above where relevant)_


## 2026-08-01 — DAILY-DRIVER UX BATCH (UX-501..600) + UI BATCH (UI-601..650)

Balu ruled Flightdeck the priority project 2026-08-01: it is his main driver, so the bar is
"streamlined daily use", not feature count. Numbering starts at 501/601 to clear the existing
schemes (plain 1-384, UI-1..51, UI-100..249). Where an item already existed it is CITED, not
duplicated. STALE-CLAIMS TRAP: verify against code before building anything old.

Named pains from Balu (2026-08-01), all in Phase U1: clicking a link or file path in agent output
does nothing; .md files have no in-app viewer; small navigation frictions everywhere.

### Phase U1 — The click-to-open gap (Balu's named pain; do this first, in this order)
UX-501. Clickable URLs in terminal output via @xterm/addon-web-links, opened with plugin-opener [was #53/#251, never built]
UX-502. Clickable FILE PATHS in terminal output: detect absolute + repo-relative, Windows + POSIX separators, quoted paths
UX-503. Path detection includes file:line and file:line:col (agent output constantly emits these)
UX-504. Ctrl+click = open in editor, plain click = in-app preview; hover shows which is which
UX-505. In-app file preview pane, read-only, syntax-highlit [UI-209, promote from optional to core]
UX-506. Markdown files RENDER in the preview (headings, code, tables, task lists), toggle raw/rendered
UX-507. Markdown links inside a rendered .md are themselves clickable: relative links open the target file, http opens the browser
UX-508. Images in rendered markdown display inline from disk (screenshots in READMEs are the common case)
UX-509. Mermaid/code fences render as code with copy button; no external network
UX-510. Preview honours the app theme and the pane font-size zoom
UX-511. Explorer: single click previews, double click opens in editor [extends #110]
UX-512. Explorer: Enter previews, Space quick-looks, both keyboard-only
UX-513. Preview tabs: keep several files open, Ctrl+Tab between them, close with Ctrl+W
UX-514. "Open containing folder" on any previewed file, and on any detected path
UX-515. Copy-path / copy-relative-path from preview, Explorer, and detected terminal paths
UX-516. Jump to file:line straight into the configured editor [was #177, Phase 4 — pull forward]
UX-517. Editor choice in Settings (VS Code, VS Code Insiders, JetBrains, Notepad++, custom command template)
UX-518. Fall back gracefully when the editor is missing: toast with the reason, offer preview instead
UX-519. Diff lines in the Review drawer are clickable to the same preview at that line
UX-520. Board card descriptions and checklists linkify paths and URLs the same way
UX-521. Broadcast + attention-queue rows linkify their last-output-line
UX-522. Git branch pill click opens the repo's web URL when a remote exists
UX-523. A detected path that no longer exists shows a clear "missing" affordance rather than failing silently
UX-524. Terminal scrollback search [was #250, @xterm/addon-search — the sibling of clickability]
UX-525. Search results navigable with Enter/Shift+Enter, count shown, Esc closes

### Phase U2 — Navigation friction (the "I have to hunt for it" class)
UX-526. Global quick-open: Ctrl+P by path across the focused pane's repo, fuzzy, opens preview
UX-527. Recent files list per workspace, in the palette
UX-528. Command palette gains file actions (open, preview, reveal, copy path)
UX-529. Palette remembers most-recent commands and ranks them first
UX-530. Palette shows the keyboard shortcut next to every command that has one
UX-531. Back/forward navigation stack for preview + Explorer selection (mouse buttons 4/5 too)
UX-532. Breadcrumb bar above the preview, each segment clickable
UX-533. Explorer: reveal-active-file button that syncs the tree to the current preview
UX-534. Explorer: type-to-jump within the expanded tree
UX-535. Explorer: filter box that matches on subsequences, showing matched parents
UX-536. Pane switch by number without the Alt chord when focus is outside a terminal
UX-537. Jump to the pane that most recently produced output (one key)
UX-538. Cycle only panes that need attention (approval/error/waiting), skipping the calm ones
UX-539. Workspace switcher gains fuzzy search when more than N workspaces exist
UX-540. Remember scroll position per pane across view switches (board <-> terminals)
UX-541. Remember Explorer expansion + scroll per workspace, not just per session
UX-542. Esc-stack discipline: Esc always closes the top-most overlay, never two at once
UX-543. Focus returns to where you came from when any overlay closes
UX-544. A visible focus ring on every interactive element in every theme [feeds UI-32]
UX-545. Keyboard cheat-sheet overlay [was #105/#269, dup entries — build once]

### Phase U3 — Agent-session ergonomics (running the fleet, not one pane)
UX-546. Per-pane transcript browser: scroll back through this pane's run history [UI-7]
UX-547. Save/export a pane's scrollback to file [was #57], redacted variant [UI-48]
UX-548. "Copy last agent message" as one action, without mouse selection
UX-549. Copy the last command the agent ran (parse from output where the vendor marks it)
UX-550. Re-send the last prompt to a pane, and to N panes at once
UX-551. Prompt history per vendor, up-arrow style, persisted across restarts
UX-552. Saved prompt snippets with placeholders, insertable from the palette
UX-553. Shift+click multi-select panes for bulk restart/close/broadcast [UI-130]
UX-554. Pane groups: name a set of panes, act on the group
UX-555. Auto-title panes from the live foreground process [UI-48 remainder, backend already emits it]
UX-556. Activity sparkline per pane header [was #56] so a quiet pane is visibly quiet
UX-557. Idle-time indicator: how long since this pane last produced output
UX-558. "Nudge" action: send a newline to a pane that looks wedged
UX-559. Detect and surface an agent asking a question that is not a standard approval prompt
UX-560. Per-vendor quiet-threshold tuning surfaced in the pane menu, not just Settings
UX-561. Session summary on quit: what each pane was doing, saved to the session doc
UX-562. Named session snapshots [was #81] and restore-to-snapshot
UX-563. Export/import a workspace definition [was #82] so a machine move is one file
UX-564. Duplicate a pane with the same cwd and vendor, one action
UX-565. Move a pane between workspaces without closing it

### Phase U4 — Review and board flow (where the work actually lands)
UX-566. Review drawer: keyboard-first file navigation (j/k or arrows) without leaving the diff
UX-567. Review: mark a file reviewed, remaining count visible
UX-568. Review: comment-to-agent — select diff lines, send them back to that pane as a prompt
UX-569. Review: "explain this diff" action that prompts the pane with its own patch
UX-570. Board: custom columns [#258], collapse [#259], archive [#261]
UX-571. Board: bulk actions [#262] and undo [#263]
UX-572. Board: edge autoscroll while dragging [#264]
UX-573. Board card <-> pane linkage visible from both sides
UX-574. Board: card templates for recurring task shapes
UX-575. Board: filter to only cards with live panes
UX-576. Send-to-agent from a card picks the vendor by rule (last used for this repo)
UX-577. Merge-back preflight summary: files, lines, base drift, in one confirm
UX-578. Post-merge "what changed" toast that links to the merge commit
UX-579. Worktree inventory reachable from the pane menu, not only Settings
UX-580. Stale-worktree nudge when one has been idle for days

### Phase U5 — Reliability and trust (small things that erode confidence daily)
UX-581. Never lose typed input: preserve a pane's unsent line across restart
UX-582. Warn before closing a pane with unsent input
UX-583. Crash-recovery banner naming exactly which panes were restored
UX-584. Surface the updater's state honestly (checking, downloading, ready, failed) [0.3.0 updater]
UX-585. Update changelog shown before install, from the release manifest
UX-586. Vendors folder file-watcher so manifests hot-reload [UI-188]
UX-587. Manifest validation errors shown inline with the offending line
UX-588. First-run checklist that verifies each vendor launches [light version of #213]
UX-589. "Run diagnostics" one-click bundle from the About page
UX-590. Clear, non-scary copy when a vendor is not signed in, with the fix action inline
UX-591. Per-pane error detail expandable rather than a truncated toast
UX-592. Offline behaviour: nothing in the UI blocks or spins forever without a network
UX-593. Long-path and unicode-path handling verified end to end (Windows MAX_PATH trap)
UX-594. Large-output resilience: a pane emitting megabytes must not freeze the app
UX-595. Cold-start and steady-state budgets measured and asserted [#279]
UX-596. Memory ceiling per pane surfaced in Diagnostics with a warning threshold
UX-597. Graceful degradation when git is missing or the repo is not a repo
UX-598. Settings search covers every setting including the new ones [UI-180 verify]
UX-599. Reset-to-defaults per section, not only global
UX-600. An in-app "what's new since your last version" panel fed by the manifest

### UI batch (UI-601..650) — look and feel of the daily surface
UI-601. Type scale collapsed to a ratio system (the parked solo-pass item)
UI-602. Single easing/duration language app-wide [UI-41]
UI-603. Loading skeletons instead of spinners for panes, diff, and Explorer
UI-604. Every screen audited for empty/loading/partial/error/ideal [ui-states skill]
UI-605. Pane header density pass: what is essential at a glance vs on hover
UI-606. Status colour semantics unified across dot, band, badge and queue rows
UI-607. Colour-blind-safe status set verified against the CVD palette [UI-32]
UI-608. Terminal-vs-chrome palette cross-check per theme [UI-34]
UI-609. Focus-visible styling that reads in all six themes
UI-610. Tooltip style policy applied app-wide [UI-221]
UI-611. Typographic quotes and dashes in user-facing strings [UI-224]
UI-612. Sentence case everywhere; kill title-case drift
UI-613. Icon set audit for stroke and optical size consistency across surfaces [UI-45]
UI-614. 16px-legibility check on every tray/taskbar surface
UI-615. Empty-state illustrations or marks that teach the next action
UI-616. Board card visual hierarchy: title first, chips subordinate
UI-617. Diff typography: tabular numerals, aligned gutters, wrap policy
UI-618. Split-diff column balance at narrow widths
UI-619. Preview pane typography for prose vs code (measure, leading)
UI-620. Markdown rendering styles that match the Deep Cove system, not GitHub default
UI-621. Scrollbar treatment consistent across xterm, tree, diff and preview
UI-622. Resize handles discoverable without being loud
UI-623. Drag affordances on panes and cards use one visual language
UI-624. Overlay elevation scale documented and applied (the z-order bugs came from this)
UI-625. Toast stack behaviour: max visible, collapse repeats, hover to hold
UI-626. Modal vs drawer policy: which surface for which decision
UI-627. Left panel information density at small heights
UI-628. Workspace tile: monogram, status roll-up, and needy badge composition pass
UI-629. Topbar spacing rhythm and grouping by function
UI-630. Attention-queue row scannability (severity first, duration last)
UI-631. Command palette result rows: icon, title, context, shortcut alignment
UI-632. Settings layout: section rhythm, control alignment, help-text placement
UI-633. Diagnostics tables readable at a glance (units, thresholds, colour)
UI-634. Vendor accent usage rules so five vendors never fight each other
UI-635. Per-vendor glyphs finished and consistent [UI-236]
UI-636. Light-theme audit of every surface added since the last light pass
UI-637. High-contrast theme audit of the same
UI-638. Dracula/Gruvbox/Nord parity check on new surfaces
UI-639. Motion respects the OS reduced-motion setting (app default, unlike the website)
UI-640. Window chrome at small sizes: min-window-size enforcement [UI-43]
UI-641. Multi-monitor DPI change handling without stale layout
UI-642. Zoom levels 80-150% verified on every surface
UI-643. Print/export styling for anything exportable (support bundle, markdown)
UI-644. App icon variants for light and dark taskbars
UI-645. Splash/first-paint that is not a white flash
UI-646. Consistent number formatting (tokens, durations, bytes) via format.ts everywhere
UI-647. Relative time everywhere with absolute on hover
UI-648. Truncation policy: middle-ellipsis for paths, tail for titles, tooltip always
UI-649. Copy microcopy pass: every button says what it does to what
UI-650. A design-critique pass on the whole app once U1-U5 land, before calling any of it done

### Suggested order
U1 first and whole (it is the named pain and the highest daily-friction fix), then U2.
U3-U5 by dogfooding: whatever annoys Balu that week goes to the top.
The UI batch runs alongside as small passes, EXCEPT UI-604 and UI-650 which are gates, not items.

## Sellability roadmap pointer (2026-08-11)
Phases F1-F5 (supervision-cockpit positioning, hook-driven state, cross-vendor burn gauge, checkpoint timeline, Agent Teams GUI, review-loop completion, packaging) live in [[PRODUCT-STRATEGY-2026-08-11|the product strategy]] section 1, diffed against Sections H/I/K/M above.
Read that section before generating new Flightdeck feature ideas.

## QL-701..735 daily-driver QoL batch (2026-08-11, monetisation lens dropped by Balu)

Reframe ruling: Flightdeck is the daily driver replacing VS Code; F5 packaging is parked; F1-F4 strategy items are folded in here where they are daily-driver wins.
Named pain: the viewers.

### V1 Viewers (the named pain)
- QL-701 Preview: render mermaid and diagram fences properly (offline, upgrade of UX-509 which shows them as plain code)
- QL-702 Preview: Ctrl+F find within the rendered document, hit count + nav
- QL-703 Preview: table-of-contents sidebar for markdown, click-to-jump, tracks scroll position
- QL-704 Preview: follow mode - auto-refresh when the file changes on disk (pairs with fs watcher UI-213)
- QL-705 Preview: image viewer upgrades - zoom/pan, fit/1:1 toggle, pixel dimensions, copy image
- QL-706 Preview: structured viewers - CSV as sortable table, JSON as collapsible tree, large-file safe
- QL-707 Preview: compare mode - diff two files or file-vs-clipboard in the existing diff renderer
- QL-708 Preview: pinnable as a persistent split beside the terminal, not only a drawer overlay
- QL-709 Preview: recent files + pinned favourites list in the drawer
- QL-710 Preview: quick-edit mode for small text files (save in place, no external editor round-trip) - scope call [Balu]: bends the editor-handoff philosophy
- QL-711 Verify/finish scrollback search UX-524/525 (claimed in the click-to-open wave, never confirmed in STATE)
- QL-712 In-app browser pane (promotes UI-6): embedded webview, auto-detect localhost URLs in agent output, click-to-open beside the pane; pairs with port-pool management
- QL-713 Markdown notes pane per workspace (promotes UI-8): scratchpad the operator and agents can both read

### V2 Review viewer, act-on-it
- QL-714 Per-hunk approve/reject with small inline edit before merge (extends shipped UI-168 include/exclude)
- QL-715 Diff: collapse unchanged regions with expand-context controls
- QL-716 Diff: image before/after view for changed binary images
- QL-717 Pre-review pass: run the repo linter + tests in the worktree on completion, surface results on the review card
- QL-718 Verification artifacts on the session card: test output, logs, screenshots
- QL-719 "Changed since I last looked" marker per pane: diff-since-last-review baseline that resets on review

### V3 Attention and trust (F1 items recast)
- QL-720 Hook-driven session state via Claude Code Notification/Stop hooks, replacing terminal-text heuristics
- QL-721 Cross-vendor burn gauge from local JSONL: per-session cost, 5-hour block burn, time-to-limit; absorbs UI-233 costPerMTok
- QL-722 Visual checkpoint timeline per session with diff preview and /rewind restore
- QL-723 Autonomy dial per session (interactive / plan / autopilot)
- QL-724 Live one-line "what is this agent doing now" in the pane header, parsed from the last tool call

### V4 Orchestration ergonomics (F3 items recast)
- QL-725 Saved task recipes: prompt + repo + vendor + permission mode + verification command
- QL-726 Board chaining: card B dispatches when card A merges
- QL-727 Race-N-and-promote: same task in N worktrees, promote the winner
- QL-728 Agent-reviews-agent preset over one diff
- QL-729 GitHub issue ingest: issue to configured session
- QL-730 Local scheduler: fire a saved session on a schedule
- QL-731 Worktree setup config per repo (.flightdeck/worktree.json: setup commands, env)
- QL-732 Auto-detect installed agent CLIs on first run

### V5 Polish sweep
- QL-733 Execute the untouched UI-601..650 phases in order (foundations 601-604 first, then diff typography 617-619, platform 639-645)
- QL-734 The ~10 remaining items in handovers\2026-08-01-flightdeck-ux-resume.md
- QL-735 Tooltip/typography policy passes UI-221/UI-224 (= UI-610/611)

## Gold-plate Flightdeck as daily driver - 4-agent research fanout (2026-08-11)

Angles: A terminal deep-craft (web), B Claude Code power tools (web), C codebase gap sweep (repo), D Windows-native integration (web + repo verify).
Deduped against QL-701..735 and all prior sections.
Stale-claim corrections found by D: UI-147 badge count is marked DONE but `setBadgeCount` is a documented no-op on Windows (use `setOverlayIcon`); OS toasts go through raw WebView2 Notification with no AUMID (tauri-plugin-notification absent); no tray exists anywhere in src-tauri. Only the taskbar flash is real.

### Convergent (two agents independently, strongest signal)
- QL-736 WebGL renderer (@xterm/addon-webgl) with fallback on context loss - the single biggest jank fix; DOM renderer confirmed in code, VS Code measured up to 900% faster [C1+A1] (S)
- QL-737 Drag-drop files/folders onto panes inserting shell-quoted paths; folder onto grid opens workspace; mind the dragDropEnabled vs DOM-drag trap [A3+D8] (S)

### Codebase defects and gaps (angle C, file:line evidence in the fanout report)
- QL-738 Cut and ship v0.5.2 - the terminal click-offset fix is stranded on main; installed 0.5.1 still has the worst daily bug (S)
- QL-739 Surface diff truncation in Review ("... [diff truncated]" is appended by worktree.rs but never shown) with an open-in-editor escape (S)
- QL-740 git_status ahead/behind vs upstream + unpushed-commits indicator on every pane, not just worktree panes (M)
- QL-741 Quick-open: raise the 4000-file/depth-14 caps, invalidate the 30s cache on fs events so agent-created files appear immediately (M)
- QL-742 Pane memory health always-on: consume overMemoryWarn in pane header + attention queue; wire the dead memory_warn_mb setting through pane_health (M)
- QL-743 Damp auto-title churn (header flips claude->node->pwsh during builds); debounce or prefer the root process (S)
- QL-744 Explorer: "show more" past the 300-row folder cap (S)
- QL-745 Preview >5MB: offer open-in-editor instead of a bare error (S)
- QL-746 Preview image failure state (retry/reveal) + delete the stale "backend not shipped" comment (S)
- QL-747 Explorer honest error states: denied/vanished folders say why instead of rendering empty (M)
- QL-748 Fix --st-waiting 3.30:1 contrast on light theme (known failure, never filed) (S)
- QL-749 Surface vendor PROXY_ENV_STRIP behaviour in Settings so Bedrock/Vertex fallback is not silent (S)
- QL-750 [Balu posture call] Scope fs_read_text_file/fs_read_file_base64 IPC to workspace roots (carried from STATE.md:39) (M)

### Terminal deep-craft (angle A)
- QL-751 Unicode 11 width addon - fixes emoji/box-drawing frame corruption from agent TUIs, correctness not polish (S)
- QL-752 OSC 133 shell integration via injected PowerShell prompt wrapper - the load-bearing primitive for 753/755/757/763 (M)
- QL-753 Command marks: Ctrl+Up/Down jump between commands, exit-status gutter glyphs, scrollbar overview ruler (M, needs 752)
- QL-754 Quick-select hints mode: keyboard labels over every path/URL/hash on screen, copy or insert without the mouse (M)
- QL-755 Sticky scroll: pin the owning command header while scrolled back (M, needs 752)
- QL-756 OSC 8 hyperlink support alongside the regex linkifier (S)
- QL-757 CWD tracking via OSC 9;9 - correct file:line resolution after an agent cd, "new pane here" (S, with 752)
- QL-758 OSC 52 clipboard write-only, opt-in per pane (WSL/remote copy) (S)
- QL-759 Write-side pty batching + bracketed-paste chunking so large pastes do not stall ConPTY (S)
- QL-760 Copy mode with vi keys over scrollback; semantic-zone selection once 752 lands (M)
- QL-761 Triggers: user regex rules on output - highlight line, capture to a clickable sidebar list, set mark (M)
- QL-762 Scrollback persistence across restart via addon-serialize (restored sessions currently come back blank) (M)
- QL-763 Output folding: collapse a command's output to "N lines, exit 1" (Warp blocks; needs real design, no xterm primitive) (L, needs 752)

### Claude Code power tools (angle B, mostly reads JSONL Flightdeck already scans)
- QL-764 Resume/fork launcher: open a pane from any past session via --resume/--fork-session, forks nested under roots (S)
- QL-765 Context breakdown meter: stacked system/tools/MCP/memory/messages + countdown to autocompact, expanding the ctx pill (S/M)
- QL-766 Model/mode/thinking chip per pane read from transcript (catches silent model fallback, stuck plan mode) (S)
- QL-767 Permission rule inspector: merged allow/ask/deny with winning source, promote-a-prompt-to-rule at chosen scope (M)
- QL-768 MCP board: per-project server health, tool counts, token cost each contributes, enable/disable (M)
- QL-769 Live subagent tree per pane: count, type, current tool, elapsed, tokens, per-subagent transcript (loudest unmet need in ecosystem) (M)
- QL-770 Plan-mode panel: render ExitPlanMode plans as a document beside the pane, approve/refine/reject, archive per pane (M)
- QL-771 Full-text search across all session transcripts, open hit as resumed/forked pane (M, pairs with 764)
- QL-772 Session ledger: auto-titled index per repo (first prompt/summary line, branch, model, duration, outcome), editable titles (S/M)
- QL-773 Hook manager: every hook by event/scope, last fire, exit code, stderr, duration, toggles, schema validation (hooks fail silently by design) (M)
- QL-774 Config doctor: effective merged settings with winning source per key, JSON lint incl. the BOM trap (S/M)
- QL-775 Memory stack viewer: resolved CLAUDE.md chain with @imports expanded, line counts, drift warning (M)
- QL-776 Skills/commands/agents inventory across projects with drift diff (M)
- QL-777 Compaction boundary marker on the pane timeline + handoff snapshot of what was live (M)
- (B's diff-review-with-inline-comments = extends QL-714, not duplicated; comments feed back as the next prompt)

### Windows-native integration (angle D, verified against src-tauri)
- QL-778 Replace the dead badge with a real taskbar overlay icon carrying the needs-attention count (S/M; corrects UI-147)
- QL-779 Monitor-aware window state persistence (tauri-plugin-window-state; no restore onto a vanished monitor; visible:false against flash) (S)
- QL-780 Global summon hotkey: one chord surfaces Flightdeck focused on the neediest pane, same chord dismisses (user-settable) (S)
- QL-781 Real AppUserModelID + route toasts through tauri-plugin-notification (fixes toast origin, pin-survives-update, prerequisite for jump lists) (M)
- QL-782 Feed the already-parsed OSC 9;4 progress to the taskbar button (aggregate rule + error state) (S)
- QL-783 Tray icon with attention state + menu (recent workspaces, summon, quit) and close-to-tray given job-object reaping (M)
- QL-784 Follow Windows theme auto-switch (Light/Dark/Follow Windows three-state) (S)
- QL-785 Respect Focus Assist/DND via SHQueryUserNotificationState: suppress ambient, keep blocking permission prompts; covers presentation mode during screen shares (S)
- QL-786 Opt-in start-with-Windows minimised to tray (off by default; requires 783 + single-instance first, job-object hazard noted) (S)
- QL-787 flightdeck:// deep links + single-instance plugin (deep link to workspace/pane; NSIS registration gap -> runtime register()) (M)
- QL-788 Jump list of recent workspaces on taskbar right-click (COM ICustomDestinationList via windows crate; needs 781 + 787) (L)
- QL-789 Power-aware polling: back off on battery/energy saver, pause on suspend, resync on resume (fixes stale-after-sleep too) (M)
- QL-790 Screen-reader pass: xterm screenReaderMode as a toggle + roles/labels on grid, queue, dropdowns (M)
- QL-791 Thumbnail toolbar buttons on taskbar preview - only as a rider once 788 pays the COM cost (L)

### Ranked out by research, recorded so it stays decided
- Frameless Mica/Acrylic title bar: forfeits working Snap Layouts/Win+arrow; Acrylic resize stutter over nine live terminals; test setEffects Mica on the decorated window instead
- Credential locker: Flightdeck deliberately stores no tokens (BACKLOG 219)
- MSIX/Share targets: repackaging cost for a surface nobody uses
- Quake dropdown pane (angle A) superseded by QL-780 global summon (angle D)
- Cursor trail/smooth caret: no xterm cursor shader hook; WebGL renderer delivers the cheap half
- QL-792 [Balu 2026-08-11] New default dark theme "Graphite": darker charcoal base, chrome/metallic surface treatment, de-emphasise the Kove blue accent ("cove colors don't look the best on here; needs to be darker, more chrome"); keep existing themes selectable; WCAG 4.5:1 floors; absorbs QL-748
