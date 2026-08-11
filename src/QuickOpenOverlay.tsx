// quickopen.tsx — UX-526/527: global "go to file" (Ctrl+P), fuzzy by path
// across the focused pane's repo, opens the pick in the read-only preview
// drawer (UX-505, useUI().openPreview). Self-contained like CommandPalette —
// owns its own open/closed state and reads the app store directly rather
// than needing props threaded in from Cockpit.
//
// Ctrl+P used to be one of CommandPalette's two toggle keys (Ctrl+K/Ctrl+P);
// this backlog wave repoints Ctrl+P at quick-open specifically, so Ctrl+P is
// no longer bound in CommandPalette.tsx/Settings.tsx — see the delivery
// report's HANDOFF EDITS for the exact two-line change (out of this file's
// ownership).
//
// There's no recursive Rust "list files under this root" command yet, only
// the one-level fs_list_dir the Explorer tree already uses — walkFiles
// (quickopen.ts) does a capped, lazy breadth-first walk on top of it. A
// dedicated recursive command would outperform this on a very large repo;
// see HANDOFF EDITS for that as an optional follow-up.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { IconFile, IconClose } from "./Icons";
import {
  walkFiles, filterFiles, loadRecentFiles, pushRecentFile, baseName,
  type WalkedFile, type DirEntry,
} from "./quickopen";
// Reuses the command palette's .cmdp-* shell (scrim/modal/input/list/item)
// and its close-button (.ov-x, from overlays.css) — same visual language as
// the rest of the app's overlays. Only the match-highlight mark (.qo-hit) is
// new, added to explorer.css alongside this wave's other Explorer/quick-open
// styling.
import "./leftpanel.css";
import "./overlays.css";
import "./explorer.css";

// Mirrors Explorer.tsx's own pane/workspace scope toggle (SCOPE_KEY there)
// so quick-open searches whichever root the Explorer panel is currently
// showing, without needing a live prop link into that component.
const EXPLORER_SCOPE_KEY = "flightdeck-explorer-scope";

function resolveRoot(): { root: string | null; label: string } {
  const s = useApp.getState();
  const ws = s.workspaces.find((w) => w.id === s.activeId);
  if (!ws) return { root: null, label: "" };
  const focused = ws.panes.find((p) => p.id === ws.focused);
  let scope: "workspace" | "pane" = "pane";
  try { scope = localStorage.getItem(EXPLORER_SCOPE_KEY) === "workspace" ? "workspace" : "pane"; } catch { /* default pane */ }
  const paneRoot = scope === "pane" ? focused?.worktreePath : undefined;
  return { root: paneRoot && paneRoot !== ws.root ? paneRoot : ws.root, label: ws.name };
}

async function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("fs_list_dir", { path });
}

interface WalkCacheEntry { files: WalkedFile[]; truncated: boolean; at: number; }
const walkCache = new Map<string, WalkCacheEntry>();
// QL-741: five seconds, not thirty. Agents write files while the cockpit sits
// open, so anything older than a few keystrokes is a stale claim about the
// repo. The TTL now only exists to stop a double Ctrl+P re-walking; past it
// the overlay still shows the cached list instantly and rescans behind it.
const WALK_TTL_MS = 5_000;

/** "idle" = nothing running; "cold" = first walk for this root, results
 *  streaming in; "refresh" = a cached list is on screen and a background walk
 *  is about to replace it. The two scans read differently to the user, so
 *  they get different copy rather than one "Loading…". */
type ScanPhase = "idle" | "cold" | "refresh";

function highlighted(text: string, positions: number[]): ReactNode {
  if (positions.length === 0) return text;
  const set = new Set(positions);
  return text.split("").map((ch, i) => (set.has(i) ? <mark key={i} className="qo-hit">{ch}</mark> : ch));
}

interface Row { file: WalkedFile; positions: number[]; }

export function QuickOpen() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<WalkedFile[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scan, setScan] = useState<ScanPhase>("idle");
  // Bumped by the retry button (which also drops the cached entry) so a
  // failed or empty scan can be re-run without closing the overlay.
  const [rescan, setRescan] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Recomputed only on open (like CommandPalette's own item list) — quick-
  // open doesn't need to track workspace switches while it's closed.
  const { root, label } = useMemo(resolveRoot, [open]);

  // Ctrl+P toggles. Guarded so it never steals keystrokes from a focused
  // terminal (same `.pbody` guard CommandPalette uses for Ctrl+K/Ctrl+B),
  // and always prevented — Ctrl+P is the browser's print shortcut otherwise.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "p" || e.key === "P");
      if (!combo) return;
      if ((e.target as HTMLElement)?.closest?.(".pbody")) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Walk the resolved root on open. Three paths, cheapest first (QL-741):
  //   fresh cache  — show it, done.
  //   stale cache  — show it instantly, rescan in the background, swap the
  //                  result in when it lands, so a file an agent wrote
  //                  seconds ago is findable without an empty flash.
  //   no cache     — stream partial results in as the walk finds them rather
  //                  than holding a spinner over a whole monorepo.
  useEffect(() => {
    if (!open || !root) { setFiles(null); setTruncated(false); setScan("idle"); return; }
    const cached = walkCache.get(root);
    if (cached) { setFiles(cached.files); setTruncated(cached.truncated); }
    else { setFiles(null); setTruncated(false); }
    if (cached && Date.now() - cached.at < WALK_TTL_MS) { setScan("idle"); return; }

    let cancelled = false;
    setScan(cached ? "refresh" : "cold");
    walkFiles(listDir, root, {
      // Only stream into an empty list — repainting over a list the user is
      // already arrowing through would move rows under the cursor.
      onProgress: cached ? undefined : (found) => { if (!cancelled) setFiles(found); },
      shouldCancel: () => cancelled,
    })
      .then((res) => {
        if (cancelled) return;
        walkCache.set(root, { files: res.files, truncated: res.truncated, at: Date.now() });
        setFiles(res.files);
        setTruncated(res.truncated);
      })
      // walkFiles swallows per-directory failures, so a rejection here means
      // the whole IPC channel is down. Keep whatever already streamed in
      // (partial beats blank), flag it as incomplete, and let the retry
      // button below be the way out.
      .catch(() => {
        if (cancelled) return;
        setFiles((cur) => cur ?? cached?.files ?? []);
        setTruncated(true);
      })
      .finally(() => { if (!cancelled) setScan("idle"); });
    return () => { cancelled = true; };
  }, [open, root, rescan]);

  const recentPaths = useMemo(() => (root ? loadRecentFiles(root) : []), [open, root]);

  // UX-527: recent files first when the box is empty; fuzzy match by
  // relative path otherwise.
  const results: Row[] = useMemo(() => {
    if (!files) return [];
    const q = query.trim();
    if (!q) {
      const byPath = new Map(files.map((f) => [f.path, f]));
      return recentPaths
        .map((p) => byPath.get(p))
        .filter((f): f is WalkedFile => !!f)
        .map((file) => ({ file, positions: [] }));
    }
    return filterFiles(files, q, 60).map((m) => ({ file: m.file, positions: m.positions }));
  }, [files, query, recentPaths]);

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [index]);

  // Drops the cached entry first so the effect below takes the cold path and
  // re-walks for real instead of re-showing the same empty list.
  const retry = () => {
    if (root) walkCache.delete(root);
    setRescan((n) => n + 1);
  };

  const choose = (file: WalkedFile) => {
    if (root) pushRecentFile(root, file.path);
    useUI.getState().openPreview(file.path);
    setOpen(false);
  };

  // UX-542/543: Esc on the shared overlay stack (ui.ts); arrow/Enter
  // navigation stays in its own local listener below.
  useOverlayEsc(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); const r = results[index]; if (r) choose(r.file); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, results, index]);

  if (!open) return null;

  const showingRecent = !query.trim() && results.length > 0;

  return (
    <div className="cmdp-scrim" onMouseDown={() => setOpen(false)}>
      <div className="cmdp-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Quick open">
        <div className="cmdp-inputrow">
          <input
            ref={inputRef}
            className="cmdp-input"
            placeholder={root ? `Go to file in ${label}…` : "No workspace open"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            disabled={!root}
          />
          <button className="ov-x" onClick={() => setOpen(false)} title="Close"><IconClose size={16} /></button>
        </div>
        <div className="cmdp-list">
          {!root && <div className="cmdp-empty">Open a workspace to search its files.</div>}
          {root && files === null && <div className="cmdp-empty">{scan === "cold" ? `Indexing ${label}…` : "Loading…"}</div>}
          {/* Nothing at all under the root: either an empty checkout or a scan
              that failed outright. Say so and offer the one action, rather
              than blaming the query for matching nothing. */}
          {root && files !== null && files.length === 0 && scan === "idle" && (
            <div className="cmdp-empty">
              <div>Nothing indexed under {label}.</div>
              <button className="ex-retry" style={{ marginTop: 8 }} onClick={retry}>Retry scan</button>
            </div>
          )}
          {root && files !== null && files.length > 0 && results.length === 0 && (
            <div className="cmdp-empty">
              {query.trim()
                ? (scan === "cold" ? `No matches yet — still indexing ${label}…` : `No files match "${query.trim()}".`)
                : "No recent files yet — start typing to search."}
            </div>
          )}
          {showingRecent && <div className="cmdp-section">Recent</div>}
          {results.map((r, i) => {
            const isActive = i === index;
            return (
              <div
                key={r.file.path}
                ref={isActive ? activeRef : undefined}
                className={"cmdp-item" + (isActive ? " active" : "")}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(r.file)}
              >
                <span className="cmdp-ic"><IconFile size={14} /></span>
                <span className="cmdp-label">{baseName(r.file.path)}</span>
                <span className="cmdp-hint">{highlighted(r.file.relPath, r.positions)}</span>
              </div>
            );
          })}
          {/* One honest status line: what the index is doing, or where it
              stopped. QL-741 — a hit cap is never silent. */}
          {root && files !== null && (scan !== "idle" || (truncated && files.length > 0)) && (
            <div className="cmdp-empty-hint" style={{ padding: "6px 10px", textAlign: "left" }} aria-live="polite">
              {scan === "cold"
                ? `Indexing ${label}… ${files.length} files so far`
                : scan === "refresh"
                  ? `Refreshing index for ${label}…`
                  : `Index truncated (${files.length} files scanned) — narrow your search to reach the rest.`}
            </div>
          )}
        </div>
        <div className="cmdp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
