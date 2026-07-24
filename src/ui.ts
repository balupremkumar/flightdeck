import { create } from "zustand";
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
  pushToast: (kind: Toast["kind"], text: string) => void;
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

  broadcasts: BroadcastRecord[];
  pushBroadcastRecord: (r: Omit<BroadcastRecord, "id" | "at">) => void;

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

const NOTIFY_KEY = "flightdeck-notify-settings";
const FEED_COLLAPSE_WINDOW_MS = 5 * 60_000;

function defaultNotifySettings(): NotifySettings {
  return {
    notifyOn: { starting: false, running: false, idle: false, waiting: true, permission: true, error: true },
    sound: false,
    osToast: true,
    // Owner feedback: waiting is routine, approval/error are not — toast
    // defaults follow that split even though the bell/feed ring for all three.
    osToastOn: { starting: false, running: false, idle: false, waiting: false, permission: true, error: true },
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

export const useUI = create<UIState>((set) => ({
  confirm: null,
  requestConfirm: (r) => set({ confirm: r }),
  dismissConfirm: () => set({ confirm: null }),

  toasts: [],
  pushToast: (kind, text) => set((s) => ({ toasts: [...s.toasts, { id: ++tseq, kind, text }] })),
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

  broadcasts: [],
  pushBroadcastRecord: (r) =>
    set((s) => ({ broadcasts: [{ ...r, id: ++bseq, at: Date.now() }, ...s.broadcasts].slice(0, 20) })),

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
export function applyUiScale(scale: number) {
  document.documentElement.style.zoom = String(scale);
  try { localStorage.setItem("flightdeck-uiscale", String(scale)); } catch { /* non-persistent */ }
  // Nudge xterm's fit addon (ResizeObserver) so terminals re-measure at the new scale.
  window.dispatchEvent(new Event("resize"));
}

export function setTheme(mode: "dark" | "light") {
  const el = document.documentElement;
  if (mode === "light") el.setAttribute("data-theme", "light");
  else el.removeAttribute("data-theme");
  try { localStorage.setItem("flightdeck-theme", mode); } catch { /* non-persistent */ }
}
