// Flightdeck terminal theme (xterm.js)
// Deep-Cove tuned. Terminal stays DARK in both app themes
// (Kove keeps code/terminal surfaces dark in light mode too).
import type { ITheme } from "@xterm/xterm";

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
