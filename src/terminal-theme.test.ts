import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flightdeckTerminalTheme, terminalThemeFor } from "./terminal-theme";

const palettes = [
  ["dark", "#05080E", "#EAF1F8"], ["light", "#05080E", "#EAF1F8"],
  ["dracula", "#282A36", "#F8F8F2"], ["gruvbox", "#282828", "#EBDBB2"],
  ["nord", "#2E3440", "#D8DEE9"], ["high-contrast", "#000000", "#FFFFFF"],
  ["graphite", "#07080A", "#E8EAED"], ["github-dark", "#0D1117", "#E6EDF3"],
  ["github-light", "#0D1117", "#E6EDF3"], ["github-dark-hc", "#0A0C10", "#F0F3F6"],
  ["one-dark-pro", "#282C34", "#ABB2BF"], ["tokyo-night", "#1A1B26", "#C0CAF5"],
  ["catppuccin-mocha", "#1E1E2E", "#CDD6F4"],
] as const;
const hexFields = [
  "background", "foreground", "cursor", "cursorAccent", "black", "red", "green",
  "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed",
  "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const getItem = vi.fn<() => string | null>();
beforeEach(() => {
  getItem.mockReset().mockReturnValue(null);
  vi.stubGlobal("localStorage", { getItem });
});
afterEach(() => vi.unstubAllGlobals());

describe("terminal palettes", () => {
  it.each(palettes)("resolves %s with valid colours and distinct foreground/background", (id, background, foreground) => {
    const theme = terminalThemeFor(id);
    expect(theme.background).toBe(background);
    expect(theme.foreground).toBe(foreground);
    expect(theme.background).not.toBe(theme.foreground);
    expect(Object.keys(theme).sort()).toEqual([...hexFields, "selectionBackground"].sort());
    for (const key of hexFields) expect(theme[key], key).toMatch(/^#[0-9a-f]{6}$/i);
    const rgba = /^rgba\((\d+),(\d+),(\d+),(0(?:\.\d+)?|1(?:\.0+)?)\)$/.exec(theme.selectionBackground!);
    expect(rgba).not.toBeNull();
    for (const channel of rgba!.slice(1, 4)) expect(Number(channel)).toBeLessThanOrEqual(255);
    expect(Number(rgba![4])).toBeGreaterThanOrEqual(0);
    expect(Number(rgba![4])).toBeLessThanOrEqual(1);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("exports the complete Deep Cove palette and shares the documented dark aliases", () => {
    expect(Object.keys(flightdeckTerminalTheme).sort()).toEqual([...hexFields, "selectionBackground"].sort());
    expect(terminalThemeFor("dark")).toBe(flightdeckTerminalTheme);
    expect(terminalThemeFor("light")).toBe(flightdeckTerminalTheme);
    expect(terminalThemeFor("github-light")).toBe(terminalThemeFor("github-dark"));
  });

  it.each(["unknown-theme", "", "DARK"])("falls back to Deep Cove for %s", (id) => {
    expect(terminalThemeFor(id)).toBe(flightdeckTerminalTheme);
  });

  it("uses a complete imported custom terminal palette", () => {
    const terminal = { ...terminalThemeFor("dracula") };
    getItem.mockReturnValue(JSON.stringify({ terminal }));
    expect(terminalThemeFor("custom")).toEqual(terminal);
    expect(getItem).toHaveBeenCalledWith("flightdeck-theme-custom");
  });

  it.each([null, "broken JSON", "null", "{}", '{"terminal":null}', '{"terminal":{"background":"#000000"}}'])(
    "falls back when the custom palette is absent, malformed or incomplete (%#)", (raw) => {
      getItem.mockReturnValue(raw);
      expect(terminalThemeFor("custom")).toBe(flightdeckTerminalTheme);
    },
  );

  it("rejects a custom palette with a non-string required field", () => {
    getItem.mockReturnValue(JSON.stringify({ terminal: { ...flightdeckTerminalTheme, brightWhite: 42 } }));
    expect(terminalThemeFor("custom")).toBe(flightdeckTerminalTheme);
  });

  it("falls back when storage is unavailable", () => {
    getItem.mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(terminalThemeFor("custom")).toBe(flightdeckTerminalTheme);
  });
});
