// Flightdeck theme registry.
//
// Colour tokens for every built-in theme live as real CSS in `theme.css`
// (one `:root[data-theme="<id>"]` block per theme, cascading over the base
// `:root` dark block — see that file's header comment). This module is the
// JS-side registry: ids/labels/swatches for the picker UI, the curated
// accent-colour presets (each with a dark-safe + light-safe variant), the
// colour-blind-safe status palette, and theme import/export.
//
// Applying a theme = `document.documentElement.setAttribute("data-theme", id)`
// (the "dark" id removes the attribute, matching the existing default).
// Accent + colour-blind overrides are applied on top as inline custom
// properties on <html>, which always win over the stylesheet's :root rules
// regardless of which theme block is active.

export interface ThemeMeta {
  id: string;
  label: string;
  mode: "dark" | "light";
  /** [bg, surface, accent] — three swatch dots for the picker tile. */
  swatch: [string, string, string];
}

export const THEMES: ThemeMeta[] = [
  { id: "dark", label: "Deep Cove — Dark", mode: "dark", swatch: ["#070B12", "#141F31", "#43A6F5"] },
  { id: "light", label: "Deep Cove — Light", mode: "light", swatch: ["#EFF3F8", "#EDF2F8", "#1C72D0"] },
  { id: "dracula", label: "Dracula", mode: "dark", swatch: ["#282A36", "#44475A", "#BD93F9"] },
  { id: "gruvbox", label: "Gruvbox Dark", mode: "dark", swatch: ["#282828", "#3C3836", "#FE8019"] },
  { id: "nord", label: "Nord", mode: "dark", swatch: ["#2E3440", "#3B4252", "#88C0D0"] },
  { id: "high-contrast", label: "High Contrast", mode: "dark", swatch: ["#000000", "#141414", "#FFD400"] },
];

export const DEFAULT_THEME_ID = "dark";

export function findTheme(id: string): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

// ---------------------------------------------------------------------
// Accent presets. A pale accent that works on a near-black surface can be
// close to invisible (or fails contrast) on white, so every preset carries
// a dark-safe and a light-safe variant; the picker applies whichever
// matches the active theme's mode.
// ---------------------------------------------------------------------
export interface AccentPreset {
  id: string;
  label: string;
  dark: { ice: string; azure: string; accent: string; grad: string };
  light: { ice: string; azure: string; accent: string; grad: string };
}

export const ACCENTS: AccentPreset[] = [
  {
    id: "ice", label: "Ice",
    dark: { ice: "#9AE9FF", azure: "#43A6F5", accent: "#43A6F5", grad: "linear-gradient(125deg,#9AE9FF 0%,#43A6F5 48%,#3F6BFF 100%)" },
    light: { ice: "#1C72D0", azure: "#1C72D0", accent: "#1C72D0", grad: "linear-gradient(125deg,#1FA0D8 0%,#1C72D0 48%,#2B53E0 100%)" },
  },
  {
    id: "violet", label: "Violet",
    dark: { ice: "#C9B6FF", azure: "#9D7CF9", accent: "#9D7CF9", grad: "linear-gradient(125deg,#C9B6FF 0%,#9D7CF9 48%,#6E3FF0 100%)" },
    light: { ice: "#6432D6", azure: "#6432D6", accent: "#6432D6", grad: "linear-gradient(125deg,#8A5CE8 0%,#6432D6 48%,#4B1FB0 100%)" },
  },
  {
    id: "coral", label: "Coral",
    dark: { ice: "#FFC2A8", azure: "#FF8F66", accent: "#FF8F66", grad: "linear-gradient(125deg,#FFC2A8 0%,#FF8F66 48%,#F5622E 100%)" },
    light: { ice: "#C44A1E", azure: "#C44A1E", accent: "#C44A1E", grad: "linear-gradient(125deg,#E06A34 0%,#C44A1E 48%,#9C3411 100%)" },
  },
  {
    id: "emerald", label: "Emerald",
    dark: { ice: "#8CF5CE", azure: "#3FD79B", accent: "#3FD79B", grad: "linear-gradient(125deg,#8CF5CE 0%,#3FD79B 48%,#0FA36C 100%)" },
    light: { ice: "#0E8C5F", azure: "#0E8C5F", accent: "#0E8C5F", grad: "linear-gradient(125deg,#1FAE7C 0%,#0E8C5F 48%,#0A6E49 100%)" },
  },
  {
    id: "gold", label: "Gold",
    dark: { ice: "#FFE29A", azure: "#F2B03D", accent: "#F2B03D", grad: "linear-gradient(125deg,#FFE29A 0%,#F2B03D 48%,#D6820F 100%)" },
    light: { ice: "#96650C", azure: "#96650C", accent: "#96650C", grad: "linear-gradient(125deg,#C68A1E 0%,#96650C 48%,#744C08 100%)" },
  },
];

export const DEFAULT_ACCENT_ID = "ice";

export function findAccent(id: string): AccentPreset {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

export function applyAccent(accentId: string, mode: "dark" | "light") {
  const a = findAccent(accentId);
  const v = mode === "light" ? a.light : a.dark;
  const el = document.documentElement;
  el.style.setProperty("--ice", v.ice);
  el.style.setProperty("--azure", v.azure);
  el.style.setProperty("--accent", v.accent);
  el.style.setProperty("--accent-grad", v.grad);
  el.style.setProperty(
    "--glow",
    `0 0 0 1px color-mix(in srgb, ${v.accent} 20%, transparent), 0 8px 40px color-mix(in srgb, ${v.accent} 22%, transparent)`,
  );
}

// ---------------------------------------------------------------------
// Colour-blind-safe status palette (209). Independent of theme/accent:
// swaps the six pane-status tokens for an Okabe-Ito-derived set (blue /
// vermillion / amber instead of red/green) so state stays distinguishable
// for the common deuteranopia/protanopia types.
// ---------------------------------------------------------------------
export const CB_SAFE_STATUS: Record<string, string> = {
  "--st-starting": "#56B4E9",
  "--st-running": "#0072B2",
  "--st-waiting": "#E69F00",
  "--st-idle": "#8A8A8A",
  "--st-error": "#D55E00",
  "--st-exited": "#009E73",
};

export function applyColorBlindSafe(on: boolean) {
  const el = document.documentElement;
  if (on) for (const [k, v] of Object.entries(CB_SAFE_STATUS)) el.style.setProperty(k, v);
  else for (const k of Object.keys(CB_SAFE_STATUS)) el.style.removeProperty(k);
}

// ---------------------------------------------------------------------
// Theme apply / boot.
// ---------------------------------------------------------------------
export function applyTheme(themeId: string) {
  const t = findTheme(themeId);
  const el = document.documentElement;
  if (t.id === "dark") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", t.id);
  try { localStorage.setItem("flightdeck-theme-id", t.id); } catch { /* non-persistent */ }
}

export function currentThemeId(): string {
  try {
    const saved = localStorage.getItem("flightdeck-theme-id");
    if (saved) return saved;
    // Back-compat with the pre-registry dark/light-only key.
    return localStorage.getItem("flightdeck-theme") === "light" ? "light" : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function currentAccentId(): string {
  try { return localStorage.getItem("flightdeck-accent") ?? DEFAULT_ACCENT_ID; } catch { return DEFAULT_ACCENT_ID; }
}

export function setAccent(accentId: string, mode: "dark" | "light") {
  try { localStorage.setItem("flightdeck-accent", accentId); } catch { /* non-persistent */ }
  applyAccent(accentId, mode);
}

export function isColorBlindSafe(): boolean {
  try { return localStorage.getItem("flightdeck-cb-safe") === "1"; } catch { return false; }
}

export function setColorBlindSafe(on: boolean) {
  try { localStorage.setItem("flightdeck-cb-safe", on ? "1" : "0"); } catch { /* non-persistent */ }
  applyColorBlindSafe(on);
}

export function isReducedMotion(): boolean {
  try { return localStorage.getItem("flightdeck-reduced-motion") === "1"; } catch { return false; }
}

export function setReducedMotion(on: boolean) {
  try { localStorage.setItem("flightdeck-reduced-motion", on ? "1" : "0"); } catch { /* non-persistent */ }
  if (on) document.documentElement.setAttribute("data-reduced-motion", "1");
  else document.documentElement.removeAttribute("data-reduced-motion");
}

/** Apply every persisted appearance setting. Call once at boot (main.tsx)
 *  and after any change made from Settings. */
export function bootAppearance() {
  const themeId = currentThemeId();
  let mode: "dark" | "light" = "dark";
  if (themeId === "custom" && restoreCustomTheme()) {
    // A custom import may itself be a light-leaning palette; infer mode from
    // its own --bg lightness so the accent variant picked below still reads.
    mode = isLikelyLight(getComputedStyle(document.documentElement).getPropertyValue("--bg")) ? "light" : "dark";
  } else {
    applyTheme(themeId);
    mode = findTheme(themeId).mode;
  }
  applyAccent(currentAccentId(), mode);
  applyColorBlindSafe(isColorBlindSafe());
  if (isReducedMotion()) document.documentElement.setAttribute("data-reduced-motion", "1");
}

function isLikelyLight(hex: string): boolean {
  const h = hex.trim().replace("#", "");
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

// ---------------------------------------------------------------------
// Theme import / export (191). A theme "file" is the flat set of CSS
// custom properties the app depends on, read back via getComputedStyle so
// export always matches what's actually on screen (built-in theme + accent
// + colour-blind overrides, all folded in).
// ---------------------------------------------------------------------
export const THEME_TOKENS = [
  "--abyss", "--bg", "--bg-2", "--surface", "--surface-2", "--elevated",
  "--line", "--line-strong", "--text", "--muted", "--faint",
  "--ice", "--azure", "--aqua", "--deepblue", "--red", "--accent",
  "--st-starting", "--st-running", "--st-waiting", "--st-idle", "--st-error", "--st-exited",
  "--agent-claude", "--accent-grad", "--glow", "--shadow-lg",
  "--font-sans", "--font-mono", "--ease-out", "--ease-soft",
];

export function exportThemeJson(name = "Flightdeck custom theme"): string {
  const cs = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const t of THEME_TOKENS) tokens[t] = cs.getPropertyValue(t).trim();
  return JSON.stringify({ name, tokens }, null, 2);
}

/** Applies an imported theme as inline overrides on <html> (always wins over
 *  any stylesheet rule) and tags data-theme="custom" for bookkeeping. Returns
 *  false (no-op) if the JSON doesn't look like a theme export. */
export function importThemeJson(json: string): boolean {
  let parsed: { name?: string; tokens?: Record<string, string> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (!parsed.tokens || typeof parsed.tokens !== "object") return false;
  const el = document.documentElement;
  for (const t of THEME_TOKENS) {
    const v = parsed.tokens[t];
    if (v) el.style.setProperty(t, v);
  }
  el.setAttribute("data-theme", "custom");
  try {
    localStorage.setItem("flightdeck-theme-id", "custom");
    localStorage.setItem("flightdeck-theme-custom", json);
  } catch { /* non-persistent */ }
  return true;
}

/** Re-applies a previously-imported custom theme, if any was saved. Called
 *  from bootAppearance()'s caller when currentThemeId() === "custom". */
export function restoreCustomTheme(): boolean {
  try {
    const json = localStorage.getItem("flightdeck-theme-custom");
    if (!json) return false;
    return importThemeJson(json);
  } catch {
    return false;
  }
}
