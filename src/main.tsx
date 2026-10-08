import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { bootAppearance } from "./themes";
import { applyReadingSettings, migrateQuietDefault, migrateTerminalDefault } from "./settingsStore";
import { useUI, applyUiScale, loadUiZoom, migrateChromeScale } from "./ui";
import { useVendors, armVendorHotReload, vendorShort } from "./vendors";
import { runWorktreeGc } from "./worktrees";
import { startAutosave, offerSessionRestore, releaseSaveHold, crashedLastRun, armCleanExitSentinel, lastRestoreReport } from "./session";
import { armGlobalErrorLog } from "./applog";
import { syncReadRoots } from "./readscope";
import { bootWindow, adoptBootInfo, listenForAdopt, replayPendingAdopts, listenForFocusPane, listenForScaleChange, closeWhenEmpty, restoreWindows } from "./windowBoot";
import { armStorageSync } from "./storageSync";
import { isMainWindow } from "./persist";

// Flight recorder catch-alls FIRST: a throw or rejection anywhere in the boot
// sequence below must reach the on-disk log (the v0.5.3 failure didn't).
armGlobalErrorLog();

// Load the vendor registry from the Rust side once at boot. Everything that
// renders an agent name/colour reads from this (BACKLOG 216).
void useVendors.getState().load();
// UX-586: pick up manifest edits without reopening the app.
armVendorHotReload();

// Session persistence (R4): autosave every store change, then offer to reopen
// the previous session. GC runs AFTER the restore offer is queued — it reads
// the same session doc for its keep-list, so order isn't load-bearing, but
// restore-first keeps the worktree reattach path cheap (dir usually intact).
startAutosave();
// Read scope: tell Rust which folders content reads may touch (readscope.rs).
syncReadRoots();
// UI-197: read the sentinel BEFORE arming it for this run, then offer the
// support bundle while the evidence from the bad run is still on disk.
const didCrash = crashedLastRun();
armCleanExitSentinel();
// Phase 4: window_boot first (ordinal for the pane-id partition, heartbeat), so
// hydrate never runs before the id counters know their partition.
// A secondary then takes the workspace it was created for (offerSessionRestore is
// main-only), and main starts listening for workspaces folding back into it.
migrateQuietDefault(); // 0.6.1: once, reset 0.6.0's stored Chat default to Quiet terminal
migrateTerminalDefault(); // 0.6.2: once, a stored Quiet terminal default goes back to Terminal (K11)
const booted = bootWindow().then((info) => adoptBootInfo(info)).then(() => closeWhenEmpty());
listenForAdopt();
listenForFocusPane();
listenForScaleChange();
// Phase 4: settings changed in another window apply here live (storage events).
armStorageSync();
// A failed boot never reaches the restore offer: don't leave autosave held for good.
booted.catch(() => releaseSaveHold());
void booted.then(() => offerSessionRestore()).then(async (restoreSecondaries) => {
  await replayPendingAdopts();
  return restoreSecondaries;
}).then((restoreSecondaries) => {
  // Declined "Reopen last session?": Rust already dropped the secondaries, nothing to recreate.
  if (restoreSecondaries) restoreWindows();
  void runWorktreeGc();
  // UX-583: after a bad shutdown, say exactly what came back and whether each
  // worktree survived, rather than a vague "restored" that leaves you guessing.
  if (!didCrash) return;
  const report = lastRestoreReport();
  if (report.length === 0) return;
  const byWs = new Map<string, string[]>();
  for (const r of report) {
    const label = r.title || vendorShort(r.vendor);
    const note =
      r.status === "reattached" ? `${label} (worktree reattached)`
      : r.status === "fell-back" ? `${label} (worktree lost, reopened plain)`
      : label;
    byWs.set(r.workspaceName, [...(byWs.get(r.workspaceName) ?? []), note]);
  }
  const detail = [...byWs.entries()].map(([ws, panes]) => `${ws}: ${panes.join(", ")}`).join(" · ");
  useUI.getState().pushToast("info", `Restored ${detail}`);
});
if (didCrash) {
  useUI.getState().pushToast(
    "info",
    "Flightdeck didn't shut down cleanly last time. The error log may say why — Settings > Diagnostics > Open error log, or export a support bundle (the log rides in it)."
  );
}

// Apply saved theme + accent + colour-blind/reduced-motion overrides before
// first paint (dark/Ice/off are the defaults).
bootAppearance();
applyReadingSettings(); // 1.5b/c: preview + interface text vars before first paint

// Apply saved UI scale (whole-app zoom) before first paint. Must go through
// applyUiScale (native webview zoom) — setting CSS zoom here would break
// xterm's mouse hit-testing; see the comment on applyUiScale.
migrateChromeScale();
const uiZoom = loadUiZoom();
useUI.setState({ uiZoom });
applyUiScale(uiZoom);

const mount = () => ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
// A secondary renders only once its workspace is in the store, or it would flash
// the launcher screen first. The cap keeps a stuck boot from leaving a blank window.
if (isMainWindow()) mount();
else void Promise.race([booted, new Promise<void>((res) => setTimeout(res, 5000))]).then(mount, mount);
