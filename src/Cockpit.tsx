import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { lazyOverlay } from "./LazyOverlay";
import { useApp } from "./store";
import { LeftPanel } from "./LeftPanel";
import { PaneGrid } from "./PaneGrid";
import { IconBrand, IconPanel, IconSettings, IconFile, IconBroadcast, IconTerminalPlus, IconHome } from "./Icons";
import { useVendors, accentCss, vendorShort } from "./vendors";
import { ConfirmDialog } from "./ConfirmDialog";
import { ToastHost } from "./ToastHost";
import { Notifications } from "./Notifications";
import { CommandPalette } from "./CommandPalette";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { isSplitActive, GRID_MIN_PCT, PREVIEW_MIN_PCT, PREVIEW_MAX_PCT } from "./previewSplit";
import { ZoomHud } from "./ZoomHud";
import { useUI, useOverlayEsc, closeTopOverlay } from "./ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getName } from "@tauri-apps/api/app";
import { spawnPane, closePaneGuarded, closeWorkspaceGuarded } from "./worktrees";
import { isTypingTarget } from "./isTypingTarget";
import { attentionQueue, mostRecentOutputPane, needsHumanQueue } from "./attention";
import { homeKeyAllowed } from "./home";
import { isMainWindow } from "./persist";
import { otherWindows, quitApp } from "./windowBoot";
import { useAnnouncement } from "./windowAnnounce";
import { multiwindowEnabled, moveActiveWorkspaceToNewWindow, focusNextWindow, MOVE_WINDOW_CHORD, NEXT_WINDOW_CHORD } from "./windowActions";

// Rarely-opened panels are lazy chunks so they stay out of the first-paint
// bundle. Ones gated on store state mount only while that state is set; the
// three that own a global hotkey (QuickOpen, Shortcuts, SessionLauncher) mount
// at once but load off the critical path.
// Each gets its own Suspense + error boundary (LazyOverlay.tsx) so one failed
// chunk load can't take the root ErrorBoundary, and the terminals, down.
const Settings = lazyOverlay(() => import("./Settings"), "Settings", "Settings");
const Broadcast = lazyOverlay(() => import("./Broadcast"), "Broadcast", "Broadcast");
const Explorer = lazyOverlay(() => import("./Explorer"), "Explorer", "the file explorer");
const Review = lazyOverlay(() => import("./Review"), "Review", "Review");
const AttentionQueue = lazyOverlay(() => import("./AttentionQueue"), "AttentionQueue", "the attention queue");
const HomeOverlay = lazyOverlay(() => import("./HomeOverlay"), "HomeOverlay", "Home");
const Shortcuts = lazyOverlay(() => import("./Shortcuts"), "Shortcuts", "keyboard shortcuts");
const SessionLauncher = lazyOverlay(() => import("./SessionLauncher"), "SessionLauncher", "the session launcher");
const PreviewHost = lazyOverlay(() => import("./PreviewHost"), "PreviewHost", "the preview");
const QuickOpen = lazyOverlay(() => import("./QuickOpenOverlay"), "QuickOpen", "quick open");
// Own chunk: keeps the gauge out of the main bundle.
const QuotaGauge = lazy(() => import("./QuotaGauge"));
const WorkspaceChips = lazy(() => import("./WorkspaceChips"));

export function Cockpit() {
  const workspaces = useApp((s) => s.workspaces);
  const activeId = useApp((s) => s.activeId);
  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const vendors = useVendors((s) => s.vendors);
  const [addOpen, setAddOpen] = useState(false);
  // QR6: the add-pane menu is an overlay like any other: Escape (shared stack)
  // and a click outside close it, not only the mouse leaving it.
  const addRef = useRef<HTMLDivElement>(null);
  useOverlayEsc(addOpen, () => setAddOpen(false), { restoreFocus: false });
  useEffect(() => {
    if (!addOpen) return;
    const away = (e: MouseEvent) => { if (!addRef.current?.contains(e.target as Node)) setAddOpen(false); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [addOpen]);
  const splitActive = useUI((s) => isSplitActive(s.previewMode, s.previewTabs.length));
  // Read non-reactively: only the panel's initial size, so dragging (which
  // writes the store) must not re-render the cockpit on every pixel.
  const splitSize = useUI.getState().previewSplitSize;

  const [expanded, setExpanded] = useState(true);
  const showExplorer = useUI((s) => s.explorerOpen);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const reviewOpen = useUI((s) => s.reviewPaneId !== null);
  const attentionOpen = useUI((s) => s.attentionOpen);
  const homeOpen = useUI((s) => s.homeOpen);
  const hasPreview = useUI((s) => s.previewTabs.length > 0);
  const setShowExplorer = useUI((s) => s.setExplorerOpen);
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
      // Phase 5 Home: while it is open only its own chords, Ctrl+Shift+A, Ctrl+,
      // and zoom act here. Backtick, bare/Alt digits, Ctrl+Alt arrows, Ctrl+Tab,
      // Ctrl+W and Ctrl+B must not touch the panes behind the sheet.
      if (useUI.getState().homeOpen && !homeKeyAllowed(e)) return;
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
      // Phase 4 (flag: Multiple windows): Ctrl+Shift+N moves the active workspace to a
      // new window, Ctrl+Shift+O goes to the next window. Nothing else in the app or
      // the agent TUIs binds either, so like Ctrl+Shift+A they work from a terminal too.
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && multiwindowEnabled()) {
        const k = e.key.toLowerCase();
        if (k === MOVE_WINDOW_CHORD.key) { e.preventDefault(); void moveActiveWorkspaceToNewWindow(); return; }
        if (k === NEXT_WINDOW_CHORD.key) { e.preventDefault(); void focusNextWindow(); return; }
      }
      // Attention queue (UI-1 v2). Deliberately NOT skipped when a terminal has
      // focus: this is a global "what needs me" shortcut, and no agent TUI binds
      // Ctrl+Shift+A. Guarding it meant the app's own advertised shortcut did
      // nothing whenever the user was actually typing at an agent — which is
      // most of the time. Ctrl+W keeps its guard; closing a pane by accident is
      // a real cost, opening an overlay isn't.
      if (e.ctrlKey && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        // QRP11: Home is the one "who needs me" surface (peek, reply, Approve),
        // so the old attention-queue shortcut opens it.
        useUI.getState().setHomeOpen(!useUI.getState().homeOpen);
        return;
      }
      // Phase 5 Home: global like Ctrl+Shift+A above (no agent TUI binds the
      // Shift variant of Ctrl+H), so it works while a terminal has focus.
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "h" || e.key === "H")) {
        e.preventDefault();
        useUI.getState().setHomeOpen(!useUI.getState().homeOpen);
        return;
      }
      // QRP11: jump to the agent that needs you most (approvals first, then the
      // longest blocked). Global like Ctrl+Shift+A; no agent TUI binds it.
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        const top = needsHumanQueue(useApp.getState().workspaces, useUI.getState().snoozed)[0];
        if (!top) { useUI.getState().pushToast("info", "Nothing needs you right now."); return; }
        useUI.getState().setHomeOpen(false);
        useApp.getState().switchWorkspace(top.w.id);
        useApp.getState().focusPane(top.w.id, top.p.id);
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
    // Phase 4: a secondary's X belongs to Rust (flush, merge into main, destroy). A JS
    // close listener would destroy the window itself the moment it returned.
    if (!isMainWindow()) return;
    try {
      getCurrentWindow()
        .onCloseRequested(async (e) => {
          // Main closing quits every window; count their live panes too. Empty when
          // this is the only window, which keeps the single-window path as it was.
          const others = await otherWindows();
          const otherLive = others.reduce((n, w) => n + w.livePanes, 0);
          // Read live state at close time (not render time) — the listener is
          // registered once and must see the current panes.
          const wss = useApp.getState().workspaces;
          const all = wss.flatMap((w) => w.panes);
          const anyLive = all.some((p) => p.state === "running" || p.state === "starting" || p.state === "waiting" || p.state === "permission");
          if (!anyLive && otherLive === 0) {
            if (others.length === 0) return; // nothing live — close straight through
            e.preventDefault();
            void quitApp(); // other windows still hold slices to flush
            return;
          }
          e.preventDefault();
          // UI-195: itemise what's actually at stake instead of a flat count —
          // "3 running, 1 waiting on you" is a decision, "4 panes" is a shrug.
          const parts: string[] = [];
          const count = (st: string) => all.filter((p) => p.state === st).length;
          if (count("running")) parts.push(`${count("running")} running`);
          if (count("starting")) parts.push(`${count("starting")} still starting`);
          if (count("permission")) parts.push(`${count("permission")} waiting on your approval`);
          if (count("waiting")) parts.push(`${count("waiting")} idle-waiting`);
          if (otherLive) parts.push(`${otherLive} in other windows`);
          const dirty = all.filter((p) => !!p.worktreePath).length;
          const worktreeNote = dirty > 0
            ? ` ${dirty} isolated worktree${dirty === 1 ? "" : "s"} stay on disk and reattach next launch.`
            : "";
          requestConfirm({
            title: "Quit Flightdeck?",
            body: `${parts.join(", ")}. Quitting ends those sessions — your workspaces reopen next launch, but running agents can't be brought back.${worktreeNote}`,
            confirmLabel: "Quit & end sessions",
            danger: true,
            onConfirm: () => { if (others.length > 0) void quitApp(); else void getCurrentWindow().destroy(); },
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
  const announcement = useAnnouncement();
  const [appName, setAppName] = useState("Flightdeck");
  useEffect(() => {
    getName().then((n) => setAppName(n)).catch(() => { /* browser preview */ });
  }, []);
  // A secondary window is named after what it holds, so the taskbar tells windows apart.
  const wsNames = isMainWindow() ? "" : workspaces.map((w) => w.name).join(", ");
  useEffect(() => {
    const bits = [appName];
    if (wsNames) bits.push(wsNames);
    if (permissionCount > 0) bits.push(`${permissionCount} need${permissionCount === 1 ? "s" : ""} approval`);
    if (waitingCount > 0) bits.push(`${waitingCount} waiting`);
    if (errorCount > 0) bits.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
    try { void getCurrentWindow().setTitle(bits.join(" — ")); } catch { /* browser preview */ }
  }, [appName, wsNames, waitingCount, permissionCount, errorCount]);

  return (
    <div className="cockpit-root">
      <div className="topbar">
        <button className="tb-toggle" onClick={() => setExpanded((e) => !e)} title="Toggle side panel (Ctrl+B)">
          <IconPanel size={20} />
        </button>
        <IconBrand size={20} className="brand-mark" />
        <span className="brand">Flightdeck</span>
        {/* QRP3: the rail already shows the active workspace; the name here only
            earns its space when the rail is collapsed. Kept in the DOM (e2e reads it). */}
        <span className={"ws" + (expanded ? " ws-dup" : "")} title={active?.name}>{active?.name}</span>
        {active && (
          <div className="addpane-wrap" ref={addRef}>
            <button
              className={"tb-ic tb-labelled" + (addOpen ? " on" : "")}
              title="Add a pane to this workspace"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((o) => !o)}
            >
              <IconTerminalPlus size={20} /><span className="tb-lbl tb-lbl-keep">Pane</span>
            </button>
            {addOpen && (
              <div className="addpane-menu" role="menu">
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
        {active && <Suspense fallback={null}><WorkspaceChips workspace={active} /></Suspense>}
        <span className="sp" />
        <Suspense fallback={null}><QuotaGauge /></Suspense>
        <button
          className={"tb-ic tb-labelled" + (homeOpen ? " on" : "")}
          title="Home (Ctrl+Shift+H)"
          aria-label="Home"
          aria-pressed={homeOpen}
          onClick={() => useUI.getState().setHomeOpen(!homeOpen)}
        >
          <IconHome size={20} /><span className="tb-lbl">Home</span>
        </button>
        <Notifications />
        <button
          className={"tb-ic tb-labelled" + (showExplorer ? " on" : "")}
          title={
            !active
              ? "File explorer opens in the terminal view of a workspace"
              : "Toggle file explorer"
          }
          disabled={!active}
          onClick={() => setShowExplorer(!showExplorer)}
        >
          <IconFile size={20} /><span className="tb-lbl">Files</span>
        </button>
        <button
          className={"tb-ic tb-labelled" + (broadcastOpen ? " on" : "")}
          title="Broadcast to panes"
          onClick={() => setBroadcastOpen(!broadcastOpen)}
        >
          <IconBroadcast size={20} /><span className="tb-lbl">Broadcast</span>
        </button>
        {/* QRP3: the light/dark flip moved to Settings > Appearance and the palette ("Toggle light / dark"). */}
        <button className="tb-ic tb-labelled" title={updateAvailable ? `Settings (Ctrl+,) — Flightdeck ${updateAvailable.version} available` : "Settings (Ctrl+,)"} onClick={() => setSettingsOpen(true)}>
          <IconSettings size={20} /><span className="tb-lbl">Settings</span>
          {updateAvailable && <span className="tb-update-dot" />}
        </button>
      </div>

      <ConfirmDialog />
      <ToastHost />
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      <CommandPalette />
      {settingsOpen && <Settings />}
      <QuickOpen />
      {broadcastOpen && <Broadcast />}
      {reviewOpen && <Review />}
      {!splitActive && hasPreview && <PreviewHost mode="drawer" />}
      {attentionOpen && <AttentionQueue />}
      {homeOpen && <HomeOverlay />}
      <Shortcuts />
      {/* QL-764: resume/fork launcher. Owns its own open state and Ctrl+Shift+R
          listener, the same way CommandPalette and Shortcuts do. */}
      <SessionLauncher />
      <ZoomHud />

      <div className="cockpit">
        <LeftPanel expanded={expanded} />
        {showExplorer && active && (
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
          {/* QL-708: the PanelGroup is ALWAYS rendered (one grid panel); only the
              preview panel + divider come and go. That keeps the wsstack at a
              fixed spot in the tree, so toggling the split never remounts the
              PaneGrids (and so never touches the live terminals). */}
          <PanelGroup direction="horizontal">
            <Panel id="split-grid" order={0} minSize={GRID_MIN_PCT} className="split-main">
              <div className="wsstack" style={{ display: "flex" }}>
                {workspaces.map((w) => (
                  <div className="wsgrid" style={{ display: w.id === activeId ? "flex" : "none" }} key={w.id}>
                    <PaneGrid ws={w} />
                  </div>
                ))}
              </div>
            </Panel>
            {splitActive && (
              <>
                <PanelResizeHandle className="rz rz-h" />
                <Panel
                  id="split-preview"
                  order={1}
                  defaultSize={splitSize}
                  minSize={PREVIEW_MIN_PCT}
                  maxSize={PREVIEW_MAX_PCT}
                  className="split-preview"
                  onResize={(size) => {
                    if (Math.abs(size - useUI.getState().previewSplitSize) >= 0.5) useUI.getState().setPreviewSplitSize(size);
                  }}
                >
                  <PreviewHost mode="split" />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </div>
    </div>
  );
}
