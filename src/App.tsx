import "./App.css";
import { useApp } from "./store";
import { NewWorkspace } from "./NewWorkspace";
import { Cockpit } from "./Cockpit";
import { IconBrand, IconSettings, IconTheme } from "./Icons";
import { Settings } from "./Settings";
import { ConfirmDialog } from "./ConfirmDialog";
import { ToastHost } from "./ToastHost";
import { useUI } from "./ui";
import { applyThemeForMode, isFollowingSystem, toggleThemeMode } from "./themes";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { logEvent } from "./applog";

// QL-784: "Follow Windows" (Settings > Appearance) hands the light/dark choice
// to the OS, landing on whichever theme was last used in that mode.
//
// Registered here rather than in Cockpit because App is the only component
// mounted in both states (launcher and cockpit), and registered unconditionally
// with the follow check done AT EVENT TIME — that way switching the setting on
// or off in Settings takes effect immediately without tearing the listener
// down and rebuilding it.
function useFollowSystemTheme() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const applyIfFollowing = (theme: string | null | undefined) => {
      if (!theme || !isFollowingSystem()) return;
      applyThemeForMode(theme === "light" ? "light" : "dark");
    };
    try {
      const win = getCurrentWindow();
      // Boot applied the persisted theme synchronously (bootAppearance, which
      // can't await Tauri); this catches an OS change made while Flightdeck
      // was closed.
      win.theme().then(applyIfFollowing).catch(() => { /* browser preview */ });
      win
        .onThemeChanged(({ payload }) => applyIfFollowing(payload))
        .then((fn) => { if (!cancelled) unlisten = fn; else fn(); })
        .catch(() => { /* browser preview */ });
    } catch { /* browser preview */ }
    return () => { cancelled = true; unlisten?.(); };
  }, []);
}

// Minimal chrome for the pre-first-workspace state: no workspace rail (there's
// nothing to switch between yet), just enough top bar to reach Settings/theme
// before committing to a workspace. Reuses the real topbar classes so it's
// visually identical to Cockpit's.
function LauncherChrome() {
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const updateAvailable = useUI((s) => s.updateAvailable);
  return (
    <div className="cockpit-root">
      <div className="topbar">
        <IconBrand size={18} className="brand-mark" />
        <span className="brand">Flightdeck</span>
        <span className="sp" />
        <button className="tb-ic" title="Toggle light / dark" onClick={() => toggleThemeMode()}>
          <IconTheme size={17} />
        </button>
        <button className="tb-ic" title={updateAvailable ? `Settings (Ctrl+,) — Flightdeck ${updateAvailable.version} available` : "Settings (Ctrl+,)"} onClick={() => setSettingsOpen(true)}>
          <IconSettings size={17} />
          {updateAvailable && <span className="tb-update-dot" />}
        </button>
      </div>
      <Settings />
      <ConfirmDialog />
      <ToastHost />
      <div className="cockpit">
        <NewWorkspace />
      </div>
    </div>
  );
}

export default function App() {
  useFollowSystemTheme();
  // Boot beacon for the release gate (tools/boot-gate.ps1). App is the one
  // component mounted in BOTH boot states (launcher and cockpit), so this line
  // in the flight recorder means "the UI provably reached a usable screen". A
  // render throw anywhere in the initial tree unwinds to the ErrorBoundary
  // before effects run, so a broken boot never writes it — the gate fails on
  // its absence. StrictMode double-mount writes it twice; harmless.
  useEffect(() => { logEvent("info", "boot-ok", "app mounted"); }, []);
  const count = useApp((s) => s.workspaces.length);
  const creating = useApp((s) => s.creating);
  if (count === 0) return <LauncherChrome />;
  return (
    <>
      <Cockpit />
      {creating && <NewWorkspace />}
    </>
  );
}
