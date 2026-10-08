# QoL phase QRP (2026-10-08)

Source: BACKLOG section QR (QRP1-QRP17), docs/plans/qol-review-2026-10-08.md, research/flightdeck-agentic-delta-2026-10-08.
Approved by Balu 2026-10-08: build all of QRP1-QRP17, usage shown bigger (not removed), Fable runs the final e2e check before the release, and the next release must account for K10 (Claude CLI missing after an install).
Branch qol/qrp, worktree .claude/worktrees/qrp, base cb105b3.

## Who builds
Codex Sol builds TypeScript jobs (low effort for S, medium for M), at most three at a time, each owning disjoint files.
Claude makes every edit to the Claude-owned files (src/store.ts, src/Cockpit.tsx, src-tauri/**, package.json) and all Rust, writes the briefs, reads every diff, runs the gates and the live checks.
No Astra.
Usage cap: Balu pauses this project at 50 percent Claude usage; ask for a reading at each wave boundary.

## Waves (file ownership decides the order)
Wave 1, parallel:
- qrp-header (Sol medium): QRP1 header strip + K13 double-click. OWNS src/PaneView.tsx, src/panes.css.
- qrp-settings (Sol medium): QRP8 Settings panel. OWNS src/Settings.tsx, src/overlays.css.
- qrp-notify (Sol medium): QRP5 notifications. OWNS src/Notifications.tsx, src/Notifications.css, src/attention.ts (+ tests).
- Claude: QRP6 hooks in the per-launch --settings file (Rust).

Wave 2, parallel:
- qrp-rail (Sol medium): QRP7. OWNS src/LeftPanel.tsx, src/leftpanel.css.
- qrp-home (Sol low): QRP12 + Home side of QRP11. OWNS src/home.ts, src/HomeOverlay.tsx, Home CSS.
- qrp-quota (Sol low): bigger usage pill with popover. OWNS src/QuotaGauge.tsx, src/quotagauge.css.
- Claude: top bar markup in Cockpit.tsx (QRP3), add-pane menu on the overlay stack (QR6), bell opens Home, Ctrl+Shift+J, Ctrl+Shift+F.

Wave 3, parallel:
- qrp-sizefloor (Sol medium): QRP2 tokens and floors across the CSS (after waves 1-2 merge).
- qrp-panemenu (Sol low): QRP10 + QRP15. OWNS src/PaneView.tsx menu and context menu, src/panes.css .pmenu.
- qrp-uiscale (Sol medium): QRP4. OWNS src/ui.ts zoom code, src/Terminal.tsx font size.

Wave 4:
- qrp-reopen (Sol low): QRP9. qrp-search (Sol low): QRP16. qrp-clicheck (Sol low): K10 "Claude CLI not found" message and a boot check.
- qrp-summary (Sol medium): QRP13, after QRP6.
- Claude: QRP17 focus grab (live only).

## Gates
Per merge: tsc, vitest, cx gates, Claude reads the diff and checks each criterion.
End: release.ps1 gate set, Claude live sweep on a Canary build (header, top bar, notifications, hooks state, click offset at 120 percent, K10 message), then one Fable end-to-end check of the whole diff before the cut.
K10 for the release: the installer and boot must never leave Claude unlaunchable; boot shows a clear "Claude CLI not found" banner with the fix if `claude` does not resolve, and the release checklist confirms `claude --version` after install.
