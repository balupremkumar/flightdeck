import { useEffect, useRef, useState } from "react";
import { useUI, applyUiScale } from "./ui";
import { useVendors } from "./vendors";
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
  const [agents, setAgents] = useState(getAgentSettings());
  const [startup, setStartup] = useState(getStartupBehavior());
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      const combo = formatCombo(e);
      if (!combo) return;
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      <div className="set-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="set-head">
          <h2>Settings</h2>
          <button className="ov-x" onClick={() => setOpen(false)} title="Close"><IconClose size={16} /></button>
        </div>
        <div className="set-body">

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
                  <span className="agent-row-name">{v.label}</span>
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
                </div>
              ))}
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

          <section className="set-section">
            <div className="set-label">About</div>
            <div className="set-about">Flightdeck v{APP_VERSION} — a multi-agent terminal cockpit. Deep Cove build.</div>
          </section>
        </div>
      </div>
    </div>
  );
}
