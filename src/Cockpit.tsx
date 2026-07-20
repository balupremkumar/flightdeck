import { useEffect, useState } from "react";
import { useApp } from "./store";
import { LeftPanel } from "./LeftPanel";
import { PaneGrid } from "./PaneGrid";
import { Board } from "./Board";
import { IconBrand, IconPanel, IconSettings, IconTheme, IconFile, IconBroadcast, IconTerminalPlus } from "./Icons";
import { useVendors, accentCss, vendorShort } from "./vendors";
import { Settings } from "./Settings";
import { ConfirmDialog } from "./ConfirmDialog";
import { ToastHost } from "./ToastHost";
import { Notifications } from "./Notifications";
import { Broadcast } from "./Broadcast";
import { CommandPalette } from "./CommandPalette";
import { Explorer } from "./Explorer";
import { Review } from "./Review";
import { useUI } from "./ui";
import { applyTheme, applyAccent, currentThemeId, currentAccentId, findTheme } from "./themes";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { spawnPane } from "./worktrees";

// Quick light/dark flip. Goes through the themes registry (not a raw data-theme
// write) so it stays in step with the richer theme picker in Settings, and
// re-applies the accent so its dark/light variant follows the new mode.
function toggleTheme() {
  const cur = findTheme(currentThemeId());
  const nextId = cur.mode === "light" ? "dark" : "light";
  applyTheme(nextId);
  applyAccent(currentAccentId(), findTheme(nextId).mode);
}

export function Cockpit() {
  const workspaces = useApp((s) => s.workspaces);
  const activeId = useApp((s) => s.activeId);
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

  // Quit guard (UI-44 / QOL 373): closing a pane or workspace confirms, but the
  // OS window X — the most destructive action of all — didn't. Intercept close
  // while any agent session is live; destroy on confirm (Rust's ExitRequested
  // handler still reaps every process tree on the way out).
  const requestConfirm = useUI((s) => s.requestConfirm);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      getCurrentWindow()
        .onCloseRequested((e) => {
          // Read live state at close time (not render time) — the listener is
          // registered once and must see the current panes.
          const wss = useApp.getState().workspaces;
          const anyLive = wss.some((w) =>
            w.panes.some((p) => p.state === "running" || p.state === "starting" || p.state === "waiting")
          );
          if (!anyLive) return; // nothing live — close straight through
          e.preventDefault();
          const n = wss.reduce((c, w) => c + w.panes.length, 0);
          requestConfirm({
            title: "Quit Flightdeck?",
            body: `Agent sessions are still live across ${n} pane${n === 1 ? "" : "s"}. Quitting ends them — your workspaces reopen next launch, but running sessions can't be brought back.`,
            confirmLabel: "Quit & end sessions",
            danger: true,
            onConfirm: () => { void getCurrentWindow().destroy(); },
          });
        })
        .then((fn) => { if (!cancelled) unlisten = fn; else fn(); })
        .catch(() => { /* browser preview */ });
    } catch { /* browser preview */ }
    return () => { cancelled = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Window title reflects what needs you (QOL 365) — visible from the taskbar
  // without focusing the app. Guarded: no-op outside a real Tauri window.
  const waitingCount = workspaces.reduce((n, w) => n + w.panes.filter((p) => p.state === "waiting").length, 0);
  const permissionCount = workspaces.reduce((n, w) => n + w.panes.filter((p) => p.state === "permission").length, 0);
  const errorCount = workspaces.reduce((n, w) => n + w.panes.filter((p) => p.state === "error").length, 0);
  useEffect(() => {
    const bits = ["Flightdeck"];
    if (permissionCount > 0) bits.push(`${permissionCount} need${permissionCount === 1 ? "s" : ""} approval`);
    if (waitingCount > 0) bits.push(`${waitingCount} waiting`);
    if (errorCount > 0) bits.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
    try { void getCurrentWindow().setTitle(bits.join(" — ")); } catch { /* browser preview */ }
  }, [waitingCount, permissionCount, errorCount]);

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
                    onClick={() => { void spawnPane(active.id, v.id, active.root); setAddOpen(false); }}
                  >
                    <span className="apm-dot" style={{ background: accentCss(v.accent) }} />
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
          title={
            !active || view !== "terminals"
              ? "File explorer opens in the terminal view of a workspace"
              : "Toggle file explorer"
          }
          disabled={!active || view !== "terminals"}
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
      <Review />

      <div className="cockpit">
        <LeftPanel expanded={expanded} view={view} setView={setView} />
        {showExplorer && active && view === "terminals" && (
          <Explorer
            root={active.root}
            wsId={active.id}
            paneRoot={active.panes.find((p) => p.id === active.focused)?.worktreePath}
            paneLabel={(() => {
              const p = active.panes.find((x) => x.id === active.focused);
              return p ? (p.title || vendorShort(p.vendor)) : undefined;
            })()}
          />
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
