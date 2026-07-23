// Flightdeck — Explorer panel (R9/107): collapsible file-tree for a workspace
// root. Self-contained: owns its own fetch/expand/cache state. Talks to two
// Rust commands — `fs_list_dir` (ships today) and `git_status` (owned by
// another agent, may not exist yet or may error — every call is guarded so
// a missing/erroring command degrades silently, never crashes the tree).
import { useCallback, useEffect, useRef, useState, type SVGProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { IconFolder, IconFile, IconChevron, IconBranch, IconAgent, IconRefresh } from "./Icons";
import { spawnPane } from "./worktrees";
import type { DiffFile, DiffSummary } from "./worktrees";
import { cachedInvoke, usePoll } from "./poll";
import { revealPath } from "./reveal";
import { useUI } from "./ui";
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
// there's no ignore data from the backend to do this properly (112).
const IGNORED_NAMES = new Set([
  "node_modules", "target", "dist", "build", ".git", ".next", "out",
  ".cache", "__pycache__", ".venv", "venv", ".turbo", ".parcel-cache",
]);

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  return parent.replace(/[\\/]+$/, "") + sep + name;
}

// UI-210: git_diff_summary returns paths forward-slash-relative to the repo
// root; the tree's node paths are built by joinPath, which always inherits
// its separator from the root. Converting once here, the same way joinPath
// picks its separator, keeps the two path styles comparable.
function gitPathToNodePath(root: string, gitRelPath: string): string {
  const sep = root.includes("/") && !root.includes("\\") ? "/" : "\\";
  return root.replace(/[\\/]+$/, "") + sep + gitRelPath.split("/").join(sep);
}

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

const LockIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg width={11} height={11} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="5" y="9" width="10" height="8" rx="1.6" />
    <path d="M7 9 V6.5 a3 3 0 0 1 6 0 V9" />
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

function Node({ name, path, dir, depth, wsId, vendor, onOpenFile, onContext, expandKey, changed, refreshTick }: {
  name: string; path: string; dir: boolean; depth: number;
  wsId?: number; vendor: string; onOpenFile: (path: string) => void;
  onContext: (x: number, y: number, path: string, dir: boolean) => void;
  expandKey: string;
  changed: Map<string, DiffFile>;
  /** Bumped by the parent on every poll/focus/manual reload (audit 2.3): lets
   *  an already-expanded node silently re-fetch its own children, so files an
   *  agent adds inside an open folder show up without collapse/re-expand. */
  refreshTick: number;
}) {
  const [expanded, setExpanded] = useState(() => isExpanded(expandKey, path));
  const [children, setChildren] = useState<Entry[] | null>(null);
  const [status, setStatus] = useState<NodeStatus>("idle");
  const { head, tail } = splitName(name, dir);
  const ignored = IGNORED_NAMES.has(name);
  const diff = !dir ? changed.get(path) : undefined;

  const toggle = async () => {
    if (!dir) { onOpenFile(path); return; }
    if (expanded) { setExpanded(false); rememberExpanded(expandKey, path, false); return; }
    if (children !== null) { setExpanded(true); rememberExpanded(expandKey, path, true); return; }
    setStatus("loading");
    try {
      const entries = await invoke<Entry[]>("fs_list_dir", { path });
      setChildren(entries);
      setStatus("loaded");
      setExpanded(true);
      rememberExpanded(expandKey, path, true);
    } catch {
      // Permission-denied (or any other read failure) on this one subfolder —
      // show a lock glyph inline, leave the rest of the tree untouched.
      setStatus("denied");
      setExpanded(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  };

  // A folder restored as "expanded" still needs its children fetched once.
  useEffect(() => {
    if (!dir || !expanded || children !== null || status === "loading") return;
    setStatus("loading");
    invoke<Entry[]>("fs_list_dir", { path })
      .then((entries) => { setChildren(entries); setStatus("loaded"); })
      .catch(() => { setStatus("denied"); setExpanded(false); });
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

  const newTerminalHere = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (wsId != null) void spawnPane(wsId, vendor, path);
  };

  return (
    <div className="ex-node">
      <div
        className={"ex-row" + (ignored ? " ex-ignored" : "")}
        style={{ paddingLeft: rowIndent(depth) }}
        role="button"
        tabIndex={0}
        title={name}
        onClick={toggle}
        onKeyDown={onKey}
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
              onOpenFile={onOpenFile}
              onContext={onContext}
              expandKey={expandKey}
              changed={changed}
              refreshTick={refreshTick}
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
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtx(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey, true); };
  }, [ctx]);

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
        <button className="ex-refresh" onClick={() => load()} title="Refresh"><IconRefresh size={15} /></button>
      </div>

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
        <div className="ex-body">
          {status === "empty-root" && <div className="ex-state">No folder open.</div>}
          {status === "loading" && <SkeletonRows depth={0} count={5} />}
          {status === "error" && (
            <div className="ex-state">
              Couldn't read this folder.
              <button className="ex-retry" onClick={() => load()}>Retry</button>
            </div>
          )}
          {status === "loaded" && entries.length === 0 && <div className="ex-state">Empty folder.</div>}
          {status === "loaded" && entries.length > 0 && (
            <div className="ex-tree">
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
                  onOpenFile={(p) => { openPath(p).catch((e) => pushToast("error", `Couldn't open ${p}: ${String(e)}`)); }}
                  changed={changed}
                  refreshTick={refreshTick}
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
