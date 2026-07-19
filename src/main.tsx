import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { bootAppearance } from "./themes";
import { useVendors } from "./vendors";

// Load the vendor registry from the Rust side once at boot. Everything that
// renders an agent name/colour reads from this (BACKLOG 216).
void useVendors.getState().load();

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
    <App />
  </React.StrictMode>,
);
