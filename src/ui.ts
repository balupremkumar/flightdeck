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
}
export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

// One entry per pane-state transition that matched the configured bell rules.
export interface NotifyEvent {
  id: number;
  wsId: number;
  wsName: string;
  paneId: number;
  vendor: string;
  state: PaneState;
  at: number; // epoch ms
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

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  notify: NotifySettings;
  setNotifyOn: (state: PaneState, on: boolean) => void;
  setNotifySound: (on: boolean) => void;
  setNotifyOsToast: (on: boolean) => void;
  setNotifyDnd: (on: boolean) => void;
  toggleMuteWorkspace: (wsId: number) => void;

  feed: NotifyEvent[];
  pushNotifyEvent: (e: Omit<NotifyEvent, "id" | "at">) => void;
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

  // Review drawer (worktree diff/merge surface): pane id being reviewed, or
  // null when closed. Store-level so the pane header, command palette, and
  // future board cards can all open it.
  reviewPaneId: number | null;
  setReviewPane: (paneId: number | null) => void;

  broadcasts: BroadcastRecord[];
  pushBroadcastRecord: (r: Omit<BroadcastRecord, "id" | "at">) => void;
}

let tseq = 0;
let nseq = 0;
let bseq = 0;

const NOTIFY_KEY = "flightdeck-notify-settings";

function defaultNotifySettings(): NotifySettings {
  return {
    notifyOn: { starting: false, running: false, idle: false, waiting: true, permission: true, error: true },
    sound: false,
    osToast: true,
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
    return { ...fallback, ...parsed, notifyOn: { ...fallback.notifyOn, ...(parsed.notifyOn ?? {}) } };
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

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

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
  pushNotifyEvent: (e) => set((s) => ({ feed: [{ ...e, id: ++nseq, at: Date.now() }, ...s.feed].slice(0, 50) })),
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

  reviewPaneId: null,
  setReviewPane: (reviewPaneId) => set({ reviewPaneId }),

  broadcasts: [],
  pushBroadcastRecord: (r) =>
    set((s) => ({ broadcasts: [{ ...r, id: ++bseq, at: Date.now() }, ...s.broadcasts].slice(0, 20) })),
}));

// Persisted UI scale (whole-app zoom). Applied on boot and from Settings.
export function applyUiScale(scale: string) {
  document.documentElement.style.zoom = scale;
  try { localStorage.setItem("flightdeck-uiscale", scale); } catch { /* non-persistent */ }
  // Nudge xterm's fit addon (ResizeObserver) so terminals re-measure at the new scale.
  window.dispatchEvent(new Event("resize"));
}

export function setTheme(mode: "dark" | "light") {
  const el = document.documentElement;
  if (mode === "light") el.setAttribute("data-theme", "light");
  else el.removeAttribute("data-theme");
  try { localStorage.setItem("flightdeck-theme", mode); } catch { /* non-persistent */ }
}
