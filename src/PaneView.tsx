import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { revealPath } from "./reveal";
import { useApp, registerPaneSend, unregisterPaneSend, type PaneModel, type PaneState } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { Terminal, type TerminalHandle } from "./Terminal";
import {
  IconBranch, IconClose, IconRefresh, IconDrag, IconOverflow,
  IconMaximizePane, IconMinimize, IconFolder, IconChevron, IconDiff, IconBoard, IconFile,
} from "./Icons";
import type { DiffSummary } from "./worktrees";
import { cachedInvoke, usePoll, useVisible, usePaneMemory } from "./poll";
import { compact, num, duration, bytes, relTime, tailEllipsis } from "./format";
import { stateSince, lastLine, isOpenQuestion, STATE_LABEL as STATE_TITLE } from "./attention";
import "./panes.css";

import { vendorShort, vendorMeta, vendorColor } from "./vendors";
import { VendorGlyph } from "./VendorGlyph";
import { closePaneWithCleanup } from "./worktrees";
import { useBoardStore, useCardForPane } from "./board/boardStore";
import { Transcript } from "./TranscriptView";
import { extractLastCommand, redactText, scrollbackFilename, toLines } from "./transcript";
import { SelectionToolbar, GroupsPanel, SessionSnapshots } from "./PaneOps";
import { parseWorkspaceDef, serializeWorkspaceExport } from "./snapshots";
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
        "This pane is still live. Closing it ends the session — the running agent can’t be brought back." +
        (isolated ? " Its worktree will be cleaned up (you’ll be asked about unmerged work)." : ""),
      confirmLabel: "Close & end session",
      danger: true,
      onConfirm: () => closePaneWithCleanup(wsId, pane),
    });
  };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.title ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  // UI-140: font zoom is a per-agent habit (agy's TUI runs denser than
  // claude's), so remember it per vendor rather than resetting every pane.
  const [fontSize, setFontSizeRaw] = useState(() => loadVendorFont(pane.vendor));
  const setFontSize = (next: number | ((f: number) => number)) => {
    setFontSizeRaw((f) => {
      const v = typeof next === "function" ? next(f) : next;
      saveVendorFont(pane.vendor, v);
      return v;
    });
  };
  const [ligatures, setLigatures] = useState(false);
  // UI-237: start from THIS vendor's own threshold (agy idles longer than
  // claude; a shell is idle at once) — UX-560: or the user's saved override
  // for that vendor, if they've set one from any pane's menu. The per-pane
  // slider still overrides it for just this pane's session.
  const [quietSec, setQuietSec] = useState(
    () => loadVendorQuietOverride(pane.vendor) ?? vendorMeta(pane.vendor).quietSeconds ?? DEFAULT_QUIET_SEC
  );
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
  // Diff-stat badge for isolated panes: "what did this agent change" at a
  // glance, polled on the same cadence as the branch pill. Click → review drawer.
  const [diffStat, setDiffStat] = useState<{ files: number; added: number; deleted: number } | null>(null);
  const [diffPulse, setDiffPulse] = useState(false);
  const setReviewPane = useUI((s) => s.setReviewPane);
  // Live foreground process name (backend pty://proc via Terminal's onProc).
  const [procName, setProcName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
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
  useEffect(() => {
    if (!procName) return;
    const s = procSamples.current;
    if (s[s.length - 1]?.name !== procName) s.push({ name: procName, at: Date.now() });
  }, [procName]);
  useEffect(() => {
    if (!procName) return;
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
  }, [procName, pane.title, pane.id, renamePane]);

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

  useEffect(() => {
    if (!editing) return;
    setDraft(pane.title ?? "");
    nameRef.current?.focus();
    nameRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commitRename = () => {
    renamePane(pane.id, draft);
    setEditing(false);
  };

  // Shared clipboard helper (UI-119 and friends) — one toast style for all copies.
  const copyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", okMsg);
    } catch {
      pushToast("error", "Couldn’t copy — clipboard unavailable.");
    }
  };

  const copyCwd = async () => {
    try {
      await navigator.clipboard.writeText(pane.cwd);
      pushToast("success", "Copied working directory.");
    } catch {
      pushToast("error", "Couldn’t copy — clipboard unavailable.");
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
    pushToast("success", `Duplicated ${displayName ? displayName : "pane"} — same folder, fresh process.`);
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

  // Diff-stat badge (UI-23): isolated panes diff against their recorded base
  // branch; plain repo panes diff against HEAD (uncommitted changes) — either
  // way, a glanceable "what's changed here" that opens the review drawer.
  const inRepo = !!pane.worktreePath || !!gitStatus?.isRepo;
  usePoll(async () => {
    if (!inRepo) { setDiffStat(null); return; }
    try {
      const s = await cachedInvoke<DiffSummary>(
        "git_diff_summary",
        { cwd: pane.cwd, base: pane.baseBranch ?? null },
        GIT_POLL_MS / 2
      );
      const next = { files: s.files.length, added: s.totalAdded, deleted: s.totalDeleted };
      // UI-118: the badge is easy to miss on a busy grid — pulse it when the
      // agent actually changes something.
      setDiffStat((prev) => {
        if (prev && (prev.added !== next.added || prev.deleted !== next.deleted || prev.files !== next.files)) {
          setDiffPulse(true);
          window.setTimeout(() => setDiffPulse(false), 1200);
        }
        return next;
      });
    } catch {
      setDiffStat(null);
    }
  }, GIT_POLL_MS, [pane.cwd, pane.epoch, pane.baseBranch, inRepo], paneVisible);

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
  const pasteFromClipboard = async () => {
    setCtxMenu(null);
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { pushToast("error", "Couldn’t read the clipboard."); return; }
    if (!text) return;
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0).length;
    if (lines > 1) {
      requestConfirm({
        title: `Paste ${lines} lines into ${displayName}?`,
        body: "Multi-line pastes can run every line at once in a shell. Check it’s what you meant to send.",
        confirmLabel: `Paste ${lines} lines`,
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

  const [usage, setUsage] = useState<{ contextTokens: number; outputTokens: number; turns: number } | null>(null);
  usePoll(async () => {
    try {
      setUsage(await cachedInvoke<{ contextTokens: number; outputTokens: number; turns: number } | null>(
        "pane_usage", { cwd: pane.cwd }, 7000
      ));
    } catch {
      setUsage(null);
    }
  }, 15000, [pane.cwd, pane.epoch], paneVisible);

  // UX-556/557: activity sparkline + idle-time, kept cheap on purpose. Output
  // arrives far more often than the header should re-render, so a ref-backed
  // ring buffer counts lines per bucket on the hot path (onLine below) and a
  // slow, visibility-gated tick is the ONLY thing that triggers a redraw —
  // never a per-line state write. Off-screen panes (paneVisible false) don't
  // even run that tick, matching every other poll in this file.
  const ACTIVITY_BUCKETS = 16;
  const BUCKET_MS = 3000;
  const activityRef = useRef<number[]>(new Array(ACTIVITY_BUCKETS).fill(0));
  const bucketStart = useRef(Date.now());
  const lastOutputRef = useRef(Date.now());
  const [activityTick, setActivityTick] = useState(0);
  const recordActivity = () => {
    const now = Date.now();
    lastOutputRef.current = now;
    const shift = Math.floor((now - bucketStart.current) / BUCKET_MS);
    if (shift > 0) {
      const arr = activityRef.current;
      for (let i = 0; i < Math.min(shift, arr.length); i++) { arr.shift(); arr.push(0); }
      bucketStart.current += shift * BUCKET_MS;
    }
    activityRef.current[activityRef.current.length - 1]++;
  };
  useEffect(() => {
    if (!paneVisible) return;
    const id = setInterval(() => setActivityTick((t) => t + 1), 4000);
    return () => clearInterval(id);
  }, [paneVisible]);
  const activityBars = useMemo(() => {
    const counts = activityRef.current;
    const max = Math.max(1, ...counts);
    return counts.map((c) => Math.round((c / max) * 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityTick]);
  const IDLE_SHOW_MS = 60_000;
  // Re-read on every render; the 4s tick above is what makes this move.
  const idleLabel = paneVisible && Date.now() - lastOutputRef.current > IDLE_SHOW_MS ? relTime(lastOutputRef.current) : null;

  // UX-573: this pane's linked board card, if any — click focuses it on the
  // board. Read-only from here; the board owns the card (board/boardStore.ts).
  const card = useCardForPane(wsId, pane.id);
  const focusCardOnBoard = () => {
    useBoardStore.getState().setFocusCardId(card!.id);
    useUI.getState().setActiveView("board");
  };

  // UX-553/554: register this pane's send function so bulk broadcast (from
  // ANY pane's selection toolbar/group action) can reach it — see PaneOps.tsx
  // and store.ts's paneSendRegistry doc comment for why this can't just be a
  // raw pty_write by store pane id.
  useEffect(() => {
    registerPaneSend(pane.id, (text) => terminalRef.current?.paste(text));
    return () => unregisterPaneSend(pane.id);
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
        if (e.shiftKey) { e.preventDefault(); togglePaneSelection(pane.id); return; }
        if (selectedIds.length) clearSelection();
        focusPane(wsId, pane.id);
      }}
      onDragOver={(e) => { if (canReorder) { e.preventDefault(); onDragEnter(index); } }}
      onDrop={(e) => { if (canReorder) { e.preventDefault(); onDropHere(index); } }}
    >
      {isLeadSelected && <SelectionToolbar />}
      <div className={"pband " + pane.state}>
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
        className="phead"
        onDoubleClick={(e) => {
          // UI-116: double-click empty header space toggles maximise (ignore
          // clicks that land on a control or the rename field).
          if ((e.target as HTMLElement).closest("button, input, .pdiff, .ptok, .branch")) return;
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
          <span className="pname" title={`${displayName} — double-click to rename`} onDoubleClick={() => setEditing(true)}>
            {displayName}
          </span>
        )}
        {/* UX-556/557: activity sparkline + idle readout. The bars stay quiet
            and small on purpose (glance-only, no numbers) — the idle label
            only appears once there's actually something to say (>60s since
            output), so a busy pane shows nothing extra at all. */}
        <span className="pspark" title={`Activity — last output ${relTime(lastOutputRef.current)}`}>
          <span className="pspark-bars">
            {activityBars.map((h, i) => <span key={i} className="pspark-bar" style={{ height: `${Math.max(8, h)}%` }} />)}
          </span>
          {idleLabel && <span className="pspark-idle">idle {idleLabel}</span>}
        </span>
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
        {/* UX-555 folds this into the pane name itself (auto-title), so the
            chip only needs to appear when the two disagree — a manual
            rename, or the moment before the first auto-title lands. */}
        {procName && procName !== displayName && <span className="pproc" title="Live process (pane name doesn’t match)">{procName}</span>}
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
        {/* UX-573: this pane dispatched (or was dispatched from) a board
            card — click focuses it there. Read-only linkage; the board owns
            the card. */}
        {card && (
          <span
            className="pcard"
            role="button"
            tabIndex={0}
            title={`Board card: ${card.title} — click to focus it on the board`}
            onClick={focusCardOnBoard}
            onKeyDown={(e) => { if (e.key === "Enter") focusCardOnBoard(); }}
          >
            <IconBoard size={11} /> {tailEllipsis(card.title, 16)}
          </span>
        )}
        {/* UI-129: this pane is in the attention queue — show it where the user is looking.
            UX-559: an open question ranks above plain waiting (attention.ts) and gets its
            own label — "waiting" undersells a pane that's actively asking you something. */}
        {(pane.state === "permission" || pane.state === "error" || openQuestion) && (
          <span
            className={"pattn " + (openQuestion ? "permission" : pane.state)}
            title={
              pane.state === "permission"
                ? "Blocked on your approval — open the attention queue (Ctrl+Shift+A)"
                : openQuestion
                  ? `Asking a question: "${tailEllipsis(lastLine.get(pane.id) ?? "", 80)}" — open the attention queue (Ctrl+Shift+A)`
                  : "Errored — open the attention queue (Ctrl+Shift+A)"
            }
            role="button"
            tabIndex={0}
            onClick={() => useUI.getState().setAttentionOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter") useUI.getState().setAttentionOpen(true); }}
          >
            {pane.state === "permission" ? "needs you" : openQuestion ? "has a question" : "error"}
          </span>
        )}
        {usage && (() => {
          // UI-231: a raw token count doesn't tell you when you're in trouble.
          // Colour it against the model's context window so "compact soon" is
          // visible before the agent starts dropping context.
          const CONTEXT_WINDOW = 200_000; // Claude's window; manifests can override later
          const pct = usage.contextTokens / CONTEXT_WINDOW;
          const level = pct >= 0.9 ? "crit" : pct >= 0.7 ? "warn" : "";
          return (
            <span
              className={"ptok " + level}
              title={
                `Session tokens (from the agent’s own transcript)
` +
                `context now: ${num(usage.contextTokens)} (${Math.round(pct * 100)}% of a ${compact(CONTEXT_WINDOW)} window)
` +
                `output so far: ${num(usage.outputTokens)} across ${num(usage.turns)} turns` +
                (level ? `

Running low — consider /compact in this pane.` : "")
              }
            >
              {compact(usage.contextTokens)} ctx
            </span>
          );
        })()}
        {/* QL-742: over the memory ceiling. Same chip geometry and amber tone
            as the token chip's warn level — this is a resource reading worth a
            look, not an alert, so it stays out of the .pattn (pulsing,
            needs-you) grammar and never rings the bell. */}
        {memWarn && (
          <span
            className="ptok pmem warn"
            title={
              `Memory: ${bytes(memWarn.memoryMb * 1024 * 1024)}
` +
              `over the ${num(Math.round(memWarn.memoryWarnMb))} MB ceiling (Settings › Diagnostics)
` +
              `Checked every 30s. Restarting this pane clears it.`
            }
          >
            {bytes(memWarn.memoryMb * 1024 * 1024)} mem
          </span>
        )}
        {diffStat && diffStat.files > 0 && (
          <button
            className={"pdiff" + (diffPulse ? " pulsing" : "")}
            onClick={() => setReviewPane(pane.id)}
            title={`${diffStat.files} file${diffStat.files === 1 ? "" : "s"} changed — review & merge`}
          >
            <IconDiff size={11} />
            <em className="add">+{diffStat.added}</em>
            <em className="del">−{diffStat.deleted}</em>
          </button>
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
            <div className="pmenu" style={{ top: menuPos.top, left: menuPos.left }} onMouseLeave={closeMenu}>
              <div className="pmenu-path" title="This pane’s working directory">
                {pane.cwd}
                {/* UI-230: an isolated pane's worktree is a real disk cost —
                    say how much, where the pane itself is described. */}
                {pane.worktreePath && wtSize != null && (
                  <span className="pmenu-path-size">isolated worktree · {bytes(wtSize)}</span>
                )}
              </div>
              <button className="pmenu-item" onClick={clearScrollback}>Clear scrollback</button>
              <button className="pmenu-item" onClick={() => { restartPane(pane.id); closeMenu(); }}>
                <IconRefresh size={13} /> Restart
              </button>
              <button className="pmenu-item" onClick={() => { onToggleMaximize(pane.id); closeMenu(); }}>
                {maximized ? <IconMinimize size={13} /> : <IconMaximizePane size={13} />}
                {maximized ? "Restore" : "Maximise"}
              </button>
              {/* UI-27: a git problem is worth one quiet word — silence reads as
            "not a repo", which may be wrong. */}
        {!gitStatus && gitError && (
          <span className="pgit-err" title={gitError}>git?</span>
        )}
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
              <div className="pmenu-sep" />
              {/* UX-546/547/549: transcript browser + scrollback export + last-command copy. */}
              <button className="pmenu-item" onClick={() => { setMenuOpen(false); setTranscriptOpen(true); }}>
                <IconFile size={13} /> View transcript…
              </button>
              <button className="pmenu-item" onClick={() => saveScrollback(false)}>Save scrollback to file</button>
              <button className="pmenu-item" onClick={() => saveScrollback(true)}>Save scrollback (redacted)</button>
              <button className="pmenu-item" onClick={copyLastCommand}>Copy last command</button>
              <div className="pmenu-sep" />
              {/* UX-564: same cwd + vendor, a fresh process. */}
              <button className="pmenu-item" onClick={doDuplicate}>Duplicate pane</button>
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
              <div className="pmenu-sep" />
              <button className="pmenu-item pmenu-danger" onClick={tryClosePane}>
                <IconClose size={13} /> Close pane
              </button>
            </div>,
            document.body
          )}
        </div>
        <button className="x" onClick={tryClosePane} title="Close pane"><IconClose size={16} /></button>
      </div>
      <div
        className={"pbody" + (bell ? " bell" : "")}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY, hasSel: !!terminalRef.current?.getSelection() });
        }}
      >
        {pane.state === "starting" && (
          <div className="plaunching" aria-live="polite">
            {/* UI-127: a setup phase is a different wait from a slow agent — say which. */}
            {pane.needsSetup && setupCmd
              ? <>Running setup: <code>{setupCmd}</code><span className="plaunching-sub">the agent starts once this finishes</span></>
              : <>Launching {vendorShort(pane.vendor)}…<span className="plaunching-sub">
                  {/* UI-126: after 20s, stop saying "a few seconds" and suggest a cause. */}
                  {slowStart ? "still starting — the agent may be waiting on sign-in, check its output" : "first output can take a few seconds"}
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
        {searchOpen && (
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
          vendor={pane.vendor}
          cwd={pane.cwd}
          initialDraft={pane.draft}
          setup={pane.needsSetup ? setupCmd : undefined}
          onSetupConsumed={() => clearNeedsSetup(pane.id)}
          fontSize={fontSize}
          ligatures={ligatures}
          quietThresholdMs={quietSec * 1000}
          onExit={(crashed) => {
            setLastExit(crashed ? "crashed" : "exited cleanly");
            setPaneState(pane.id, crashed ? "error" : "idle");
          }}
          onState={(st) => setPaneState(pane.id, st as PaneState)}
          onProc={setProcName}
          onBell={pulseBell}
          onLine={(l) => { lastLine.set(pane.id, l); recordActivity(); }}
          onScrollAway={setBehind}
          onProgress={setProgress}
        />
      </div>
      {ctxMenu && createPortal(
        <div
          className="pmenu pctx"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
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
