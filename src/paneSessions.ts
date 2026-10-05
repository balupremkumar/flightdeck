// R1: module-level registry of live pane terminals, keyed by PaneModel.id.
//
// The xterm and its PTY used to be owned by Terminal's mount effect, so any
// remount of the component (a pane changing grid row on add / close / drag)
// killed the PTY and spawned a new one. Ownership now lives here, outside
// React: components only ATTACH and DETACH a persistent DOM host, and nothing
// in React ever creates or kills. See docs/plans/phase0-r1-terminal-registry.md.
//
// The ONLY things that kill a PTY: dispose() (called by the close funnels in
// worktrees.ts and by acquire() on a restart / vendor / cwd change) and the
// orphan sweep, which is a safety net for any close path that missed a funnel.
//
// Deliberately type-only imports from xterm: the runtime lives in Terminal.tsx,
// which registers the factory below, so worktrees.ts can call dispose() without
// pulling the terminal into its import graph.
//
// File naming (CLAUDE.md): never add a component whose name differs from this
// file only by case.
import type { Terminal as XTerm, ITheme } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { LigaturesAddon } from "@xterm/addon-ligatures";
import { invoke } from "@tauri-apps/api/core";
import { useApp, type Workspace } from "./store";
import { logEvent } from "./applog";

/** Latest callbacks from the mounted PaneView. Replaced on every render, so the
 *  session always calls the live ones, never a closure from a long-gone mount. */
export interface PaneHandlers {
  onExit?: (crashed: boolean) => void;
  onState?: (state: string) => void;
  onProc?: (name: string) => void;
  onBell?: () => void;
  onLine?: (line: string) => void;
  onScrollAway?: (linesBehind: number) => void;
  onProgress?: (pct: number | null) => void;
  onCwd?: (cwd: string) => void;
  onSetupConsumed?: () => void;
}

/** What the session is born with. setup, draft and scrollback are consumed only
 *  at creation; the rest of the live prefs are re-synced by Terminal each render. */
export interface SpawnSpec {
  vendor: string;
  cwd: string;
  epoch: number;
  setup?: string;
  /** Claude fullscreen opt-in (C2b); consumed only at pty_spawn. */
  focusMode?: boolean;
  initialDraft?: string;
  restoredScrollback?: string;
  fontSize: number;
  osc52: boolean;
  quietMs: number;
}

/** `{current}` boxes the session's closures read at call time, so a pref change
 *  applies live without recreating anything. */
export interface SessionLive {
  osc52: { current: boolean };
  quietMs: { current: number };
  fontSize: { current: number };
  ligatures: { current: boolean };
}

export interface PaneSession {
  modelId: number;
  /** `${epoch}|${vendor}|${cwd}`; a mismatch on acquire means restart. */
  gen: string;
  term: XTerm;
  /** term.open(host) once; this node is what moves between grid cells. */
  host: HTMLDivElement;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon | null;
  ligatures: LigaturesAddon | null;
  /** Rust pty id, 0 until pty_spawn resolves. */
  ptyId: number;
  handlers: PaneHandlers;
  live: SessionLive;
  theme: { current: ITheme };
  api: {
    jumpMark: (dir: 1 | -1) => boolean;
    showHints: () => boolean;
    remeasure: () => void;
    /** QL-763: unfold whatever hides this buffer line / fold or unfold every finished command. */
    revealLine?: (line: number) => void;
    foldAll?: (on: boolean) => void;
    /** Called after every attach: the factory re-creates WebGL only if this session's context was lost. */
    onAttach: () => void;
  };
  /** Current attach token; null while parked. */
  owner: symbol | null;
  saved: { viewportY: number; atBottom: boolean; hadFocus: boolean };
  disposers: (() => void)[];
  disposed: boolean;
}

export type SessionFactory = (modelId: number, gen: string, spec: SpawnSpec, handlers: PaneHandlers, container: HTMLElement) => PaneSession;

interface Registry {
  sessions: Map<number, PaneSession>;
  sweepInstalled: boolean;
}

// HMR: a hot reload of this module must not orphan live PTYs, so the Map
// survives through import.meta.hot.data.
const reg: Registry = (import.meta.hot?.data.reg as Registry | undefined) ?? { sessions: new Map(), sweepInstalled: false };
if (import.meta.hot) import.meta.hot.data.reg = reg;
const sessions = reg.sessions;

/** A fit below this is a layout still settling (react-resizable-panels has not
 *  sized the cell yet), never a real size. Sending it to a live agent makes it
 *  re-render at a few columns and the re-wrapped lines stay in scrollback. */
export const MIN_FIT_COLS = 20;
export const MIN_FIT_ROWS = 5;
/** Spawn size when no sane fit arrives within the grace period. */
export const FALLBACK_COLS = 120;
export const FALLBACK_ROWS = 30;

/** fit.fit(), but only when the proposed size is sane. Returns whether it fit.
 *  A skipped fit leaves the terminal (and so the PTY) at its last good size;
 *  the ResizeObserver fits again once the layout settles. */
export function fitIfSane(fit: Pick<FitAddon, "fit" | "proposeDimensions">): boolean {
  try {
    const d = fit.proposeDimensions();
    if (!d || !(d.cols >= MIN_FIT_COLS && d.rows >= MIN_FIT_ROWS)) return false;
    fit.fit();
    return true;
  } catch {
    return false; // not measured yet, or mid-teardown
  }
}

let factory: SessionFactory | null = null;
export function setSessionFactory(f: SessionFactory): void {
  factory = f;
}

export function genOf(spec: Pick<SpawnSpec, "epoch" | "vendor" | "cwd">): string {
  return `${spec.epoch}|${spec.vendor}|${spec.cwd}`;
}

export function get(modelId: number): PaneSession | undefined {
  return sessions.get(modelId);
}

export function size(): number {
  return sessions.size;
}

/** Idempotent per (modelId, gen). `container` is where a NEW session's host is
 *  first mounted (xterm has to measure inside the document at open()). */
export function acquire(modelId: number, spec: SpawnSpec, handlers: PaneHandlers, container: HTMLElement): PaneSession {
  const gen = genOf(spec);
  const existing = sessions.get(modelId);
  if (existing && !existing.disposed) {
    if (existing.gen === gen) {
      existing.handlers = handlers;
      return existing;
    }
    dispose(modelId); // restart / vendor or cwd change: the only intended kill besides close
  }
  if (!factory) throw new Error("paneSessions: no session factory registered");
  const s = factory(modelId, gen, spec, handlers, container);
  sessions.set(modelId, s);
  installOrphanSweep();
  return s;
}

let park: HTMLDivElement | null = null;
function parkEl(): HTMLDivElement {
  if (park && park.isConnected) return park;
  park = document.createElement("div");
  park.id = "fd-term-park";
  park.setAttribute("aria-hidden", "true");
  park.style.cssText = "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;";
  document.body.appendChild(park);
  return park;
}

function moveInto(container: HTMLElement, node: HTMLElement): void {
  const m = (container as HTMLElement & { moveBefore?: (n: Node, ref: Node | null) => void }).moveBefore;
  if (m && node.isConnected && container.isConnected) {
    try { m.call(container, node, null); return; } catch { /* fall through to appendChild */ }
  }
  container.appendChild(node);
}

/** Put the host in `container`, refit, restore scroll and focus. Returns the
 *  token a later detach() must present. */
export function attach(modelId: number, container: HTMLElement): symbol | null {
  const s = sessions.get(modelId);
  if (!s || s.disposed) return null;
  const token = Symbol(`pane-${modelId}`);
  s.owner = token;
  s.host.style.cssText = "width:100%;height:100%;";
  if (s.host.parentElement !== container) moveInto(container, s.host);
  const r = container.getBoundingClientRect();
  if (r.width >= 24 && r.height >= 24) fitIfSane(s.fit);
  try {
    s.term.refresh(0, s.term.rows - 1);
    if (s.saved.atBottom) s.term.scrollToBottom();
    else s.term.scrollToLine(s.saved.viewportY);
  } catch { /* mid-teardown */ }
  s.api.onAttach();
  if (s.saved.hadFocus) { s.term.focus(); s.saved.hadFocus = false; }
  return token;
}

/** Park the host if `token` still owns it. Never kills. A stale token (the new
 *  owner already attached, or the session was replaced) is ignored. */
export function detach(modelId: number, token: symbol | null): void {
  const s = sessions.get(modelId);
  if (!s || s.disposed || !token || s.owner !== token) return;
  const buf = s.term.buffer.active;
  s.saved = {
    viewportY: buf.viewportY,
    atBottom: buf.viewportY >= buf.baseY - 1,
    hadFocus: s.host.contains(document.activeElement),
  };
  const rect = s.host.getBoundingClientRect();
  s.owner = null;
  // Sized to its last rect so parking reflows nothing and sends no pty_resize.
  s.host.style.cssText = `position:fixed;left:0;top:0;width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;`;
  parkEl().appendChild(s.host);
}

/** Kill the PTY and tear everything down. Idempotent. */
export function dispose(modelId: number): void {
  const s = sessions.get(modelId);
  if (!s || s.disposed) { sessions.delete(modelId); return; }
  s.disposed = true;
  sessions.delete(modelId);
  for (const d of s.disposers.splice(0)) {
    try { d(); } catch { /* keep tearing down */ }
  }
  if (s.ptyId) {
    const id = s.ptyId;
    s.ptyId = 0;
    void Promise.resolve(invoke("pty_kill", { paneId: id })).catch(() => { /* already gone */ });
  }
  try { s.term.dispose(); } catch { /* already disposed */ }
  s.host.remove();
}

/** Tear the session down WITHOUT pty_kill: the pty keeps running in Rust and
 *  its ring keeps buffering, so another window can pty_attach to it. Idempotent.
 *  Must run BEFORE the pane leaves the store (see releaseWorkspace): the session
 *  is gone from the registry by then, so the orphan sweep never sees it.
 *  Caveat: a release while pty_spawn is still in flight (ptyId 0) hits the
 *  `entry.disposed` guard in Terminal.tsx and kills the just-spawned pty. */
export function release(modelId: number): void {
  const s = sessions.get(modelId);
  if (!s || s.disposed) { sessions.delete(modelId); return; }
  s.disposed = true;
  sessions.delete(modelId);
  for (const d of s.disposers.splice(0)) {
    try { d(); } catch { /* keep tearing down */ }
  }
  s.ptyId = 0; // forget, never kill
  try { s.term.dispose(); } catch { /* already disposed */ }
  s.host.remove();
}

/** Move-out half of a workspace transfer: release every pane, THEN detach from
 *  the store, in that order, so the orphan sweep finds nothing to dispose.
 *  Returns the detached workspace for the target window to adopt. */
export function releaseWorkspace(id: number): Workspace | undefined {
  const ws = useApp.getState().workspaces.find((w) => w.id === id);
  if (!ws) return undefined;
  for (const p of ws.panes) release(p.id);
  useApp.getState().detachWorkspace(id);
  return ws;
}

/** Safety net: dispose any session whose pane no longer exists in the store.
 *  Logged, because reaching here means a close path skipped dispose(). */
export function sweepOrphans(liveIds: ReadonlySet<number>): void {
  for (const id of [...sessions.keys()]) {
    if (liveIds.has(id)) continue;
    logEvent("warn", "paneSessions", `missed close path: pane ${id} left the store without dispose(); disposing its session`);
    dispose(id);
  }
}

function installOrphanSweep(): void {
  if (reg.sweepInstalled) return;
  reg.sweepInstalled = true;
  let last = useApp.getState().workspaces;
  useApp.subscribe((state) => {
    if (state.workspaces === last) return;
    last = state.workspaces;
    if (sessions.size === 0) return;
    const live = new Set<number>();
    for (const w of state.workspaces) for (const p of w.panes) live.add(p.id);
    sweepOrphans(live);
  });
}

/** Test helper: forget everything without killing (the test owns its mocks). */
export function _resetForTests(): void {
  sessions.clear();
  factory = null;
  park?.remove();
  park = null;
}
