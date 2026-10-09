import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { revealPath } from "./reveal";
import { useApp, registerPaneSend, unregisterPaneSend, type PaneModel, type PaneState } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { Terminal, type TerminalHandle } from "./Terminal";
import { get as getPaneSession, writeToPane } from "./paneSessions";
import { getTerminalSettings } from "./settingsStore";
import { rightClickAction, shouldConfirmPaste } from "./terminalMouse";
import {
  IconBranch, IconClose, IconRefresh, IconDrag, IconOverflow,
  IconMaximizePane, IconMinimize, IconFolder, IconChevron, IconDiff, IconFile,
} from "./Icons";
import { cachedInvoke, usePoll, useVisible, usePaneMemory } from "./poll";
import { compact, num, duration, bytes, tailEllipsis } from "./format";
import { clearMcpNotices, mcpChip, noteMcpLine } from "./mcphealth";
import { paneStateWord } from "./paneHeader";
import { shouldBulkSelect } from "./paneSelectGesture";
import { stateSince, lastLine, isOpenQuestion, attentionKind, STATE_LABEL as STATE_TITLE } from "./attention";
import { missingCliHint } from "./paneMenu";
import "./panes.css";

// Phase 3: the chat view is its own chunk, fetched the first time a pane opens it.
const ChatView = lazy(() => import("./ChatView"));

import { vendorShort, vendorMeta, vendorColor } from "./vendors";
import { PANE_SWATCHES, swatchToken, normalizePaneName } from "./paneStyle";
import { VendorGlyph } from "./VendorGlyph";
import { closePaneWithCleanup } from "./worktrees";
import { Transcript } from "./TranscriptView";
import { extractLastCommand, redactText, scrollbackFilename, toLines } from "./transcript";
import { SelectionToolbar, GroupsPanel, SessionSnapshots } from "./PaneOps";
import { openSessionLauncher, modelShort, contextWindowFor, canResume, RESUME_VENDOR, setFocusModeKeepingSession } from "./sessionLauncherLogic";
import { SubagentTree, type SubagentCount } from "./SubagentTreeView";
import { PlanPanel, pendingPlan, planChipTitle, PLAN_APPROVE_KEYS, type PlanEntry } from "./PlanPanelView";
import { parseWorkspaceDef, serializeWorkspaceExport } from "./snapshots";
import { registerScrollbackSource, unregisterScrollbackSource, restoredScrollbackFor } from "./session";
const MIN_FONT = 9;
const MAX_FONT = 22;
const DEFAULT_FONT = 13;
const MIN_QUIET_SEC = 1;
const MAX_QUIET_SEC = 30;
const DEFAULT_QUIET_SEC = 3;
const GIT_POLL_MS = 30000;
/** UI-151: drag payload identifying a pane being moved between workspaces. */
export const PANE_DRAG_TYPE = "application/x-flightdeck-pane";

// UX-560: per-vendor quiet-threshold DEFAULT, editable from any pane's menu
// (previously only the per-pane slider existed — this is the "save what I
// just set as this vendor's default" companion, same shape as the existing
// VENDOR_FONT_KEY below). vendorMeta(vendor).quietSeconds is still the
// baseline for a vendor with no saved override.
const VENDOR_QUIET_KEY = "flightdeck-vendor-quiet";
function loadVendorQuietOverride(vendor: string): number | null {
  try {
    const map = JSON.parse(localStorage.getItem(VENDOR_QUIET_KEY) ?? "{}");
    const v = map[vendor];
    return typeof v === "number" && v >= MIN_QUIET_SEC && v <= MAX_QUIET_SEC ? v : null;
  } catch { return null; }
}
function saveVendorQuietOverride(vendor: string, seconds: number) {
  try {
    const map = JSON.parse(localStorage.getItem(VENDOR_QUIET_KEY) ?? "{}");
    map[vendor] = seconds;
    localStorage.setItem(VENDOR_QUIET_KEY, JSON.stringify(map));
  } catch { /* non-persistent */ }
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
  /** QL-740: unpushed/unpulled commits vs the tracking branch. null = no
      upstream to compare against (local-only branch), which is NOT "in sync". */
  ahead: number | null;
  behind: number | null;
}

/** QL-740: compact ahead/behind for the branch pill — "↑2 ↓1", or "" when
 *  there's nothing to say (in sync, or no upstream at all). Kept pure and
 *  exported so the no-upstream vs in-sync distinction is testable. */
export function aheadBehindLabel(ahead: number | null | undefined, behind: number | null | undefined): string {
  const parts: string[] = [];
  if (ahead && ahead > 0) parts.push(`↑${ahead}`);
  if (behind && behind > 0) parts.push(`↓${behind}`);
  return parts.join(" ");
}

/** Tooltip half of the same fact, in words. "" when the pill shows no counts. */
export function aheadBehindTitle(ahead: number | null | undefined, behind: number | null | undefined): string {
  const parts: string[] = [];
  if (ahead && ahead > 0) parts.push(`${ahead} unpushed commit${ahead === 1 ? "" : "s"}`);
  if (behind && behind > 0) parts.push(`${behind} behind upstream`);
  return parts.length ? ` — ${parts.join(", ")}` : "";
}

// QL-743: auto-title damping. A build turns one pane's foreground process into
// a stream of transients (claude → node → pwsh → node …), and renaming on every
// one of them makes the header flip several times a minute. Instead of taking
// the latest name, take the name that has OWNED the pane for the longest slice
// of a trailing window — the long-lived root wins over its short-lived children
// — and only once it has held it for at least STABLE_MS, so a name that has
// only just appeared never lands.
export interface ProcSample { name: string; at: number }
export const PROC_STABLE_MS = 4000;
const PROC_WINDOW_MS = 30000;

/** Agent children (including MCP servers) do not identify the pane itself. */
export function usesProcessTitle(vendor: string): boolean {
  return vendorMeta(vendor).kind === "shell";
}

/** Drop samples that have fallen out of the trailing window, keeping (and
 *  clipping) the one that was still current when the window opened so a
 *  long-running root doesn't lose its residency. */
export function pruneProcSamples(samples: ProcSample[], now: number, windowMs = PROC_WINDOW_MS): ProcSample[] {
  const cutoff = now - windowMs;
  let start = 0;
  for (let i = 0; i < samples.length; i++) if (samples[i].at <= cutoff) start = i;
  const kept = samples.slice(start);
  if (kept.length && kept[0].at < cutoff) kept[0] = { name: kept[0].name, at: cutoff };
  return kept;
}

/** The name to auto-title with, or null while nothing has earned it yet.
 *  `samples` are (name, started-at) transitions in order, oldest first. */
export function stableProcName(samples: ProcSample[], now: number, stableMs = PROC_STABLE_MS): string | null {
  const lived = new Map<string, number>();
  for (let i = 0; i < samples.length; i++) {
    const end = i + 1 < samples.length ? samples[i + 1].at : now;
    lived.set(samples[i].name, (lived.get(samples[i].name) ?? 0) + Math.max(0, end - samples[i].at));
  }
  let best: string | null = null;
  let bestMs = 0;
  for (const [name, ms] of lived) if (ms > bestMs) { best = name; bestMs = ms; }
  return bestMs >= stableMs ? best : null;
}

// UI-140: per-vendor font zoom, classified as a preference in storageKeys.ts
// so "reset all settings" clears it with everything else.
const VENDOR_FONT_KEY = "flightdeck-vendor-fonts";
function loadVendorFont(vendor: string): number {
  try {
    const map = JSON.parse(localStorage.getItem(VENDOR_FONT_KEY) ?? "{}");
    const v = map[vendor];
    return typeof v === "number" && v >= MIN_FONT && v <= MAX_FONT ? v : DEFAULT_FONT;
  } catch { return DEFAULT_FONT; }
}
function saveVendorFont(vendor: string, size: number) {
  try {
    const map = JSON.parse(localStorage.getItem(VENDOR_FONT_KEY) ?? "{}");
    map[vendor] = size;
    localStorage.setItem(VENDOR_FONT_KEY, JSON.stringify(map));
  } catch { /* non-persistent */ }
}

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s || p;
}

// Local — not in Icons.tsx, matches its grid (20x20, strokeWidth 1.6, round caps).
function IconSearch({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8.4" cy="8.4" r="5" />
      <path d="M12.4 12.4 L17 17" />
    </svg>
  );
}

interface PaneViewProps {
  wsId: number;
  pane: PaneModel;
  /** Position in the grid — passed back to the stable drag handlers (UI-226). */
  index: number;
  maximized: boolean;
  onToggleMaximize: (paneId: number) => void;
  canReorder: boolean;
  dragging: boolean;
  dragOver: boolean;
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onDragEnd: () => void;
  onDropHere: (index: number) => void;
}

function PaneViewInner({
  wsId,
  pane,
  index,
  maximized,
  onToggleMaximize,
  canReorder,
  dragging,
  dragOver,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDropHere,
}: PaneViewProps) {
  const focused = useApp((s) => s.workspaces.find((w) => w.id === wsId)?.focused === pane.id);
  const focusPane = useApp((s) => s.focusPane);
  const setPaneState = useApp((s) => s.setPaneState);
  const restartPane = useApp((s) => s.restartPane);
  const clearNeedsSetup = useApp((s) => s.clearNeedsSetup);
  // Off-screen panes (background workspace, or a sibling maximised) stop polling.
  const paneRef = useRef<HTMLDivElement>(null);
  const paneVisible = useVisible(paneRef);
  const setupCmd = useApp((s) => s.workspaces.find((w) => w.id === wsId)?.setupCmd);
  const renamePane = useApp((s) => s.renamePane);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);
  const dead = pane.state === "idle" || pane.state === "error";

  // Closing a pane kills its PTY. If the agent is still live, confirm first —
  // a misclick otherwise ends a running session with no way back (matches the
  // same guard the workspace-close path uses). Isolated panes get their
  // worktree cleaned up too (dirty ones prompt keep/discard afterwards).
  const isolated = !!pane.worktreePath;
  const tryClosePane = () => {
    setMenuOpen(false);
    if (dead) { closePaneWithCleanup(wsId, pane); return; }
    requestConfirm({
      title: `Close ${displayName}?`,
      body:
        "This pane is still live. Closing it ends the session: the running agent can’t be brought back." +
        (isolated ? " Its worktree will be cleaned up (you’ll be asked about unmerged work)." : ""),
      confirmLabel: "Close & end session",
      danger: true,
      onConfirm: () => closePaneWithCleanup(wsId, pane),
    });
  };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.title ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [, bumpMcp] = useState(0); // G2: re-render when an MCP notice lands
  // SF4: a restart (epoch bump) starts a fresh process; old notices are stale.
  useEffect(() => () => clearMcpNotices(pane.id), [pane.id, pane.epoch]);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  // UI-140: font zoom is a per-agent habit (agy's TUI runs denser than
  // claude's), so remember it per vendor rather than resetting every pane.
  // R1: a pane that changes grid row remounts this PaneView but keeps its
  // terminal session, so the live prefs seed from the session (when there is
  // one) instead of resetting to defaults and undoing the zoom / toggles.
  const [fontSize, setFontSizeRaw] = useState(() => getPaneSession(pane.id)?.live.fontSize.current ?? loadVendorFont(pane.vendor));
  const setFontSize = (next: number | ((f: number) => number)) => {
    setFontSizeRaw((f) => {
      const v = typeof next === "function" ? next(f) : next;
      saveVendorFont(pane.vendor, v);
      return v;
    });
  };
  const [ligatures, setLigatures] = useState(() => getPaneSession(pane.id)?.live.ligatures.current ?? false);
  // QL-758: OSC 52 clipboard writes from the child, off until this pane is
  // told otherwise. Per pane and per session on purpose — it is a "I trust
  // what this one agent is about to do" switch, not a preference.
  const [osc52, setOsc52] = useState(() => getPaneSession(pane.id)?.live.osc52.current ?? false);
  // QL-762: this pane's buffer from the last session, if the restore staged
  // one. Read once per PaneView (not per Terminal mount) and only handed over
  // on the pane's FIRST spawn: a deliberate Restart bumps the epoch and should
  // give you a clean pane, not last week's output replayed at you.
  const [restoredScrollback] = useState(() => restoredScrollbackFor(pane.id));
  // UI-237: start from THIS vendor's own threshold (agy idles longer than
  // claude; a shell is idle at once) — UX-560: or the user's saved override
  // for that vendor, if they've set one from any pane's menu. The per-pane
  // slider still overrides it for just this pane's session.
  const [quietSec, setQuietSec] = useState(() => {
    const live = getPaneSession(pane.id)?.live.quietMs.current;
    return live !== undefined
      ? live / 1000
      : loadVendorQuietOverride(pane.vendor) ?? vendorMeta(pane.vendor).quietSeconds ?? DEFAULT_QUIET_SEC;
  });
  // UX-546/553/554/562/563: overlay open flags for the new per-pane surfaces.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // UI-137: reopening find with an empty box loses the search you were mid-way
  // through; remember it for the life of the pane.
  const [query, setQuery] = useState("");
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number } | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const setReviewPane = useUI((s) => s.setReviewPane);
  // Live foreground process name (backend pty://proc via Terminal's onProc).
  const [procName, setProcName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<TerminalHandle>(null);

  // UX-555: auto-title this pane from its live foreground process, but only
  // while nothing else has claimed the title text. `lastAutoTitle` remembers
  // what WE last wrote — if pane.title ever drifts from that (a manual
  // rename via the header, or the user clearing it back to blank) auto-
  // titling backs off until the title is cleared again. A pane that already
  // has a title when this first runs (e.g. restored from a prior session) is
  // treated as manually named — conservative, but it means a real rename can
  // never be silently overwritten.
  // QL-743: the raw process name churns during a build (claude → node → pwsh →
  // node), and renaming on every change flipped the header several times a
  // minute. Record the transitions instead, and rename only to whichever name
  // has actually held the pane (stableProcName above) — a transient child never
  // reaches the 4s threshold, so the header sits still. The manual-rename guard
  // below is unchanged.
  const lastAutoTitle = useRef<string | undefined>(undefined);
  const procSamples = useRef<ProcSample[]>([]);
  const processTitleEnabled = usesProcessTitle(pane.vendor);
  useEffect(() => {
    if (!processTitleEnabled || !procName) return;
    const s = procSamples.current;
    if (s[s.length - 1]?.name !== procName) s.push({ name: procName, at: Date.now() });
  }, [processTitleEnabled, procName]);
  useEffect(() => {
    if (!processTitleEnabled || !procName) return;
    const apply = () => {
      const now = Date.now();
      procSamples.current = pruneProcSamples(procSamples.current, now);
      const next = stableProcName(procSamples.current, now);
      if (!next || next === pane.title) return;
      if (pane.title && pane.title !== lastAutoTitle.current) return; // manual rename — leave it
      renamePane(pane.id, next);
      lastAutoTitle.current = next;
    };
    apply(); // a name that's already been stable for a while shouldn't wait a tick
    const id = setInterval(apply, 1000);
    return () => clearInterval(id);
  }, [processTitleEnabled, procName, pane.title, pane.id, renamePane]);

  useEffect(() => {
    if (!searchOpen) { setMatchInfo(null); return; }
    findRef.current?.focus();
    findRef.current?.select();
    const unsub = terminalRef.current?.onSearchResults((e) => setMatchInfo({ index: e.resultIndex, count: e.resultCount }));
    return () => unsub?.();
  }, [searchOpen]);

  const runFind = (query: string, dir: "next" | "prev") => {
    if (!query) { terminalRef.current?.clearSearch(); setMatchInfo(null); return; }
    if (dir === "next") terminalRef.current?.findNext(query, { incremental: true });
    else terminalRef.current?.findPrevious(query);
  };

  const closeSearch = () => {
    terminalRef.current?.clearSearch();
    setSearchOpen(false);
    setMatchInfo(null); // query deliberately kept — reopening prefills it (UI-137)
  };

  // The menu is portalled to <body> — `.pane` clips overflow (and so does the
  // resizable-panel wrapper), so an absolutely-positioned child would be cut off.
  // UI-230: measured only while the menu is open — the size walk is not free.
  const [wtSize, setWtSize] = useState<number | null>(null);
  useEffect(() => {
    if (!menuOpen || !pane.worktreePath) return;
    let cancelled = false;
    void cachedInvoke<{ path: string; bytes: number }[]>("git_worktree_list", { claimed: [] }, 30000)
      .then((list) => {
        if (cancelled) return;
        const norm = (x: string) => x.replace(/[\/]+$/, "").toLowerCase();
        setWtSize(list.find((w) => norm(w.path) === norm(pane.worktreePath!))?.bytes ?? null);
      })
      .catch(() => { if (!cancelled) setWtSize(null); });
    return () => { cancelled = true; };
  }, [menuOpen, pane.worktreePath]);

  const openMenu = () => {
    const r = menuBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.right - 220) });
    setMenuOpen(true);
  };
  const closeMenu = () => setMenuOpen(false);

  // Esc closes the overflow menu (UI-30) — was mouse-leave only. UX-542/543:
  // shared overlay stack (ui.ts).
  useOverlayEsc(menuOpen, closeMenu);

  // Measure the rendered menu, including More, before paint and on resize.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menuOpen || !menuPos || !menu) return;
    const clamp = () => {
      menu.style.top = Math.max(8, Math.min(menuPos.top, window.innerHeight - 8 - menu.getBoundingClientRect().height)) + "px";
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(menu);
    window.addEventListener("resize", clamp);
    return () => { observer.disconnect(); window.removeEventListener("resize", clamp); };
  }, [menuOpen, menuPos]);

  useEffect(() => {
    if (!editing) return;
    setDraft(pane.title ?? "");
    nameRef.current?.focus();
    nameRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commitRename = () => {
    renamePane(pane.id, draft, true);
    setEditing(false);
  };

  // Colour and name popover (pane menu). Colour applies live; the name saves
  // on Enter / Save, through the same renamePane path as the header rename.
  const setPaneColor = useApp((s) => s.setPaneColor);
  const [styleOpen, setStyleOpen] = useState(false);
  const [styleDraft, setStyleDraft] = useState("");
  const styleNameRef = useRef<HTMLInputElement>(null);
  const tintToken = swatchToken(pane.color);
  const openStyle = () => {
    setStyleDraft(pane.title ?? "");
    setMenuOpen(false);
    setStyleOpen(true);
  };
  const closeStyle = () => setStyleOpen(false);
  const saveStyle = () => {
    if (normalizePaneName(styleDraft) !== pane.title) renamePane(pane.id, styleDraft, true);
    setStyleOpen(false);
  };
  useOverlayEsc(styleOpen, closeStyle);
  useEffect(() => {
    if (!styleOpen) return;
    styleNameRef.current?.focus();
    styleNameRef.current?.select();
  }, [styleOpen]);

  // Shared clipboard helper (UI-119 and friends) — one toast style for all copies.
  const copyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", okMsg);
    } catch {
      pushToast("error", "Couldn’t copy: clipboard unavailable.");
    }
  };

  const copyCwd = async () => {
    try {
      await navigator.clipboard.writeText(pane.cwd);
      pushToast("success", "Copied working directory.");
    } catch {
      pushToast("error", "Couldn’t copy: clipboard unavailable.");
    }
    setMenuOpen(false);
  };

  const reveal = async () => {
    try {
      await revealPath(pane.cwd);
    } catch {
      pushToast("error", "Couldn’t open Explorer for this folder.");
    }
    setMenuOpen(false);
  };

  // UX-546/547/549: the terminal's own scrollback, via a TerminalHandle
  // method that doesn't exist on Terminal.tsx yet (that file isn't ours —
  // see HANDOFF EDITS for the exact addition). Degrades to null rather than
  // throwing so the transcript browser and these menu actions show an honest
  // "not available yet" instead of a crash.
  const getScrollback = (): string | null => {
    const handle = terminalRef.current as (TerminalHandle & { getScrollbackText?: () => string }) | null;
    return typeof handle?.getScrollbackText === "function" ? handle.getScrollbackText() : null;
  };

  const saveScrollback = (redacted: boolean) => {
    setMenuOpen(false);
    const raw = getScrollback();
    if (raw == null) { pushToast("error", "Transcript export isn’t wired up for this pane yet."); return; }
    downloadText(scrollbackFilename(pane.vendor, redacted), redacted ? redactText(raw) : raw);
    pushToast("success", redacted ? "Saved redacted scrollback." : "Saved scrollback.");
  };

  const copyLastCommand = () => {
    setMenuOpen(false);
    const raw = getScrollback();
    const cmd = raw != null ? extractLastCommand(toLines(raw)) : null;
    if (!cmd) { pushToast("info", "Couldn’t find a command in this pane’s recent output."); return; }
    void copyText(cmd, "Copied last command.");
  };

  const duplicatePane = useApp((s) => s.duplicatePane);
  const doDuplicate = () => {
    setMenuOpen(false);
    duplicatePane(wsId, pane.id);
    pushToast("success", `Duplicated ${displayName ? displayName : "pane"} · same folder, fresh process.`);
  };

  // UX-563: export this pane's WORKSPACE as a file (client-side Blob
  // download — the app has no generic file-write IPC command available to
  // the frontend today; see HANDOFF EDITS if a native save-dialog path is
  // wanted later). Import is the same mechanism in reverse via a hidden
  // file input, reachable from any pane's menu since there's no dedicated
  // workspace-level menu owned by this file.
  const ws = useApp((s) => s.workspaces.find((w) => w.id === wsId));
  const createWorkspace = useApp((s) => s.createWorkspace);
  const exportWorkspace = () => {
    setMenuOpen(false);
    if (!ws) return;
    downloadText(`${ws.name.replace(/[^a-z0-9-]/gi, "-") || "workspace"}.flightdeck-workspace.json`, serializeWorkspaceExport(ws));
    pushToast("success", "Exported workspace definition.");
  };
  const importWorkspace = () => {
    setMenuOpen(false);
    importInputRef.current?.click();
  };
  const onImportFile = async (file: File) => {
    try {
      const def = parseWorkspaceDef(await file.text());
      createWorkspace(def.root, def.panes.map((p) => ({ vendor: p.vendor, cwd: p.cwd })), def.setupCmd);
      pushToast("success", `Imported "${def.name}" as a new workspace.`);
    } catch (e) {
      pushToast("error", e instanceof Error ? e.message : "Couldn’t import that file.");
    }
  };

  const displayName = pane.title || vendorShort(pane.vendor);
  // UI-26: a truncated path with a tooltip can't be read in full or selected;
  // the menu shows it wrapped and selectable.

  // Real git branch for this pane's cwd. Cheap to poll — re-check on mount,
  // on pane restart (epoch bump), and every 30s. Degrades silently: any
  // invoke failure (git missing, cwd gone) just hides the pill.
  // Shared cache (UI-234): six panes on one repo now make ONE git_status call
  // per cycle instead of six. Poll stands down when this pane is off-screen or
  // the window is hidden (UI-227/228).
  usePoll(async () => {
    try {
      setGitStatus(await cachedInvoke<GitStatus>("git_status", { cwd: pane.cwd }, GIT_POLL_MS / 2));
      setGitError(null);
    } catch (e) {
      // UI-27: "not a repo", "git isn't installed" and "the call failed" all
      // collapsed to no-pill, which loses the diagnosis. Keep the reason so the
      // header can say which it was.
      setGitStatus(null);
      setGitError(/not available|No such file|not recognized/i.test(String(e))
        ? "git isn’t installed or isn’t on PATH"
        : "couldn’t read git status for this folder");
    }
  }, GIT_POLL_MS, [pane.cwd, pane.epoch], paneVisible);

  // Token chip (UI-3): real numbers from the agent's own session transcript
  // (Claude Code writes ~/.claude/projects/<cwd>/*.jsonl). Agents without a
  // transcript return null and get no chip — never an estimate.
  // UI-17 superseded (owner feedback item 3): Ctrl+=/-/0 used to zoom this
  // pane's font; those keys now mean whole-app zoom (Cockpit.tsx, capture
  // phase) so browser-style zoom expectations work everywhere, including
  // while a terminal has focus. Two capture-phase listeners on the same keys
  // would both fire — removed here rather than there, since per-pane font
  // size stays reachable via the +/− buttons in the overflow menu below.

  // UI-132: terminal context menu (copy/paste/clear/find), positioned at the
  // click. Native right-click gives nothing useful inside a canvas terminal.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null);
  // UI-135: brief visual pulse when the child rings BEL.
  const [bell, setBell] = useState(false);
  // UI-128: how far the user has scrolled off the live tail, in new lines.
  const [behind, setBehind] = useState(0);
  // UI-136: progress reported by the child via OSC 9;4 (npm/winget/cargo all
  // emit it). -1 means indeterminate.
  const [progress, setProgress] = useState<number | null>(null);
  // UI-125: how the process ended, so Restart can say what it's recovering from.
  const [lastExit, setLastExit] = useState<string | null>(null);
  // Epoch in which the process exited: "idle" alone cannot tell exited from waiting.
  const [exitEpoch, setExitEpoch] = useState<number | null>(null);
  const bellTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pulseBell = () => {
    setBell(true);
    clearTimeout(bellTimer.current);
    bellTimer.current = setTimeout(() => setBell(false), 900);
  };
  useEffect(() => () => clearTimeout(bellTimer.current), []);

  // UX-542/543: shared overlay stack (ui.ts) — right-click context menu.
  useOverlayEsc(!!ctxMenu, () => setCtxMenu(null));
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [ctxMenu]);

  // UI-133: pasting many lines into a shell can execute them all — confirm
  // first. Single-line pastes go straight through.
  const pasteFromClipboard = async (forceConfirm = false) => {
    setCtxMenu(null);
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { pushToast("error", "Couldn’t read the clipboard."); return; }
    if (!text) return;
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0).length;
    if (lines > 1 || forceConfirm) {
      requestConfirm({
        title: lines > 1 ? `Paste ${lines} lines into ${displayName}?` : `Paste into ${displayName}?`,
        body: lines > 1
          ? "Multi-line pastes can run every line at once in a shell. Check it’s what you meant to send."
          : "This pane is waiting on you or isn’t the focused pane, so a paste could answer a prompt you haven’t read.",
        confirmLabel: lines > 1 ? `Paste ${lines} lines` : "Paste",
        onConfirm: () => terminalRef.current?.paste(text),
      });
      return;
    }
    terminalRef.current?.paste(text);
  };

  const clearScrollback = () => {
    setCtxMenu(null);
    setMenuOpen(false);
    terminalRef.current?.clearScrollback();
    pushToast("info", "Cleared this pane’s scrollback.");
  };

  // QL-754: the hint mode is a terminal mode, so the menu has to hand focus
  // back before raising it — otherwise the first label keystroke goes to the
  // button that opened it. Degrades quietly on a Terminal without the method.
  const showQuickHints = () => {
    setCtxMenu(null);
    setMenuOpen(false);
    focusPane(wsId, pane.id);
    paneRef.current?.querySelector<HTMLElement>("textarea.xterm-helper-textarea")?.focus();
    const handle = terminalRef.current as (TerminalHandle & { showQuickHints?: () => boolean }) | null;
    if (typeof handle?.showQuickHints !== "function") {
      pushToast("info", "Link hints aren’t available in this pane.");
      return;
    }
    // Focus lands in the terminal's textarea on the next frame; raising the
    // hints after it keeps the blur-dismiss from closing them instantly.
    requestAnimationFrame(() => { handle.showQuickHints!(); });
  };

  // UI-126: escalate the "starting" copy once the wait stops looking normal.
  const [slowStart, setSlowStart] = useState(false);
  useEffect(() => {
    if (pane.state !== "starting") { setSlowStart(false); return; }
    const t = setTimeout(() => setSlowStart(true), 20000);
    return () => clearTimeout(t);
  }, [pane.state, pane.epoch]);

  // QL-742: this pane's memory, but only while it's over the ceiling set in
  // Settings › Diagnostics. Read-only — the reading comes from the app-wide
  // 30s health cycle (poll.ts), not a per-pane poll, so six panes cost nothing
  // extra here. Clears itself when the pane drops back under or restarts.
  const memWarn = usePaneMemory(pane.id, pane.epoch);

  // QL-765/766: the same poll now also carries the latest turn's token split
  // and the model that produced it — both already in the transcript line the
  // context total is read from, so the chip and its tooltip cost nothing extra.
  interface PaneUsage {
    contextTokens: number;
    outputTokens: number;
    turns: number;
    model: string | null;
    lastInputTokens: number;
    lastCacheReadTokens: number;
    lastCacheCreationTokens: number;
    lastOutputTokens: number;
    // Codex only (null for Claude): the window the rollout states, and plan
    // rate-limit usage from its rate_limits block.
    contextWindow?: number | null;
    planUsedPercent5h?: number | null;
    planUsedPercentWeek?: number | null;
    apiEquivUsd?: number;
  }
  const [usage, setUsage] = useState<PaneUsage | null>(null);
  usePoll(async () => {
    try {
      setUsage(await cachedInvoke<PaneUsage | null>("pane_usage", { vendor: pane.vendor, cwd: pane.cwd }, 7000));
    } catch {
      setUsage(null);
    }
  }, 15000, [pane.cwd, pane.vendor, pane.epoch], paneVisible);

  // QL-769/770: subagent fan-out and plan mode, both read from the same Claude
  // Code transcripts the chip above reads — so both are Claude-only, and a pane
  // running anything else never calls either command.
  const isClaude = pane.vendor === RESUME_VENDOR;
  // Phase 3 chat view: Claude panes only. The terminal stays mounted (and keeps
  // receiving output) underneath; chat is an overlay inside .pbody.
  const setPaneView = useApp((s) => s.setPaneView);
  const view = isClaude && pane.view === "chat" ? "chat" : "terminal";
  const switchView = (v: "terminal" | "chat") => {
    setPaneView(pane.id, v);
    if (v === "terminal") requestAnimationFrame(() => getPaneSession(pane.id)?.term.focus());
  };
  const switchViewRef = useRef(switchView);
  switchViewRef.current = () => switchView(view === "chat" ? "terminal" : "chat");
  // Ctrl+Shift+M toggles the focused Claude pane. (Ctrl+Shift+V is the
  // terminal paste convention, so it is left alone.)
  useEffect(() => {
    if (!focused || !isClaude) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "M" || e.key === "m")) {
        e.preventDefault();
        e.stopPropagation();
        switchViewRef.current("terminal");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focused, isClaude]);
  const toggleFocusMode = () => {
    setMenuOpen(false);
    const on = !pane.focusMode;
    requestConfirm({
      title: on ? "Switch to Quiet terminal?" : "Switch to the full terminal?",
      body: "Claude restarts in " + (on ? "Quiet terminal" : "the full terminal") + " and picks up the same conversation.",
      confirmLabel: "Restart pane",
      onConfirm: () => { void setFocusModeKeepingSession(pane.id, on, getPaneSession(pane.id)?.ptyId ?? 0); },
    });
  };
  const [subCount, setSubCount] = useState<SubagentCount | null>(null);
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [subagentPos, setSubagentPos] = useState<{ top: number; left: number } | null>(null);
  const [plans, setPlans] = useState<PlanEntry[]>([]);
  const [planOpen, setPlanOpen] = useState(false);

  // Both ride the session usage poll cadence. pane_subagent_count is directory
  // metadata only (no transcript is opened) and pane_plans reads incrementally,
  // so this adds no measurable cost per pane — the popover's own faster poll
  // (SubagentTreeView) runs only while it's open.
  usePoll(async () => {
    if (!isClaude) { setSubCount(null); setPlans([]); return; }
    try {
      setSubCount(await cachedInvoke<SubagentCount>("pane_subagent_count", { cwd: pane.cwd }, 7000));
    } catch {
      setSubCount(null); // command not there yet → no chip, never a broken one
    }
    try {
      setPlans(await cachedInvoke<PlanEntry[]>("pane_plans", { cwd: pane.cwd }, 7000));
    } catch {
      setPlans([]);
    }
  }, 15000, [pane.cwd, pane.epoch, isClaude], paneVisible);

  const openSubagents = () => {
    const r = menuBtnRef.current?.getBoundingClientRect();
    if (r) setSubagentPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 372)) });
    closeMenu();
    setSubagentsOpen(true);
  };

  // The pending plan drives the header chip; an answered one is history and
  // only lives in the drawer's archive.
  const waitingPlan = pendingPlan(plans);

  // Approve types the prompt's own keystroke at this pane's PTY — the same
  // thing the user would press in the terminal, sent down the same channel
  // (Terminal's paste → pty_write). Nothing is written to the transcript here.
  const approvePlan = () => {
    terminalRef.current?.paste(PLAN_APPROVE_KEYS);
    setPlanOpen(false);
    focusPane(wsId, pane.id);
    pushToast("info", `Sent your approval to ${displayName}.`);
  };
  // Refine hands the pane back instead of answering for you: focus it and put
  // the caret in the terminal so the next keystroke is already the reply.
  const refinePlan = () => {
    setPlanOpen(false);
    focusPane(wsId, pane.id);
    paneRef.current?.querySelector<HTMLElement>("textarea.xterm-helper-textarea")?.focus();
  };

  // Keep the idle age current only while this pane is visible.
  const lastOutputRef = useRef(Date.now());
  const [, setIdleTick] = useState(0);
  const recordActivity = () => { lastOutputRef.current = Date.now(); };
  useEffect(() => {
    if (!paneVisible) return;
    const id = setInterval(() => setIdleTick((t) => t + 1), 4000);
    return () => clearInterval(id);
  }, [paneVisible]);

  // UX-553/554: register this pane's send function so bulk broadcast (from
  // ANY pane's selection toolbar/group action) can reach it — see PaneOps.tsx
  // and store.ts's paneSendRegistry doc comment for why this can't just be a
  // raw pty_write by store pane id.
  useEffect(() => {
    registerPaneSend(pane.id, (text) => terminalRef.current?.paste(text));
    return () => unregisterPaneSend(pane.id);
  }, [pane.id]);

  // QL-762: offer this pane's buffer to the session save. session.ts pulls it
  // on an idle callback (never on the save path itself) and caps what it keeps
  // — see its scrollback comment block. Degrades to "" on a Terminal that
  // predates the handle method rather than throwing mid-save.
  useEffect(() => {
    registerScrollbackSource(pane.id, () => {
      const handle = terminalRef.current as (TerminalHandle & { serializeScrollback?: () => string }) | null;
      return typeof handle?.serializeScrollback === "function" ? handle.serializeScrollback() : "";
    });
    return () => unregisterScrollbackSource(pane.id);
  }, [pane.id]);

  // UX-553: shift+click toggles this pane in/out of the cross-workspace
  // selection instead of the usual focus-on-mousedown. The lead pane (lowest
  // selected id, arbitrary but stable) is the one instance that portals the
  // bulk toolbar — otherwise every selected pane would render its own copy.
  const selectedIds = useApp((s) => s.selectedPaneIds);
  const togglePaneSelection = useApp((s) => s.togglePaneSelection);
  const clearSelection = useApp((s) => s.clearSelection);
  const selected = selectedIds.includes(pane.id);
  const isLeadSelected = selectedIds.length > 0 && selectedIds[0] === pane.id;

  // UX-559: a "waiting" pane whose last line reads as a genuine open
  // question (not a standard approval prompt) gets its own badge — the
  // generic "waiting" label undersells it (it's not idle, it's asking you
  // something specific). See attention.ts's isOpenQuestion + attentionQueue.
  const openQuestion = pane.state === "waiting" && isOpenQuestion(lastLine.get(pane.id));

  const cliHint = dead ? missingCliHint(pane.vendor, lastLine.get(pane.id)) : null;

  const stateWord = paneStateWord(pane.state, openQuestion, Date.now() - lastOutputRef.current);

  return (
    <div
      className={
        "pane" +
        (focused ? " focused" : "") +
        (maximized ? " pmax" : "") +
        (dragging ? " dragging" : "") +
        (dragOver ? " drop-target" : "") +
        (selected ? " selected" : "")
      }
      ref={paneRef}
      // UI-121: with six panes open, a neutral focus ring doesn't say WHICH
      // agent you're about to type at. The vendor's own colour does.
      style={focused ? ({ "--pane-accent": vendorColor(pane.vendor) } as React.CSSProperties) : undefined}
      onMouseDown={(e) => {
        // UX-553: shift+click toggles selection and does NOT steal focus —
        // a plain click elsewhere still clears a stale selection first, so
        // the bulk toolbar never lingers over an unrelated click.
        if (shouldBulkSelect(e.shiftKey, e.target as HTMLElement)) { e.preventDefault(); togglePaneSelection(pane.id); return; }
        if (selectedIds.length) clearSelection();
        focusPane(wsId, pane.id);
      }}
      onDragOver={(e) => { if (canReorder) { e.preventDefault(); onDragEnter(index); } }}
      onDrop={(e) => { if (canReorder) { e.preventDefault(); onDropHere(index); } }}
    >
      {isLeadSelected && <SelectionToolbar />}
      <div className={"pband " + pane.state + (openQuestion ? " question" : "")}>
        {/* UI-136: the status band already means "what is this pane doing" —
            a real progress figure belongs there, not in a separate widget. */}
        {progress != null && (
          <span
            className={"pband-fill" + (progress < 0 ? " indet" : "")}
            style={progress >= 0 ? { width: `${progress}%` } : undefined}
            title={progress >= 0 ? `${progress}% complete` : "Working…"}
          />
        )}
      </div>
      <div
        className={"phead" + (tintToken ? " tinted" : "")}
        style={tintToken ? ({ "--pane-tint": `var(${tintToken})` } as React.CSSProperties) : undefined}
        onDoubleClick={(e) => {
          // UI-116: double-click empty header space toggles maximise (ignore
          // clicks that land on a control or the rename field).
          if ((e.target as HTMLElement).closest("button, input, .pname, .prename, .pplan, .branch")) return;
          onToggleMaximize(pane.id);
        }}
        onAuxClick={(e) => {
          // UI-117: middle-click closes, through the same guard as the X.
          if (e.button === 1) { e.preventDefault(); tryClosePane(); }
        }}
      >
        {canReorder && (
          <span
            className="pgrip"
            draggable
            title="Drag to reorder"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              // UI-151: carry identity so a workspace tile can accept this pane.
              // The in-grid reorder path ignores it and still works on position.
              e.dataTransfer.setData(PANE_DRAG_TYPE, JSON.stringify({ wsId, paneId: pane.id }));
              onDragStart(index);
            }}
            onDragEnd={onDragEnd}
          >
            <IconDrag size={12} />
          </span>
        )}
        {/* UI-115: the dot is the primary status signal — say what it means
            and how long it's been that way. */}
        <span
          className={"pdot " + pane.state}
          title={`${STATE_TITLE[pane.state]} · ${duration(stateSince.get(pane.id) ?? Date.now())}`}
        />
        <VendorGlyph id={pane.vendor} size={15} title={vendorMeta(pane.vendor).label} />
        {editing ? (
          <input
            ref={nameRef}
            className="prename"
            value={draft}
            placeholder={vendorShort(pane.vendor)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setEditing(false);
              e.stopPropagation();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="pname" style={tintToken ? { color: "var(--pane-tint)" } : undefined} title={`${displayName} · double-click to rename`} onDoubleClick={() => setEditing(true)}>
            {displayName}
          </span>
        )}
        <span className="pstate" style={{ color: `var(--st-${stateWord.tone})` }}>{stateWord.text}</span>
        <span
          className="prepo prepo-click"
          role="button"
          tabIndex={0}
          title={`${pane.cwd} — click to open in Explorer`}
          onClick={() => { void revealPath(pane.cwd).catch(() => pushToast("error", "Couldn’t open that folder.")); }}
          onKeyDown={(e) => { if (e.key === "Enter") void revealPath(pane.cwd).catch(() => {}); }}
        >
          &middot; {baseName(pane.cwd)}
        </span>
        {/* UI-27: a git problem is worth one quiet word — silence reads as
            "not a repo", which may be wrong. */}
        {!gitStatus && gitError && (
          <span className="pgit-err" title={gitError}>git?</span>
        )}
        {gitStatus?.isRepo && (() => {
          // QL-740: unpushed/unpulled work belongs next to the branch, on every
          // repo pane (worktree or not). Silent when in sync or when there's no
          // upstream; tinted (same grammar as the Explorer's dirty pill) the
          // moment this branch is carrying commits nobody else has.
          const ab = aheadBehindLabel(gitStatus.ahead, gitStatus.behind);
          const unpushed = (gitStatus.ahead ?? 0) > 0;
          return (
          <span
            className={"branch branch-copy" + (unpushed ? " branch-unpushed" : "")}
            role="button"
            tabIndex={0}
            style={unpushed ? { color: "var(--accent)", borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))" } : undefined}
            title={`${gitStatus.branch} — click to copy${gitStatus.dirty ? " (uncommitted changes)" : ""}${aheadBehindTitle(gitStatus.ahead, gitStatus.behind)}`}
            onClick={() => copyText(gitStatus.branch ?? "", "Copied branch name")}
            onKeyDown={(e) => { if (e.key === "Enter") copyText(gitStatus.branch ?? "", "Copied branch name"); }}
          >
            <IconBranch size={11} /><span className="branch-name">{gitStatus.branch}</span>
            {ab && <span className="branch-ab" style={{ flex: "none", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{ab}</span>}
            {gitStatus.dirty && (
              <span aria-hidden className="dirty-dot" />
            )}
          </span>
          );
        })()}
        {/* UI-129: this pane is in the attention queue — show it where the user is looking.
            UX-559: an open question ranks above plain waiting (attention.ts) and gets its
            own label — "waiting" undersells a pane that's actively asking you something. */}
        {(pane.state === "permission" || pane.state === "error" || openQuestion) && (
          <span
            className={"pattn " + (openQuestion ? "permission" : pane.state)}
            title={openQuestion
              ? `Open Home · Ctrl+Shift+H. Asking a question: "${tailEllipsis(lastLine.get(pane.id) ?? "", 80)}"`
              : "Open Home · Ctrl+Shift+H"}
            role="button"
            tabIndex={0}
            onClick={() => useUI.getState().setHomeOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter") useUI.getState().setHomeOpen(true); }}
          >
            {pane.state === "permission" ? "Needs you" : openQuestion ? "Has a question" : "Error"}
          </span>
        )}
        {(() => {
          const chip = mcpChip(pane.id);
          return chip ? <span className="pattn mcp" title={chip.title}>{chip.label}</span> : null;
        })()}
        {/* QL-770: a plan is waiting to be read. Waiting tone, no bell, no
            queue entry (notification ruling) — it's a "when you look" signal. */}
        {isClaude && waitingPlan && (
          <span
            className="pplan"
            role="button"
            tabIndex={0}
            title={planChipTitle(waitingPlan)}
            onClick={() => setPlanOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter") setPlanOpen(true); }}
          >
            Plan ready
          </span>
        )}
        <span className="sp" />
        {dead && (
          <button
            className="prestart"
            onClick={() => restartPane(pane.id)}
            title={
              pane.state === "error"
                ? `${displayName} exited unexpectedly${lastExit ? ` (${lastExit})` : ""}. Restart it in the same folder.`
                : "Restart this pane in the same folder"
            }
          >
            <IconRefresh size={14} /> Restart
          </button>
        )}
        <button
          className={"pfindbtn" + (searchOpen ? " active" : "")}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          title="Find in scrollback"
        >
          <IconSearch size={17} />
        </button>
        <button className="pmaxbtn" onClick={() => onToggleMaximize(pane.id)} title={maximized ? "Restore" : "Maximise this pane"}>
          {maximized ? <IconMinimize size={17} /> : <IconMaximizePane size={17} />}
        </button>
        <div className="pmenu-wrap">
          <button ref={menuBtnRef} className="pmenubtn" onClick={() => (menuOpen ? closeMenu() : openMenu())} title="More actions">
            <IconOverflow size={17} />
          </button>
          {menuOpen && menuPos && createPortal(
            <div ref={menuRef} className="pmenu" style={{ top: menuPos.top, left: menuPos.left }} onMouseLeave={closeMenu}>
              <div className="pmenu-details" aria-label="Details">
                <div className="pmenu-details-title">Details</div>
                <div className="pmenu-detail"><span>Model</span><span>{usage?.model ? modelShort(usage.model) : "Unavailable"}</span></div>
                <div className="pmenu-detail"><span>Context</span><span>{usage ? `${compact(usage.contextTokens)} (${Math.round(usage.contextTokens / contextWindowFor(usage.model, usage.contextWindow) * 100)}%)` : "Unavailable"}</span></div>
                {memWarn && <div className="pmenu-detail"><span>Memory</span><span>{bytes(memWarn.memoryMb * 1024 * 1024)} (over {num(Math.round(memWarn.memoryWarnMb))} MB)</span></div>}
                {isClaude && subCount && subCount.total > 0 && <button className="pmenu-item" onClick={openSubagents}>Subagents...</button>}
              </div>
              <div className="pmenu-heading">View</div>
              {isClaude && <button className="pmenu-item" role="menuitemcheckbox" aria-checked={view === "chat"} onClick={() => { switchView(view === "chat" ? "terminal" : "chat"); closeMenu(); }} title="Chat view (Ctrl+Shift+M)">{view === "chat" ? "✓ " : ""}Chat view</button>}
              {isClaude && (
                <button className="pmenu-item" role="menuitemcheckbox" aria-checked={!!pane.focusMode} onClick={toggleFocusMode} title="Quiet Claude view: just your prompt, a one-line summary of each turn's tool work with edit counts, and Claude's final reply. Ctrl+O shows the full transcript. The mouse wheel scrolls the conversation. Switching restarts Claude and resumes the same conversation.">
                  {pane.focusMode ? "✓ " : ""}Quiet terminal
                </button>
              )}
              <button className="pmenu-item" onClick={() => { onToggleMaximize(pane.id); closeMenu(); }}>
                {maximized ? <IconMinimize size={13} /> : <IconMaximizePane size={13} />}
                {maximized ? "Restore" : "Maximise"}
              </button>
              <button className="pmenu-item" onClick={openStyle}>Colour and name…</button>
              <button className="pmenu-item" onClick={clearScrollback}>Clear scrollback</button>
              {vendorMeta(pane.vendor).kind === "shell" && (
                <>
                  <button className="pmenu-item" onClick={() => { terminalRef.current?.foldAllCommands(true); closeMenu(); }}>Fold all commands</button>
                  <button className="pmenu-item" onClick={() => { terminalRef.current?.foldAllCommands(false); closeMenu(); }}>Unfold all commands</button>
                </>
              )}
              <div className="pmenu-heading">Session</div>
              <button className="pmenu-item" title={lastExit ?? "Restart this pane in the same folder"} onClick={() => { restartPane(pane.id); closeMenu(); }}>
                <IconRefresh size={13} /> Restart
              </button>
              {/* QL-764: reopen one of this folder's past sessions in a new
                  pane (--resume, or --fork-session from the launcher). Claude
                  Code only — nothing else writes the transcripts it reads. */}
              {canResume(pane.vendor) && (
                <button className="pmenu-item" onClick={() => { setMenuOpen(false); openSessionLauncher(pane.id); }}>
                  <IconRefresh size={13} /> Resume a past session…
                </button>
              )}
              {/* UX-564: same cwd + vendor, a fresh process. */}
              <button className="pmenu-item" onClick={doDuplicate}>Duplicate pane</button>
              <button className="pmenu-item" onClick={() => { setMenuOpen(false); setTranscriptOpen(true); }}>
                <IconFile size={13} /> View transcript…
              </button>
              <div className="pmenu-heading">Folder</div>
              <div className="pmenu-path" title="This pane’s working directory">
                {pane.cwd}
                {/* UI-230: an isolated pane's worktree is a real disk cost —
                    say how much, where the pane itself is described. */}
                {pane.worktreePath && wtSize != null && (
                  <span className="pmenu-path-size">isolated worktree · {bytes(wtSize)}</span>
                )}
              </div>
              {gitStatus?.isRepo && (
                <button className="pmenu-item" onClick={() => { setReviewPane(pane.id); closeMenu(); }}>
                  <IconDiff size={13} /> Review changes
                </button>
              )}
              <button className="pmenu-item" onClick={copyCwd}>
                <IconFolder size={13} /> Copy working directory
              </button>
              <button className="pmenu-item" onClick={reveal}>
                <IconFolder size={13} /> Reveal in Explorer
              </button>
              {/* UX-579: worktrees were only reachable from Settings >
                  Diagnostics — jump straight there from wherever you're
                  actually looking at one. Shown on every pane (not just
                  isolated ones) since the inventory is app-wide, not
                  per-pane. */}
              <button
                className="pmenu-item"
                onClick={() => { closeMenu(); useUI.getState().openSettingsAt("Diagnostics"); }}
              >
                <IconFolder size={13} /> Worktree inventory
              </button>
              <details className="pmenu-more">
                <summary className="pmenu-heading">More</summary>
              {/* QL-754: the hint mode is invisible until you know the key —
                  name it here so it's discoverable from where people already
                  look for pane actions. */}
              <button className="pmenu-item" onClick={showQuickHints}>
                Pick a path or link…<span className="pmenu-key">Ctrl+Shift+Space</span>
              </button>
              <button className="pmenu-item" onClick={() => saveScrollback(false)}>Save scrollback to file</button>
              <button className="pmenu-item" onClick={() => saveScrollback(true)}>Save scrollback (redacted)</button>
              <button className="pmenu-item" onClick={copyLastCommand}>Copy last command</button>
              {/* UX-553/554: multi-select is shift+click on any pane; groups are managed here. */}
              <button className="pmenu-item" onClick={() => { setMenuOpen(false); setGroupsOpen(true); }}>
                Pane groups…
              </button>
              {/* UX-562/563: named snapshots of the whole session; export/import one workspace. */}
              <button className="pmenu-item" onClick={() => { setMenuOpen(false); setSnapshotsOpen(true); }}>
                Session snapshots…
              </button>
              <button className="pmenu-item" onClick={exportWorkspace}>Export this workspace…</button>
              <button className="pmenu-item" onClick={importWorkspace}>Import workspace…</button>
              <div className="pmenu-zoom">
                <span className="pmenu-zoom-label">Font size (this pane)</span>
                <div className="pmenu-zoom-controls">
                  <button onClick={() => setFontSize((f) => Math.max(MIN_FONT, f - 1))} title="Zoom out">&minus;</button>
                  <span>{fontSize}px</span>
                  <button onClick={() => setFontSize((f) => Math.min(MAX_FONT, f + 1))} title="Zoom in">+</button>
                  <button className="pmenu-zoom-reset" onClick={() => setFontSize(DEFAULT_FONT)} title="Reset to default">Reset</button>
                </div>
              </div>
              <div className="pmenu-row">
                <span>Ligatures</span>
                <button
                  className={"toggle" + (ligatures ? " on" : "")}
                  role="switch"
                  aria-checked={ligatures}
                  onClick={() => setLigatures((v) => !v)}
                  title="Toggle code ligatures for this pane"
                >
                  <span />
                </button>
              </div>
              {/* QL-758: OSC 52 — let this pane's process write the clipboard.
                  Off by default, per pane, and write-only: a read request is
                  never answered, whatever this is set to. */}
              <div className="pmenu-row">
                <span>Allow clipboard writes</span>
                <button
                  className={"toggle" + (osc52 ? " on" : "")}
                  role="switch"
                  aria-checked={osc52}
                  onClick={() => setOsc52((v) => !v)}
                  title="Let this pane's process copy to the clipboard (OSC 52). Reading the clipboard is never allowed."
                >
                  <span />
                </button>
              </div>
              <div className="pmenu-zoom">
                <span className="pmenu-zoom-label">Quiet threshold (waiting)</span>
                <div className="pmenu-zoom-controls">
                  <button onClick={() => setQuietSec((s) => Math.max(MIN_QUIET_SEC, s - 1))} title="Shorter">&minus;</button>
                  <span>{quietSec}s</span>
                  <button onClick={() => setQuietSec((s) => Math.min(MAX_QUIET_SEC, s + 1))} title="Longer">+</button>
                  <button className="pmenu-zoom-reset" onClick={() => setQuietSec(DEFAULT_QUIET_SEC)} title="Reset to default">Reset</button>
                </div>
                {/* UX-560: save the current value as this VENDOR's default, so
                    every new/restarted pane of this vendor starts here instead
                    of the built-in baseline — not just this one pane's session. */}
                <button
                  className="pmenu-zoom-vendor-default"
                  onClick={() => {
                    saveVendorQuietOverride(pane.vendor, quietSec);
                    pushToast("success", `${quietSec}s is now the default quiet threshold for ${vendorShort(pane.vendor)}.`);
                  }}
                  title={`Make ${quietSec}s the default for every ${vendorShort(pane.vendor)} pane`}
                >
                  Save as {vendorShort(pane.vendor)} default
                </button>
              </div>
              </details>
              <div className="pmenu-sep" />
              <button className="pmenu-item pmenu-danger" onClick={tryClosePane}>
                <IconClose size={13} /> Close pane
              </button>
            </div>,
            document.body
          )}
          {styleOpen && menuPos && createPortal(
            <>
              <div className="pstyle-scrim" onMouseDown={closeStyle} />
              <div
                className="pmenu pstyle"
                role="dialog"
                aria-label="Pane colour and name"
                style={{ top: menuPos.top, left: menuPos.left }}
              >
                <label className="pstyle-label" htmlFor={`pstyle-name-${pane.id}`}>Name</label>
                <input
                  id={`pstyle-name-${pane.id}`}
                  ref={styleNameRef}
                  className="pstyle-name"
                  value={styleDraft}
                  maxLength={60}
                  placeholder={vendorShort(pane.vendor)}
                  onChange={(e) => setStyleDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveStyle(); } }}
                />
                <span className="pstyle-label" id={`pstyle-col-${pane.id}`}>Colour</span>
                <div className="pstyle-swatches" role="radiogroup" aria-labelledby={`pstyle-col-${pane.id}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!pane.color}
                    aria-label="None"
                    title="None"
                    className="pstyle-swatch none"
                    onClick={() => setPaneColor(pane.id, undefined)}
                  />
                  {PANE_SWATCHES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={pane.color === s.id}
                      aria-label={s.label}
                      title={s.label}
                      className="pstyle-swatch"
                      style={{ background: `var(${s.token})` }}
                      onClick={() => setPaneColor(pane.id, s.id)}
                    />
                  ))}
                </div>
                <div className="pstyle-actions">
                  <button type="button" className="pstyle-save" onClick={saveStyle}>Save</button>
                </div>
              </div>
            </>,
            document.body
          )}
        </div>
        <span className="pclose-divider" aria-hidden="true" />
        <button className="x" onClick={tryClosePane} title="Close pane"><IconClose size={16} /></button>
      </div>
      <div
        className={"pbody" + (bell ? " bell" : "")}
        onContextMenu={(e) => {
          e.preventDefault();
          // H2: Windows Terminal style. A right-click over a link never gets
          // here (Terminal.tsx's capture listener opens LinkMenu and stops it).
          const t = terminalRef.current;
          const sel = t?.getSelection() ?? "";
          const act = rightClickAction({
            hasSelection: !!sel, overLink: false, mouseTracking: !!t?.isMouseTracking(),
            shift: e.shiftKey, setting: getTerminalSettings().rightClick,
            agentVendor: vendorMeta(pane.vendor).kind === "agent",
            confirmPaste: shouldConfirmPaste({ attention: attentionKind(pane), focused }),
          });
          if (act === "app") return;
          if (act === "copy") {
            void navigator.clipboard.writeText(sel).catch(() => pushToast("error", "Couldn’t copy: clipboard unavailable."));
            t?.clearSelection();
            return;
          }
          if (act === "paste") { void pasteFromClipboard(); return; }
          if (act === "paste-confirm") { void pasteFromClipboard(true); return; }
          setCtxMenu({ x: e.clientX, y: e.clientY, hasSel: !!sel });
        }}
      >
        {cliHint && (
          <div className="pmissing-cli" role="status">
            <strong>Claude Code isn't installed or isn't on PATH.</strong>
            <div className="pmissing-cli-command">
              <code>{cliHint}</code>
              <button onClick={() => void copyText(cliHint, "Copied install command.")}>Copy</button>
            </div>
            <span>Run it in PowerShell outside Flightdeck, then press Restart.</span>
          </div>
        )}
        {pane.state === "starting" && (
          <div className="plaunching" aria-live="polite">
            {/* UI-127: a setup phase is a different wait from a slow agent — say which. */}
            {pane.needsSetup && setupCmd
              ? <>Running setup: <code>{setupCmd}</code><span className="plaunching-sub">the agent starts once this finishes</span></>
              : <>Launching {vendorShort(pane.vendor)}…<span className="plaunching-sub">
                  {/* UI-126: after 20s, stop saying "a few seconds" and suggest a cause. */}
                  {slowStart ? "still starting: the agent may be waiting on sign-in, check its output" : "first output can take a few seconds"}
                </span></>}
          </div>
        )}
        {/* UI-128: scrolled up on a chatty agent, it's easy to lose track of
            whether output is still arriving — and of how to get back. */}
        {behind > 0 && (
          <button
            className="pscroll-tail"
            onClick={() => { terminalRef.current?.scrollToBottom(); setBehind(0); }}
            title="Jump to the newest output"
          >
            ↓ {behind > 999 ? "999+" : behind} new
          </button>
        )}
        {searchOpen && view === "terminal" && (
          <div className="pfind">
            <IconSearch size={12} />
            <input
              ref={findRef}
              value={query}
              placeholder="Find in this pane…"
              onChange={(e) => { const v = e.target.value; setQuery(v); runFind(v, "next"); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); runFind(query, e.shiftKey ? "prev" : "next"); }
                else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
                e.stopPropagation();
              }}
              onMouseDown={(e) => e.stopPropagation()}
            />
            <span className="pfind-count">
              {matchInfo ? (matchInfo.count === 0 ? "0/0" : `${matchInfo.index + 1}/${matchInfo.count}`) : ""}
            </span>
            <button onClick={() => runFind(query, "prev")} title="Previous match (Shift+Enter)">
              <IconChevron size={12} style={{ transform: "rotate(-90deg)" }} />
            </button>
            <button onClick={() => runFind(query, "next")} title="Next match (Enter)">
              <IconChevron size={12} style={{ transform: "rotate(90deg)" }} />
            </button>
            <button onClick={closeSearch} title="Close find (Esc)"><IconClose size={12} /></button>
          </div>
        )}
        <Terminal
          key={pane.epoch}
          ref={terminalRef}
          modelId={pane.id}
          epoch={pane.epoch}
          focusMode={isClaude && !!pane.focusMode}
          vendor={pane.vendor}
          cwd={pane.cwd}
          initialDraft={pane.draft}
          restoredScrollback={pane.epoch === 0 ? restoredScrollback : undefined}
          osc52={osc52}
          setup={pane.needsSetup ? setupCmd : undefined}
          onSetupConsumed={() => clearNeedsSetup(pane.id)}
          fontSize={fontSize}
          ligatures={ligatures}
          quietThresholdMs={quietSec * 1000}
          onExit={(crashed) => {
            setLastExit(crashed ? "crashed" : "exited cleanly");
            setExitEpoch(pane.epoch);
            clearMcpNotices(pane.id); // SF4: a dead process has no MCP servers
            bumpMcp((n) => n + 1);
            setPaneState(pane.id, crashed ? "error" : "idle");
          }}
          onState={(st) => setPaneState(pane.id, st as PaneState)}
          onProc={setProcName}
          onBell={pulseBell}
          onLine={(l) => { lastLine.set(pane.id, l); if (noteMcpLine(pane.id, l)) bumpMcp((n) => n + 1); recordActivity(); }}
          onScrollAway={setBehind}
          onProgress={setProgress}
        />
        {view === "chat" && (
          <Suspense fallback={<div role="status" style={{ position: "absolute", inset: 0, zIndex: 4, display: "grid", placeItems: "center", background: "var(--surface)", color: "var(--muted)", fontSize: 12.5 }}>Loading chat...</div>}>
            <ChatView
              paneId={pane.id}
              cwd={pane.cwd}
              epoch={pane.epoch}
              paneState={pane.state}
              exited={exitEpoch === pane.epoch}
              onRestart={() => restartPane(pane.id)}
              active={paneVisible}
              onSwitchToTerminal={() => switchView("terminal")}
            />
          </Suspense>
        )}
      </div>
      {ctxMenu && createPortal(
        <div
          className="pmenu pctx"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          {vendorMeta(pane.vendor).kind === "agent" && (
            <button className="pmenu-item" onClick={() => {
              void writeToPane(pane.id, "\x1b").catch(() => pushToast("error", "Couldn't interrupt agent."));
              setCtxMenu(null);
            }}>Interrupt agent</button>
          )}
          <button className="pmenu-item" disabled={!ctxMenu.hasSel} onClick={() => { void terminalRef.current?.copySelection(); setCtxMenu(null); }}>
            Copy
          </button>
          <button className="pmenu-item" onClick={() => void pasteFromClipboard()}>Paste</button>
          <button className="pmenu-item" onClick={() => { terminalRef.current?.selectAll(); setCtxMenu(null); }}>Select all</button>
          <div className="pmenu-sep" />
          <button className="pmenu-item" onClick={() => { setCtxMenu(null); setSearchOpen(true); }}>Find…</button>
          <button className="pmenu-item" onClick={clearScrollback}>Clear scrollback</button>
        </div>,
        document.body
      )}
      <Transcript
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
        paneName={displayName}
        getScrollback={getScrollback}
      />
      {/* QL-769/770: both are per-pane surfaces, mounted here beside the
          transcript browser for the same reason — they describe THIS pane's
          session and close with it. */}
      <SubagentTree
        open={subagentsOpen}
        onClose={() => setSubagentsOpen(false)}
        pos={subagentPos}
        cwd={pane.cwd}
        epoch={pane.epoch}
      />
      <PlanPanel
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        paneName={displayName}
        plans={plans}
        onApprove={approvePlan}
        onRefine={refinePlan}
      />
      <GroupsPanel open={groupsOpen} onClose={() => setGroupsOpen(false)} />
      <SessionSnapshots open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} />
      {/* UX-563: hidden file input backing "Import workspace…" above — no
          Tauri file-open IPC used here (see the export/import comment near
          exportWorkspace), so this is a plain <input type=file>. */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow re-importing the same filename later
          if (file) void onImportFile(file);
        }}
      />
    </div>
  );
}

// UI-226: the store ticks constantly (pane state, activity, polls), and without
// this every tick re-rendered every pane — each of which owns an xterm. Props
// are all primitives plus the pane object and stable callbacks, so the default
// shallow compare is correct.
export const PaneView = memo(PaneViewInner);
