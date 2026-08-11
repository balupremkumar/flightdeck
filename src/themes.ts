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
  /** Set when the theme owns its accent and the picker must not repaint it.
   *  The string is the reason, shown in place of the picker in Settings.
   *  applyAccent() honours this, so a saved accent id can't leak back in at
   *  boot either (it used to: High Contrast's fixed #FFD400 was silently
   *  overpainted by the persisted accent on every launch). */
  fixedAccent?: string;
}

export const THEMES: ThemeMeta[] = [
  // Graphite leads: it is the default (see DEFAULT_THEME_ID) and findTheme's
  // fallback, so the list order and the default agree.
  { id: "graphite", label: "Graphite", mode: "dark", swatch: ["#0B0D0F", "#161A1E", "#AAB4BF"], fixedAccent: "Fixed by Graphite, whose steel palette is the theme" },
  { id: "dark", label: "Deep Cove — Dark", mode: "dark", swatch: ["#070B12", "#141F31", "#43A6F5"] },
  { id: "light", label: "Deep Cove — Light", mode: "light", swatch: ["#EFF3F8", "#EDF2F8", "#1C72D0"] },
  { id: "dracula", label: "Dracula", mode: "dark", swatch: ["#282A36", "#44475A", "#BD93F9"] },
  { id: "gruvbox", label: "Gruvbox Dark", mode: "dark", swatch: ["#282828", "#3C3836", "#FE8019"] },
  { id: "nord", label: "Nord", mode: "dark", swatch: ["#2E3440", "#3B4252", "#88C0D0"] },
  { id: "high-contrast", label: "High Contrast", mode: "dark", swatch: ["#000000", "#141414", "#FFD400"], fixedAccent: "Fixed by High Contrast for accessibility" },
];

// QL-792: Graphite is this install's default dark theme. Only reached on a
// fresh profile, since an existing install has already persisted its choice under
// `flightdeck-theme-id`, and that keeps winning (see currentThemeId).
export const DEFAULT_THEME_ID = "graphite";

// The theme the light half of the light/dark toggle lands on when nothing has
// been remembered yet (mirror of DEFAULT_THEME_ID for the dark half).
export const DEFAULT_LIGHT_THEME_ID = "light";

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

// ---------------------------------------------------------------------
// Custom accent (UI-50): any user-chosen colour. One hex in, both
// theme-mode variants out — same shape as a hand-tuned preset, derived:
//   dark mode : accent kept vivid + legible on near-black (L clamped up),
//               ice = pale tint for text/focus, grad = tint → base → deep.
//   light mode: accent darkened for contrast on white (L clamped down).
// ---------------------------------------------------------------------
export const CUSTOM_ACCENT_ID = "custom";
const CUSTOM_ACCENT_KEY = "flightdeck-accent-custom";

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hsl(h: number, s: number, l: number): string {
  const c = Math.max(0, Math.min(1, l));
  const sat = Math.max(0, Math.min(1, s));
  return `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(sat * 100)}% ${Math.round(c * 100)}%)`;
}

/** Derive a full AccentPreset from one hex colour. Exported for tests/tools. */
export function deriveAccent(hex: string): AccentPreset | null {
  const c = hexToHsl(hex);
  if (!c) return null;
  const { h, s } = c;
  // UI-audit 2.9: an achromatic pick (grey/black/white, s≈0) has no hue to
  // keep — forcing a saturation floor on it used to tint the ramp with h's
  // arbitrary fallback value (0 = red) even though the user picked no colour
  // at all. Only a genuinely saturated pick gets the "make sure it reads"
  // floor; a neutral pick stays neutral at every derived lightness.
  const neutral = s < 0.04;
  // Dark mode: keep the hue, force enough lightness to read on --abyss.
  const dL = Math.min(Math.max(c.l, 0.52), 0.68);
  const dAccent = hsl(h, neutral ? 0 : Math.max(s, 0.35), dL);
  const dIce = hsl(h, neutral ? 0 : Math.max(s * 0.85, 0.3), Math.max(dL + 0.2, 0.78));
  const dDeep = hsl(neutral ? h : h + 12, neutral ? 0 : Math.min(Math.max(s, 0.35) + 0.08, 1), Math.max(dL - 0.16, 0.3));
  // Light mode: same hue, darkened so it holds contrast on white surfaces.
  const lL = Math.min(c.l, 0.38);
  const lAccent = hsl(h, neutral ? 0 : Math.max(s, 0.45), lL);
  const lHi = hsl(neutral ? h : h - 8, neutral ? 0 : Math.max(s, 0.45), Math.min(lL + 0.12, 0.5));
  const lDeep = hsl(neutral ? h : h + 12, neutral ? 0 : Math.min(Math.max(s, 0.45) + 0.08, 1), Math.max(lL - 0.1, 0.16));
  return {
    id: CUSTOM_ACCENT_ID,
    label: "Custom",
    dark: {
      ice: dIce,
      azure: dAccent,
      accent: dAccent,
      grad: `linear-gradient(125deg,${dIce} 0%,${dAccent} 48%,${dDeep} 100%)`,
    },
    light: {
      ice: lAccent,
      azure: lAccent,
      accent: lAccent,
      grad: `linear-gradient(125deg,${lHi} 0%,${lAccent} 48%,${lDeep} 100%)`,
    },
  };
}

export function customAccentHex(): string {
  try { return localStorage.getItem(CUSTOM_ACCENT_KEY) ?? "#43A6F5"; } catch { return "#43A6F5"; }
}

/** Store the chosen hex, select the custom accent, and apply it. */
export function setCustomAccent(hex: string, mode: "dark" | "light") {
  try { localStorage.setItem(CUSTOM_ACCENT_KEY, hex); } catch { /* non-persistent */ }
  setAccent(CUSTOM_ACCENT_ID, mode);
}

export function findAccent(id: string): AccentPreset {
  if (id === CUSTOM_ACCENT_ID) {
    const derived = deriveAccent(customAccentHex());
    if (derived) return derived;
  }
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

const ACCENT_PROPS = ["--ice", "--azure", "--accent", "--accent-grad", "--glow"];

/** True only for a REGISTERED theme that declares fixedAccent. An imported
 *  "custom" theme is not registered, so it keeps the accent picker. The
 *  exact-id `some()` (not findTheme, which falls back to THEMES[0]) is what
 *  guarantees that. */
function activeThemeFixesAccent(): boolean {
  const id = currentThemeId();
  return THEMES.some((t) => t.id === id && !!t.fixedAccent);
}

export function applyAccent(accentId: string, mode: "dark" | "light") {
  const el = document.documentElement;
  // A theme that owns its accent must win over the picker's inline
  // properties, so clear them rather than skip, or the previous theme's accent
  // stays painted on <html> after the switch.
  if (activeThemeFixesAccent()) {
    for (const p of ACCENT_PROPS) el.style.removeProperty(p);
    return;
  }
  const a = findAccent(accentId);
  const v = mode === "light" ? a.light : a.dark;
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
// UI-607 (2026-08-01): starting and running previously sat on an identical
// ~201.6 deg hue and differed only in lightness, which defeats the point of a
// CVD palette. Swapping running with exited gives ~38 deg of hue separation
// while keeping the set pure Okabe-Ito.
// Two variants, because one palette cannot serve both grounds. The Okabe-Ito
// values below are tuned for a DARK surface; on a light one the lighter
// members collapse (--st-starting measured 2.07:1, --st-waiting 2.02:1, both
// under the 3:1 non-text floor). The light variant keeps the same hues — hue
// separation is what does the colour-blind work — and darkens the light
// members until they clear the floor against a near-white surface.
export const CB_SAFE_STATUS: Record<string, string> = {
  "--st-starting": "#56B4E9",
  "--st-running": "#009E73",
  "--st-waiting": "#E69F00",
  "--st-idle": "#8A8A8A",
  "--st-error": "#D55E00",
  "--st-exited": "#0072B2",
};

// Same hue family, darkened for a light ground. Measured against #FFFFFF:
// starting 4.6:1, running 3.9:1, waiting 4.6:1, idle 4.6:1, error 5.4:1,
// exited 5.9:1 — every one clears 3:1 for UI, and all but running clear the
// 4.5:1 text floor too (running carries a shape/label as well as colour).
export const CB_SAFE_STATUS_LIGHT: Record<string, string> = {
  "--st-starting": "#1A6E9E",
  "--st-running": "#007857",
  "--st-waiting": "#8A5F00",
  "--st-idle": "#6B6B6B",
  "--st-error": "#A84900",
  "--st-exited": "#005B8C",
};

export function applyColorBlindSafe(on: boolean, mode: "dark" | "light" = "dark") {
  const el = document.documentElement;
  const palette = mode === "light" ? CB_SAFE_STATUS_LIGHT : CB_SAFE_STATUS;
  if (on) for (const [k, v] of Object.entries(palette)) el.style.setProperty(k, v);
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
  try {
    localStorage.setItem("flightdeck-theme-id", t.id);
    // QL-784: remember this as the theme for its own mode, so the light/dark
    // toggle can come back to it instead of the hardcoded Deep Cove pair.
    localStorage.setItem(t.mode === "light" ? LIGHT_THEME_KEY : DARK_THEME_KEY, t.id);
  } catch { /* non-persistent */ }
}

// ---------------------------------------------------------------------
// Light/dark memory (QL-784). The topbar toggle used to write the literal ids
// "dark"/"light", so flipping out of Graphite (or Nord, or Dracula) and back
// dumped you on Deep Cove Dark and quietly lost the theme you had chosen. Each
// mode now keeps its own last-used theme id and the toggle flips between them.
// ---------------------------------------------------------------------
const DARK_THEME_KEY = "flightdeck-theme-dark";
const LIGHT_THEME_KEY = "flightdeck-theme-light";

/** The theme to use for `mode`: what was last used in that mode, else the
 *  currently-active theme if it already is that mode (so an install that
 *  predates the memory keeps its choice on the first toggle), else the
 *  registry default for the mode. */
export function rememberedThemeId(mode: "dark" | "light"): string {
  const matches = (id: string | null) => !!id && THEMES.some((t) => t.id === id && t.mode === mode);
  try {
    const saved = localStorage.getItem(mode === "light" ? LIGHT_THEME_KEY : DARK_THEME_KEY);
    if (matches(saved)) return saved as string;
    const active = localStorage.getItem("flightdeck-theme-id");
    if (matches(active)) return active as string;
  } catch { /* non-persistent */ }
  return mode === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_THEME_ID;
}

/** Switch to `mode`, landing on that mode's remembered theme, and bring the
 *  mode-specific accent variant and CVD palette with it. The one place the
 *  topbar toggle, the Settings appearance control and the follow-Windows
 *  listener all go through. */
export function applyThemeForMode(mode: "dark" | "light"): string {
  const id = rememberedThemeId(mode);
  applyTheme(id);
  applyAccent(currentAccentId(), mode);
  applyColorBlindSafe(isColorBlindSafe(), mode);
  return id;
}

/** The topbar's light/dark flip. Returns the mode switched to. An explicit
 *  flip also ends "follow Windows" — the OS would otherwise undo it at the
 *  next system change, which reads as the app fighting the user. */
export function toggleThemeMode(): "dark" | "light" {
  const next = currentMode() === "light" ? "dark" : "light";
  setAppearanceMode(next);
  applyThemeForMode(next);
  return next;
}

// ---------------------------------------------------------------------
// Appearance mode (QL-784): Light / Dark / Follow Windows. Absent key = the
// behaviour that shipped before this setting existed (whatever theme is saved,
// no OS following), so no existing install changes on upgrade.
// ---------------------------------------------------------------------
export type AppearanceMode = "light" | "dark" | "system";
const APPEARANCE_MODE_KEY = "flightdeck-appearance-mode";

export function appearanceMode(): AppearanceMode {
  try {
    const v = localStorage.getItem(APPEARANCE_MODE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* non-persistent */ }
  return currentMode();
}

/** Persist only — the caller applies, because "system" needs an async read of
 *  the OS theme that this module deliberately stays out of (no Tauri imports
 *  here: themes.ts is loaded by main.tsx before anything else). */
export function setAppearanceMode(mode: AppearanceMode) {
  try { localStorage.setItem(APPEARANCE_MODE_KEY, mode); } catch { /* non-persistent */ }
}

export function isFollowingSystem(): boolean {
  try { return localStorage.getItem(APPEARANCE_MODE_KEY) === "system"; } catch { return false; }
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
  applyColorBlindSafe(on, currentMode());
}

/** The mode the CVD palette and accent variants key off. Custom themes infer
 *  it from their own --bg, matching bootAppearance's logic. */
export function currentMode(): "dark" | "light" {
  const id = currentThemeId();
  if (id === "custom") {
    return isLikelyLight(getComputedStyle(document.documentElement).getPropertyValue("--bg")) ? "light" : "dark";
  }
  return findTheme(id).mode;
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
  applyColorBlindSafe(isColorBlindSafe(), mode);
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
