import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "./store";
import { IconClose, IconFolder, IconRefresh } from "./Icons";

const VENDORS = [
  { id: "claude", name: "Claude Code" },
  { id: "agy", name: "Antigravity" },
  { id: "pwsh", name: "pwsh (shell)" },
];
const CYCLE = ["claude", "agy"];
const SHORT: Record<string, string> = { claude: "Claude", agy: "Antigravity", pwsh: "pwsh" };

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s || p;
}
function gridStyle(n: number): CSSProperties {
  if (n === 2) return { gridTemplateColumns: "1fr 1fr" };
  if (n === 4) return { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" };
  return { gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "1fr 1fr" };
}

interface Slot { vendor: string; dir: string | null; } // dir null = use the workspace default

export function NewWorkspace() {
  const createWorkspace = useApp((s) => s.createWorkspace);
  const cancelCreate = useApp((s) => s.cancelCreate);
  const hasWorkspaces = useApp((s) => s.workspaces.length > 0);

  const [count, setCount] = useState(4);
  const [root, setRoot] = useState("D:\\Dev\\ai\\Harness");
  const [slots, setSlots] = useState<Slot[]>(() =>
    Array.from({ length: 4 }, (_, i) => ({ vendor: CYCLE[i % CYCLE.length], dir: null }))
  );

  // First-run detection: which agent CLIs are actually installed here.
  const [vinfo, setVinfo] = useState<Record<string, { installed: boolean; detail: string }>>({});
  useEffect(() => {
    invoke<{ id: string; label: string; installed: boolean; detail: string }[]>("detect_vendors")
      .then((list) => {
        const m: Record<string, { installed: boolean; detail: string }> = {};
        for (const v of list) m[v.id] = { installed: v.installed, detail: v.detail };
        setVinfo(m);
      })
      .catch(() => { /* detection is best-effort — never block the launcher */ });
  }, []);

  const changeCount = (n: number) => {
    setCount(n);
    setSlots((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? { vendor: CYCLE[i % CYCLE.length], dir: null }));
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

  const create = () =>
    createWorkspace(root.trim(), slots.map((s) => ({ vendor: s.vendor, cwd: (s.dir ?? root).trim() })));

  const counts = slots.reduce<Record<string, number>>((m, s) => ((m[s.vendor] = (m[s.vendor] || 0) + 1), m), {});
  const summary = Object.entries(counts).map(([v, c]) => `${c}× ${SHORT[v] ?? v}`).join(", ");

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
              {[2, 4, 6].map((n) => (
                <div className={"tile" + (count === n ? " sel" : "")} key={n} onClick={() => changeCount(n)}>
                  <div className="prev" style={gridStyle(n)}>
                    {Array.from({ length: n }).map((_, i) => (<i key={i} />))}
                  </div>
                  <span className="num">{n}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <span className="lbl">Default directory</span>
            <div className="dir">
              <span className="folder"><IconFolder size={14} /></span>
              <input className="path" value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} />
              <button className="browse" onClick={browseRoot}>Browse</button>
            </div>
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
                    {VENDORS.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
                  </select>
                  {vinfo[s.vendor] && !vinfo[s.vendor].installed && (
                    <span className="slot-warn" title={vinfo[s.vendor].detail}>not installed</span>
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
          <button className="btn-primary" onClick={create} disabled={!root.trim()}>Create Workspace →</button>
        </div>
      </div>
    </div>
  );
}
