import { useEffect, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "./store";
import { IconClose, IconFolder, IconRefresh } from "./Icons";
import { useVendors, vendorMeta, vendorShort, defaultCycle } from "./vendors";
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
    if (!dir) { setIsRepo(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void repoToplevel(dir).then(async (top) => {
        if (cancelled) return;
        setIsRepo(top != null);
        if (top == null || setupTouched) return;
        let remembered: string | null = null;
        try { remembered = localStorage.getItem(`flightdeck-setup:${top.toLowerCase()}`); } catch { /* non-persistent */ }
        if (remembered != null) { if (!cancelled) setSetupCmd(remembered); return; }
        const suggested = await invoke<string | null>("detect_setup_command", { cwd: dir }).catch(() => null);
        if (!cancelled && suggested) setSetupCmd(suggested);
      });
    }, 350); // debounce typing
    return () => { cancelled = true; clearTimeout(t); };
  }, [root, setupTouched]);

  const changeCount = (n: number) => {
    setCount(n);
    const cycle = defaultCycle();
    setSlots((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? { vendor: cycle[i % cycle.length], dir: null }));
  };
  const setVendor = (i: number, v: string) => setSlots((s) => s.map((x, j) => (j === i ? { ...x, vendor: v } : x)));
  const setDir = (i: number, d: string | null) => setSlots((s) => s.map((x, j) => (j === i ? { ...x, dir: d } : x)));

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
    try {
      const panes = await preparePanes(
        slots.map((s) => ({ vendor: s.vendor, cwd: (s.dir ?? root).trim() })),
        isolate
      );
      // Remember the exact value per repo (including a deliberate blank).
      try {
        const top = await repoToplevel(root.trim());
        if (top) localStorage.setItem(`flightdeck-setup:${top.toLowerCase()}`, effectiveSetup);
      } catch { /* non-persistent */ }
      createWorkspace(root.trim(), panes, effectiveSetup || undefined);
    } finally {
      setBusy(false);
    }
  };

  const counts = slots.reduce<Record<string, number>>((m, s) => ((m[s.vendor] = (m[s.vendor] || 0) + 1), m), {});
  const summary = Object.entries(counts).map(([v, c]) => `${c}× ${vendorShort(v)}`).join(", ");

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
                <div className={"tile" + (count === n ? " sel" : "")} key={n} onClick={() => changeCount(n)}>
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
                    onClick={() => changeCount(Math.max(MIN_COUNT, count - 1))}
                    disabled={count <= MIN_COUNT}
                    aria-label="Decrease pane count"
                  >
                    −
                  </button>
                  <span className="step-n">{count}</span>
                  <button
                    type="button"
                    className="step-btn"
                    onClick={() => changeCount(Math.min(MAX_COUNT, count + 1))}
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
            <div className="dir">
              <span className="folder"><IconFolder size={14} /></span>
              <input className="path" value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} placeholder="Choose your project folder…" />
              <button className="browse" onClick={browseRoot}>Browse</button>
            </div>
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
              </div>
            )}
          </div>

          <div>
            <div className="agents-head">
              <span className="lbl">Panes &amp; directories</span>
              <span className="summary">{summary}</span>
            </div>
            <div className="slot-list">
              {slots.map((s, i) => (
                <div className="slot-row" key={i}>
                  <span className="slot-n">Pane {i + 1}</span>
                  <select className="vsel" value={s.vendor} onChange={(e) => setVendor(i, e.target.value)}>
                    {vendors.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
                  </select>
                  {vendorsLoaded && !vendorMeta(s.vendor).installed && (
                    <span className="slot-warn" title={vendorMeta(s.vendor).detail}>not installed</span>
                  )}
                  <button className={"dirbtn" + (s.dir ? " custom" : "")} onClick={() => browseSlot(i)} title={s.dir ?? root + "  (default)"}>
                    <IconFolder size={12} /> {baseName(s.dir ?? root)}
                  </button>
                  {s.dir && <button className="dirreset" onClick={() => setDir(i, null)} title="Use default directory"><IconRefresh size={12} /></button>}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="df">
          {hasWorkspaces && <button className="cancel" onClick={cancelCreate}>Cancel</button>}
          <button className="btn-primary" onClick={() => void create()} disabled={!root.trim() || busy}>
            {busy ? "Preparing worktrees…" : "Create Workspace →"}
          </button>
        </div>
      </div>
    </div>
  );
}
