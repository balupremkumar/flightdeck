import { create } from "zustand";
import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PaneState } from "./store";

// Lightweight UI-only store (kept separate from the app/domain store): confirm
// dialogs, transient toasts, the settings-modal flag, and notification prefs/feed.
export interface ConfirmReq {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  /** Runs on every non-confirm exit (Cancel, Esc, scrim). Callers awaiting an
   *  answer must supply this or they hang on dismissal. */
  onCancel?: () => void;
}
export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  /** UX-578: an optional link the toast can offer (e.g. the merge commit on
   *  a host). Opened via plugin-opener's openUrl, never auto-navigated. */
  url?: string;
  /** UX-591: an optional longer detail string, hidden by default and
   *  revealed by an expand affordance — the full pane-error text instead of
   *  a truncated one-liner. */
  detail?: string;
}

// Local-file self-update (updater.ts / Rust updates.rs): mirrors the last
// successful check_update() result so the topbar gear dot and Settings >
// About agree with whatever triggered the check (startup, the palette, or
// the Settings button itself), rather than each tracking its own copy.
export interface UpdateInfo {
  version: string;
  notes: string;
  installerPath: string;
}

// UX-505/513: one open tab in the file preview drawer.
export interface PreviewTab {
  id: number;
  path: string;
  /** 1-based line to scroll to on open — carried over from a terminal
   *  path:line[:col] match. */
  line?: number;
  /** Font-size (px) inherited from the pane that opened it (UX-510) so the
   *  preview visually matches the terminal zoom it was opened from. */
  fontSize?: number;
}

// One entry per pane-state transition that matched the configured bell rules.
// Repeats of the same pane+state within COLLAPSE_WINDOW_MS bump `repeats` and
// refresh `at` in place instead of pushing a new row (owner feedback: a pane
// flapping waiting/running must not spam the feed).
export interface NotifyEvent {
  id: number;
  wsId: number;
  wsName: string;
  paneId: number;
  vendor: string;
  /** Pane's own title if renamed — lets a feed row name the SPECIFIC pane,
   *  not just its vendor (two same-vendor panes in a workspace need this). */
  title?: string;
  state: PaneState;
  at: number; // epoch ms
  repeats: number;
}

// A lightweight record of a completed broadcast send, so the composer (and
// later, a feed view) can show "last sent 2m ago to 4 panes" without redoing
// the send logic. Capped at 20, newest first.
export interface BroadcastRecord {
  id: number;
  text: string;
  sentTo: number;
  failed: number;
  at: number; // epoch ms
}

export interface NotifySettings {
  notifyOn: Record<PaneState, boolean>;
  sound: boolean;
  osToast: boolean;
  /** Per-state OS-toast gate, layered under the master `osToast` switch above.
   *  Owner feedback: a waiting pane is normal traffic and shouldn't pop a
   *  toast by default, but an approval prompt or an error should. Existing
   *  saved settings that predate this field fall back to these defaults via
   *  loadNotifySettings' merge, so nobody's prefs silently change underneath
   *  them. */
  osToastOn: Record<PaneState, boolean>;
  dnd: boolean;
  mutedWorkspaces: number[];
}

interface UIState {
  confirm: ConfirmReq | null;
  requestConfirm: (r: ConfirmReq) => void;
  dismissConfirm: () => void;

  toasts: Toast[];
  pushToast: (kind: Toast["kind"], text: string, opts?: { url?: string; detail?: string }) => void;
  dismissToast: (id: number) => void;

  updateAvailable: UpdateInfo | null;
  setUpdateAvailable: (info: UpdateInfo | null) => void;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** UI-181: a section name to jump to when Settings opens. Consumed (and
   *  cleared) by Settings itself, so it can't stick across opens. */
  settingsJumpTo: string | null;
  openSettingsAt: (section: string) => void;
  clearSettingsJump: () => void;

  notify: NotifySettings;
  setNotifyOn: (state: PaneState, on: boolean) => void;
  setNotifySound: (on: boolean) => void;
  setNotifyOsToast: (on: boolean) => void;
  setOsToastOn: (state: PaneState, on: boolean) => void;
  setNotifyDnd: (on: boolean) => void;
  toggleMuteWorkspace: (wsId: number) => void;

  feed: NotifyEvent[];
  pushNotifyEvent: (e: Omit<NotifyEvent, "id" | "at" | "repeats">) => void;
  clearFeed: () => void;

  // Which main surface is showing. Lives here (not as Cockpit-local state) so
  // the command palette / notifications can switch back to the terminal grid.
  activeView: "terminals" | "board";
  setActiveView: (v: "terminals" | "board") => void;

  // Explorer + Broadcast visibility, store-level so the command palette and
  // top bar can both drive them. Explorer open state persists across launches.
  explorerOpen: boolean;
  setExplorerOpen: (open: boolean) => void;
  broadcastOpen: boolean;
  setBroadcastOpen: (open: boolean) => void;
  // Standalone attention-queue overlay (UI-1 v2).
  attentionOpen: boolean;
  setAttentionOpen: (open: boolean) => void;
  // UI-145: which pane (if any) is maximised. Owned by PaneGrid, mirrored here
  // so Notifications can treat focus mode as do-not-disturb.
  maximizedPaneId: number | null;
  setMaximizedPaneId: (id: number | null) => void;
  // UI-143: panes snoozed out of the attention queue until a timestamp.
  // UI-146/200: opt-in attention behaviours, off by default — an app that
  // grabs focus or opens overlays uninvited is worse than one that doesn't.
  autoQueue: boolean;
  setAutoQueue: (on: boolean) => void;
  followAttention: boolean;
  setFollowAttention: (on: boolean) => void;
  snoozed: Record<number, number>;
  snoozePane: (paneId: number, ms: number) => void;
  unsnoozePane: (paneId: number) => void;

  // Review drawer (worktree diff/merge surface): pane id being reviewed, or
  // null when closed. Store-level so the pane header, command palette, and
  // future board cards can all open it.
  reviewPaneId: number | null;
  setReviewPane: (paneId: number | null) => void;

  // File preview drawer (UX-505/513): read-only tabs opened by clicking a
  // linkified path in a terminal. Store-level for the same reason as the
  // review drawer above — Terminal.tsx (any pane) opens it, Preview.tsx
  // renders it. Multiple files stay open as tabs; Ctrl+Tab/Ctrl+W cycle and
  // close (registered by Preview itself, only while it has focus).
  previewTabs: PreviewTab[];
  activePreviewId: number | null;
  /** Opens `path` as a tab (or refocuses/updates it if already open). Also
   *  records the path into the back/forward nav stack (UX-531) unless the
   *  caller is the stack itself replaying a step — see navBack/navForward. */
  openPreview: (path: string, opts?: { line?: number; fontSize?: number; skipHistory?: boolean }) => void;
  closePreview: (id: number) => void;
  /** Dismisses the whole drawer (every tab) — Esc / clicking the scrim. */
  closeAllPreviews: () => void;
  setActivePreview: (id: number) => void;
  /** Ctrl+Tab / Ctrl+Shift+Tab among open preview tabs. */
  cyclePreview: (dir: 1 | -1) => void;

  // UX-531: browser-style back/forward across every path opened in the
  // preview drawer (terminal clicks, markdown links, Explorer — once wired,
  // see HANDOFF). `navHistory`/`navIndex` are exposed directly (rather than
  // derived canGoBack/canGoForward booleans) so a consumer can also show
  // "3 of 7" if it wants to; see navCanGoBack/navCanGoForward below for the
  // common case.
  navHistory: string[];
  navIndex: number;
  navBack: () => void;
  navForward: () => void;

  broadcasts: BroadcastRecord[];
  pushBroadcastRecord: (r: Omit<BroadcastRecord, "id" | "at">) => void;

  // UX-552: a saved-snippet id chosen from the command palette, waiting for
  // Broadcast to pick it up the moment it (re)opens — the palette can't fill
  // a placeholder itself since the snippet-insert UI lives in Broadcast.
  // Cleared by Broadcast once consumed, so it never re-fires on a later open.
  pendingSnippetId: string | null;
  setPendingSnippet: (id: string | null) => void;

  // Whole-app zoom (owner feedback item 3): one numeric value, persisted and
  // applied at boot (main.tsx), driven by both Settings > UI size and the
  // Ctrl+=/-/0 shortcut so the two can never disagree.
  uiZoom: number;
  setUiZoom: (z: number) => void;
  stepUiZoom: (dir: 1 | -1) => void;
  resetUiZoom: () => void;
  /** Transient HUD chip ("110%") shown for ~800ms after a zoom change. `id`
   *  lets the HUD component restart its hide-timer on every change even when
   *  the value repeats (e.g. hitting the top step twice in a row). */
  zoomHud: { value: number; id: number } | null;
}

let tseq = 0;
let nseq = 0;
let bseq = 0;
let pseq = 0;

const NOTIFY_KEY = "flightdeck-notify-settings";
const FEED_COLLAPSE_WINDOW_MS = 5 * 60_000;

function defaultNotifySettings(): NotifySettings {
  return {
    notifyOn: { starting: false, running: false, idle: false, waiting: true, permission: true, error: true },
    sound: false,
    osToast: true,
    // UX-601: the `waiting` key now only ever reaches an alert as a genuine
    // question — attention.ts gates plain quiet out before the toast path — so
    // it defaults ON. Under the old meaning ("a pane stopped printing") it had
    // to be off, which is exactly the noise this ruling removed.
    osToastOn: { starting: false, running: false, idle: false, waiting: true, permission: true, error: true },
    dnd: false,
    mutedWorkspaces: [],
  };
}

function loadNotifySettings(): NotifySettings {
  const fallback = defaultNotifySettings();
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<NotifySettings>;
    return {
      ...fallback,
      ...parsed,
      notifyOn: { ...fallback.notifyOn, ...(parsed.notifyOn ?? {}) },
      osToastOn: { ...fallback.osToastOn, ...(parsed.osToastOn ?? {}) },
    };
  } catch {
    return fallback;
  }
}

function saveNotifySettings(s: NotifySettings) {
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(s)); } catch { /* non-persistent */ }
}

export const useUI = create<UIState>((set, get) => ({
  confirm: null,
  requestConfirm: (r) => set({ confirm: r }),
  dismissConfirm: () => set({ confirm: null }),

  toasts: [],
  pushToast: (kind, text, opts) =>
    set((s) => ({ toasts: [...s.toasts, { id: ++tseq, kind, text, url: opts?.url, detail: opts?.detail }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  updateAvailable: null,
  setUpdateAvailable: (updateAvailable) => set({ updateAvailable }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  settingsJumpTo: null,
  openSettingsAt: (section) => set({ settingsOpen: true, settingsJumpTo: section }),
  clearSettingsJump: () => set({ settingsJumpTo: null }),

  notify: loadNotifySettings(),
  setNotifyOn: (state, on) =>
    set((s) => {
      const notify = { ...s.notify, notifyOn: { ...s.notify.notifyOn, [state]: on } };
      saveNotifySettings(notify);
      return { notify };
    }),
  setNotifySound: (on) =>
    set((s) => { const notify = { ...s.notify, sound: on }; saveNotifySettings(notify); return { notify }; }),
  setNotifyOsToast: (on) =>
    set((s) => { const notify = { ...s.notify, osToast: on }; saveNotifySettings(notify); return { notify }; }),
  setOsToastOn: (state, on) =>
    set((s) => {
      const notify = { ...s.notify, osToastOn: { ...s.notify.osToastOn, [state]: on } };
      saveNotifySettings(notify);
      return { notify };
    }),
  setNotifyDnd: (on) =>
    set((s) => { const notify = { ...s.notify, dnd: on }; saveNotifySettings(notify); return { notify }; }),
  toggleMuteWorkspace: (wsId) =>
    set((s) => {
      const muted = s.notify.mutedWorkspaces.includes(wsId)
        ? s.notify.mutedWorkspaces.filter((id) => id !== wsId)
        : [...s.notify.mutedWorkspaces, wsId];
      const notify = { ...s.notify, mutedWorkspaces: muted };
      saveNotifySettings(notify);
      return { notify };
    }),

  feed: [],
  // UI-144 (owner feedback, moved from render-time grouping to source-of-
  // truth): a repeat of the same pane+state within COLLAPSE_WINDOW_MS bumps
  // the existing top-of-feed entry's `repeats` and refreshes `at`, rather
  // than pushing a new row. Grouping this at push time (not display time)
  // means a flapping pane can no longer push genuinely different events out
  // of the 50-entry cap by spamming repeats of itself.
  pushNotifyEvent: (e) =>
    set((s) => {
      const now = Date.now();
      const top = s.feed[0];
      if (top && top.paneId === e.paneId && top.state === e.state && now - top.at < FEED_COLLAPSE_WINDOW_MS) {
        return { feed: [{ ...top, ...e, id: top.id, repeats: top.repeats + 1, at: now }, ...s.feed.slice(1)] };
      }
      return { feed: [{ ...e, id: ++nseq, at: now, repeats: 1 }, ...s.feed].slice(0, 50) };
    }),
  clearFeed: () => set({ feed: [] }),

  activeView: "terminals",
  setActiveView: (activeView) => set({ activeView }),

  explorerOpen: (() => {
    try { return localStorage.getItem("flightdeck-explorer-open") === "1"; } catch { return false; }
  })(),
  setExplorerOpen: (explorerOpen) => {
    try { localStorage.setItem("flightdeck-explorer-open", explorerOpen ? "1" : "0"); } catch { /* non-persistent */ }
    set({ explorerOpen });
  },
  broadcastOpen: false,
  setBroadcastOpen: (broadcastOpen) => set({ broadcastOpen }),
  attentionOpen: false,
  setAttentionOpen: (attentionOpen) => set({ attentionOpen }),
  maximizedPaneId: null,
  setMaximizedPaneId: (maximizedPaneId) => set({ maximizedPaneId }),
  autoQueue: (() => { try { return localStorage.getItem("flightdeck-auto-queue") === "1"; } catch { return false; } })(),
  setAutoQueue: (on) => {
    try { localStorage.setItem("flightdeck-auto-queue", on ? "1" : "0"); } catch { /* non-persistent */ }
    set({ autoQueue: on });
  },
  followAttention: (() => { try { return localStorage.getItem("flightdeck-follow-attention") === "1"; } catch { return false; } })(),
  setFollowAttention: (on) => {
    try { localStorage.setItem("flightdeck-follow-attention", on ? "1" : "0"); } catch { /* non-persistent */ }
    set({ followAttention: on });
  },
  snoozed: {},
  snoozePane: (paneId, ms) => set((s) => ({ snoozed: { ...s.snoozed, [paneId]: Date.now() + ms } })),
  unsnoozePane: (paneId) => set((s) => {
    const next = { ...s.snoozed };
    delete next[paneId];
    return { snoozed: next };
  }),

  reviewPaneId: null,
  setReviewPane: (reviewPaneId) => set({ reviewPaneId }),

  previewTabs: [],
  activePreviewId: null,
  openPreview: (path, opts) =>
    set((s) => {
      // UX-531: record into the back/forward stack. A step that's just
      // replaying history (navBack/navForward calling openPreview themselves)
      // sets skipHistory so it doesn't push a duplicate entry or truncate the
      // forward branch it's walking back into.
      const nav = opts?.skipHistory ? { navHistory: s.navHistory, navIndex: s.navIndex } : navPush(s.navHistory, s.navIndex, path);
      const existing = s.previewTabs.find((t) => t.path === path);
      if (existing) {
        const updated = { ...existing, line: opts?.line ?? existing.line, fontSize: opts?.fontSize ?? existing.fontSize };
        return {
          previewTabs: s.previewTabs.map((t) => (t.id === existing.id ? updated : t)),
          activePreviewId: existing.id,
          ...nav,
        };
      }
      const tab: PreviewTab = { id: ++pseq, path, line: opts?.line, fontSize: opts?.fontSize };
      return { previewTabs: [...s.previewTabs, tab], activePreviewId: tab.id, ...nav };
    }),
  closePreview: (id) =>
    set((s) => {
      const idx = s.previewTabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const previewTabs = s.previewTabs.filter((t) => t.id !== id);
      let activePreviewId = s.activePreviewId;
      if (activePreviewId === id) {
        const next = previewTabs[idx] ?? previewTabs[idx - 1];
        activePreviewId = next ? next.id : null;
      }
      return { previewTabs, activePreviewId };
    }),
  closeAllPreviews: () => set({ previewTabs: [], activePreviewId: null }),
  setActivePreview: (id) => set({ activePreviewId: id }),
  cyclePreview: (dir) =>
    set((s) => {
      if (s.previewTabs.length < 2) return s;
      const idx = s.previewTabs.findIndex((t) => t.id === s.activePreviewId);
      const next = (idx + dir + s.previewTabs.length) % s.previewTabs.length;
      return { activePreviewId: s.previewTabs[next].id };
    }),

  navHistory: [],
  navIndex: -1,
  navBack: () => {
    const s = get();
    const r = navStep(s.navHistory, s.navIndex, -1);
    if (r.path == null) return;
    set({ navIndex: r.index });
    get().openPreview(r.path, { skipHistory: true });
  },
  navForward: () => {
    const s = get();
    const r = navStep(s.navHistory, s.navIndex, 1);
    if (r.path == null) return;
    set({ navIndex: r.index });
    get().openPreview(r.path, { skipHistory: true });
  },

  broadcasts: [],
  pushBroadcastRecord: (r) =>
    set((s) => ({ broadcasts: [{ ...r, id: ++bseq, at: Date.now() }, ...s.broadcasts].slice(0, 20) })),

  pendingSnippetId: null,
  setPendingSnippet: (id) => set({ pendingSnippetId: id }),

  uiZoom: loadUiZoom(),
  setUiZoom: (z) => set(() => { applyUiScale(z); return { uiZoom: z }; }),
  stepUiZoom: (dir) =>
    set((s) => {
      const next = nextZoomStep(s.uiZoom, dir);
      applyUiScale(next);
      return { uiZoom: next, zoomHud: { value: next, id: ++zseq } };
    }),
  resetUiZoom: () =>
    set(() => {
      applyUiScale(1);
      return { uiZoom: 1, zoomHud: { value: 1, id: ++zseq } };
    }),
  zoomHud: null,
}));

// ---------------------------------------------------------------------
// Whole-app zoom (owner feedback item 3). One mechanism, two entry points:
// the Settings > UI size stepper and the Ctrl+=/-/0 shortcut (Cockpit.tsx,
// capture phase). Both go through setUiZoom/stepUiZoom/resetUiZoom above so
// they can never drift out of sync with each other.
// ---------------------------------------------------------------------
export const ZOOM_STEPS = [0.85, 0.95, 1, 1.1, 1.2, 1.35, 1.5];
let zseq = 0;

function loadUiZoom(): number {
  try {
    const raw = localStorage.getItem("flightdeck-uiscale");
    const n = raw ? parseFloat(raw) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

/** Steps from `current` to the next/previous entry in ZOOM_STEPS. If `current`
 *  isn't exactly on a step (an old 1.12/1.25 "Comfortable/Large" value, or a
 *  hand-edited localStorage value), moves to the nearest step in the
 *  requested direction rather than jumping to the closest step overall — a
 *  press of Ctrl+- must always get smaller, never accidentally larger.
 *  Exported (only) so ui.test.ts can exercise the stepping algorithm without
 *  going through applyUiScale, which touches `document`/`window` and so
 *  needs a real DOM — this project's vitest runs in plain Node, no jsdom. */
export function nextZoomStep(current: number, dir: 1 | -1): number {
  const exact = ZOOM_STEPS.findIndex((v) => Math.abs(v - current) < 0.001);
  if (exact !== -1) {
    return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, exact + dir))];
  }
  const candidates = dir === 1 ? ZOOM_STEPS.filter((v) => v > current) : ZOOM_STEPS.filter((v) => v < current);
  if (candidates.length) return dir === 1 ? Math.min(...candidates) : Math.max(...candidates);
  return current; // already past every step in that direction
}

// Persisted UI scale (whole-app zoom). Applied on boot (main.tsx) and from
// Settings / the Ctrl+=/-/0 shortcut via the store actions above.
//
// Native webview zoom, NOT CSS `zoom` on <html>. xterm hit-tests mouse events
// itself — (clientX − rect.left) ÷ measured cell size — and under CSS zoom the
// pixel distance is scaled while the cell measurement is not, so clicks land
// 1-2+ rows away from the cursor, drifting worse toward the bottom of the
// terminal (repro: any zoom ≠ 1, any DPR). Native zoom is what the browser's
// own Ctrl+= does; coordinates stay consistent for everything, terminals
// included. getCurrentWebview() throws *synchronously* outside Tauri (the
// LeftPanel/NewWorkspace trap), and setZoom rejects if the capability is
// missing — both fall back to CSS zoom so the browser rigs still scale.
export function applyUiScale(scale: number) {
  const cssFallback = () => { document.documentElement.style.zoom = scale === 1 ? "" : String(scale); };
  try {
    getCurrentWebview().setZoom(scale)
      // An older run's fallback (or a pre-fix build) may have left CSS zoom
      // behind; clear it or the two would multiply.
      .then(() => { document.documentElement.style.zoom = ""; })
      .catch(cssFallback);
  } catch {
    cssFallback();
  }
  try { localStorage.setItem("flightdeck-uiscale", String(scale)); } catch { /* non-persistent */ }
  // Nudge xterm's fit addon (ResizeObserver) so terminals re-measure at the new scale.
  window.dispatchEvent(new Event("resize"));
}

// ---------------------------------------------------------------------
// UX-531: back/forward navigation stack (currently drives the preview
// drawer via openPreview/navBack/navForward above; Explorer selection can
// join the same stack — see HANDOFF). Pure and exported so the ordering
// rules are directly testable without touching the store.
// ---------------------------------------------------------------------

/** Pushes `path` onto the stack at `index`. Re-visiting the CURRENT entry is
 *  a no-op (clicking the same link twice shouldn't grow the stack). Opening
 *  a new path while sitting mid-history drops everything ahead of it — the
 *  same rule every browser's address bar follows. */
export function navPush(history: string[], index: number, path: string): { navHistory: string[]; navIndex: number } {
  if (index >= 0 && history[index] === path) return { navHistory: history, navIndex: index };
  const truncated = history.slice(0, index + 1);
  const next = [...truncated, path];
  return { navHistory: next, navIndex: next.length - 1 };
}

/** One step back (`dir` -1) or forward (`dir` 1). `path` is null at either
 *  end of the stack — the caller (ui.ts's navBack/navForward) no-ops then. */
export function navStep(history: string[], index: number, dir: 1 | -1): { index: number; path: string | null } {
  const next = index + dir;
  if (next < 0 || next >= history.length) return { index, path: null };
  return { index: next, path: history[next] };
}

// ---------------------------------------------------------------------
// UX-542/543: one overlay stack for every dismissible overlay in the app.
// Each overlay registers its close handler while open via useOverlayEsc
// below, instead of installing its own capture-phase Escape listener (the
// old per-overlay pattern — the real bug it caused: with N overlays open,
// Esc fired all N listeners at once, closing more than the top one). A
// single shared listener (installed once, see Cockpit.tsx's shared keydown
// handler calling closeTopOverlay()) closes ONLY the most-recently-opened
// overlay. Closing it — by Esc, a scrim click, a Cancel button, anything —
// also restores focus to wherever it was before the overlay opened
// (UX-543), because that's a property of the REGISTRATION, not of Esc
// specifically.
//
// The stack itself is plain module state (not zustand) so push/pop/close
// are synchronous and don't fight React's render cycle; useOverlayEsc is
// the only DOM/React-touching part, kept thin on purpose so the ordering
// logic below is directly unit-testable without jsdom.
// ---------------------------------------------------------------------
interface OverlayHandle { id: number; close: () => void; }
let overlaySeq = 0;
const overlayStack: OverlayHandle[] = [];

/** Registers `close` at the top of the stack. Returns an id — pass it to
 *  popOverlay in a cleanup effect (not only "on Esc"): an overlay can also
 *  close via a scrim click or a Cancel button and must not linger
 *  registered, or a later Esc press would close the wrong (already-gone)
 *  overlay. */
export function pushOverlay(close: () => void): number {
  const id = ++overlaySeq;
  overlayStack.push({ id, close });
  return id;
}
export function popOverlay(id: number) {
  const i = overlayStack.findIndex((o) => o.id === id);
  if (i !== -1) overlayStack.splice(i, 1);
}
/** Closes exactly the top-most registered overlay. Pops it off the stack
 *  IMMEDIATELY (synchronously), rather than waiting for the overlay's own
 *  close() to eventually trigger its cleanup effect's popOverlay — React's
 *  effect cleanup runs on the next commit, not inline, so two Escape
 *  presses (or, as in ui.test.ts, two synchronous closeTopOverlay calls)
 *  arriving before that commit would otherwise both hit the same top entry.
 *  The overlay's own cleanup-effect popOverlay call becomes a safe no-op
 *  once this has already removed it (popOverlay no-ops on an unknown id).
 *  Returns true if it closed something (the caller — Cockpit's shared
 *  Escape handler — only preventDefault()s in that case, so Esc still
 *  reaches ordinary form fields/inputs when no overlay is open). */
export function closeTopOverlay(): boolean {
  const top = overlayStack.pop();
  if (!top) return false;
  top.close();
  return true;
}
export function overlayStackDepth(): number {
  return overlayStack.length;
}
/** Test-only: the stack is module-level singleton state, so tests must reset
 *  it between cases the same way ui.test.ts resets zustand slices. */
export function __resetOverlayStackForTests() {
  overlayStack.length = 0;
  overlaySeq = 0;
}

/** Registers `onClose` as the active overlay's Esc/focus-return handler
 *  while `open` is true. Drop this into any dismissible overlay in place of
 *  its own `window.addEventListener("keydown", ...)` Escape effect — see
 *  HANDOFF EDITS for the exact swap in each overlay this session didn't own.
 *  `restoreFocus: false` opts an overlay out of the focus-return step (a
 *  transient dropdown whose trigger button already holds focus by the time
 *  it closes doesn't need it). */
export function useOverlayEsc(open: boolean, onClose: () => void, opts?: { restoreFocus?: boolean }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const restoreFocus = opts?.restoreFocus !== false;

  useEffect(() => {
    if (!open) return;
    const returnEl = (typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
    const id = pushOverlay(() => closeRef.current());
    return () => {
      popOverlay(id);
      if (restoreFocus && returnEl && document.contains(returnEl)) {
        // Deferred a frame: the overlay's own unmount hasn't necessarily
        // committed yet, and focusing too early can be stolen back by
        // React's reconciliation of whatever's replacing it.
        requestAnimationFrame(() => returnEl.focus());
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export function setTheme(mode: "dark" | "light") {
  const el = document.documentElement;
  if (mode === "light") el.setAttribute("data-theme", "light");
  else el.removeAttribute("data-theme");
  try { localStorage.setItem("flightdeck-theme", mode); } catch { /* non-persistent */ }
}
