import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { bootAppearance } from "./themes";
import { useUI } from "./ui";
import { useVendors } from "./vendors";
import { runWorktreeGc } from "./worktrees";
import { startAutosave, offerSessionRestore, crashedLastRun, armCleanExitSentinel } from "./session";

// Load the vendor registry from the Rust side once at boot. Everything that
// renders an agent name/colour reads from this (BACKLOG 216).
void useVendors.getState().load();

// Session persistence (R4): autosave every store change, then offer to reopen
// the previous session. GC runs AFTER the restore offer is queued — it reads
// the same session doc for its keep-list, so order isn't load-bearing, but
// restore-first keeps the worktree reattach path cheap (dir usually intact).
startAutosave();
// UI-197: read the sentinel BEFORE arming it for this run, then offer the
// support bundle while the evidence from the bad run is still on disk.
const didCrash = crashedLastRun();
armCleanExitSentinel();
void offerSessionRestore().then(() => runWorktreeGc());
if (didCrash) {
  useUI.getState().pushToast(
    "info",
    "Flightdeck didn't shut down cleanly last time. If that keeps happening, export a support bundle from Settings > Diagnostics."
  );
}

// Apply saved theme + accent + colour-blind/reduced-motion overrides before
// first paint (dark/Ice/off are the defaults).
bootAppearance();

// Apply saved UI scale (whole-app zoom) before first paint.
try {
  const s = localStorage.getItem("flightdeck-uiscale");
  if (s && s !== "1") document.documentElement.style.zoom = s;
} catch { /* non-persistent */ }

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
