import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useApp } from "./store";
import { IconClose, IconFolder, IconRefresh } from "./Icons";
import { useVendors, vendorMeta, vendorShort, defaultCycle } from "./vendors";
import { VendorGlyph } from "./VendorGlyph";
import { isolationPref, setIsolationPref, preparePanes, repoToplevel } from "./worktrees";
import "./review.css"; // .isolate-row lives with the review/worktree styles

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s || p;
}
function gridStyle(n: number): CSSProperties {
  if (n === 1) return { gridTemplateColumns: "1fr" };
  if (n === 2) return { gridTemplateColumns: "1fr 1fr" };
  if (n === 4) return { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" };
  return { gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "1fr 1fr" };
}

const TILE_COUNTS = [1, 2, 4, 6];
const MIN_COUNT = 1;
const MAX_COUNT = 9;

interface Slot { vendor: string; dir: string | null; } // dir null = use the workspace default

// UI-101/108: recent roots + the layout last used per repo.
const RECENTS_KEY = "flightdeck-recent-roots";
const MAX_RECENTS = 8;

function loadRecentRoots(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENTS) : [];
  } catch { return []; }
}

function rememberRoot(dir: string) {
  try {
    const next = [dir, ...loadRecentRoots().filter((d) => d.toLowerCase() !== dir.toLowerCase())].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch { /* non-persistent */ }
}

function layoutKey(top: string) { return `flightdeck-layout:${top.toLowerCase()}`; }

export function NewWorkspace() {
  const createWorkspace = useApp((s) => s.createWorkspace);
  const cancelCreate = useApp((s) => s.cancelCreate);
  const hasWorkspaces = useApp((s) => s.workspaces.length > 0);

  const [count, setCount] = useState(4);
  // No baked-in default path (QOL 285) — placeholder guides instead.
  const [root, setRoot] = useState("");
  const [slots, setSlots] = useState<Slot[]>(() => {
    const cycle = defaultCycle();
    return Array.from({ length: 4 }, (_, i) => ({ vendor: cycle[i % cycle.length], dir: null }));
  });
  // UI-101: recently-used roots, most recent first.
  const [recents] = useState<string[]>(loadRecentRoots);
  const [showRecents, setShowRecents] = useState(false);
  // UI-103: does the typed path exist? null = unchecked/blank.
  const [pathOk, setPathOk] = useState<boolean | null>(null);
  // UI-106: where the setup command came from, so it isn't magic.
  const [setupSource, setSetupSource] = useState<string | null>(null);
  // UI-112: per-slot progress while worktrees are prepared.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Vendor list + install detection both come from the Rust registry (216).
  const vendors = useVendors((s) => s.vendors);
  const vendorsLoaded = useVendors((s) => s.loaded);
  const loadVendors = useVendors((s) => s.load);
  useEffect(() => { void loadVendors(); }, [loadVendors]);

  // Worktree isolation (Tier 0): default from the last-used preference; the
  // toggle only applies when the default directory is actually a git repo.
  const [isolate, setIsolate] = useState(isolationPref);
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Worktree setup command (Tier 0 follow-up): runs in each FRESH worktree
  // before its agent spawns (fresh copies have no node_modules). Suggested
  // from the repo's lockfile; last-used value per repo wins over the suggestion.
  const [setupCmd, setSetupCmd] = useState("");
  const [setupTouched, setSetupTouched] = useState(false);
  useEffect(() => {
    const dir = root.trim();
    if (!dir) { setIsRepo(null); setPathOk(null); setSetupSource(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      // UI-103: validate the path itself before anything else — a typo'd path
      // used to fail silently at Create time.
      void invoke<unknown[]>("fs_list_dir", { path: dir })
        .then(() => { if (!cancelled) setPathOk(true); })
        .catch((e) => {
          if (cancelled) return;
          // Only claim a folder is unreadable when the backend actually
          // answered. With no Tauri bridge at all (browser preview) we can't
          // know, and a false "missing" warning is worse than staying quiet.
          const noBridge = /__TAURI|transformCallback|not a function|undefined/i.test(String(e));
          setPathOk(noBridge ? null : false);
          if (!noBridge) setIsRepo(null);
        });

      void repoToplevel(dir).then(async (top) => {
        if (cancelled) return;
        setIsRepo(top != null);
        if (top == null) { setSetupSource(null); return; }
        // UI-108: reuse the layout this repo was last opened with.
        try {
          const n = parseInt(localStorage.getItem(layoutKey(top)) ?? "", 10);
          if (Number.isFinite(n) && n >= MIN_COUNT && n <= MAX_COUNT && !layoutTouched.current) changeCount(n);
        } catch { /* non-persistent */ }
        if (setupTouched) return;
        let remembered: string | null = null;
        try { remembered = localStorage.getItem(`flightdeck-setup:${top.toLowerCase()}`); } catch { /* non-persistent */ }
        if (remembered != null) {
          if (!cancelled) { setSetupCmd(remembered); setSetupSource(remembered ? "last used for this repo" : null); }
          return;
        }
        const suggested = await invoke<string | null>("detect_setup_command", { cwd: dir }).catch(() => null);
        if (!cancelled && suggested) {
          setSetupCmd(suggested);
          setSetupSource("suggested from this repo's lockfile");
        }
      });
    }, 350); // debounce typing
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, setupTouched]);

  // Tracks whether the user picked a layout themselves — a remembered
  // per-repo layout must never overwrite a deliberate choice.
  const layoutTouched = useRef(false);

  const changeCount = (n: number) => {
    setCount(n);
    const cycle = defaultCycle();
    setSlots((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? { vendor: cycle[i % cycle.length], dir: null }));
  };
  const pickCount = (n: number) => { layoutTouched.current = true; changeCount(n); };
  const setVendor = (i: number, v: string) => setSlots((s) => s.map((x, j) => (j === i ? { ...x, vendor: v } : x)));
  const setDir = (i: number, d: string | null) => setSlots((s) => s.map((x, j) => (j === i ? { ...x, dir: d } : x)));

  // UI-104: duplicate a row (same agent + directory) — the common "one more
  // like that" action previously meant re-picking both.
  const duplicateSlot = (i: number) => {
    if (count >= MAX_COUNT) return;
    layoutTouched.current = true;
    setSlots((s) => [...s.slice(0, i + 1), { ...s[i] }, ...s.slice(i + 1)]);
    setCount((c) => Math.min(MAX_COUNT, c + 1));
  };
  const removeSlot = (i: number) => {
    if (count <= MIN_COUNT) return;
    layoutTouched.current = true;
    setSlots((s) => s.filter((_, j) => j !== i));
    setCount((c) => Math.max(MIN_COUNT, c - 1));
  };
  // UI-105: reorder rows so pane order matches intent.
  const moveSlot = (from: number, to: number) => {
    if (to < 0 || to >= count || from === to) return;
    layoutTouched.current = true;
    setSlots((s) => {
      const next = s.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const browseRoot = async () => {
    const p = await open({ directory: true, defaultPath: root || undefined });
    if (typeof p === "string") setRoot(p);
  };
  const browseSlot = async (i: number) => {
    const p = await open({ directory: true, defaultPath: (slots[i].dir ?? root) || undefined });
    if (typeof p === "string") setDir(i, p);
  };

  // Async: each isolated slot gets its own git worktree BEFORE the workspace is
  // created, so the pane's cwd is the worktree from the very first PTY spawn.
  // Worktree creation lives here in the click path (not in Terminal's mount
  // effect) so StrictMode double-mounts and restarts can never re-create one.
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setIsolationPref(isolate);
    const effectiveSetup = isolate && isRepo !== false ? setupCmd.trim() : "";
    setProgress({ done: 0, total: slots.length });
    try {
      const panes = await preparePanes(
        slots.map((s) => ({ vendor: s.vendor, cwd: (s.dir ?? root).trim() })),
        isolate,
        (done, total) => setProgress({ done, total }) // UI-112
      );
      rememberRoot(root.trim()); // UI-101
      // Remember the exact value per repo (including a deliberate blank).
      try {
        const top = await repoToplevel(root.trim());
        if (top) {
          localStorage.setItem(`flightdeck-setup:${top.toLowerCase()}`, effectiveSetup);
          localStorage.setItem(layoutKey(top), String(count)); // UI-108
        }
      } catch { /* non-persistent */ }
      createWorkspace(root.trim(), panes, effectiveSetup || undefined);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // UI-110: Esc closes (matches every other overlay) — only when there's
  // something to go back to. UI-100: Enter submits from any field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && hasWorkspaces && !busy) { e.preventDefault(); cancelCreate(); return; }
      if (e.key === "Enter" && !busy && canCreate && !(e.target as HTMLElement)?.closest?.("select")) {
        e.preventDefault();
        void create();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWorkspaces, busy, root, slots, isolate, setupCmd, count]);

  // UI-113: drop a folder anywhere on the dialog to fill the directory.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    // getCurrentWebview() throws SYNCHRONOUSLY outside a real Tauri window
    // (it reads __TAURI_INTERNALS__), so a .catch() on the promise never sees
    // it — same guard as LeftPanel's folder-drop.
    let webview: ReturnType<typeof getCurrentWebview>;
    try { webview = getCurrentWebview(); } catch { return; }
    webview
      .onDragDropEvent((e) => {
        if (e.payload.type !== "drop") return;
        const p = e.payload.paths[0];
        if (p) { setRoot(p); setShowRecents(false); }
      })
      .then((fn) => { if (cancelled) fn(); else un = fn; })
      .catch(() => { /* drag-drop unavailable — Browse still works */ });
    return () => { cancelled = true; un?.(); };
  }, []);

  // UI-109: two non-isolated slots in the same folder means two agents editing
  // the same files — worth a word before they trample each other.
  const collision = !isolate && (() => {
    const dirs = slots.map((s) => (s.dir ?? root).trim().toLowerCase()).filter(Boolean);
    return new Set(dirs).size < dirs.length;
  })();

  const counts = slots.reduce<Record<string, number>>((m, s) => ((m[s.vendor] = (m[s.vendor] || 0) + 1), m), {});
  const summary = Object.entries(counts).map(([v, c]) => `${c}× ${vendorShort(v)}`).join(", ");
  const canCreate = !!root.trim();

  return (
    <div className={"launcher" + (hasWorkspaces ? " overlay" : "")}>
      <div className="dialog">
        <div className="dh">
          <h2>New Workspace</h2>
          {hasWorkspaces && <span className="dh-x" onClick={cancelCreate}><IconClose size={13} /></span>}
        </div>
        <div className="db">
          <div>
            <span className="lbl">Layout</span>
            <div className="tiles">
              {TILE_COUNTS.map((n) => (
                <div className={"tile" + (count === n ? " sel" : "")} key={n} onClick={() => pickCount(n)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickCount(n); } }}>
                  <div className="prev" style={gridStyle(n)}>
                    {Array.from({ length: n }).map((_, i) => (<i key={i} />))}
                  </div>
                  <span className="num">{n}</span>
                </div>
              ))}
              <div className={"tile tile-custom" + (!TILE_COUNTS.includes(count) ? " sel" : "")}>
                <div className="stepper" role="group" aria-label="Custom pane count">
                  <button
                    type="button"
                    className="step-btn"
                    onClick={() => pickCount(Math.max(MIN_COUNT, count - 1))}
                    disabled={count <= MIN_COUNT}
                    aria-label="Decrease pane count"
                  >
                    −
                  </button>
                  <span className="step-n">{count}</span>
                  <button
                    type="button"
                    className="step-btn"
                    onClick={() => pickCount(Math.min(MAX_COUNT, count + 1))}
                    disabled={count >= MAX_COUNT}
                    aria-label="Increase pane count"
                  >
                    +
                  </button>
                </div>
                <span className="num">Custom</span>
              </div>
            </div>
          </div>

          <div>
            <span className="lbl">Default directory</span>
            <div className={"dir" + (pathOk === false ? " bad" : "")}>
              <span className="folder"><IconFolder size={14} /></span>
              <input
                className="path"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                onFocus={() => setShowRecents(recents.length > 0 && !root.trim())}
                onBlur={() => window.setTimeout(() => setShowRecents(false), 120)}
                spellCheck={false}
                placeholder="Choose your project folder…  (or drop one here)"
                aria-invalid={pathOk === false}
              />
              {recents.length > 0 && (
                <button className="browse recents-btn" onClick={() => setShowRecents((v) => !v)} title="Recent folders">
                  Recent
                </button>
              )}
              <button className="browse" onClick={browseRoot}>Browse</button>
              {showRecents && recents.length > 0 && (
                <div className="recents-menu">
                  {recents.map((r) => (
                    <button key={r} className="recents-item" onMouseDown={(e) => { e.preventDefault(); setRoot(r); setShowRecents(false); }} title={r}>
                      <IconFolder size={11} />
                      <span className="recents-name">{baseName(r)}</span>
                      <span className="recents-path">{r}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {pathOk === false && (
              <div className="dir-err">
                Couldn't read that folder — check the path, or use Browse. You can still create the
                workspace; panes will report the error if it really is missing.
              </div>
            )}
            <label className={"isolate-row" + (isRepo === false ? " off" : "")} title={
              isRepo === false
                ? "This folder isn't a git repository — panes run directly in it."
                : "Each agent works on its own branch in its own folder copy, so parallel agents never overwrite each other. Review & merge their changes from the pane header."
            }>
              <input
                type="checkbox"
                checked={isolate && isRepo !== false}
                disabled={isRepo === false}
                onChange={(e) => setIsolate(e.target.checked)}
              />
              <span>Isolate each agent in its own git worktree</span>
              {isRepo === false && <span className="isolate-note">not a git repo — runs directly</span>}
            </label>
            {isolate && isRepo !== false && (
              <div className="setup-row" title="Runs once inside each freshly created worktree before its agent starts (a fresh worktree has no node_modules). Leave blank to skip.">
                <span className="setup-lbl">Worktree setup</span>
                <input
                  className="setup-input"
                  value={setupCmd}
                  onChange={(e) => { setSetupTouched(true); setSetupCmd(e.target.value); }}
                  spellCheck={false}
                  placeholder="e.g. npm ci  (runs in each fresh worktree — blank = skip)"
                />
                {setupSource && !setupTouched && <span className="setup-src">{setupSource}</span>}
              </div>
            )}
          </div>

          <div>
            <div className="agents-head">
              <span className="lbl">Panes &amp; directories</span>
              <span className="summary">{summary}</span>
            </div>
            {collision && (
              <div className="slot-collision">
                Two or more panes share a folder with isolation off — those agents will edit the same
                files at the same time. Turn isolation on, or give them different folders.
              </div>
            )}
            <div className="slot-list">
              {slots.map((s, i) => (
                <div className="slot-row" key={i}>
                  <span className="slot-n">Pane {i + 1}</span>
                  {/* UI-236/219: identity by glyph as well as colour. */}
                  <VendorGlyph id={s.vendor} size={18} />
                  <select className="vsel" value={s.vendor} onChange={(e) => setVendor(i, e.target.value)}>
                    {vendors.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
                  </select>
                  {/* UI-9/351: an actionable sentence, not a bare fragment. */}
                  {vendorsLoaded && !vendorMeta(s.vendor).installed && (
                    <span
                      className="slot-warn"
                      title={
                        `${vendorMeta(s.vendor).label} isn't installed, so this pane will fail to start. ` +
                        (vendorMeta(s.vendor).installHint
                          ? `Install it with: ${vendorMeta(s.vendor).installHint} — or pick another agent. `
                          : "Pick another agent, or install it first. ") +
                        `(${vendorMeta(s.vendor).detail})`
                      }
                    >
                      not installed
                    </span>
                  )}
                  {vendorsLoaded && vendorMeta(s.vendor).installed && vendorMeta(s.vendor).authState === "none" && (
                    <span className="slot-warn" title={vendorMeta(s.vendor).authDetail || "No stored sign-in — the pane will ask you to log in on first launch."}>not signed in</span>
                  )}
                  <button className={"dirbtn" + (s.dir ? " custom" : "")} onClick={() => browseSlot(i)} title={s.dir ?? root + "  (default)"}>
                    <IconFolder size={12} /> {baseName(s.dir ?? root)}
                  </button>
                  {s.dir && <button className="dirreset" onClick={() => setDir(i, null)} title="Use default directory"><IconRefresh size={12} /></button>}
                  {/* UI-105/104: reorder + duplicate/remove this row. */}
                  <span className="slot-actions">
                    <button className="slot-act" onClick={() => moveSlot(i, i - 1)} disabled={i === 0} title="Move up" aria-label={`Move pane ${i + 1} up`}>↑</button>
                    <button className="slot-act" onClick={() => moveSlot(i, i + 1)} disabled={i === count - 1} title="Move down" aria-label={`Move pane ${i + 1} down`}>↓</button>
                    <button className="slot-act" onClick={() => duplicateSlot(i)} disabled={count >= MAX_COUNT} title="Duplicate this pane" aria-label={`Duplicate pane ${i + 1}`}>+</button>
                    <button className="slot-act" onClick={() => removeSlot(i)} disabled={count <= MIN_COUNT} title="Remove this pane" aria-label={`Remove pane ${i + 1}`}>×</button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="df">
          {hasWorkspaces && <button className="cancel" onClick={cancelCreate}>Cancel</button>}
          <button className="btn-primary" onClick={() => void create()} disabled={!canCreate || busy}>
            {busy
              ? progress && progress.total > 1
                ? `Preparing worktree ${progress.done} of ${progress.total}…`
                : "Preparing…"
              : "Create Workspace →"}
          </button>
        </div>
      </div>
    </div>
  );
}
