import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Single frontend source of truth for "what agents/shells exist" (BACKLOG I1 /
// 216). The list comes from the Rust registry (vendors.rs) via detect_vendors —
// nothing here hardcodes an agent, so adding one is a backend-only change.

export interface VendorInfo {
  id: string;
  label: string;
  /** Compact name for chips/badges. */
  short: string;
  /** "agent" = an AI coding CLI, "shell" = a plain terminal. */
  kind: "agent" | "shell";
  /** CSS custom-property name, e.g. "--agent-claude". */
  accent: string;
  installed: boolean;
  detail: string;
  /** #219 auth probe: "ok" (signed in / not needed), "none" (installed but no
   *  stored sign-in — the CLI will prompt on first launch), "unknown". */
  authState: "ok" | "none" | "unknown";
  authDetail: string;
  /** UI-237: seconds of silence before this vendor reads as "waiting". */
  quietSeconds: number;
}

// Used only until the backend responds, and as a safety net if the invoke fails
// (e.g. unit tests, or a browser preview with no Tauri host). The backend
// registry is always the truth once it answers.
const FALLBACK: VendorInfo[] = [
  { id: "claude", label: "Claude Code", short: "Claude", kind: "agent", accent: "--agent-claude", installed: false, detail: "", authState: "unknown", authDetail: "", quietSeconds: 3 },
  { id: "agy", label: "Antigravity", short: "Antigravity", kind: "agent", accent: "--accent", installed: false, detail: "", authState: "unknown", authDetail: "", quietSeconds: 3 },
  { id: "pwsh", label: "pwsh (shell)", short: "pwsh", kind: "shell", accent: "--aqua", installed: false, detail: "", authState: "unknown", authDetail: "", quietSeconds: 3 },
];

interface VendorState {
  vendors: VendorInfo[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Force a re-probe (install/auth state changes while the app runs). */
  refresh: () => Promise<void>;
}

export const useVendors = create<VendorState>((set, get) => ({
  vendors: FALLBACK,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    await get().refresh();
  },
  refresh: async () => {
    try {
      const list = await invoke<VendorInfo[]>("detect_vendors");
      if (Array.isArray(list) && list.length > 0) set({ vendors: list, loaded: true });
    } catch {
      /* keep the fallback — detection is best-effort, never blocks the UI */
    }
  },
}));

/** Snapshot accessors, for non-reactive call sites (helpers, event handlers). */
export function vendorList(): VendorInfo[] {
  return useVendors.getState().vendors;
}

/** Only the AI agents — excludes plain shells (pwsh/cmd/git-bash/wsl). */
export function agentVendors(): VendorInfo[] {
  return vendorList().filter((v) => v.kind === "agent");
}

/** Never throws: an unknown id yields a usable placeholder descriptor. */
export function vendorMeta(id: string): VendorInfo {
  return (
    vendorList().find((v) => v.id === id) ?? {
      id,
      label: id,
      short: id,
      kind: "agent",
      accent: "--muted",
      installed: false,
      detail: "",
      authState: "unknown" as const,
      authDetail: "",
      quietSeconds: 3,
    }
  );
}

export function vendorLabel(id: string): string {
  return vendorMeta(id).label;
}

export function vendorShort(id: string): string {
  return vendorMeta(id).short;
}

/** An accent value from the registry is either a theme token ("--aqua") or,
 *  for manifest vendors (#218), a literal colour ("#3FD79B"). */
export function accentCss(accent: string): string {
  return accent.startsWith("--") ? `var(${accent})` : accent;
}

// Per-vendor accent overrides (UI-51 / #222): pick a colour per agent in
// Settings > Agents; chips, dots and cards follow. Persisted as {id: hex}.
const VENDOR_ACCENT_KEY = "flightdeck-vendor-accents";

export function vendorAccentOverrides(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(VENDOR_ACCENT_KEY) ?? "{}"); } catch { return {}; }
}

export function setVendorAccentOverride(id: string, hex: string | null) {
  const map = vendorAccentOverrides();
  if (hex) map[id] = hex;
  else delete map[id];
  try { localStorage.setItem(VENDOR_ACCENT_KEY, JSON.stringify(map)); } catch { /* non-persistent */ }
  // Poke subscribers (new array identity) so open surfaces repaint live.
  useVendors.setState((s) => ({ vendors: [...s.vendors] }));
}

/** Ready-to-use CSS colour for a vendor, theme-reactive via the token.
 *  A user override (Settings > Agents) wins over the registry accent. */
export function vendorColor(id: string): string {
  const override = vendorAccentOverrides()[id];
  return override ?? accentCss(vendorMeta(id).accent);
}

/**
 * Default pane mix for a new workspace: cycle the installed agents, falling
 * back to all known agents, then to a plain shell. Replaces the old hardcoded
 * ["claude","agy"] cycles.
 */
export function defaultCycle(): string[] {
  const agents = agentVendors();
  const installed = agents.filter((a) => a.installed);
  const pool = installed.length > 0 ? installed : agents;
  return pool.length > 0 ? pool.map((a) => a.id) : ["pwsh"];
}
