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
}

// Used only until the backend responds, and as a safety net if the invoke fails
// (e.g. unit tests, or a browser preview with no Tauri host). The backend
// registry is always the truth once it answers.
const FALLBACK: VendorInfo[] = [
  { id: "claude", label: "Claude Code", short: "Claude", kind: "agent", accent: "--agent-claude", installed: false, detail: "" },
  { id: "agy", label: "Antigravity", short: "Antigravity", kind: "agent", accent: "--accent", installed: false, detail: "" },
  { id: "pwsh", label: "pwsh (shell)", short: "pwsh", kind: "shell", accent: "--aqua", installed: false, detail: "" },
];

interface VendorState {
  vendors: VendorInfo[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useVendors = create<VendorState>((set, get) => ({
  vendors: FALLBACK,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
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
    }
  );
}

export function vendorLabel(id: string): string {
  return vendorMeta(id).label;
}

export function vendorShort(id: string): string {
  return vendorMeta(id).short;
}

/** Ready-to-use CSS colour for a vendor, theme-reactive via the token. */
export function vendorColor(id: string): string {
  return `var(${vendorMeta(id).accent})`;
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
