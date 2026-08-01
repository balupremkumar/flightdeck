// Flightdeck — Explorer panel (R9/107): collapsible file-tree for a workspace
// root. Self-contained: owns its own fetch/expand/cache state. Talks to two
// Rust commands — `fs_list_dir` (ships today) and `git_status` (owned by
// another agent, may not exist yet or may error — every call is guarded so
// a missing/erroring command degrades silently, never crashes the tree).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SVGProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { IconFolder, IconFile, IconChevron, IconBranch, IconAgent, IconRefresh, IconClose } from "./Icons";
import { spawnPane } from "./worktrees";
import type { DiffFile, DiffSummary } from "./worktrees";
import { cachedInvoke, usePoll } from "./poll";
import { revealPath } from "./reveal";
import { useUI, useOverlayEsc } from "./ui";
// Reuses the workspace-list search input's look (.lp-search) for the new
// filter box below — same visual language, no new input styling needed.
import "./leftpanel.css";
import {
  IGNORED_DIR_NAMES, joinPath, relToAbs, isAncestor,
  walkFiles, filterFiles, keepPathsForMatches, buildFilterRows, typeaheadNext,
  pushRecentFile,
  type WalkedFile, type FilterMatch,
} from "./quickopen";
import "./explorer.css";

interface Entry { name: string; dir: boolean; }
interface GitInfo { branch: string; dirty: boolean; }

export interface ExplorerProps {
  /** Workspace root to browse. Required — with no root the panel shows an empty state. */
  root: string;
  /** Workspace id to spawn a new pane into via "new terminal here". Omit to hide that action. */
  wsId?: number;
  /** Vendor for panes spawned via "new terminal here". Defaults to a plain shell. */
  vendor?: string;
  /** Focused pane's worktree (per-pane rooting): when set, a Workspace/Pane
   *  scope toggle appears and "Pane" browses the agent's isolated copy. */
  paneRoot?: string;
  /** Label for the pane scope button (the focused pane's name). */
  paneLabel?: string;
}

// Best-effort, no-gitignore-parser dimming for common generated/vendor dirs —
// there's no ignore data from the backend to do this properly (112). Shared
// with quick-open/filter's walker (quickopen.ts) so "what counts as noise"
// can't drift between the two.
const IGNORED_NAMES = IGNORED_DIR_NAMES;

// UI-210: git_diff_summary returns paths forward-slash-relative to the repo
// root; the tree's node paths are built by joinPath, which always inherits
// its separator from the root. relToAbs (quickopen.ts) does the same
// conversion the walker uses for its own relPaths, so this reuses it rather
// than keeping a second copy.
const gitPathToNodePath = relToAbs;

// Split a filename so the extension always stays visible; the head truncates
// with CSS ellipsis when the row is too narrow ("middle" ellipsis effect).
function splitName(name: string, dir: boolean): { head: string; tail: string } {
  if (dir) return { head: name, tail: "" };
  const dotfile = name.startsWith(".");
  const body = dotfile ? name.slice(1) : name;
  const dot = body.lastIndexOf(".");
  if (dot <= 0 || dot === body.length - 1) return { head: name, tail: "" };
  const head = (dotfile ? "." : "") + body.slice(0, dot);
  const tail = body.slice(dot);
  return { head, tail };
}

// UX-535: wraps the characters of `text` that fall within `positions` (index
// offsets into the FULL relPath a match was scored against — `offset` is
// where `text`, typically just the last segment, begins within that
// relPath) in a highlight mark. Falls back to plain text with no positions.
function highlightText(text: string, positions: number[], offset: number): ReactNode {
  if (positions.length === 0) return text;
  const local = new Set(positions.map((p) => p - offset).filter((p) => p >= 0 && p < text.length));
  if (local.size === 0) return text;
  return text.split("").map((ch, i) => (local.has(i) ? <mark key={i} className="ex-hit">{ch}</mark> : ch));
}

const LockIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg width={11} height={11} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="5" y="9" width="10" height="8" rx="1.6" />
    <path d="M7 9 V6.5 a3 3 0 0 1 6 0 V9" />
  </svg>
);

// UX-533: reveal-active-file button — a locate/crosshair glyph, local to
// this file the same way LockIcon is (no new shared icon needed).
const TargetIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg width={15} height={15} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="10" cy="10" r="5.6" />
    <circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none" />
    <path d="M10 2.6 V5.2" />
    <path d="M10 14.8 V17.4" />
    <path d="M2.6 10 H5.2" />
    <path d="M14.8 10 H17.4" />
  </svg>
);

function SkeletonRows({ depth, count = 3 }: { depth: number; count?: number }) {
  return (
    <div className="ex-skel-group">
      {Array.from({ length: count }).map((_, i) => (
        <div className="ex-row ex-skel" style={{ paddingLeft: rowIndent(depth) }} key={i}>
          <span className="ex-skel-bar" style={{ width: 60 + ((i * 37) % 90) }} />
        </div>
      ))}
    </div>
  );
}

function rowIndent(depth: number): number {
  return 8 + Math.min(depth, 12) * 14;
}

// Order and content equality for a directory listing — used to skip a
// setChildren (and the re-render it causes) when a background refresh
// reads back the same entries (audit 2.3).
function sameEntries(a: Entry[], b: Entry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].dir !== b[i].dir) return false;
  }
  return true;
}

type NodeStatus = "idle" | "loading" | "loaded" | "denied";

// UI-49 / QOL 323: node_modules-scale directories put thousands of rows into
// the DOM at once. Rather than pull in a virtualisation dependency, render a
// generous slice and say plainly how many are hidden — the tree is for
// navigating, and nobody scrolls 4000 sibling files.
const MAX_ROWS = 300;

// UX-512: quick-look popover body — first slice of the raw file text, no
// markdown rendering (that's what Enter's real preview is for). Kept tiny
// and local to Node since it only ever needs a read-only peek.
const QUICKLOOK_LINES = 60;

function QuickLookPopover({ name, path, pos, onClose }: { name: string; path: string; pos: { top: number; left: number }; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setErrored(false);
    invoke<string>("fs_read_text_file", { path })
      .then((t) => { if (!cancelled) setText(t); })
      .catch(() => { if (!cancelled) setErrored(true); });
    return () => { cancelled = true; };
  }, [path]);

  return (
    <div className="ex-qlook" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label={`Quick look: ${name}`}>
      <div className="ex-qlook-head">
        <span className="ex-qlook-name">{name}</span>
        <button className="ex-qlook-close" onClick={onClose} title="Close (Space/Esc)" aria-label="Close quick look">
          <IconClose size={11} />
        </button>
      </div>
      <div className="ex-qlook-body">
        {errored && <div className="ex-qlook-msg">Couldn't read this file.</div>}
        {!errored && text === null && <div className="ex-qlook-msg">Loading…</div>}
        {!errored && text !== null && (
          <pre className="ex-qlook-pre">
            {text === "" ? "Empty file." : text.split(/\r?\n/).slice(0, QUICKLOOK_LINES).join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}

function Node({
  name, path, dir, depth, wsId, vendor, onPreview, onOpenInEditor, onContext, expandKey, changed, refreshTick,
  revealTarget, revealSeq,
}: {
  name: string; path: string; dir: boolean; depth: number;
  wsId?: number; vendor: string;
  /** UX-511/512: single click / Enter — read-only preview drawer. */
  onPreview: (path: string) => void;
  /** UX-511: double click — hands off to the OS/editor (openPath). */
  onOpenInEditor: (path: string) => void;
  onContext: (x: number, y: number, path: string, dir: boolean) => void;
  expandKey: string;
  changed: Map<string, DiffFile>;
  /** Bumped by the parent on every poll/focus/manual reload (audit 2.3): lets
   *  an already-expanded node silently re-fetch its own children, so files an
   *  agent adds inside an open folder show up without collapse/re-expand. */
  refreshTick: number;
  /** UX-533: absolute path of the file the "reveal active file" button wants
   *  shown, or null when idle. Every node checks itself against it on each
   *  revealSeq bump — an ancestor folder expands (and fetches if needed),
   *  the exact target scrolls into view and takes focus. */
  revealTarget: string | null;
  revealSeq: number;
}) {
  const [expanded, setExpanded] = useState(() => isExpanded(expandKey, path));
  const [children, setChildren] = useState<Entry[] | null>(null);
  const [status, setStatus] = useState<NodeStatus>("idle");
  const { head, tail } = splitName(name, dir);
  const ignored = IGNORED_NAMES.has(name);
  const diff = !dir ? changed.get(path) : undefined;
  const rowRef = useRef<HTMLDivElement>(null);

  // UX-512: Space "quick-looks" a file — an ephemeral read-only peek,
  // distinct from Enter's persistent preview tab. Closes on Space again,
  // Escape, or the row losing focus; never steals focus itself.
  const [quickLook, setQuickLook] = useState(false);
  const [qlPos, setQlPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!quickLook) { setQlPos(null); return; }
    const r = rowRef.current?.getBoundingClientRect();
    if (r) setQlPos({ top: r.bottom + 4, left: r.left });
  }, [quickLook]);

  const fetchChildren = async () => {
    setStatus("loading");
    try {
      const entries = await invoke<Entry[]>("fs_list_dir", { path });
      setChildren(entries);
      setStatus("loaded");
      return true;
    } catch {
      // Permission-denied (or any other read failure) on this one subfolder —
      // show a lock glyph inline, leave the rest of the tree untouched.
      setStatus("denied");
      setExpanded(false);
      return false;
    }
  };

  const toggle = async () => {
    if (expanded) { setExpanded(false); rememberExpanded(expandKey, path, false); return; }
    if (children !== null) { setExpanded(true); rememberExpanded(expandKey, path, true); return; }
    if (await fetchChildren()) { setExpanded(true); rememberExpanded(expandKey, path, true); }
  };

  const onRowClick = () => { if (dir) void toggle(); else onPreview(path); };
  const onRowDoubleClick = () => { if (!dir) onOpenInEditor(path); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); if (dir) void toggle(); else onPreview(path); return; }
    if (e.key === " ") {
      e.preventDefault();
      if (dir) { void toggle(); return; }
      setQuickLook((v) => !v);
      return;
    }
    if (e.key === "Escape" && quickLook) { e.preventDefault(); e.stopPropagation(); setQuickLook(false); }
  };

  // A folder restored as "expanded" still needs its children fetched once.
  useEffect(() => {
    if (!dir || !expanded || children !== null || status === "loading") return;
    void fetchChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, expanded]);

  // Nested refresh (audit 2.3): the root's 10s poll / focus reload bumps
  // refreshTick; an already-expanded folder with children already loaded
  // re-fetches quietly here. Compares before setState so an unchanged
  // directory never re-renders (no flicker). Collapsed/not-yet-loaded nodes
  // skip entirely — cheap, and only visible nodes ever mount at all.
  const prevRefreshTick = useRef(refreshTick);
  useEffect(() => {
    if (prevRefreshTick.current === refreshTick) return;
    prevRefreshTick.current = refreshTick;
    if (!dir || !expanded || children === null) return;
    invoke<Entry[]>("fs_list_dir", { path })
      .then((entries) => {
        setChildren((prev) => (prev && sameEntries(prev, entries) ? prev : entries));
      })
      .catch(() => { /* transient read failure — leave the stale listing in place */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // UX-533: reveal-active-file. Runs on every revealSeq bump (including on
  // mount, for nodes that only exist because an ancestor just expanded) —
  // each node in the chain expands/fetches itself in turn, cascading down to
  // the target one level at a time as children mount.
  const prevRevealSeq = useRef(0);
  useEffect(() => {
    if (!revealTarget || revealSeq === prevRevealSeq.current) return;
    prevRevealSeq.current = revealSeq;
    if (dir && path !== revealTarget && isAncestor(path, revealTarget)) {
      if (!expanded) { setExpanded(true); rememberExpanded(expandKey, path, true); }
      if (children === null && status !== "loading") void fetchChildren();
    }
    if (path === revealTarget) {
      rowRef.current?.scrollIntoView({ block: "center" });
      rowRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq]);

  const newTerminalHere = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (wsId != null) void spawnPane(wsId, vendor, path);
  };

  return (
    <div className="ex-node">
      <div
        ref={rowRef}
        className={"ex-row" + (ignored ? " ex-ignored" : "")}
        style={{ paddingLeft: rowIndent(depth) }}
        role="button"
        tabIndex={0}
        title={name}
        data-ex-name={name}
        onClick={onRowClick}
        onDoubleClick={onRowDoubleClick}
        onKeyDown={onKey}
        onBlur={() => setQuickLook(false)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY, path, dir); }}
      >
        {dir ? (
          <span className={"ex-chev" + (expanded ? " open" : "")}><IconChevron size={11} /></span>
        ) : (
          <span className="ex-chev-spacer" />
        )}
        <span className="ex-icon">{dir ? <IconFolder size={13} /> : <IconFile size={13} />}</span>
        <span className="ex-name">
          <span className="ex-head">{head}</span>
          {tail && <span className="ex-tail">{tail}</span>}
        </span>
        {diff && (
          <i
            className="ex-changed-dot"
            title={diff.binary ? "Binary file changed" : `+${diff.added} -${diff.deleted}`}
          />
        )}
        {status === "denied" && <LockIcon className="ex-lock" aria-label="Permission denied" />}
        {dir && wsId != null && (
          <button className="ex-action" title="New terminal here" onClick={newTerminalHere}>
            <IconAgent size={12} />
          </button>
        )}
      </div>
      {quickLook && qlPos && !dir && (
        <QuickLookPopover name={name} path={path} pos={qlPos} onClose={() => setQuickLook(false)} />
      )}
      {dir && status === "loading" && <SkeletonRows depth={depth + 1} count={2} />}
      {dir && expanded && children !== null && (
        children.length === 0 ? (
          <div className="ex-row ex-empty" style={{ paddingLeft: rowIndent(depth + 1) }}>Empty</div>
        ) : (
          children.slice(0, MAX_ROWS).map((c) => (
            <Node
              key={joinPath(path, c.name)}
              name={c.name}
              path={joinPath(path, c.name)}
              dir={c.dir}
              depth={depth + 1}
              wsId={wsId}
              vendor={vendor}
              onPreview={onPreview}
              onOpenInEditor={onOpenInEditor}
              onContext={onContext}
              expandKey={expandKey}
              changed={changed}
              refreshTick={refreshTick}
              revealTarget={revealTarget}
              revealSeq={revealSeq}
            />
          ))
        )
      )}
      {dir && expanded && children !== null && children.length > MAX_ROWS && (
        <div className="ex-row ex-more" style={{ paddingLeft: rowIndent(depth + 1) }}>
          {children.length - MAX_ROWS} more items not shown
        </div>
      )}
    </div>
  );
}

type RootStatus = "empty-root" | "loading" | "error" | "loaded";

// Panel width (major, R-sizing): persisted so the split stays put across
// launches. Default 240, clamped 180-480.
const WIDTH_KEY = "flightdeck-explorer-width";
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;

function clampWidth(n: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n)) return clampWidth(n);
  } catch { /* non-persistent */ }
  return DEFAULT_WIDTH;
}

const SCOPE_KEY = "flightdeck-explorer-scope";

// UI-212: remember which folders were open, keyed per browsed root, so the
// tree isn't fully collapsed every time the panel remounts.
const EXPAND_KEY = "flightdeck-explorer-expanded";
type ExpandMap = Record<string, string[]>;

function readExpandMap(): ExpandMap {
  try { return JSON.parse(localStorage.getItem(EXPAND_KEY) ?? "{}") as ExpandMap; } catch { return {}; }
}
function isExpanded(key: string, path: string): boolean {
  return (readExpandMap()[key] ?? []).includes(path);
}
function rememberExpanded(key: string, path: string, open: boolean) {
  try {
    const map = readExpandMap();
    const list = new Set(map[key] ?? []);
    if (open) list.add(path); else list.delete(path);
    // Cap so a long browsing session can't grow this unbounded.
    map[key] = [...list].slice(-200);
    localStorage.setItem(EXPAND_KEY, JSON.stringify(map));
  } catch { /* non-persistent */ }
}

// UX-541: scroll position, keyed the same way as EXPAND_KEY above (per
// browsed root, persisted across launches — expansion already worked this
// way; this closes the gap for scroll position specifically).
const SCROLL_KEY = "flightdeck-explorer-scroll";
function loadScrollMap(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SCROLL_KEY) ?? "{}") as Record<string, number>; } catch { return {}; }
}
function rememberScroll(key: string, top: number) {
  try {
    const map = loadScrollMap();
    map[key] = top;
    localStorage.setItem(SCROLL_KEY, JSON.stringify(map));
  } catch { /* non-persistent */ }
}

export function Explorer({ root, wsId, vendor = "pwsh", paneRoot, paneLabel }: ExplorerProps) {
  const pushToast = useUI((s) => s.pushToast);
  const [panelOpen, setPanelOpen] = useState(true);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<RootStatus>(root ? "loading" : "empty-root");
  const [git, setGit] = useState<GitInfo | null>(null);
  // UI-210: path -> DiffFile for files changed since base, keyed on the same
  // node paths the tree renders so a row can look itself up with no per-node
  // fetch. Empty (not stale) whenever the repo/base can't be diffed.
  const [changed, setChanged] = useState<Map<string, DiffFile>>(new Map());
  // Bumped on every load() (manual refresh, 10s poll, focus reload) so
  // already-expanded Node instances know to quietly re-fetch their own
  // children too (audit 2.3) — see Node's refreshTick effect.
  const [refreshTick, setRefreshTick] = useState(0);
  const seq = useRef(0);
  // Per-pane rooting: browse the focused pane's worktree instead of the main
  // checkout. Preference persisted; falls back to workspace when the focused
  // pane isn't isolated.
  const [scope, setScope] = useState<"workspace" | "pane">(() => {
    try { return localStorage.getItem(SCOPE_KEY) === "workspace" ? "workspace" : "pane"; } catch { return "pane"; }
  });
  const pickScope = (s: "workspace" | "pane") => {
    setScope(s);
    try { localStorage.setItem(SCOPE_KEY, s); } catch { /* non-persistent */ }
  };
  const paneScoped = scope === "pane" && !!paneRoot && paneRoot !== root;
  const effectiveRoot = paneScoped ? paneRoot! : root;

  const openPreview = useUI((s) => s.openPreview);
  const previewTabs = useUI((s) => s.previewTabs);
  const activePreviewId = useUI((s) => s.activePreviewId);

  // UX-511/527: single click / Enter previews a file; recorded as "recent"
  // under this root either way (quick-open reads the same list — quickopen.ts).
  const handlePreview = useCallback((p: string) => {
    if (effectiveRoot) pushRecentFile(effectiveRoot, p);
    openPreview(p);
  }, [effectiveRoot, openPreview]);
  // UX-511: double click hands off to the OS/editor via the opener plugin —
  // Windows file associations already route most source files to whatever
  // editor owns them; see the delivery report for the real-editor-launch gap.
  const handleOpenInEditor = useCallback((p: string) => {
    if (effectiveRoot) pushRecentFile(effectiveRoot, p);
    openPath(p).catch((e) => pushToast("error", `Couldn't open ${p}: ${String(e)}`));
  }, [effectiveRoot, pushToast]);

  const [width, setWidth] = useState(loadWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    setResizing(true);
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const next = clampWidth(startWidth + (ev.clientX - startX));
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(false);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      try { localStorage.setItem(WIDTH_KEY, String(widthRef.current)); } catch { /* non-persistent */ }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // UI-211: right-click path actions (copy path / copy relative / reveal).
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  // UX-542/543: shared overlay stack — see ui.ts.
  useOverlayEsc(!!ctx, () => setCtx(null));
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [ctx]);

  // UX-533: reveal-active-file — syncs the tree to whatever the preview
  // drawer currently shows. An explicit button rather than automatic: the
  // app's own convention (autoQueue/followAttention in ui.ts) is that
  // anything that yanks the tree's scroll/focus around is opt-in.
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const [revealSeq, setRevealSeq] = useState(0);
  const activePreviewPath = previewTabs.find((t) => t.id === activePreviewId)?.path ?? null;
  const revealActiveFile = () => {
    if (!activePreviewPath) { pushToast("info", "No file is open in preview."); return; }
    if (!effectiveRoot || !isAncestor(effectiveRoot, activePreviewPath)) {
      pushToast("info", "That file isn't inside this explorer's folder.");
      return;
    }
    setRevealTarget(activePreviewPath);
    setRevealSeq((n) => n + 1);
  };

  // UX-534: type-to-jump within the expanded tree. DOM-based on purpose —
  // it only ever needs to know about currently-rendered (i.e. visible/
  // expanded) rows, which a `.ex-row[data-ex-name]` query already gives for
  // free with no parallel state to keep in sync with the recursive Node tree.
  const treeRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });
  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    // Space/Enter are Node's own toggle/preview/quick-look keys — leave them
    // alone here so typeahead never fights that dedicated meaning.
    if (e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1 || e.key === " ") return;
    const container = treeRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".ex-row[data-ex-name]"));
    if (rows.length === 0) return;
    const names = rows.map((r) => r.dataset.exName ?? "");
    const currentIndex = rows.indexOf(document.activeElement as HTMLElement);
    const now = Date.now();
    const buffer = now - typeahead.current.at < 700 ? typeahead.current.buffer + e.key : e.key;
    typeahead.current = { buffer, at: now };
    const next = typeaheadNext(names, currentIndex, buffer);
    if (next != null) { e.preventDefault(); rows[next].focus(); }
  };

  // UX-535: subsequence filter box. Walks effectiveRoot once per session per
  // root (same capped, lazy walker quick-open uses — quickopen.ts's
  // walkFiles), then filters/highlights entirely client-side on every
  // keystroke so typing doesn't re-hit the filesystem.
  const [filterQuery, setFilterQuery] = useState("");
  const [filterFilesList, setFilterFilesList] = useState<WalkedFile[] | null>(null);
  const [filterTruncated, setFilterTruncated] = useState(false);
  const [filterLoading, setFilterLoading] = useState(false);

  useEffect(() => { setFilterFilesList(null); setFilterQuery(""); }, [effectiveRoot]);

  useEffect(() => {
    if (!filterQuery.trim() || !effectiveRoot || filterFilesList !== null || filterLoading) return;
    let cancelled = false;
    setFilterLoading(true);
    walkFiles((p) => invoke<Entry[]>("fs_list_dir", { path: p }), effectiveRoot)
      .then((res) => { if (!cancelled) { setFilterFilesList(res.files); setFilterTruncated(res.truncated); } })
      .catch(() => { if (!cancelled) setFilterFilesList([]); })
      .finally(() => { if (!cancelled) setFilterLoading(false); });
    return () => { cancelled = true; };
  }, [filterQuery, effectiveRoot, filterFilesList, filterLoading]);

  const filterMatches: FilterMatch[] | null = useMemo(
    () => (filterFilesList && filterQuery.trim() ? filterFiles(filterFilesList, filterQuery, 300) : null),
    [filterFilesList, filterQuery]
  );
  const filterKeep = useMemo(() => (filterMatches ? keepPathsForMatches(filterMatches) : null), [filterMatches]);
  const filterMatchByRel = useMemo(
    () => new Map((filterMatches ?? []).map((m) => [m.file.relPath, m])),
    [filterMatches]
  );
  const filterRows = useMemo(
    () => (filterMatches && filterKeep ? buildFilterRows(filterMatches, filterKeep) : []),
    [filterMatches, filterKeep]
  );

  // UX-541: remember the tree's scroll position per browsed root, the same
  // way EXPAND_KEY already remembers which folders were open — both persist
  // to localStorage, so both survive a relaunch, not just the session.
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoredRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "loaded" || !effectiveRoot || restoredRootRef.current === effectiveRoot) return;
    restoredRootRef.current = effectiveRoot;
    const top = loadScrollMap()[effectiveRoot];
    if (top != null && bodyRef.current) bodyRef.current.scrollTop = top;
  }, [status, effectiveRoot]);
  const scrollSaveTimer = useRef<number | null>(null);
  const onBodyScroll = () => {
    if (!effectiveRoot || scrollSaveTimer.current != null) return;
    scrollSaveTimer.current = window.setTimeout(() => {
      scrollSaveTimer.current = null;
      if (bodyRef.current) rememberScroll(effectiveRoot, bodyRef.current.scrollTop);
    }, 200);
  };

  /** `quiet` re-reads without flipping to the skeleton state — an automatic
   *  refresh must never make a settled tree flash every few seconds. */
  const load = (quiet = false) => {
    if (!effectiveRoot) { setStatus("empty-root"); return; }
    const mySeq = ++seq.current;
    if (!quiet) setStatus("loading");
    setRefreshTick((t) => t + 1);
    invoke<Entry[]>("fs_list_dir", { path: effectiveRoot })
      .then((e) => { if (seq.current === mySeq) { setEntries(e); setStatus("loaded"); } })
      .catch(() => { if (seq.current === mySeq && !quiet) setStatus("error"); });
    // Shared with every PaneView on this cwd (UI-234) — one git subprocess,
    // not one per surface. Degrades silently for non-repos.
    cachedInvoke<GitInfo>("git_status", { cwd: effectiveRoot }, 15000)
      .then((g) => { if (seq.current === mySeq) setGit(g); })
      .catch(() => { if (seq.current === mySeq) setGit(null); });
    // Same cache entry PaneView's diff-stat badge reads (UI-234) — one git
    // subprocess serves both surfaces.
    cachedInvoke<DiffSummary>("git_diff_summary", { cwd: effectiveRoot, base: null }, 15000)
      .then((d) => {
        if (seq.current !== mySeq) return;
        setChanged(new Map(d.files.map((f) => [gitPathToNodePath(effectiveRoot, f.path), f])));
      })
      .catch(() => { if (seq.current === mySeq) setChanged(new Map()); });
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [effectiveRoot]);

  // UI-213: agents change files behind your back, so a manually-refreshed tree
  // goes stale within seconds. This is a periodic re-read, not a true OS
  // watcher (that would mean a new crate + a watcher thread; persist.rs set the
  // no-new-dependency precedent). usePoll already stands down when the panel is
  // hidden or the window is minimised, and refreshes immediately on return, so
  // the common case — alt-tab back and look — is covered with no extra cost.
  usePoll(() => { load(true); }, 10000, [effectiveRoot], panelOpen && !!effectiveRoot);

  // Refresh the moment the window regains focus, ahead of the next tick.
  useEffect(() => {
    const onFocus = () => { if (panelOpen && effectiveRoot) load(true); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, effectiveRoot]);

  return (
    <div className="explorer" style={{ width }}>
      <div
        className={"ex-resize" + (resizing ? " dragging" : "")}
        onMouseDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize explorer panel"
      />
      <div className="ex-head">
        <button className={"ex-toggle" + (panelOpen ? " open" : "")} onClick={() => setPanelOpen((o) => !o)} title={panelOpen ? "Collapse" : "Expand"}>
          <IconChevron size={15} />
        </button>
        <span className="ex-title">Explorer</span>
        {git && (
          <span className={"ex-branch" + (git.dirty ? " dirty" : "")} title={git.dirty ? "Uncommitted changes" : "Clean"}>
            <IconBranch size={11} /> {git.branch}
            {git.dirty && <i className="ex-dirty-dot" />}
          </span>
        )}
        <span className="sp" />
        <button
          className="ex-refresh"
          onClick={revealActiveFile}
          disabled={!activePreviewPath}
          title={activePreviewPath ? `Reveal active file in tree\n${activePreviewPath}` : "Reveal active file in tree (nothing open in preview)"}
        >
          <TargetIcon />
        </button>
        <button className="ex-refresh" onClick={() => load()} title="Refresh"><IconRefresh size={15} /></button>
      </div>

      {status === "loaded" && entries.length > 0 && (
        <div className="ex-filter-wrap">
          <input
            className="lp-search ex-filter"
            placeholder="Filter files (matches subsequences)…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            spellCheck={false}
          />
          {filterQuery && (
            <button className="ex-filter-clear" onClick={() => setFilterQuery("")} title="Clear filter" aria-label="Clear filter">
              <IconClose size={11} />
            </button>
          )}
        </div>
      )}

      {paneRoot && paneRoot !== root && (
        <div className="ex-scope" role="tablist" aria-label="Explorer scope">
          <button
            className={"ex-scope-btn" + (!paneScoped ? " on" : "")}
            onClick={() => pickScope("workspace")}
            title={"Browse the main checkout\n" + root}
          >
            Workspace
          </button>
          <button
            className={"ex-scope-btn" + (paneScoped ? " on" : "")}
            onClick={() => pickScope("pane")}
            title={`Browse ${paneLabel ?? "the focused pane"}'s isolated worktree\n${paneRoot}`}
          >
            {paneLabel ?? "Pane"}
          </button>
        </div>
      )}

      {ctx && (
        <div className="ex-ctx" style={{ top: ctx.y, left: ctx.x }} onMouseDown={(e) => e.stopPropagation()} role="menu">
          <button className="ex-ctx-item" onClick={() => { void navigator.clipboard.writeText(ctx.path); setCtx(null); }}>
            Copy path
          </button>
          <button
            className="ex-ctx-item"
            onClick={() => {
              const rel = ctx.path.startsWith(effectiveRoot) ? ctx.path.slice(effectiveRoot.length).replace(/^[\/]+/, "") : ctx.path;
              void navigator.clipboard.writeText(rel);
              setCtx(null);
            }}
          >
            Copy relative path
          </button>
          <button className="ex-ctx-item" onClick={() => { void revealPath(ctx.path); setCtx(null); }}>
            Reveal in Explorer
          </button>
          {ctx.dir && wsId != null && (
            <button className="ex-ctx-item" onClick={() => { void spawnPane(wsId, vendor, ctx.path); setCtx(null); }}>
              New terminal here
            </button>
          )}
        </div>
      )}

      {panelOpen && (
        <div className="ex-body" ref={bodyRef} onScroll={onBodyScroll}>
          {status === "empty-root" && <div className="ex-state">No folder open.</div>}
          {status === "loading" && <SkeletonRows depth={0} count={5} />}
          {status === "error" && (
            <div className="ex-state">
              Couldn't read this folder.
              <button className="ex-retry" onClick={() => load()}>Retry</button>
            </div>
          )}
          {status === "loaded" && entries.length === 0 && <div className="ex-state">Empty folder.</div>}

          {/* UX-535: subsequence filter — replaces the normal tree while a
              query is typed, showing only matches and their ancestor folders. */}
          {status === "loaded" && entries.length > 0 && filterQuery.trim() && (
            filterLoading || filterFilesList === null ? (
              <SkeletonRows depth={0} count={5} />
            ) : filterRows.length === 0 ? (
              <div className="ex-state">No files match "{filterQuery.trim()}".</div>
            ) : (
              <div className="ex-tree">
                {filterRows.map((row) => {
                  const match = filterMatchByRel.get(row.relPath);
                  const abs = relToAbs(effectiveRoot, row.relPath);
                  return (
                    <div
                      key={row.relPath}
                      className="ex-row"
                      style={{ paddingLeft: rowIndent(row.depth) }}
                      role="button"
                      tabIndex={0}
                      title={row.relPath}
                      data-ex-name={row.name}
                      onClick={() => { if (!row.dir) handlePreview(abs); }}
                      onDoubleClick={() => { if (!row.dir) handleOpenInEditor(abs); }}
                      onKeyDown={(e) => {
                        if ((e.key === "Enter" || e.key === " ") && !row.dir) { e.preventDefault(); handlePreview(abs); }
                      }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, path: abs, dir: row.dir }); }}
                    >
                      <span className="ex-chev-spacer" />
                      <span className="ex-icon">{row.dir ? <IconFolder size={13} /> : <IconFile size={13} />}</span>
                      <span className="ex-name">
                        <span className="ex-head">
                          {match ? highlightText(row.name, match.positions, row.relPath.length - row.name.length) : row.name}
                        </span>
                      </span>
                    </div>
                  );
                })}
                {filterTruncated && (
                  <div className="ex-row ex-more">
                    Search covered the first {filterFilesList.length} files — narrow the filter to reach the rest.
                  </div>
                )}
              </div>
            )
          )}

          {status === "loaded" && entries.length > 0 && !filterQuery.trim() && (
            <div className="ex-tree" ref={treeRef} onKeyDown={onTreeKeyDown}>
              {entries.slice(0, MAX_ROWS).map((e) => (
                <Node
                  key={joinPath(effectiveRoot, e.name)}
                  name={e.name}
                  path={joinPath(effectiveRoot, e.name)}
                  dir={e.dir}
                  depth={0}
                  wsId={wsId}
                  vendor={vendor}
                  expandKey={effectiveRoot}
                  onContext={(x, y, path, isDir) => setCtx({ x, y, path, dir: isDir })}
                  onPreview={handlePreview}
                  onOpenInEditor={handleOpenInEditor}
                  changed={changed}
                  refreshTick={refreshTick}
                  revealTarget={revealTarget}
                  revealSeq={revealSeq}
                />
              ))}
              {entries.length > MAX_ROWS && (
                <div className="ex-row ex-more">
                  {entries.length - MAX_ROWS} more items not shown
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
