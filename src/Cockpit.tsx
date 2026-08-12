import { useEffect, useRef, useState } from "react";
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
import { AttentionQueue } from "./AttentionQueue";
import { Shortcuts } from "./Shortcuts";
import { SessionLauncher } from "./SessionLauncher";
import { Preview } from "./Preview";
import { QuickOpen } from "./QuickOpenOverlay";
import { ZoomHud } from "./ZoomHud";
import { useUI, closeTopOverlay } from "./ui";
// Quick light/dark flip lives in the themes registry (toggleThemeMode): it
// remembers the last theme used in each mode and carries the accent + CVD
// palette across, so it stays in step with the picker in Settings.
import { toggleThemeMode } from "./themes";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getName } from "@tauri-apps/api/app";
import { spawnPane, closePaneGuarded, closeWorkspaceGuarded } from "./worktrees";
import { isTypingTarget } from "./Shortcuts";
import { attentionQueue, mostRecentOutputPane } from "./attention";

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
  const updateAvailable = useUI((s) => s.updateAvailable);
  const broadcastOpen = useUI((s) => s.broadcastOpen);
  const setBroadcastOpen = useUI((s) => s.setBroadcastOpen);

  // UI-152: below this width the panel costs more than it gives, so collapse it
  // to the rail. A manual toggle after that is respected until the window
  // crosses the threshold again — auto-behaviour must never fight the user.
  const NARROW_PX = 1000;
  const autoCollapsed = useRef(false);
  useEffect(() => {
    const onResize = () => {
      const narrow = window.innerWidth < NARROW_PX;
      if (narrow && !autoCollapsed.current) {
        autoCollapsed.current = true;
        setExpanded(false);
      } else if (!narrow && autoCollapsed.current) {
        autoCollapsed.current = false;
        setExpanded(true);
      }
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // UI-156: most-recently-used workspace order for Ctrl+Tab.
  const mruRef = useRef<number[]>([]);
  useEffect(() => {
    if (activeId == null) return;
    mruRef.current = [activeId, ...mruRef.current.filter((id) => id !== activeId)].slice(0, 20);
  }, [activeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // UX-542: Esc always closes exactly the top-most registered overlay —
      // see ui.ts's overlay-stack comment for the bug this replaces (every
      // overlay used to install its own capture-phase Esc listener, so with
      // two open, Esc could close both at once). Only preventDefault when
      // something was actually closed, so Esc still falls through to
      // ordinary inputs (rename fields, the find box) when no overlay is
      // registered — those aren't on the stack and don't need to be; their
      // own onKeyDown already handles Escape locally.
      if (e.key === "Escape") {
        if (closeTopOverlay()) { e.preventDefault(); }
        return;
      }
      // UX-537: one key, no modifier — jump straight to whichever pane most
      // recently produced output, the pane you'd otherwise go hunting for.
      // Guarded the same way "?" (Shortcuts.tsx) is: never steals the literal
      // character from a text field, select, or terminal.
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === "`") {
        if (isTypingTarget(e.target as Element | null)) return;
        const hit = mostRecentOutputPane(useApp.getState().workspaces);
        if (hit) {
          e.preventDefault();
          useApp.getState().switchWorkspace(hit.w.id);
          useApp.getState().focusPane(hit.w.id, hit.p.id);
        }
        return;
      }
      // UX-536: switch to pane N by its bare number key whenever focus isn't
      // inside a terminal or a text field — Alt+1..9 below still works from
      // ANYWHERE (including mid-typing in a terminal), this is the faster
      // unmodified path for the common case of clicking around the chrome.
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        if (isTypingTarget(e.target as Element | null)) return;
        const st = useApp.getState();
        const ws = st.workspaces.find((w) => w.id === st.activeId);
        const target = ws?.panes[parseInt(e.key, 10) - 1];
        if (ws && target) { e.preventDefault(); st.focusPane(ws.id, target.id); }
        return;
      }
      // UX-538: cycle only the panes that actually need you — approval,
      // error, waiting — skipping calm running/idle ones. Same modifier
      // family as the spatial Ctrl+Alt+Arrow cycle below, with Shift added
      // (a "narrower" version of that cycle, not a competing shortcut).
      if (e.ctrlKey && e.altKey && e.shiftKey && /^Arrow(Left|Right)$/.test(e.key)) {
        const queue = attentionQueue(useApp.getState().workspaces, useUI.getState().snoozed);
        if (queue.length === 0) return;
        e.preventDefault();
        const st = useApp.getState();
        const ws = st.workspaces.find((w) => w.id === st.activeId);
        const focusedPane = ws?.panes.find((p) => p.id === ws.focused);
        const at = queue.findIndex((x) => x.p.id === focusedPane?.id);
        const step = e.key === "ArrowRight" ? 1 : -1;
        const next = queue[(Math.max(0, at) + step + queue.length) % queue.length];
        st.switchWorkspace(next.w.id);
        st.focusPane(next.w.id, next.p.id);
        return;
      }
      // Owner feedback item 3: Ctrl+=/-/0 must scale the WHOLE APP, the
      // browser-style expectation — previously only per-pane terminal font
      // zoom existed on these same keys (removed from PaneView.tsx to avoid
      // both firing at once). Deliberately NOT guarded by `.pbody` like
      // Ctrl+W/B below: these keys are inert in every shell/agent TUI we
      // ship (same reasoning Ctrl+Shift+A already documents), and a browser
      // zoom shortcut that stops working the moment a terminal has focus
      // would be the exact bug being fixed here.
      if (e.ctrlKey && !e.altKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_")) {
        e.preventDefault();
        useUI.getState().stepUiZoom(e.key === "-" || e.key === "_" ? -1 : 1);
        return;
      }
      if (e.ctrlKey && !e.altKey && e.key === "0") {
        e.preventDefault();
        useUI.getState().resetUiZoom();
        return;
      }
      if (e.ctrlKey && e.key === ",") { e.preventDefault(); setSettingsOpen(true); return; }
      // Attention queue (UI-1 v2). Deliberately NOT skipped when a terminal has
      // focus: this is a global "what needs me" shortcut, and no agent TUI binds
      // Ctrl+Shift+A. Guarding it meant the app's own advertised shortcut did
      // nothing whenever the user was actually typing at an agent — which is
      // most of the time. Ctrl+W keeps its guard; closing a pane by accident is
      // a real cost, opening an overlay isn't.
      if (e.ctrlKey && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        useUI.getState().setAttentionOpen(!useUI.getState().attentionOpen);
        return;
      }
      // UI-156: Ctrl+Tab cycles workspaces most-recently-used first, like a
      // browser — Ctrl+1..9 is positional, this is "back to what I was on".
      if (e.ctrlKey && e.key === "Tab") {
        // UX-513: the file preview drawer owns Ctrl+Tab for cycling its own
        // tabs while it has focus, so don't also spin the workspace ring.
        if ((e.target as HTMLElement)?.closest?.(".prv-drawer")) return;
        e.preventDefault();
        const st = useApp.getState();
        if (st.workspaces.length < 2) return;
        const order = mruRef.current.filter((id) => st.workspaces.some((w) => w.id === id));
        const rest = st.workspaces.map((w) => w.id).filter((id) => !order.includes(id));
        const ring = [...order, ...rest];
        const cur = ring.indexOf(st.activeId ?? ring[0]);
        const next = ring[(cur + (e.shiftKey ? -1 : 1) + ring.length) % ring.length];
        st.switchWorkspace(next);
        return;
      }
      // UI-122: Ctrl+Alt+arrows walk pane focus. The grid is a wrapped flow
      // rather than a fixed matrix, so "spatial" here means next/previous in
      // grid order — which is what the eye follows anyway.
      if (e.ctrlKey && e.altKey && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        const st = useApp.getState();
        const ws = st.workspaces.find((w) => w.id === st.activeId);
        if (!ws || ws.panes.length < 2) return;
        e.preventDefault();
        const at = ws.panes.findIndex((p) => p.id === ws.focused);
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
        const next = ws.panes[(Math.max(0, at) + step + ws.panes.length) % ws.panes.length];
        if (next) st.focusPane(ws.id, next.id);
        return;
      }
      // UI-124: Alt+1..9 focuses pane N in the active workspace.
      if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const st = useApp.getState();
        const ws = st.workspaces.find((w) => w.id === st.activeId);
        const target = ws?.panes[parseInt(e.key, 10) - 1];
        if (ws && target) { e.preventDefault(); st.focusPane(ws.id, target.id); }
        return;
      }
      // UI-123: Ctrl+W closes the focused pane, Ctrl+Shift+W the workspace —
      // both go through the same live-session confirms as the buttons.
      if (e.ctrlKey && (e.key === "w" || e.key === "W")) {
        if ((e.target as HTMLElement)?.closest?.(".pbody")) return;
        // UX-513: let the preview drawer close its own active tab instead.
        if ((e.target as HTMLElement)?.closest?.(".prv-drawer")) return;
        e.preventDefault();
        const st = useApp.getState();
        const ws = st.workspaces.find((w) => w.id === st.activeId);
        if (!ws) return;
        if (e.shiftKey) { closeWorkspaceGuarded(ws); return; }
        const pane = ws.panes.find((p) => p.id === ws.focused);
        if (pane) closePaneGuarded(ws.id, pane);
        return;
      }
      if (e.ctrlKey && (e.key === "b" || e.key === "B")) {
        // Don't hijack Ctrl+B while the user is typing in a terminal — let the agent have it.
        if ((e.target as HTMLElement)?.closest?.(".pbody")) return;
        e.preventDefault();
        setExpanded((x) => !x);
      }
    };
    // CAPTURE phase. xterm stops propagation for keys it handles, so a
    // bubble-phase listener never sees anything while a terminal has focus —
    // which is the normal working state. Every app shortcut here (attention
    // queue, workspace switching, settings) was silently dead whenever the user
    // was actually typing at an agent. Individual shortcuts still yield to the
    // terminal where that's right: Ctrl+W and Ctrl+B check for .pbody below,
    // because closing a pane or stealing tmux's prefix by accident has a real
    // cost. Opening an overlay does not.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setSettingsOpen]);

  // UX-531: mouse buttons 4/5 (browser back/forward, MouseEvent.button 3/4)
  // drive the same back/forward stack as the preview drawer's buttons
  // (ui.ts's navBack/navForward — see HANDOFF EDITS for the toolbar itself).
  // A no-op when the stack is empty, so this is safe to leave listening
  // globally rather than scoping it to "Preview is open".
  useEffect(() => {
    const onAux = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) useUI.getState().navBack();
      else useUI.getState().navForward();
    };
    window.addEventListener("mouseup", onAux);
    return () => window.removeEventListener("mouseup", onAux);
  }, []);

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
          const all = wss.flatMap((w) => w.panes);
          const anyLive = all.some((p) => p.state === "running" || p.state === "starting" || p.state === "waiting" || p.state === "permission");
          if (!anyLive) return; // nothing live — close straight through
          e.preventDefault();
          // UI-195: itemise what's actually at stake instead of a flat count —
          // "3 running, 1 waiting on you" is a decision, "4 panes" is a shrug.
          const parts: string[] = [];
          const count = (st: string) => all.filter((p) => p.state === st).length;
          if (count("running")) parts.push(`${count("running")} running`);
          if (count("starting")) parts.push(`${count("starting")} still starting`);
          if (count("permission")) parts.push(`${count("permission")} waiting on your approval`);
          if (count("waiting")) parts.push(`${count("waiting")} idle-waiting`);
          const dirty = all.filter((p) => !!p.worktreePath).length;
          const worktreeNote = dirty > 0
            ? ` ${dirty} isolated worktree${dirty === 1 ? "" : "s"} stay on disk and reattach next launch.`
            : "";
          requestConfirm({
            title: "Quit Flightdeck?",
            body: `${parts.join(", ")}. Quitting ends those sessions — your workspaces reopen next launch, but running agents can't be brought back.${worktreeNote}`,
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
  // Canary keeps its product name in the title, or the two side-by-side
  // installs become indistinguishable in the taskbar (getName resolves
  // "Flightdeck" / "Flightdeck Canary" from the flavour's config).
  const [appName, setAppName] = useState("Flightdeck");
  useEffect(() => {
    getName().then((n) => setAppName(n)).catch(() => { /* browser preview */ });
  }, []);
  useEffect(() => {
    const bits = [appName];
    if (permissionCount > 0) bits.push(`${permissionCount} need${permissionCount === 1 ? "s" : ""} approval`);
    if (waitingCount > 0) bits.push(`${waitingCount} waiting`);
    if (errorCount > 0) bits.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
    try { void getCurrentWindow().setTitle(bits.join(" — ")); } catch { /* browser preview */ }
  }, [appName, waitingCount, permissionCount, errorCount]);

  return (
    <div className="cockpit-root">
      <div className="topbar">
        <button className="tb-toggle" onClick={() => setExpanded((e) => !e)} title="Toggle side panel (Ctrl+B)">
          <IconPanel size={17} />
        </button>
        <IconBrand size={18} className="brand-mark" />
        <span className="brand">Flightdeck</span>
        <span className="ws" title={view === "board" ? "Board" : active?.name}>{view === "board" ? "Board" : active?.name}</span>
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
      <CommandPalette />
      <QuickOpen />
      <Broadcast />
      <Review />
      <Preview />
      <AttentionQueue />
      <Shortcuts />
      {/* QL-764: resume/fork launcher. Owns its own open state and Ctrl+Shift+R
          listener, the same way CommandPalette and Shortcuts do. */}
      <SessionLauncher />
      <ZoomHud />

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
