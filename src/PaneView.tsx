import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { revealPath } from "./reveal";
import { useApp, type PaneModel, type PaneState } from "./store";
import { useUI } from "./ui";
import { Terminal, type TerminalHandle } from "./Terminal";
import {
  IconBranch, IconClose, IconRefresh, IconDrag, IconOverflow,
  IconMaximizePane, IconMinimize, IconFolder, IconChevron, IconDiff, IconBoard,
} from "./Icons";
import type { DiffSummary } from "./worktrees";
import { cachedInvoke, usePoll, useVisible } from "./poll";
import { compact, num, duration, bytes, relTime, tailEllipsis } from "./format";
import { stateSince, lastLine, STATE_LABEL as STATE_TITLE } from "./attention";
import "./panes.css";

import { vendorShort, vendorMeta, vendorColor } from "./vendors";
import { VendorGlyph } from "./VendorGlyph";
import { closePaneWithCleanup } from "./worktrees";
import { useBoardStore, useCardForPane } from "./board/boardStore";
const MIN_FONT = 9;
const MAX_FONT = 22;
const DEFAULT_FONT = 13;
const MIN_QUIET_SEC = 1;
const MAX_QUIET_SEC = 30;
const DEFAULT_QUIET_SEC = 3;
const GIT_POLL_MS = 30000;
/** UI-151: drag payload identifying a pane being moved between workspaces. */
export const PANE_DRAG_TYPE = "application/x-flightdeck-pane";

interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
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
        "This pane is still live. Closing it ends the session — the running agent can't be brought back." +
        (isolated ? " Its worktree will be cleaned up (you'll be asked about unmerged work)." : ""),
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
  // claude; a shell is idle at once). The per-pane slider still overrides it.
  const [quietSec, setQuietSec] = useState(() => vendorMeta(pane.vendor).quietSeconds || DEFAULT_QUIET_SEC);
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
  const lastAutoTitle = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!procName || procName === pane.title) return;
    if (pane.title && pane.title !== lastAutoTitle.current) return; // manual rename — leave it
    renamePane(pane.id, procName);
    lastAutoTitle.current = procName;
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

  // Esc closes the overflow menu (UI-30) — was mouse-leave only.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menuOpen]);

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
      pushToast("error", "Couldn't copy — clipboard unavailable.");
    }
  };

  const copyCwd = async () => {
    try {
      await navigator.clipboard.writeText(pane.cwd);
      pushToast("success", "Copied working directory.");
    } catch {
      pushToast("error", "Couldn't copy — clipboard unavailable.");
    }
    setMenuOpen(false);
  };

  const reveal = async () => {
    try {
      await revealPath(pane.cwd);
    } catch {
      pushToast("error", "Couldn't open Explorer for this folder.");
    }
    setMenuOpen(false);
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
        ? "git isn't installed or isn't on PATH"
        : "couldn't read git status for this folder");
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

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey, true); };
  }, [ctxMenu]);

  // UI-133: pasting many lines into a shell can execute them all — confirm
  // first. Single-line pastes go straight through.
  const pasteFromClipboard = async () => {
    setCtxMenu(null);
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { pushToast("error", "Couldn't read the clipboard."); return; }
    if (!text) return;
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0).length;
    if (lines > 1) {
      requestConfirm({
        title: `Paste ${lines} lines into ${displayName}?`,
        body: "Multi-line pastes can run every line at once in a shell. Check it's what you meant to send.",
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
    pushToast("info", "Cleared this pane's scrollback.");
  };

  // UI-126: escalate the "starting" copy once the wait stops looking normal.
  const [slowStart, setSlowStart] = useState(false);
  useEffect(() => {
    if (pane.state !== "starting") { setSlowStart(false); return; }
    const t = setTimeout(() => setSlowStart(true), 20000);
    return () => clearTimeout(t);
  }, [pane.state, pane.epoch]);

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

  return (
    <div
      className={
        "pane" +
        (focused ? " focused" : "") +
        (maximized ? " pmax" : "") +
        (dragging ? " dragging" : "") +
        (dragOver ? " drop-target" : "")
      }
      ref={paneRef}
      // UI-121: with six panes open, a neutral focus ring doesn't say WHICH
      // agent you're about to type at. The vendor's own colour does.
      style={focused ? ({ "--pane-accent": vendorColor(pane.vendor) } as React.CSSProperties) : undefined}
      onMouseDown={() => focusPane(wsId, pane.id)}
      onDragOver={(e) => { if (canReorder) { e.preventDefault(); onDragEnter(index); } }}
      onDrop={(e) => { if (canReorder) { e.preventDefault(); onDropHere(index); } }}
    >
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
          onClick={() => { void revealPath(pane.cwd).catch(() => pushToast("error", "Couldn't open that folder.")); }}
          onKeyDown={(e) => { if (e.key === "Enter") void revealPath(pane.cwd).catch(() => {}); }}
        >
          &middot; {baseName(pane.cwd)}
        </span>
        {/* UX-555 folds this into the pane name itself (auto-title), so the
            chip only needs to appear when the two disagree — a manual
            rename, or the moment before the first auto-title lands. */}
        {procName && procName !== displayName && <span className="pproc" title="Live process (pane name doesn't match)">{procName}</span>}
        {/* UI-27: a git problem is worth one quiet word — silence reads as
            "not a repo", which may be wrong. */}
        {!gitStatus && gitError && (
          <span className="pgit-err" title={gitError}>git?</span>
        )}
        {gitStatus?.isRepo && (
          <span
            className="branch branch-copy"
            role="button"
            tabIndex={0}
            title={`${gitStatus.branch} — click to copy${gitStatus.dirty ? " (uncommitted changes)" : ""}`}
            onClick={() => copyText(gitStatus.branch ?? "", "Copied branch name")}
            onKeyDown={(e) => { if (e.key === "Enter") copyText(gitStatus.branch ?? "", "Copied branch name"); }}
          >
            <IconBranch size={11} /><span className="branch-name">{gitStatus.branch}</span>
            {gitStatus.dirty && (
              <span aria-hidden className="dirty-dot" />
            )}
          </span>
        )}
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
        {/* UI-129: this pane is in the attention queue — show it where the user is looking. */}
        {(pane.state === "permission" || pane.state === "error") && (
          <span
            className={"pattn " + pane.state}
            title={pane.state === "permission" ? "Blocked on your approval — open the attention queue (Ctrl+Shift+A)" : "Errored — open the attention queue (Ctrl+Shift+A)"}
            role="button"
            tabIndex={0}
            onClick={() => useUI.getState().setAttentionOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter") useUI.getState().setAttentionOpen(true); }}
          >
            {pane.state === "permission" ? "needs you" : "error"}
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
                `Session tokens (from the agent's own transcript)
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
              <div className="pmenu-path" title="This pane's working directory">
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
    </div>
  );
}

// UI-226: the store ticks constantly (pane state, activity, polls), and without
// this every tick re-rendered every pane — each of which owns an xterm. Props
// are all primitives plus the pane object and stable callbacks, so the default
// shallow compare is correct.
export const PaneView = memo(PaneViewInner);
