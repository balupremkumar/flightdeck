// Flightdeck — Explorer panel (R9/107): collapsible file-tree for a workspace
// root. Self-contained: owns its own fetch/expand/cache state. Talks to two
// Rust commands — `fs_list_dir` (ships today) and `git_status` (owned by
// another agent, may not exist yet or may error — every call is guarded so
// a missing/erroring command degrades silently, never crashes the tree).
import { useCallback, useEffect, useRef, useState, type SVGProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useApp } from "./store";
import { IconFolder, IconFile, IconChevron, IconBranch, IconAgent, IconRefresh } from "./Icons";
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

type NodeStatus = "idle" | "loading" | "loaded" | "denied";

function Node({ name, path, dir, depth, wsId, vendor, onOpenFile }: {
  name: string; path: string; dir: boolean; depth: number;
  wsId?: number; vendor: string; onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);
  const [status, setStatus] = useState<NodeStatus>("idle");
  const addPane = useApp((s) => s.addPane);
  const { head, tail } = splitName(name, dir);
  const ignored = IGNORED_NAMES.has(name);

  const toggle = async () => {
    if (!dir) { onOpenFile(path); return; }
    if (expanded) { setExpanded(false); return; }
    if (children !== null) { setExpanded(true); return; }
    setStatus("loading");
    try {
      const entries = await invoke<Entry[]>("fs_list_dir", { path });
      setChildren(entries);
      setStatus("loaded");
      setExpanded(true);
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

  const newTerminalHere = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (wsId != null) addPane(wsId, vendor, path);
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
          children.map((c) => (
            <Node
              key={c.name}
              name={c.name}
              path={joinPath(path, c.name)}
              dir={c.dir}
              depth={depth + 1}
              wsId={wsId}
              vendor={vendor}
              onOpenFile={onOpenFile}
            />
          ))
        )
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

export function Explorer({ root, wsId, vendor = "pwsh" }: ExplorerProps) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<RootStatus>(root ? "loading" : "empty-root");
  const [git, setGit] = useState<GitInfo | null>(null);
  const seq = useRef(0);

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

  const load = () => {
    if (!root) { setStatus("empty-root"); return; }
    const mySeq = ++seq.current;
    setStatus("loading");
    invoke<Entry[]>("fs_list_dir", { path: root })
      .then((e) => { if (seq.current === mySeq) { setEntries(e); setStatus("loaded"); } })
      .catch(() => { if (seq.current === mySeq) setStatus("error"); });
    // git_status may not exist yet (another agent owns it) — degrade silently.
    invoke<GitInfo>("git_status", { path: root })
      .then((g) => { if (seq.current === mySeq) setGit(g); })
      .catch(() => { if (seq.current === mySeq) setGit(null); });
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [root]);

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
          <IconChevron size={12} />
        </button>
        <span className="ex-title">Explorer</span>
        {git && (
          <span className={"ex-branch" + (git.dirty ? " dirty" : "")} title={git.dirty ? "Uncommitted changes" : "Clean"}>
            <IconBranch size={11} /> {git.branch}
            {git.dirty && <i className="ex-dirty-dot" />}
          </span>
        )}
        <span className="sp" />
        <button className="ex-refresh" onClick={load} title="Refresh"><IconRefresh size={12} /></button>
      </div>

      {panelOpen && (
        <div className="ex-body">
          {status === "empty-root" && <div className="ex-state">No folder open.</div>}
          {status === "loading" && <SkeletonRows depth={0} count={5} />}
          {status === "error" && (
            <div className="ex-state">
              Couldn't read this folder.
              <button className="ex-retry" onClick={load}>Retry</button>
            </div>
          )}
          {status === "loaded" && entries.length === 0 && <div className="ex-state">Empty folder.</div>}
          {status === "loaded" && entries.length > 0 && (
            <div className="ex-tree">
              {entries.map((e) => (
                <Node
                  key={e.name}
                  name={e.name}
                  path={joinPath(root, e.name)}
                  dir={e.dir}
                  depth={0}
                  wsId={wsId}
                  vendor={vendor}
                  onOpenFile={(p) => { openPath(p).catch(() => { /* no default app / unsupported — ignore */ }); }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
