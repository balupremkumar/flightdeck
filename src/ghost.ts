// The drag ghost's page (ghost.html). Deliberately tiny: no React, no store, no IPC,
// no capability. Rust opens the window with `?name=&tint=&panes=&mode=` and flips the
// mode with `window.__ghostMode("join")` through eval. Everything lands via textContent
// or a validated CSS value, so a workspace name can never become markup.

export type GhostMode = "new" | "join" | "cancel";

export interface GhostInfo { name: string; tint: string | null; panes: number; mode: GhostMode }

const MAX_NAME = 80;
// A colour token only: hex and rgb()/hsl()/color-mix()/var() characters, nothing that can end a value.
const TINT_RE = /^[#a-zA-Z0-9(),.%\s/-]{1,64}$/;

export const MODE_TEXT: Record<GhostMode, string> = {
  new: "Release to open in a new window",
  join: "Release to move into this window",
  cancel: "Release to cancel",
};

export function parseMode(v: unknown): GhostMode {
  return v === "join" || v === "cancel" ? v : "new";
}

export function parseGhostQuery(search: string): GhostInfo {
  const q = new URLSearchParams(search);
  const name = (q.get("name") ?? "").trim().slice(0, MAX_NAME) || "Workspace";
  const rawTint = (q.get("tint") ?? "").trim();
  const panes = Math.max(0, Math.min(999, Math.floor(Number(q.get("panes")) || 0)));
  return { name, tint: TINT_RE.test(rawTint) ? rawTint : null, panes, mode: parseMode(q.get("mode")) };
}

export function paneLabel(panes: number): string {
  return panes <= 0 ? "" : panes === 1 ? "1 pane" : `${panes} panes`;
}

function boot() {
  const root = document.getElementById("ghost");
  const nameEl = document.getElementById("ghost-name");
  const modeEl = document.getElementById("ghost-mode");
  if (!root || !nameEl || !modeEl) return;
  const info = parseGhostQuery(window.location.search);
  const pl = paneLabel(info.panes);
  nameEl.textContent = pl ? `${info.name} · ${pl}` : info.name;
  if (info.tint) root.style.setProperty("--ghost-tint", info.tint);
  const set = (m: unknown) => {
    const mode = parseMode(m);
    root.dataset.mode = mode;
    modeEl.textContent = MODE_TEXT[mode];
  };
  set(info.mode);
  (window as unknown as { __ghostMode: (m: unknown) => void }).__ghostMode = set;
}

if (typeof document !== "undefined") boot();
