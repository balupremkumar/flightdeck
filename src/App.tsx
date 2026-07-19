import "./App.css";
import { useApp } from "./store";
import { NewWorkspace } from "./NewWorkspace";
import { Cockpit } from "./Cockpit";
import { IconBrand, IconSettings, IconTheme } from "./Icons";
import { Settings } from "./Settings";
import { ConfirmDialog } from "./ConfirmDialog";
import { ToastHost } from "./ToastHost";
import { useUI } from "./ui";
import { applyTheme, currentThemeId, findTheme } from "./themes";

// Same light/dark flip as Cockpit's top bar — routed through the themes
// registry so it stays in step with the richer theme picker in Settings.
function toggleTheme() {
  const cur = findTheme(currentThemeId());
  applyTheme(cur.mode === "light" ? "dark" : "light");
}

// Minimal chrome for the pre-first-workspace state: no workspace rail (there's
// nothing to switch between yet), just enough top bar to reach Settings/theme
// before committing to a workspace. Reuses the real topbar classes so it's
// visually identical to Cockpit's.
function LauncherChrome() {
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  return (
    <div className="cockpit-root">
      <div className="topbar">
        <IconBrand size={18} className="brand-mark" />
        <span className="brand">Flightdeck</span>
        <span className="sp" />
        <button className="tb-ic" title="Toggle light / dark" onClick={toggleTheme}>
          <IconTheme size={17} />
        </button>
        <button className="tb-ic" title="Settings (Ctrl+,)" onClick={() => setSettingsOpen(true)}>
          <IconSettings size={17} />
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
