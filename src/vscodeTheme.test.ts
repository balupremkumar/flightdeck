import { describe, expect, it } from "vitest";
import { importVsCodeTheme, stripJsonc, contrastRatio, VsCodeThemeError } from "./vscodeTheme";
import { THEME_TOKENS } from "./themes";

// A realistic file: line + block comments, trailing commas, a "//" inside a
// string value, and several keys deliberately missing (no terminal.ansi*
// brights, no panel.border, no descriptionForeground).
const FIXTURE = `{
  // Fixture theme
  "name": "Fixture Night",
  "type": "dark",
  /* block comment */
  "colors": {
    "editor.background": "#1b1d26",
    "editor.foreground": "#c8cbe0",
    "terminal.ansiRed": "#ff6b81",
    "terminal.ansiGreen": "#7bd88f",
    "terminal.ansiBlue": "#6c9cff",
    "terminalCursor.foreground": "#ffcc00",
    "terminal.selectionBackground": "#3a3f5a",
    "editorLineNumber.foreground": "#5c6288",
    "sideBar.background": "#161821",
    "focusBorder": "#6c9cff",
    "button.background": "#3d5afe",
    "diffEditor.insertedTextBackground": "#7bd88f33",
    "diffEditor.removedTextBackground": "#ff6b8133",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#5c6288" } },
  ],
  "$schema": "vscode://schemas/color-theme", // http://not-a-comment
}`;

describe("stripJsonc", () => {
  it("removes comments and trailing commas but leaves strings alone", () => {
    const out = JSON.parse(stripJsonc('{ "a": "http://x // y", /* c */ "b": [1, 2, ], // t\n }'));
    expect(out).toEqual({ a: "http://x // y", b: [1, 2] });
  });
  it("tolerates a BOM", () => {
    expect(JSON.parse(stripJsonc("﻿{\"a\":1}"))).toEqual({ a: 1 });
  });
});

describe("importVsCodeTheme", () => {
  const t = importVsCodeTheme(FIXTURE);

  it("reads the name and mode", () => {
    expect(t.name).toBe("Fixture Night");
    expect(t.mode).toBe("dark");
  });

  it("maps editor and sidebar colours straight onto tokens", () => {
    expect(t.tokens["--bg"]).toBe("#1B1D26");
    expect(t.tokens["--surface"]).toBe("#161821");
    // button.background is the accent source; it is lightened only as far as
    // needed to read as text on --bg, so it stays blue-ish rather than grey.
    const [r, , b] = [1, 3, 5].map((i) => parseInt(t.tokens["--accent"].slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r);
  });

  it("emits every colour token the app's custom-theme import knows", () => {
    const colour = THEME_TOKENS.filter((k) => !/^--(font-|ease-)/.test(k));
    expect(colour.filter((k) => !t.tokens[k])).toEqual([]);
  });

  it("derives missing keys from the editor background/foreground", () => {
    // no panel.border: --line is derived (translucent foreground), not blank
    expect(t.tokens["--line"]).toMatch(/^rgba\(/);
    // no descriptionForeground: --muted is derived and still readable
    expect(contrastRatio(t.tokens["--muted"], t.tokens["--bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.tokens["--text"], t.tokens["--bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.tokens["--accent"], t.tokens["--bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("returns a complete terminal palette, filling omitted ANSI colours", () => {
    expect(t.terminal.red).toBe("#FF6B81");
    expect(t.terminal.green).toBe("#7BD88F");
    expect(t.terminal.magenta).toMatch(/^#[0-9A-F]{6}$/); // default, not provided
    expect(t.terminal.brightWhite).toMatch(/^#[0-9A-F]{6}$/);
    expect(t.terminal.cursor).toBe("#FFCC00");
    expect(t.terminal.background).toBe("#1B1D26"); // no terminal.background: editor bg
    expect(t.terminal.selectionBackground).toBe("#3A3F5A");
  });

  it("keeps the diff tints, and derives them when absent", () => {
    expect(t.diff.added).toBe("rgba(123,216,143,0.2)");
    const bare = importVsCodeTheme('{"colors":{"editor.background":"#101010"}}');
    expect(bare.diff.added).toMatch(/^rgba\(/);
    expect(bare.diff.removed).toMatch(/^rgba\(/);
  });

  it("detects a light theme from the editor background when type is absent", () => {
    const light = importVsCodeTheme('{"colors":{"editor.background":"#fafafa","editor.foreground":"#222222"}}');
    expect(light.mode).toBe("light");
    expect(contrastRatio(light.tokens["--text"], light.tokens["--bg"])).toBeGreaterThanOrEqual(4.5);
    expect(light.tokens["--on-accent"]).toMatch(/^#/);
  });

  it("composites an 8-digit background over the page rather than emitting alpha", () => {
    const x = importVsCodeTheme('{"type":"dark","colors":{"editor.background":"#ffffff80","editor.foreground":"#fff"}}');
    expect(x.tokens["--bg"]).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe("importVsCodeTheme errors", () => {
  it("rejects non-JSON with a clear message", () => {
    expect(() => importVsCodeTheme("not json {")).toThrow(VsCodeThemeError);
    expect(() => importVsCodeTheme("not json {")).toThrow(/valid JSON/);
  });
  it("rejects JSON that is not an object", () => {
    expect(() => importVsCodeTheme("[1,2]")).toThrow(/expected a JSON object/);
  });
  it("rejects a file with no colors section", () => {
    expect(() => importVsCodeTheme('{"name":"x","tokenColors":[]}')).toThrow(/colors/);
  });
  it("explains an include-only theme", () => {
    expect(() => importVsCodeTheme('{"include":"./base.json","tokenColors":[]}')).toThrow(/include/);
  });
  it("rejects a colors section with nothing usable", () => {
    expect(() => importVsCodeTheme('{"colors":{"editor.background":"red"}}')).toThrow(/no usable colours/);
  });
});
