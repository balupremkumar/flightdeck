import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useUI, applyUiScale } from "./ui";
import { useApp } from "./store";
import { bytes, relTime, absTime } from "./format";
import { useFocusTrap } from "./useFocusTrap";
import { listRestorePoints, restoreFromPoint, exportBackup, importBackup, type RestorePointInfo } from "./persist";
import { adoptSession, lastSessionSaveAt } from "./session";
import { spawnPane } from "./worktrees";
import { useVendors, vendorColor, vendorAccentOverrides, setVendorAccentOverride } from "./vendors";
import { IconClose } from "./Icons";
import {
  THEMES, ACCENTS, findTheme, findAccent, CUSTOM_ACCENT_ID, customAccentHex, setCustomAccent,
  applyTheme, applyAccent, setAccent,
  currentThemeId, currentAccentId,
  isColorBlindSafe, setColorBlindSafe,
  isReducedMotion, setReducedMotion,
  exportThemeJson, importThemeJson,
} from "./themes";
import "./overlays.css";

const SCALES = [
  { k: "1", label: "Comfortable" },
  { k: "1.12", label: "Large" },
  { k: "1.25", label: "Extra" },
];

function currentScale(): string {
  return document.documentElement.style.zoom || "1";
}

// ---------------------------------------------------------------------
// Terminal settings (88). Persisted + exported for Terminal.tsx to read.
// Terminal.tsx (owned by another agent) can do:
//   import { getTerminalSettings } from "./Settings";
//   const t = getTerminalSettings();
//   new XTerm({ fontFamily: t.fontFamily, fontSize: t.fontSize, cursorStyle: t.cursorStyle, scrollback: t.scrollback, ... })
// and optionally listen for live changes:
//   window.addEventListener("flightdeck-terminal-settings-changed", (e) => { ... (e as CustomEvent).detail })
// ---------------------------------------------------------------------
export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
}
const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: "JetBrains Mono", fontSize: 12.5, cursorStyle: "block", scrollback: 5000,
};
const TERMINAL_FONTS = ["JetBrains Mono", "Cascadia Code", "Consolas", "Fira Code", "Menlo", "ui-monospace"];

export function getTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem("flightdeck-terminal-settings");
    if (raw) return { ...DEFAULT_TERMINAL_SETTINGS, ...JSON.parse(raw) };
  } catch { /* non-persistent */ }
  return DEFAULT_TERMINAL_SETTINGS;
}
function saveTerminalSettings(patch: Partial<TerminalSettings>): TerminalSettings {
  const next = { ...getTerminalSettings(), ...patch };
  try { localStorage.setItem("flightdeck-terminal-settings", JSON.stringify(next)); } catch { /* non-persistent */ }
  window.dispatchEvent(new CustomEvent("flightdeck-terminal-settings-changed", { detail: next }));
  return next;
}

// ---------------------------------------------------------------------
// Shortcut editor (89). Rebinding is persisted here; the two real
// shortcuts today (Ctrl+, and Ctrl+B) are still hardcoded in Cockpit.tsx's
// keydown handler (a file this agent doesn't own) — see the report for the
// small diff that would make it read `getShortcuts()` instead.
// ---------------------------------------------------------------------
export interface ShortcutDef { id: string; label: string; combo: string; }
const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  { id: "settings", label: "Open settings", combo: "Ctrl+," },
  { id: "toggle-panel", label: "Toggle side panel", combo: "Ctrl+B" },
];
// Shipped shortcuts that aren't rebindable — hardcoded elsewhere (CommandPalette's
// own key handler, Cockpit's Ctrl+1-9 workspace switcher). Shown here read-only so
// Settings doesn't undersell what the app actually supports.
const FIXED_SHORTCUTS: ShortcutDef[] = [
  { id: "cmdp-k", label: "Command palette", combo: "Ctrl+K" },
  { id: "cmdp-p", label: "Command palette", combo: "Ctrl+P" },
  { id: "switch-workspace", label: "Switch to workspace 1-9", combo: "Ctrl+1..9" },
];
export function getShortcuts(): ShortcutDef[] {
  let overrides: Record<string, string> = {};
  try { overrides = JSON.parse(localStorage.getItem("flightdeck-shortcuts") || "{}"); } catch { /* non-persistent */ }
  return DEFAULT_SHORTCUTS.map((s) => ({ ...s, combo: overrides[s.id] ?? s.combo }));
}
function saveShortcut(id: string, combo: string) {
  let overrides: Record<string, string> = {};
  try { overrides = JSON.parse(localStorage.getItem("flightdeck-shortcuts") || "{}"); } catch { /* non-persistent */ }
  overrides[id] = combo;
  try { localStorage.setItem("flightdeck-shortcuts", JSON.stringify(overrides)); } catch { /* non-persistent */ }
}
function resetShortcuts() {
  try { localStorage.removeItem("flightdeck-shortcuts"); } catch { /* non-persistent */ }
}
function formatCombo(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join("+");
}

// ---------------------------------------------------------------------
// Agents settings (90). Default vendor + per-vendor flags/binary path
// overrides. Vendor ids mirror src-tauri/src/lib.rs's VENDORS table.
// Persisted here for the launcher / pty_spawn call sites to read later.
// ---------------------------------------------------------------------
// Vendor list comes from the Rust registry (src/vendors.ts) — never hardcode it
// here, or a newly-added agent silently gets no settings row (BACKLOG 216).
export interface AgentSettings {
  defaultVendor: string;
  flags: Record<string, string>;
  binaryPaths: Record<string, string>;
}
const DEFAULT_AGENT_SETTINGS: AgentSettings = { defaultVendor: "claude", flags: {}, binaryPaths: {} };
export function getAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem("flightdeck-agent-settings");
    if (raw) {
      const p = JSON.parse(raw);
      return { ...DEFAULT_AGENT_SETTINGS, ...p, flags: { ...p.flags }, binaryPaths: { ...p.binaryPaths } };
    }
  } catch { /* non-persistent */ }
  return DEFAULT_AGENT_SETTINGS;
}
function saveAgentSettings(next: AgentSettings) {
  try { localStorage.setItem("flightdeck-agent-settings", JSON.stringify(next)); } catch { /* non-persistent */ }
}

// ---------------------------------------------------------------------
// Startup behaviour (91).
// ---------------------------------------------------------------------
export type StartupBehavior = "reopen" | "launcher";
export function getStartupBehavior(): StartupBehavior {
  try { return (localStorage.getItem("flightdeck-startup") as StartupBehavior) || "launcher"; } catch { return "launcher"; }
}
function saveStartupBehavior(v: StartupBehavior) {
  try { localStorage.setItem("flightdeck-startup", v); } catch { /* non-persistent */ }
}

// Shown in About + useful for bug reports. Keep in step with package.json /
// tauri.conf.json version bumps.
export const APP_VERSION = "0.1.0";

// Newest first; trim to the last ~10 entries as it grows.
const CHANGELOG: Array<{ date: string; text: string }> = [
  { date: "2026-07-20", text: "\"Needs approval\" badge when an agent is blocked on a permission prompt; attention queue ranks it first." },
  { date: "2026-07-20", text: "Add any agent by dropping a JSON manifest in the vendors folder — no rebuild (see Agents above)." },
  { date: "2026-07-20", text: "Sessions persist: workspaces, panes, worktrees and the Board survive a restart, with a reopen prompt." },
  { date: "2026-07-20", text: "Custom accent colour — pick any colour; dark & light variants are derived automatically." },
  { date: "2026-07-20", text: "Diagnostics: per-pane CPU/memory, stray-process cleanup, redacted support-bundle export." },
  { date: "2026-07-19", text: "Worktree isolation: each agent works on its own branch in its own folder copy, with a review & merge drawer." },
];

// ---------------------------------------------------------------------
// Diagnostics (UI-4 / QOL 375-377): surfaces three backend capabilities that
// were built + tested but had zero UI — per-pane health, stray-process
// recovery, and the redacted support bundle.
// ---------------------------------------------------------------------
interface PaneHealthRow { paneId: number; pid: number; cpuPercent: number; memoryMb: number; procName: string; }
interface OrphanRow { pid: number; ppid: number; name: string; }

// UI-191/192: restore points and one-file backup. persist.rs has shipped all
// of this since wave 2 with zero UI — every autosave already writes a snapshot,
// they were just unreachable.
function SessionSection() {
  const [points, setPoints] = useState<RestorePointInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    listRestorePoints()
      .then(setPoints)
      .catch(() => setPoints([]));
  };
  useEffect(refresh, []);

  const restore = (pt: RestorePointInfo) => {
    useUI.getState().requestConfirm({
      title: `Restore the session from ${relTime(pt.savedAt)}?`,
      body: "Your open workspaces are closed first (their isolated worktrees are cleaned up, keeping any work on its branch), then this snapshot is reopened. Running agents end.",
      confirmLabel: "Restore this point",
      danger: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          const doc = await restoreFromPoint(pt.id);
          await adoptSession(doc);
          useUI.getState().pushToast("success", `Restored the session from ${relTime(pt.savedAt)}.`);
        } catch (e) {
          useUI.getState().pushToast("error", `Couldn't restore: ${String(e)}`);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const doExport = async () => {
    const dest = await save({
      title: "Save Flightdeck backup",
      defaultPath: `flightdeck-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    }).catch(() => null);
    if (!dest) return;
    try {
      await exportBackup(dest);
      useUI.getState().pushToast("success", "Backup saved.");
    } catch (e) {
      useUI.getState().pushToast("error", `Backup failed: ${String(e)}`);
    }
  };

  const doImport = async () => {
    const src = await openDialog({
      title: "Import Flightdeck backup",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    }).catch(() => null);
    if (typeof src !== "string") return;
    useUI.getState().requestConfirm({
      title: "Import this backup?",
      body: "It replaces your current session: open workspaces close (worktrees cleaned up, work kept on branches) and the backup's workspaces reopen.",
      confirmLabel: "Import & replace",
      danger: true,
      onConfirm: async () => {
        try {
          const doc = await importBackup(src);
          if (doc) {
            await adoptSession(doc);
            useUI.getState().pushToast("success", "Backup imported.");
          } else {
            useUI.getState().pushToast("info", "That backup had no session in it — settings only.");
          }
          refresh();
        } catch (e) {
          useUI.getState().pushToast("error", `Import failed: ${String(e)}`);
        }
      },
    });
  };

  return (
    <section className="set-section">
      <div className="set-label">Session</div>
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Restore points</span>
          <span className="set-row-sub">Automatic snapshots, newest first — taken as you work</span>
        </div>
        <button className="set-btn" onClick={refresh}>Refresh</button>
      </div>
      {points === null && <div className="diag-empty">Loading…</div>}
      {points && points.length === 0 && (
        <div className="diag-empty">No restore points yet — they appear as the session autosaves.</div>
      )}
      {points && points.length > 0 && (
        <div className="diag-table" role="table" aria-label="Restore points">
          {points.map((pt) => (
            <div className="diag-tr" role="row" key={pt.id}>
              <span title={absTime(pt.savedAt)}>{relTime(pt.savedAt)}</span>
              <span className="diag-proc">{absTime(pt.savedAt)}</span>
              <span />
              <span />
              <button className="set-btn" disabled={busy} onClick={() => restore(pt)}>Restore</button>
            </div>
          ))}
        </div>
      )}

      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Backup</span>
          <span className="set-row-sub">One file with your session and preferences</span>
        </div>
        <button className="set-btn" onClick={() => void doExport()}>Export…</button>
        <button className="set-btn" onClick={() => void doImport()}>Import…</button>
      </div>
    </section>
  );
}

interface WorktreeEntry {
  path: string; repo: string; branch: string; baseBranch: string; bytes: number; orphan: boolean;
}

function DiagnosticsSection() {
  const [worktrees, setWorktrees] = useState<WorktreeEntry[] | null>(null);
  const [wtBusy, setWtBusy] = useState(false);

  const loadWorktrees = async () => {
    setWtBusy(true);
    try {
      // Claimed = every worktree a live pane owns; anything else is reapable.
      const claimed = useApp.getState().workspaces.flatMap((w) =>
        w.panes.map((p) => p.worktreePath).filter((x): x is string => !!x)
      );
      setWorktrees(await invoke<WorktreeEntry[]>("git_worktree_list", { claimed }));
    } catch {
      setWorktrees([]);
    } finally {
      setWtBusy(false);
    }
  };

  const reapOrphanWorktrees = () => {
    const orphans = (worktrees ?? []).filter((w) => w.orphan);
    if (orphans.length === 0) return;
    useUI.getState().requestConfirm({
      title: `Clean ${orphans.length} unused worktree${orphans.length === 1 ? "" : "s"}?`,
      body: "These aren't claimed by any open pane. Any uncommitted work in them is committed to their branch first, so nothing is lost — only the folders go.",
      confirmLabel: "Clean up",
      onConfirm: async () => {
        let freed = 0;
        for (const w of orphans) {
          try { await invoke("git_worktree_remove", { worktreePath: w.path, mode: "keep" }); freed += w.bytes; } catch { /* keep going */ }
        }
        useUI.getState().pushToast("success", `Freed ${bytes(freed)} (work kept on branches).`);
        void loadWorktrees();
      },
    });
  };

  const pushToast = useUI((s) => s.pushToast);
  const [health, setHealth] = useState<PaneHealthRow[] | null>(null);
  const [orphans, setOrphans] = useState<OrphanRow[] | null>(null);
  const [scanning, setScanning] = useState(false);

  // Poll health while the section is on screen. First sample reads 0% CPU by
  // design (delta-based); ticks refine it.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      invoke<PaneHealthRow[]>("pane_health")
        .then((rows) => { if (!cancelled) setHealth(rows); })
        .catch(() => { if (!cancelled) setHealth(null); });
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const scanOrphans = () => {
    setScanning(true);
    invoke<OrphanRow[]>("recover_orphans")
      .then(setOrphans)
      .catch(() => pushToast("error", "Couldn't scan for stray processes."))
      .finally(() => setScanning(false));
  };

  const killOrphans = () => {
    if (!orphans || orphans.length === 0) return;
    invoke("kill_orphans", { pids: orphans.map((o) => o.pid) })
      .then(() => { pushToast("success", `Ended ${orphans.length} stray process tree${orphans.length === 1 ? "" : "s"}.`); setOrphans([]); })
      .catch(() => pushToast("error", "Couldn't end the stray processes."));
  };

  const exportBundle = async () => {
    try {
      const dest = await save({ defaultPath: "flightdeck-support.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!dest) return;
      await invoke("export_support_bundle", { destPath: dest });
      pushToast("success", "Support bundle exported (secrets redacted).");
    } catch (e) {
      pushToast("error", `Couldn't export the bundle: ${String(e)}`);
    }
  };

  return (
    <section className="set-section">
      <div className="set-label">Diagnostics</div>

      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Pane health</span>
          <span className="set-row-sub">CPU is % of one core since the last sample</span>
        </div>
      </div>
      {health && health.length > 0 ? (
        <div className="diag-table" role="table" aria-label="Per-pane process health">
          <div className="diag-tr diag-th" role="row">
            <span>Pane</span><span>Process</span><span>PID</span><span>CPU</span><span>Memory</span>
          </div>
          {health.map((h) => (
            <div className="diag-tr" role="row" key={h.paneId}>
              <span>#{h.paneId}</span>
              <span className="diag-proc">{h.procName || "—"}</span>
              <span>{h.pid}</span>
              <span>{h.cpuPercent.toFixed(1)}%</span>
              <span>{h.memoryMb.toFixed(0)} MB</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="diag-empty">{health === null ? "Health data unavailable in this environment." : "No live panes to sample."}</div>
      )}

      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Stray agent processes</span>
          <span className="set-row-sub">Agent trees left running by a crash or force-quit</span>
        </div>
        <button className="set-btn" onClick={scanOrphans} disabled={scanning}>{scanning ? "Scanning…" : "Scan"}</button>
        {orphans && orphans.length > 0 && (
          <button className="set-btn danger" onClick={killOrphans}>End {orphans.length} stray</button>
        )}
      </div>
      {orphans && orphans.length === 0 && <div className="diag-empty">No strays found — every agent process belongs to a live pane.</div>}
      {orphans && orphans.length > 0 && (
        <div className="diag-table">
          {orphans.map((o) => (
            <div className="diag-tr" key={o.pid}><span>{o.name}</span><span>PID {o.pid}</span><span /><span /><span /></div>
          ))}
        </div>
      )}

      {/* UI-187: worktrees are the app's biggest disk footprint and were
          invisible — list them, size them, and allow reaping the orphans. */}
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Worktrees on disk</span>
          <span className="set-row-sub">
            {worktrees ? `${worktrees.length} total · ${bytes(worktrees.reduce((n, w) => n + w.bytes, 0))}` : "Isolated agent checkouts under app data"}
          </span>
        </div>
        <button className="set-btn" onClick={loadWorktrees} disabled={wtBusy}>{wtBusy ? "Scanning…" : "Scan"}</button>
        {worktrees && worktrees.some((w) => w.orphan) && (
          <button className="set-btn danger" onClick={reapOrphanWorktrees}>
            Clean {worktrees.filter((w) => w.orphan).length} unused
          </button>
        )}
      </div>
      {worktrees && worktrees.length === 0 && <div className="diag-empty">No worktrees on disk.</div>}
      {worktrees && worktrees.length > 0 && (
        <div className="diag-table" role="table" aria-label="Worktrees on disk">
          <div className="diag-tr diag-th" role="row">
            <span>Branch</span><span>Repo</span><span>Size</span><span>State</span><span />
          </div>
          {worktrees.map((w) => (
            <div className="diag-tr" role="row" key={w.path} title={w.path}>
              <span className="diag-proc">{w.branch || "—"}</span>
              <span className="diag-proc">{w.repo.split(/[\/]/).pop() || "—"}</span>
              <span>{bytes(w.bytes)}</span>
              <span className={w.orphan ? "diag-orphan" : ""}>{w.orphan ? "unused" : "in use"}</span>
              <span />
            </div>
          ))}
        </div>
      )}

      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Support bundle</span>
          <span className="set-row-sub">Redacted app + pane snapshot for bug reports</span>
        </div>
        <button className="set-btn" onClick={() => void exportBundle()}>Export…</button>
      </div>
    </section>
  );
}

export function Settings() {
  const open = useUI((s) => s.settingsOpen);
  const setOpen = useUI((s) => s.setSettingsOpen);
  const vendors = useVendors((s) => s.vendors);

  const [themeId, setThemeId] = useState(currentThemeId());
  const [accentId, setAccentId] = useState(currentAccentId());
  const [customHex, setCustomHex] = useState(customAccentHex());
  const [cbSafe, setCbSafe] = useState(isColorBlindSafe());
  const [reducedMotion, setReducedMotionOn] = useState(isReducedMotion());
  const [scale, setScale] = useState(currentScale());
  const [term, setTerm] = useState(getTerminalSettings());
  const [shortcuts, setShortcuts] = useState(getShortcuts());
  const [capturing, setCapturing] = useState<string | null>(null);
  // UI-190: a rebind that collides with an existing binding, pending the user's
  // decision to reassign (which clears the old one) or cancel.
  const [conflict, setConflict] = useState<
    { combo: string; otherId?: string; otherLabel: string; forId: string; fixed: boolean } | null
  >(null);
  const [agents, setAgents] = useState(getAgentSettings());
  const [startup, setStartup] = useState(getStartupBehavior());
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // UI-196: a slow tick is enough — this is reassurance, not telemetry.
  const [savedAgo, setSavedAgo] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const at = lastSessionSaveAt();
      setSavedAgo(at ? relTime(at) : null);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  // UI-180: live section filter. Matching is done on rendered text rather than
  // a hand-maintained keyword table, so a new section is searchable for free.
  const [q, setQ] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  // UI-30: Tab could walk out of the modal into the app behind the scrim.
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, open);
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const needle = q.trim().toLowerCase();
    let shown = 0;
    for (const sec of Array.from(root.querySelectorAll<HTMLElement>(".set-section"))) {
      const hit = !needle || (sec.textContent ?? "").toLowerCase().includes(needle);
      sec.style.display = hit ? "" : "none";
      if (hit) shown++;
    }
    const empty = root.querySelector<HTMLElement>(".set-noresults");
    if (empty) empty.style.display = shown === 0 ? "" : "none";
  });

  // UI-189: manifests that failed to parse — silently skipping them made a
  // typo'd vendor file indistinguishable from a missing one.
  const [manifestProblems, setManifestProblems] = useState<{ file: string; error: string }[]>([]);
  useEffect(() => {
    void invoke<{ file: string; error: string }[]>("manifest_problems")
      .then(setManifestProblems)
      .catch(() => setManifestProblems([]));
  }, []);

  // Re-probe install + auth state (#219) each time Settings opens — a login
  // completed in a pane should show as "signed in" without an app restart.
  useEffect(() => { void useVendors.getState().refresh(); }, []);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      const combo = formatCombo(e);
      if (!combo) return;
      // UI-190: binding a combo that's already taken silently shadowed the
      // other action — whichever handler ran first won, with no way to tell.
      // A clash with a FIXED shortcut can't be reassigned away, so it's a hard
      // refusal; a clash with another rebindable one offers the swap.
      const fixed = FIXED_SHORTCUTS.find((f) => f.combo.toLowerCase() === combo.toLowerCase());
      if (fixed) {
        setConflict({ combo, otherLabel: fixed.label, forId: capturing, fixed: true });
        setCapturing(null);
        return;
      }
      const clash = getShortcuts().find((sc) => sc.id !== capturing && sc.combo === combo);
      if (clash) {
        setConflict({ combo, otherId: clash.id, otherLabel: clash.label, forId: capturing, fixed: false });
        setCapturing(null);
        return;
      }
      saveShortcut(capturing, combo);
      setShortcuts(getShortcuts());
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  // Esc closes — every other overlay does; Settings was the odd one out (QOL 328).
  // Skipped while capturing a shortcut rebind so Esc can be bound/cancelled there.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !capturing) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, capturing, setOpen]);

  if (!open) return null;

  const mode = themeId === "custom" ? "dark" : findTheme(themeId).mode;

  function selectTheme(id: string) {
    if (id === "custom") return; // custom is only reached via import, not clickable directly
    applyTheme(id);
    setThemeId(id);
    applyAccent(accentId, findTheme(id).mode);
  }
  function selectAccent(id: string) {
    setAccent(id, mode);
    setAccentId(id);
  }
  function toggleCbSafe() {
    const next = !cbSafe;
    setColorBlindSafe(next);
    setCbSafe(next);
  }
  function toggleReducedMotion() {
    const next = !reducedMotion;
    setReducedMotion(next);
    setReducedMotionOn(next);
  }
  function handleExport() {
    const json = exportThemeJson(findTheme(themeId).label);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flightdeck-theme-${themeId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ok = importThemeJson(String(reader.result));
      if (ok) { setThemeId("custom"); setImportError(null); }
      else setImportError("That file doesn't look like a Flightdeck theme export.");
    };
    reader.readAsText(file);
  }

  // UI-183: one honest reset. Deliberately scoped to PREFERENCES — it must
  // never touch session state (workspaces/board/worktrees), which is why the
  // key list is explicit rather than a localStorage.clear().
  function resetEverything() {
    useUI.getState().requestConfirm({
      title: "Reset all settings?",
      body: "Theme, accent, terminal, shortcuts, agent and startup preferences go back to defaults. Your workspaces, board cards and worktrees are not affected.",
      confirmLabel: "Reset settings",
      danger: true,
      onConfirm: () => {
        // Verified against every localStorage key the app actually writes —
        // a reset that leaves state behind is worse than no reset.
        const keys = [
          "flightdeck-theme", "flightdeck-theme-id",
          "flightdeck-accent", "flightdeck-accent-custom", "flightdeck-custom-accent",
          "flightdeck-vendor-accents", "flightdeck-colorblind", "flightdeck-reduced-motion",
          "flightdeck-terminal-settings", "flightdeck-terminal-settings-changed",
          "flightdeck-shortcuts", "flightdeck-agent-settings",
          "flightdeck-startup", "flightdeck-ui-scale", "flightdeck-notify-settings",
          "flightdeck-explorer-width", "flightdeck-explorer-scope", "flightdeck-explorer-expanded",
        ];
        for (const k of keys) { try { localStorage.removeItem(k); } catch { /* non-persistent */ } }
        useUI.getState().pushToast("success", "Settings reset — reloading.");
        window.setTimeout(() => window.location.reload(), 600);
      },
    });
  }

  function updateTerm(patch: Partial<TerminalSettings>) {
    setTerm(saveTerminalSettings(patch));
  }
  function updateAgents(next: AgentSettings) {
    saveAgentSettings(next);
    setAgents(next);
  }
  function updateStartup(v: StartupBehavior) {
    saveStartupBehavior(v);
    setStartup(v);
  }

  return (
    <div className="ov-scrim" onMouseDown={() => setOpen(false)}>
      <div className="set-modal" ref={modalRef} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <div className="set-head">
          <h2>Settings</h2>
          {/* UI-180: eleven sections is too many to scan — filter them. */}
          <input
            className="set-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search settings…"
            spellCheck={false}
            aria-label="Search settings"
          />
          <button className="ov-x" onClick={() => setOpen(false)} title="Close"><IconClose size={16} /></button>
        </div>
        <div className="set-body" ref={bodyRef}>

          <section className="set-section">
            <div className="set-label">Appearance</div>

            <div className="theme-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={"theme-tile" + (themeId === t.id ? " on" : "")}
                  onClick={() => selectTheme(t.id)}
                  title={t.label}
                >
                  <span className="theme-swatch">
                    <i style={{ background: t.swatch[0] }} />
                    <i style={{ background: t.swatch[1] }} />
                    <i style={{ background: t.swatch[2] }} />
                  </span>
                  <span className="theme-tile-label">{t.label}</span>
                </button>
              ))}
              {themeId === "custom" && (
                <div className="theme-tile on custom" title="Imported theme">
                  <span className="theme-swatch"><i /><i /><i /></span>
                  <span className="theme-tile-label">Custom (imported)</span>
                </div>
              )}
            </div>

            {/* High Contrast fixes its accent deliberately for accessibility —
                letting the picker override it silently defeats the whole theme. */}
            {themeId !== "high-contrast" && (
              <div className="set-row">
                <div className="set-row-t"><span className="set-row-name">Accent colour</span><span className="set-row-sub">Auto-adjusts for dark or light</span></div>
                <div className="accent-row">
                  {ACCENTS.map((a) => (
                    <button
                      key={a.id}
                      className={"accent-swatch" + (accentId === a.id ? " on" : "")}
                      style={{ background: mode === "light" ? findAccent(a.id).light.accent : findAccent(a.id).dark.accent }}
                      onClick={() => selectAccent(a.id)}
                      title={a.label}
                      aria-label={`Accent: ${a.label}`}
                    />
                  ))}
                  {/* UI-50: any colour — dark/light variants + gradient derived
                      from the one picked hex. The swatch doubles as the input. */}
                  <label
                    className={"accent-swatch accent-custom" + (accentId === CUSTOM_ACCENT_ID ? " on" : "")}
                    style={{
                      background:
                        accentId === CUSTOM_ACCENT_ID
                          ? (mode === "light" ? findAccent(CUSTOM_ACCENT_ID).light.accent : findAccent(CUSTOM_ACCENT_ID).dark.accent)
                          : "conic-gradient(#f55 0deg, #fb0 70deg, #4d4 140deg, #2bd 210deg, #74f 280deg, #f55 360deg)",
                    }}
                    title="Custom — pick any colour"
                    aria-label="Accent: custom colour"
                  >
                    <input
                      type="color"
                      value={customHex}
                      onChange={(e) => {
                        setCustomHex(e.target.value);
                        setCustomAccent(e.target.value, mode);
                        setAccentId(CUSTOM_ACCENT_ID);
                      }}
                    />
                  </label>
                </div>
              </div>
            )}
            {themeId === "high-contrast" && (
              <div className="set-row">
                <div className="set-row-t">
                  <span className="set-row-name">Accent colour</span>
                  <span className="set-row-sub">Fixed by High Contrast for accessibility</span>
                </div>
              </div>
            )}

            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Colour-blind-safe status colours</span><span className="set-row-sub">Blue / amber / vermillion instead of red / green</span></div>
              <button className={"toggle" + (cbSafe ? " on" : "")} role="switch" aria-checked={cbSafe} onClick={toggleCbSafe}><span /></button>
            </div>

            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Reduced motion</span><span className="set-row-sub">Minimise animations app-wide</span></div>
              <button className={"toggle" + (reducedMotion ? " on" : "")} role="switch" aria-checked={reducedMotion} onClick={toggleReducedMotion}><span /></button>
            </div>

            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Theme file</span><span className="set-row-sub">Export the active theme, or import one</span></div>
              <div className="seg">
                <button onClick={handleExport}>Export</button>
                <button onClick={() => fileRef.current?.click()}>Import</button>
              </div>
              <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={handleImportFile} />
            </div>
            {importError && <div className="set-error">{importError}</div>}

            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">UI size</span><span className="set-row-sub">Scale the whole interface</span></div>
              <div className="seg">
                {SCALES.map((s) => (
                  <button key={s.k} className={scale === s.k ? "on" : ""} onClick={() => { applyUiScale(s.k); setScale(s.k); }}>{s.label}</button>
                ))}
              </div>
            </div>
          </section>

          <section className="set-section">
            <div className="set-label">Terminal</div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Font</span></div>
              <select className="set-select" value={term.fontFamily} onChange={(e) => updateTerm({ fontFamily: e.target.value })}>
                {TERMINAL_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Font size</span></div>
              <input
                className="set-input set-input-num" type="number" min={9} max={22} step={0.5}
                value={term.fontSize}
                onChange={(e) => updateTerm({ fontSize: Number(e.target.value) || DEFAULT_TERMINAL_SETTINGS.fontSize })}
              />
            </div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Cursor style</span></div>
              <div className="seg">
                {(["block", "underline", "bar"] as const).map((c) => (
                  <button key={c} className={term.cursorStyle === c ? "on" : ""} onClick={() => updateTerm({ cursorStyle: c })}>
                    {c[0].toUpperCase() + c.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Scrollback</span><span className="set-row-sub">Lines kept per pane</span></div>
              <input
                className="set-input set-input-num" type="number" min={200} max={100000} step={100}
                value={term.scrollback}
                onChange={(e) => updateTerm({ scrollback: Number(e.target.value) || DEFAULT_TERMINAL_SETTINGS.scrollback })}
              />
            </div>
          </section>

          <section className="set-section">
            <div className="set-label">Shortcuts</div>
            <div className="kbd-list">
              {shortcuts.map((s) => (
                <div className="kbd-row" key={s.id}>
                  <span>{s.label}</span>
                  {capturing === s.id ? (
                    <span className="kbd-capturing">Press keys… <button className="kbd-cancel" onClick={() => setCapturing(null)}>Esc</button></span>
                  ) : (
                    <span className="kbd-keys">
                      {s.combo.split("+").map((k) => <kbd key={k}>{k}</kbd>)}
                      <button className="kbd-edit" onClick={() => setCapturing(s.id)}>Change</button>
                    </span>
                  )}
                </div>
              ))}
              {FIXED_SHORTCUTS.map((s) => (
                <div className="kbd-row" key={s.id}>
                  <span>{s.label}</span>
                  <span className="kbd-keys">
                    {s.combo.split("+").map((k) => <kbd key={k}>{k}</kbd>)}
                  </span>
                </div>
              ))}
              <div className="kbd-row"><span>Close settings / dialog</span><span className="kbd-keys"><kbd>Esc</kbd></span></div>
            </div>
            {conflict && (
              <div className="kbd-conflict" role="alert">
                <span>
                  <kbd>{conflict.combo}</kbd> is already used by <b>{conflict.otherLabel}</b>.
                  {conflict.fixed
                    ? " That one is built in and can't be moved — pick a different combination."
                    : " Reassigning leaves that action without a shortcut."}
                </span>
                <span className="kbd-conflict-actions">
                  {!conflict.fixed && conflict.otherId && (
                    <button
                      className="set-btn danger"
                      onClick={() => {
                        saveShortcut(conflict.otherId!, "");
                        saveShortcut(conflict.forId, conflict.combo);
                        setShortcuts(getShortcuts());
                        setConflict(null);
                      }}
                    >
                      Reassign
                    </button>
                  )}
                  <button className="set-btn" onClick={() => setConflict(null)}>
                    {conflict.fixed ? "OK" : "Keep as is"}
                  </button>
                </span>
              </div>
            )}
            <div className="set-row-sub">Only the shortcuts above with a Change button can be rebound.</div>
            <button className="btn-ghost set-reset" onClick={() => { resetShortcuts(); setShortcuts(getShortcuts()); }}>Reset to defaults</button>
          </section>

          <section className="set-section">
            <div className="set-label">Agents</div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">Default vendor</span><span className="set-row-sub">Pre-selected for new panes</span></div>
              <div className="seg">
                {vendors.map((v) => (
                  <button key={v.id} className={agents.defaultVendor === v.id ? "on" : ""} onClick={() => updateAgents({ ...agents, defaultVendor: v.id })}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="agent-list">
              {vendors.map((v) => (
                <div className="agent-row" key={v.id}>
                  <span className="agent-row-name">
                    {v.label}
                    {/* #219 install + auth state; sign-in opens a pane so the CLI runs its own login flow. */}
                    {!v.installed && <span className="agent-chip warn" title={v.detail}>not installed</span>}
                    {v.installed && v.authState === "none" && (
                      <button
                        className="agent-chip warn agent-login"
                        title={(v.authDetail || "No stored sign-in.") + " Opens a pane in the current workspace — complete the CLI's login there."}
                        onClick={() => {
                          const s = useApp.getState();
                          const ws = s.workspaces.find((w) => w.id === s.activeId);
                          if (!ws) { useUI.getState().pushToast("info", "Open a workspace first — sign-in runs in a pane."); return; }
                          void spawnPane(ws.id, v.id, ws.root, false);
                          useUI.getState().setSettingsOpen(false);
                        }}
                      >
                        run login
                      </button>
                    )}
                    {v.installed && v.authState === "ok" && v.kind === "agent" && (
                      <span className="agent-chip ok" title="Stored sign-in found">signed in</span>
                    )}
                    {/* UI-239: prove a vendor launches without committing a
                        workspace to it — one throwaway pane, isolation off, so
                        there's no worktree to clean up afterwards. */}
                    {v.installed && (
                      <button
                        className="agent-chip agent-test"
                        title={`Open a throwaway ${v.short} pane to check it launches`}
                        onClick={() => {
                          const st = useApp.getState();
                          const ws = st.workspaces.find((w) => w.id === st.activeId);
                          if (!ws) {
                            useUI.getState().pushToast("info", "Open a workspace first — the test pane opens inside it.");
                            return;
                          }
                          void spawnPane(ws.id, v.id, ws.root, false);
                          useUI.getState().setSettingsOpen(false);
                          useUI.getState().pushToast("info", `Test pane opened for ${v.short}. Close it when you're done.`);
                        }}
                      >
                        test launch
                      </button>
                    )}
                  </span>
                  <input
                    className="set-input" placeholder="extra CLI flags"
                    value={agents.flags[v.id] ?? ""}
                    onChange={(e) => updateAgents({ ...agents, flags: { ...agents.flags, [v.id]: e.target.value } })}
                  />
                  <input
                    className="set-input" placeholder="binary path override"
                    value={agents.binaryPaths[v.id] ?? ""}
                    onChange={(e) => updateAgents({ ...agents, binaryPaths: { ...agents.binaryPaths, [v.id]: e.target.value } })}
                  />
                  {/* UI-51: per-agent colour — chips/dots/cards follow. */}
                  <label className="agent-color" title={`Colour for ${v.label} — chips and status dots follow`}>
                    <span className="agent-color-dot" style={{ background: vendorColor(v.id) }} />
                    <input
                      type="color"
                      value={vendorAccentOverrides()[v.id] ?? "#43A6F5"}
                      onChange={(e) => setVendorAccentOverride(v.id, e.target.value)}
                    />
                  </label>
                  {vendorAccentOverrides()[v.id] && (
                    <button className="agent-color-reset" title="Reset to the default colour" onClick={() => setVendorAccentOverride(v.id, null)}>×</button>
                  )}
                </div>
              ))}
            </div>
            {manifestProblems.length > 0 && (
              <div className="manifest-problems" role="alert">
                <div className="manifest-problems-t">
                  {manifestProblems.length} vendor file{manifestProblems.length === 1 ? "" : "s"} couldn't be loaded
                </div>
                {manifestProblems.map((m) => (
                  <div className="manifest-problem" key={m.file}>
                    <code>{m.file}</code> — {m.error}
                  </div>
                ))}
              </div>
            )}
            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">Add your own agent</span>
                <span className="set-row-sub">Drop a JSON manifest in the vendors folder — no rebuild. Start from _example-opencode.json.</span>
              </div>
              <button
                className="set-btn"
                onClick={() => {
                  invoke<string | null>("vendors_dir")
                    .then((dir) => { if (dir) return revealItemInDir(dir); })
                    .catch(() => useUI.getState().pushToast("error", "Couldn't open the vendors folder."));
                }}
              >
                Open vendors folder
              </button>
            </div>
          </section>

          <section className="set-section">
            <div className="set-label">Startup</div>
            <div className="set-row">
              <div className="set-row-t"><span className="set-row-name">On launch</span></div>
              <div className="seg">
                <button className={startup === "reopen" ? "on" : ""} onClick={() => updateStartup("reopen")}>Reopen last session</button>
                <button className={startup === "launcher" ? "on" : ""} onClick={() => updateStartup("launcher")}>Show launcher</button>
              </div>
            </div>
          </section>

          <DiagnosticsSection />

          <SessionSection />

          <section className="set-section">
            <div className="set-label">Reset</div>
            <div className="set-row">
              <div className="set-row-t">
                <span className="set-row-name">Reset all settings</span>
                <span className="set-row-sub">
                  Theme, accent, terminal, shortcuts, agents and startup — back to defaults.
                  Your workspaces, board and worktrees are untouched.
                </span>
              </div>
              <button className="set-btn danger" onClick={resetEverything}>Reset</button>
            </div>
          </section>

          <section className="set-section">
            <div className="set-label">About</div>
            {/* UI-196: persistence is silent by design, but "is my session
                actually being saved?" deserves a visible answer. */}
            <div className="set-row-sub">
              {savedAgo === null
                ? "Session autosave is on — nothing saved yet this run."
                : `Session last saved ${savedAgo}.`}
            </div>
            <div className="set-about">Flightdeck v{APP_VERSION} — a multi-agent terminal cockpit. Deep Cove build.</div>
            {/* UI-42: a real "what's new" — the cheapest active-development signal. */}
            <details className="set-changelog">
              <summary>What's new</summary>
              <ul>
                {CHANGELOG.map((c) => (
                  <li key={c.date + c.text}><span className="set-cl-date">{c.date}</span> {c.text}</li>
                ))}
              </ul>
            </details>
          </section>
          <div className="set-noresults" style={{ display: "none" }}>
            Nothing matches that. Try a shorter word — sections are matched on their full text.
          </div>
        </div>
      </div>
    </div>
  );
}
