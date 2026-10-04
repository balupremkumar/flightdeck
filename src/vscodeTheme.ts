// VS Code colour-theme import. Maps a VS Code theme file (`colors` object) onto
// Flightdeck's tokens (see THEME_TOKENS in themes.ts), the xterm palette, and the
// diff tints. Keys a theme leaves out are derived from editor.background /
// editor.foreground so a sparse theme still produces a complete, legible result.
//
// Pure: no DOM, no storage in importVsCodeTheme. The saved-list helpers at the
// bottom are the only localStorage touchpoint.
import type { FlightdeckTheme } from "./themes";

// ---------------------------------------------------------------------
// JSONC tolerance: VS Code theme files routinely carry // and /* */ comments
// and trailing commas. A string-aware pass so a "//" inside a value (a URL, a
// colour name) is left alone.
// ---------------------------------------------------------------------
export function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  if (src.charCodeAt(0) === 0xfeff) i = 1; // BOM
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: a comma followed only by whitespace then } or ]. Done as a
  // second string-aware scan for the same reason as above.
  let res = "";
  i = 0;
  const m = out.length;
  while (i < m) {
    const c = out[i];
    if (c === '"') {
      let j = i + 1;
      while (j < m && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      res += out.slice(i, j + 1);
      i = j + 1;
    } else if (c === ",") {
      let j = i + 1;
      while (j < m && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") { i++; continue; }
      res += c;
      i++;
    } else {
      res += c;
      i++;
    }
  }
  return res;
}

// ---------------------------------------------------------------------
// Colour maths.
// ---------------------------------------------------------------------
interface RGBA { r: number; g: number; b: number; a: number }

export function parseColor(s: unknown): RGBA | null {
  if (typeof s !== "string") return null;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = h.split("").map((x) => x + x).join("");
  const v = (k: number) => parseInt(h.slice(k, k + 2), 16);
  return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) / 255 : 1 };
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0").toUpperCase();
const toHex = (c: RGBA) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const toCss = (c: RGBA) => (c.a >= 0.999 ? toHex(c) : `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${+c.a.toFixed(2)})`);
const withAlpha = (c: RGBA, a: number): RGBA => ({ ...c, a });

/** Composite over an opaque background. */
function flatten(c: RGBA, bg: RGBA): RGBA {
  return { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a), a: 1 };
}

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 };
}

function channelLum(v: number): number {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
export function luminance(c: RGBA): number {
  return 0.2126 * channelLum(c.r) + 0.7152 * channelLum(c.g) + 0.0722 * channelLum(c.b);
}
export function contrastRatio(a: string, b: string): number {
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) return 0;
  const la = luminance(ca), lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };

/** Nudge `c` toward white or black (whichever direction gains contrast) until it
 *  reaches `min` against `bg`. Keeps the hue; only adjusts lightness. */
function ensureContrast(c: RGBA, bg: RGBA, min: number): RGBA {
  const cr = (x: RGBA) => (Math.max(luminance(x), luminance(bg)) + 0.05) / (Math.min(luminance(x), luminance(bg)) + 0.05);
  if (cr(c) >= min) return c;
  const target = luminance(bg) < 0.4 ? WHITE : BLACK;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const next = mix(c, target, t);
    if (cr(next) >= min) return next;
  }
  return target;
}

/** Readable ink (near-black or white) for text sitting ON `fill`. */
function inkOn(fill: RGBA): RGBA {
  const dark: RGBA = { r: 5, g: 8, b: 14, a: 1 };
  const cr = (x: RGBA) => (Math.max(luminance(x), luminance(fill)) + 0.05) / (Math.min(luminance(x), luminance(fill)) + 0.05);
  return cr(dark) >= cr(WHITE) ? dark : WHITE;
}

// ---------------------------------------------------------------------
// Defaults for the 16 ANSI colours (VS Code's own Dark+ / Light+ terminal
// defaults), used for any terminal.ansi* key the theme omits.
// ---------------------------------------------------------------------
const ANSI_KEYS = [
  ["black", "Black"], ["red", "Red"], ["green", "Green"], ["yellow", "Yellow"],
  ["blue", "Blue"], ["magenta", "Magenta"], ["cyan", "Cyan"], ["white", "White"],
] as const;

const ANSI_DARK: Record<string, string> = {
  black: "#000000", red: "#CD3131", green: "#0DBC79", yellow: "#E5E510", blue: "#2472C8", magenta: "#BC3FBC", cyan: "#11A8CD", white: "#E5E5E5",
  brightBlack: "#666666", brightRed: "#F14C4C", brightGreen: "#23D18B", brightYellow: "#F5F543", brightBlue: "#3B8EEA", brightMagenta: "#D670D6", brightCyan: "#29B8DB", brightWhite: "#E5E5E5",
};
const ANSI_LIGHT: Record<string, string> = {
  black: "#000000", red: "#CD3131", green: "#00BC00", yellow: "#949800", blue: "#0451A5", magenta: "#BC05BC", cyan: "#0598BC", white: "#555555",
  brightBlack: "#666666", brightRed: "#CD3131", brightGreen: "#14CE14", brightYellow: "#B5BA00", brightBlue: "#0451A5", brightMagenta: "#BC05BC", brightCyan: "#0598BC", brightWhite: "#A5A5A5",
};

export class VsCodeThemeError extends Error {}

// ---------------------------------------------------------------------
// The importer.
// ---------------------------------------------------------------------
export function importVsCodeTheme(json: string): FlightdeckTheme {
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonc(json));
  } catch {
    throw new VsCodeThemeError("That file isn’t valid JSON, so it can’t be read as a VS Code theme.");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new VsCodeThemeError("That file doesn’t look like a VS Code theme (expected a JSON object).");
  }
  const d = doc as { name?: unknown; type?: unknown; colors?: unknown; include?: unknown };
  const colors = d.colors;
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) {
    throw new VsCodeThemeError(
      typeof d.include === "string"
        ? "This theme extends another theme file (\"include\"), which can’t be followed. Import the file it extends instead."
        : "No `colors` section found. Pick a VS Code colour theme file (the .json inside a theme extension’s themes folder).",
    );
  }
  const col = colors as Record<string, unknown>;
  if (!Object.values(col).some((v) => parseColor(v))) {
    throw new VsCodeThemeError("The `colors` section has no usable colours (only #rgb / #rrggbb / #rrggbbaa values are read).");
  }

  const get = (...keys: string[]): RGBA | null => {
    for (const k of keys) { const c = parseColor(col[k]); if (c) return c; }
    return null;
  };

  // Mode: the file's own `type` when it says so, else judged from the editor bg.
  const type = typeof d.type === "string" ? d.type.toLowerCase() : "";
  const rawBg = get("editor.background");
  let mode: "dark" | "light";
  if (type === "light" || type === "hclight") mode = "light";
  else if (type === "dark" || type === "hc") mode = "dark";
  else mode = rawBg && luminance(flatten(rawBg, WHITE)) > 0.4 ? "light" : "dark";

  const bg = rawBg ? flatten(rawBg, mode === "light" ? WHITE : BLACK) : parseColor(mode === "light" ? "#FFFFFF" : "#1E1E1E")!;
  const fg = get("editor.foreground", "foreground") ?? parseColor(mode === "light" ? "#333333" : "#D4D4D4")!;
  const fgOpaque = flatten(fg, bg);
  const over = (c: RGBA | null): RGBA | null => (c ? flatten(c, bg) : null);

  // Terminal palette (always complete).
  const defaults = mode === "light" ? ANSI_LIGHT : ANSI_DARK;
  const ansi: Record<string, string> = {};
  for (const [name, cap] of ANSI_KEYS) {
    ansi[name] = toHex(get(`terminal.ansi${cap}`) ?? parseColor(defaults[name])!);
    const b = `bright${cap}`;
    ansi[b] = toHex(get(`terminal.ansiBright${cap}`) ?? parseColor(defaults[b])!);
  }
  const A = (k: string) => parseColor(ansi[k])!;

  // Accent family. button.background is the usual "brand" colour; focusBorder and
  // textLink are fallbacks. Text-weight uses (links, focus ring) must read on --bg.
  const accentRaw = over(get("button.background", "focusBorder", "textLink.foreground", "progressBar.background")) ?? A("blue");
  const accent = ensureContrast(accentRaw, bg, 4.5);
  const azure = ensureContrast(over(get("textLink.foreground")) ?? accent, bg, 4.5);
  const ice = ensureContrast(over(get("textLink.activeForeground", "focusBorder")) ?? mix(accent, mode === "light" ? BLACK : WHITE, 0.3), bg, 4.5);
  const green = ensureContrast(A("green"), bg, 3);
  const red = ensureContrast(A("red"), bg, 3);
  const yellow = ensureContrast(A("yellow"), bg, 3);
  const cyan = ensureContrast(A("cyan"), bg, 3);
  const blue = ensureContrast(A("blue"), bg, 3);
  const magenta = ensureContrast(A("magenta"), bg, 3);

  const toward = mode === "light" ? BLACK : WHITE;
  const surface = over(get("sideBar.background")) ?? mix(bg, toward, 0.04);
  const surface2 = over(get("sideBarSectionHeader.background", "editorGroupHeader.tabsBackground")) ?? mix(bg, toward, 0.07);
  const elevated = over(get("editorWidget.background", "quickInput.background", "menu.background")) ?? mix(bg, toward, 0.1);
  const abyss = over(get("activityBar.background", "titleBar.activeBackground")) ?? mix(bg, BLACK, mode === "light" ? 0.06 : 0.4);
  const bg2 = over(get("editorGroupHeader.tabsBackground")) ?? mix(bg, surface, 0.5);

  const line = get("panel.border", "sideBar.border", "editorGroup.border") ?? withAlpha(fgOpaque, 0.15);
  const lineStrong = mix(flatten(line, bg), fgOpaque, 0.35);

  const muted = ensureContrast(over(get("descriptionForeground")) ?? mix(fgOpaque, bg, 0.3), bg, 4.5);
  const faint = ensureContrast(over(get("editorLineNumber.foreground")) ?? mix(fgOpaque, bg, 0.5), bg, 3);
  const text = ensureContrast(fgOpaque, bg, 4.5);

  const accentCss = toHex(accent);
  const glowA = `${accent.r},${accent.g},${accent.b}`;
  const tokens: Record<string, string> = {
    "--abyss": toHex(abyss),
    "--bg": toHex(bg),
    "--bg-2": toHex(bg2),
    "--surface": toHex(surface),
    "--surface-2": toHex(surface2),
    "--elevated": toHex(elevated),
    "--line": toCss(line),
    "--line-strong": toHex(lineStrong),
    "--on-accent": toHex(inkOn(accent)),
    "--on-warn": toHex(inkOn(yellow)),
    "--text": toHex(text),
    "--muted": toHex(muted),
    "--faint": toHex(faint),
    "--ice": toHex(ice),
    "--azure": toHex(azure),
    "--aqua": toHex(cyan),
    "--deepblue": toHex(blue),
    "--red": toHex(red),
    "--accent": accentCss,
    "--st-starting": toHex(blue),
    "--st-running": toHex(green),
    "--st-waiting": toHex(yellow),
    "--st-idle": toHex(faint),
    "--st-error": toHex(red),
    "--st-exited": toHex(cyan),
    "--agent-claude": toHex(magenta),
    "--accent-grad": `linear-gradient(125deg,${toHex(ice)} 0%,${accentCss} 48%,${toHex(blue)} 100%)`,
    "--glow": `0 0 0 1px rgba(${glowA},0.22), 0 8px 40px rgba(${glowA},0.${mode === "light" ? "14" : "20"})`,
    "--shadow-lg": mode === "light" ? "0 24px 60px -22px rgba(20,40,70,0.28)" : "0 30px 70px -20px rgba(0,0,0,0.75)",
  };

  const tBg = over(get("terminal.background")) ?? bg;
  const tFg = over(get("terminal.foreground")) ?? fgOpaque;
  const terminal: Record<string, string> = {
    background: toHex(tBg),
    foreground: toHex(tFg),
    cursor: toHex(over(get("terminalCursor.foreground")) ?? tFg),
    cursorAccent: toHex(over(get("terminalCursor.background")) ?? tBg),
    selectionBackground: toCss(get("terminal.selectionBackground", "editor.selectionBackground") ?? withAlpha(accent, 0.3)),
    ...ansi,
  };

  const diff = {
    added: toCss(get("diffEditor.insertedTextBackground", "diffEditor.insertedLineBackground") ?? withAlpha(green, 0.2)),
    removed: toCss(get("diffEditor.removedTextBackground", "diffEditor.removedLineBackground") ?? withAlpha(red, 0.2)),
  };

  const name = typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 60) : "Imported VS Code theme";
  return { name, mode, tokens, terminal, diff };
}

/** The `{ name, tokens, terminal }` document importThemeJson (themes.ts) applies
 *  and persists. `terminal` rides along so terminal-theme.ts can paint the panes. */
export function themeToJson(t: FlightdeckTheme): string {
  return JSON.stringify({ name: t.name, tokens: t.tokens, terminal: t.terminal, diff: t.diff }, null, 2);
}

// ---------------------------------------------------------------------
// Saved imports, listed beside the built-in tiles in Settings.
// ---------------------------------------------------------------------
export const IMPORTED_THEMES_KEY = "flightdeck-imported-themes";
export const MAX_IMPORTED_THEMES = 12;

export interface SavedImportedTheme extends FlightdeckTheme { id: string }

export function loadImportedThemes(): SavedImportedTheme[] {
  try {
    const raw = JSON.parse(localStorage.getItem(IMPORTED_THEMES_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((t) => t && typeof t.id === "string" && t.tokens && t.terminal && typeof t.name === "string");
  } catch {
    return [];
  }
}

/** Save (replacing a same-named earlier import so re-importing updates it). */
export function saveImportedTheme(t: FlightdeckTheme): SavedImportedTheme[] {
  const saved: SavedImportedTheme = { ...t, id: "vsc-" + t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") };
  const next = [saved, ...loadImportedThemes().filter((x) => x.id !== saved.id)].slice(0, MAX_IMPORTED_THEMES);
  try { localStorage.setItem(IMPORTED_THEMES_KEY, JSON.stringify(next)); } catch { /* non-persistent */ }
  return next;
}

export function deleteImportedTheme(id: string): SavedImportedTheme[] {
  const next = loadImportedThemes().filter((x) => x.id !== id);
  try { localStorage.setItem(IMPORTED_THEMES_KEY, JSON.stringify(next)); } catch { /* non-persistent */ }
  return next;
}
