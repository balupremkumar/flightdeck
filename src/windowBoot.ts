import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getMultiwindow } from "./settingsStore";
import { setWindowOrdinal, useApp, type Workspace } from "./store";
import { useUI } from "./ui";
import { isMainWindow, type SessionDraft } from "./persist";
import { addRestoredUiPrefs, hydrateFrom, parseUiPrefs } from "./session";
import { markRestoredPane } from "./ptyAttach";
import { stageTransfers, type PaneTransfer } from "./transferSnap";
import { get as getSession, remeasureAttached } from "./paneSessions";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logEvent } from "./applog";
import { announce } from "./windowAnnounce";

// Phase 4: tell Rust this window is up, learn its label/ordinal (pane-id
// partition) and, for a secondary, its slice. Then keep a heartbeat going so
// Rust can re-adopt this window's workspaces if the webview dies silently.
/** What a window created by a workspace move boots with (windows.rs ws_transfer). */
export interface TransferPayload { workspace: Workspace; panes: Record<number, PaneTransfer> }
export interface BootInfo { label: string; ordinal: number; slice?: SessionDraft | null; transfer?: TransferPayload | null }

export const HEARTBEAT_MS = 2000;

let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Null outside Tauri or on a build without the command: single-window behaviour. */
export async function bootWindow(): Promise<BootInfo | null> {
  try {
    const info = await invoke<BootInfo>("window_boot", { multiwindow: getMultiwindow() });
    if (!info || typeof info.ordinal !== "number") return null;
    setWindowOrdinal(info.ordinal);
    if (heartbeat === undefined) {
      heartbeat = setInterval(() => { void invoke("window_heartbeat").catch(() => { /* Rust gone or reloading */ }); }, HEARTBEAT_MS);
    }
    return info;
  } catch {
    return null;
  }
}

/** Phase 4 D2: main has hydrated, so Rust may recreate the secondaries the last
 *  session had open (flag on only; Rust checks it too). Fire and forget. */
export function restoreWindows(): void {
  if (!isMainWindow() || !getMultiwindow()) return;
  void invoke("restore_windows").catch((e) => logEvent("warn", "windowBoot", `restore_windows failed: ${String(e)}`));
}

/** Wait until every pane of the workspace has a pty, then put keyboard focus on the
 *  active pane. Each terminal calls term.focus() as it finishes attaching, so a short
 *  settle delay lets the last of those land first. Gives up after ~6 s. */
function focusActivePane(ws: Workspace): void {
  const target = ws.focused ?? ws.panes[0]?.id;
  if (target == null) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    const ready = ws.panes.every((p) => !!getSession(p.id)?.ptyId);
    if (!ready && tries < 60) return;
    clearInterval(timer);
    setTimeout(() => getSession(target)?.term.focus(), 200);
  }, 100);
}

/** Take a workspace moved here alive (a new window's boot transfer, or a
 *  `win://adopt` into an existing window). */
function adoptTransfer(t: TransferPayload): void {
  // The panes' ptys are alive in Rust: mark them restored so the terminals
  // attach instead of spawning, and hand each its source-side screen.
  for (const p of t.workspace.panes) markRestoredPane(p.id);
  stageTransfers(t.panes ?? {});
  const ws: Workspace = { ...t.workspace, panes: t.workspace.panes.map((p) => ({ ...p, state: "starting" as const })) };
  useApp.getState().adoptWorkspace(ws);
  // Screen readers hear where the workspace went. Cockpit's live region mounts
  // after this returns, so announce once it is in the DOM.
  setTimeout(() => announce(`Workspace ${ws.name} moved to this window. ${ws.panes.length} pane${ws.panes.length === 1 ? "" : "s"}.`), 600);
  focusActivePane(ws);
}

/** A secondary window's first job: take the workspace it was created for. Never
 *  throws; a window that cannot hydrate just shows the launcher. */
export async function adoptBootInfo(info: BootInfo | null): Promise<void> {
  if (!info || info.label === "main") return;
  try {
    const t = info.transfer;
    if (t?.workspace) {
      adoptTransfer(t);
    } else if (info.slice && info.slice.workspaces.length > 0) {
      addRestoredUiPrefs(parseUiPrefs(info.slice.uiPrefs));
      await hydrateFrom(info.slice.workspaces, info.slice.activeWorkspaceId);
    }
  } catch (e) {
    logEvent("error", "windowBoot", `could not adopt the boot slice: ${String(e)}`);
  }
}

/** Sent by Rust to main when a window's workspaces fold into it: the heartbeat
 *  watcher (a dead secondary), and later the close path. */
interface AdoptPayload { from: string; workspaceIds: number[]; activeWs: number | null; slice: SessionDraft | null; transfer?: TransferPayload | null }

/** Every window listens. A payload with a `transfer` is a workspace moved here alive
 *  ("Move workspace to window..."): adopt it as a new window does at boot. Otherwise
 *  it is a fold into main: rebuild the workspaces from the closed window's last slice
 *  and add them; their ptys are still running in Rust, so the terminals attach. */
export function listenForAdopt(): void {
  void listen<AdoptPayload>("win://adopt", async (e) => {
    const { from, workspaceIds, activeWs, slice, transfer } = e.payload;
    try {
      if (transfer?.workspace) {
        if (!useApp.getState().workspaces.some((w) => w.id === transfer.workspace.id)) adoptTransfer(transfer);
        return;
      }
      if (!isMainWindow()) return;
      if (!slice) { logEvent("warn", "windowBoot", `win://adopt from ${from} carried no slice; its workspaces cannot be restored`); return; }
      const known = new Set(useApp.getState().workspaces.map((w) => w.id));
      const fresh = slice.workspaces.filter((w) => workspaceIds.includes(w.id) && !known.has(w.id));
      if (fresh.length === 0) return;
      addRestoredUiPrefs(parseUiPrefs(slice.uiPrefs));
      await hydrateFrom(fresh, activeWs, true);
      useUI.getState().pushToast("info", `Window ${from} closed: ${fresh.map((w) => w.name).join(", ")} moved back here`);
    } catch (err) {
      logEvent("error", "windowBoot", `win://adopt from ${from} failed: ${String(err)}`);
    }
  }).catch(() => { /* browser preview */ });
}

/** Rust asks this window to select a pane (a palette or Home click in another window,
 *  which `window_focus_pane` has already brought to the front). */
export function listenForFocusPane(): void {
  void listen<{ wsId: number; paneId: number }>("app://focus-pane", (e) => {
    const { wsId, paneId } = e.payload;
    const st = useApp.getState();
    const ws = st.workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    st.switchWorkspace(ws.id);
    if (ws.panes.some((p) => p.id === paneId)) st.focusPane(ws.id, paneId);
  }).catch(() => { /* browser preview */ });
}

/** Each window re-measures its terminals when its own scale factor changes. */
export function listenForScaleChange(): void {
  try {
    void getCurrentWindow().onScaleChanged(() => remeasureAttached()).catch(() => { /* browser preview */ });
  } catch { /* browser preview */ }
}

/** Tell Rust the Settings toggle changed; ws_transfer refuses while it is off, and
 *  turning it off makes Rust merge every secondary into main. */
export function pushMultiwindow(enabled: boolean): void {
  void invoke("set_multiwindow", { enabled }).catch(() => { /* browser preview */ });
}

/** A secondary never shows the launcher: once it has booted, an empty store means
 *  there is nothing left to show, so ask Rust to close it (flush, merge, destroy).
 *  Call after the boot adopt has finished. */
export function closeWhenEmpty(): void {
  if (isMainWindow()) return;
  let asked = false;
  const check = () => {
    if (asked || useApp.getState().workspaces.length > 0) return;
    asked = true;
    void invoke("window_close_self").catch((e) => { asked = false; logEvent("warn", "windowBoot", `window_close_self failed: ${String(e)}`); });
  };
  useApp.subscribe(check);
  check();
}

/** A workspace in another window, from that window's last slice. */
export interface RemoteWorkspace { id: number; name: string; root: string; paneId: number | null; livePanes: number }
export interface WindowSummary { label: string; livePanes: number; title?: string; needsYou?: number; top?: { wsId: number; paneId: number } | null; workspaces?: RemoteWorkspace[] }

/** Live panes in the other windows, for the quit guard. Empty outside Tauri, on a
 *  build without the command, or when this is the only window. */
export async function otherWindows(): Promise<WindowSummary[]> {
  try {
    const rows = await invoke<WindowSummary[]>("window_summary");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Main's confirmed quit when other windows exist: Rust flushes every slice, writes
 *  the session, exits. Falls back to a plain destroy if the command is missing. */
export async function quitApp(): Promise<void> {
  try {
    await invoke("app_quit");
  } catch {
    await import("@tauri-apps/api/window").then((m) => m.getCurrentWindow().destroy()).catch(() => { /* gone already */ });
  }
}
