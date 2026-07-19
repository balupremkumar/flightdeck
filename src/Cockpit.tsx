import { useEffect, useState } from "react";
import { useApp } from "./store";
import { LeftPanel } from "./LeftPanel";
import { PaneGrid } from "./PaneGrid";
import { Board } from "./Board";
import { IconBrand, IconPanel, IconSettings, IconTheme, IconFile, IconBroadcast, IconTerminalPlus } from "./Icons";
import { useVendors } from "./vendors";
import { Settings } from "./Settings";
import { ConfirmDialog } from "./ConfirmDialog";
import { ToastHost } from "./ToastHost";
import { Notifications } from "./Notifications";
import { Broadcast } from "./Broadcast";
import { CommandPalette } from "./CommandPalette";
import { Explorer } from "./Explorer";
import { useUI } from "./ui";
import { applyTheme, currentThemeId, findTheme } from "./themes";

// Quick light/dark flip. Goes through the themes registry (not a raw data-theme
// write) so it stays in step with the richer theme picker in Settings.
function toggleTheme() {
  const cur = findTheme(currentThemeId());
  applyTheme(cur.mode === "light" ? "dark" : "light");
}

export function Cockpit() {
  const workspaces = useApp((s) => s.workspaces);
  const activeId = useApp((s) => s.activeId);
  const addPane = useApp((s) => s.addPane);
  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const vendors = useVendors((s) => s.vendors);
  const [addOpen, setAddOpen] = useState(false);

  const [expanded, setExpanded] = useState(true);
  const showExplorer = useUI((s) => s.explorerOpen);
  const setShowExplorer = useUI((s) => s.setExplorerOpen);
  const view = useUI((s) => s.activeView);
  const setView = useUI((s) => s.setActiveView);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const broadcastOpen = useUI((s) => s.broadcastOpen);
  const setBroadcastOpen = useUI((s) => s.setBroadcastOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ",") { e.preventDefault(); setSettingsOpen(true); return; }
      if (e.ctrlKey && (e.key === "b" || e.key === "B")) {
        // Don't hijack Ctrl+B while the user is typing in a terminal — let the agent have it.
        if ((e.target as HTMLElement)?.closest?.(".pbody")) return;
        e.preventDefault();
        setExpanded((x) => !x);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen]);

  return (
    <div className="cockpit-root">
      <div className="topbar">
        <button className="tb-toggle" onClick={() => setExpanded((e) => !e)} title="Toggle side panel (Ctrl+B)">
          <IconPanel size={17} />
        </button>
        <IconBrand size={18} className="brand-mark" />
        <span className="brand">Flightdeck</span>
        <span className="ws">{view === "board" ? "Board" : active?.name}</span>
        {view === "terminals" && active && (
          <div className="addpane-wrap">
            <button
              className={"tb-ic" + (addOpen ? " on" : "")}
              title="Add a pane to this workspace"
              onClick={() => setAddOpen((o) => !o)}
            >
              <IconTerminalPlus size={17} />
            </button>
            {addOpen && (
              <div className="addpane-menu" onMouseLeave={() => setAddOpen(false)}>
                <div className="apm-h">New pane in {active.name}</div>
                {vendors.map((v) => (
                  <button
                    className="apm-item"
                    key={v.id}
                    onClick={() => { addPane(active.id, v.id, active.root); setAddOpen(false); }}
                  >
                    <span className="apm-dot" style={{ background: `var(${v.accent})` }} />
                    <span className="apm-name">{v.label}</span>
                    {!v.installed && <span className="apm-warn" title={v.detail}>not installed</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <span className="sp" />
        <Notifications />
        <button
          className={"tb-ic" + (showExplorer ? " on" : "")}
          title="Toggle file explorer"
          onClick={() => setShowExplorer(!showExplorer)}
        >
          <IconFile size={17} />
        </button>
        <button
          className={"tb-ic" + (broadcastOpen ? " on" : "")}
          title="Broadcast to panes"
          onClick={() => setBroadcastOpen(!broadcastOpen)}
        >
          <IconBroadcast size={17} />
        </button>
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
      <CommandPalette />
      <Broadcast />

      <div className="cockpit">
        <LeftPanel expanded={expanded} view={view} setView={setView} />
        {showExplorer && active && view === "terminals" && (
          <Explorer root={active.root} wsId={active.id} />
        )}
        <div className="main">
          <div className="wsstack" style={{ display: view === "board" ? "none" : "flex" }}>
            {workspaces.map((w) => (
              <div className="wsgrid" style={{ display: w.id === activeId ? "flex" : "none" }} key={w.id}>
                <PaneGrid ws={w} />
              </div>
            ))}
          </div>
          {view === "board" && <Board />}
        </div>
      </div>
    </div>
  );
}
