// Flightdeck terminal themes (xterm.js)
// One ITheme per app theme (see themes.ts THEMES for the id list). Palettes
// are read from theme.css's per-theme :root blocks (or the app's own well-
// known ANSI mapping for Dracula/Gruvbox/Nord, which are more legible than
// deriving ANSI colours from the five UI tokens theme.css carries).
import type { ITheme } from "@xterm/xterm";

// Deep Cove — dark. Also used for `light`: per the Kove brand rule, code/
// terminal surfaces stay DARK even in the light app theme, so there is no
// separate light terminal palette.
export const flightdeckTerminalTheme: ITheme = {
  background: "#05080E",              // --abyss: panes read deeper than chrome
  foreground: "#EAF1F8",
  cursor: "#9AE9FF",
  cursorAccent: "#05080E",
  selectionBackground: "rgba(67,166,245,0.30)",

  black: "#0D1320",
  red: "#FF5C6A",
  green: "#52E08A",
  yellow: "#F2B03D",
  blue: "#43A6F5",
  magenta: "#8FA2FF",
  cyan: "#57E5C6",
  white: "#94A6BC",

  brightBlack: "#71839A",
  brightRed: "#FF8A94",
  brightGreen: "#7DEBAE",
  brightYellow: "#FFD07A",
  brightBlue: "#7CC4FF",
  brightMagenta: "#B3C0FF",
  brightCyan: "#8FF0DC",
  brightWhite: "#EAF1F8",
};

const draculaTerminalTheme: ITheme = {
  background: "#282A36",
  foreground: "#F8F8F2",
  cursor: "#F8F8F2",
  cursorAccent: "#282A36",
  selectionBackground: "rgba(68,71,90,0.65)",

  black: "#21222C",
  red: "#FF5555",
  green: "#50FA7B",
  yellow: "#F1FA8C",
  blue: "#BD93F9",
  magenta: "#FF79C6",
  cyan: "#8BE9FD",
  white: "#F8F8F2",

  brightBlack: "#6272A4",
  brightRed: "#FF6E6E",
  brightGreen: "#69FF94",
  brightYellow: "#FFFFA5",
  brightBlue: "#D6ACFF",
  brightMagenta: "#FF92DF",
  brightCyan: "#A4FFFF",
  brightWhite: "#FFFFFF",
};

const gruvboxTerminalTheme: ITheme = {
  background: "#282828",
  foreground: "#EBDBB2",
  cursor: "#EBDBB2",
  cursorAccent: "#282828",
  selectionBackground: "rgba(80,73,69,0.65)",

  black: "#282828",
  red: "#CC241D",
  green: "#98971A",
  yellow: "#D79921",
  blue: "#458588",
  magenta: "#B16286",
  cyan: "#689D6A",
  white: "#A89984",

  brightBlack: "#928374",
  brightRed: "#FB4934",
  brightGreen: "#B8BB26",
  brightYellow: "#FABD2F",
  brightBlue: "#83A598",
  brightMagenta: "#D3869B",
  brightCyan: "#8EC07C",
  brightWhite: "#EBDBB2",
};

const nordTerminalTheme: ITheme = {
  background: "#2E3440",
  foreground: "#D8DEE9",
  cursor: "#D8DEE9",
  cursorAccent: "#2E3440",
  selectionBackground: "rgba(76,86,106,0.65)",

  black: "#3B4252",
  red: "#BF616A",
  green: "#A3BE8C",
  yellow: "#EBCB8B",
  blue: "#81A1C1",
  magenta: "#B48EAD",
  cyan: "#88C0D0",
  white: "#E5E9F0",

  brightBlack: "#4C566A",
  brightRed: "#BF616A",
  brightGreen: "#A3BE8C",
  brightYellow: "#EBCB8B",
  brightBlue: "#81A1C1",
  brightMagenta: "#B48EAD",
  brightCyan: "#8FBCBB",
  brightWhite: "#ECEFF4",
};

// Genuinely high-contrast: black bg, white fg, saturated (not pastel) ANSI —
// matches theme.css's `high-contrast` block (black surfaces, #FFD400 accent).
const highContrastTerminalTheme: ITheme = {
  background: "#000000",
  foreground: "#FFFFFF",
  cursor: "#FFD400",
  cursorAccent: "#000000",
  selectionBackground: "rgba(255,255,255,0.35)",

  black: "#000000",
  red: "#FF3B30",
  green: "#00E5A0",
  yellow: "#FFD400",
  blue: "#5AC8FA",
  magenta: "#C77DFF",
  cyan: "#00E5FF",
  white: "#FFFFFF",

  brightBlack: "#6E6E6E",
  brightRed: "#FF6961",
  brightGreen: "#5CFFC1",
  brightYellow: "#FFEB6E",
  brightBlue: "#8FDFFF",
  brightMagenta: "#E0A3FF",
  brightCyan: "#6EFFFF",
  brightWhite: "#FFFFFF",
};

// Graphite (QL-792). Without this entry the panes inside the steel chrome fell
// back to Deep Cove's blue-tinted ANSI, which is the one place the theme leaked.
// Background is graphite's own --abyss, so a pane still reads deeper than the
// chrome around it (same relationship as Deep Cove above).
//
// The ramp is desaturated to sit with the chrome, but red/green/yellow keep the
// Okabe-Ito hue relationship the app's colour-blind palette uses (vermillion-
// leaning red, BLUISH green, amber yellow) so the three stay separable for
// deuteranopia/protanopia rather than collapsing into one muddy band. Luminance
// separates them too: red ~0.28, yellow ~0.41, green ~0.44 (all >= 6:1 on the
// background). Blue/cyan/magenta are lifted straight from the theme's own
// tokens (--st-starting, --aqua, --agent-claude) so terminal output and app
// chrome speak the same colours.
const graphiteTerminalTheme: ITheme = {
  background: "#07080A",              // --abyss
  foreground: "#E8EAED",              // --text
  cursor: "#AAB4BF",                  // --accent (steel)
  cursorAccent: "#07080A",
  selectionBackground: "rgba(170,182,194,0.30)",

  black: "#14181B",
  red: "#D9736A",
  green: "#6FC29B",
  yellow: "#D2A45F",
  blue: "#8FA9BA",
  magenta: "#A6A9D8",
  cyan: "#7FBFAE",
  white: "#9AA0A6",                   // --muted

  brightBlack: "#6E767E",
  brightRed: "#EE8F84",
  brightGreen: "#8FD6B4",
  brightYellow: "#E7BE81",
  brightBlue: "#AFC4D2",
  brightMagenta: "#C0C2E9",
  brightCyan: "#9BD5C4",
  brightWhite: "#E8EAED",
};

const TERMINAL_THEMES: Record<string, ITheme> = {
  graphite: graphiteTerminalTheme,
  dark: flightdeckTerminalTheme,
  light: flightdeckTerminalTheme, // Kove rule: terminal stays dark in light mode too
  dracula: draculaTerminalTheme,
  gruvbox: gruvboxTerminalTheme,
  nord: nordTerminalTheme,
  "high-contrast": highContrastTerminalTheme,
};

/** Resolves an app theme id (from `data-theme`) to an xterm ITheme. Unknown
 *  ids — including `custom`, whose palette can't be trusted to yield a
 *  legible ANSI 16 — fall back to Deep Cove dark. */
export function terminalThemeFor(themeId: string): ITheme {
  return TERMINAL_THEMES[themeId] ?? flightdeckTerminalTheme;
}
