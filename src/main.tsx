import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { bootAppearance } from "./themes";
import { useVendors } from "./vendors";
import { runWorktreeGc } from "./worktrees";

// Load the vendor registry from the Rust side once at boot. Everything that
// renders an agent name/colour reads from this (BACKLOG 216).
void useVendors.getState().load();

// Reap worktrees left behind by crashed/killed sessions (D6). Stray work is
// committed to its branch by the backend before removal — never destroyed.
void runWorktreeGc();

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
