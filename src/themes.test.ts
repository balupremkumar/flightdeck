import { beforeEach, describe, expect, it, vi } from "vitest";

// The suite runs in node, so stub the two globals themes.ts touches. Same
// approach as trust.test.ts — adding jsdom for one module is a heavy trade.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const attrs = new Map<string, string>();
const props = new Map<string, string>();
vi.stubGlobal("document", {
  documentElement: {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => void props.delete(k),
    },
  },
});

const {
  applyTheme, rememberedThemeId, applyThemeForMode, toggleThemeMode,
  appearanceMode, setAppearanceMode, isFollowingSystem,
  currentThemeId, currentMode, DEFAULT_THEME_ID, DEFAULT_LIGHT_THEME_ID,
} = await import("./themes");
const { terminalThemeFor } = await import("./terminal-theme");

beforeEach(() => {
  store.clear();
  attrs.clear();
  props.clear();
});

describe("light/dark memory (QL-784)", () => {
  it("remembers the last theme used in each mode", () => {
    applyTheme("nord");
    applyTheme("light");
    expect(rememberedThemeId("dark")).toBe("nord");
    expect(rememberedThemeId("light")).toBe("light");
  });

  it("toggling out of a dark theme and back returns to it, not Deep Cove Dark", () => {
    applyTheme("graphite");
    expect(toggleThemeMode()).toBe("light");
    expect(currentThemeId()).toBe("light");
    expect(toggleThemeMode()).toBe("dark");
    expect(currentThemeId()).toBe("graphite"); // the bug: this used to be "dark"
  });

  it("first toggle on an install that predates the memory keeps the saved theme", () => {
    // Only flightdeck-theme-id is set, as an upgraded install would have.
    store.set("flightdeck-theme-id", "dracula");
    expect(rememberedThemeId("dark")).toBe("dracula");
  });

  it("falls back to the registry defaults when nothing is remembered", () => {
    expect(rememberedThemeId("dark")).toBe(DEFAULT_THEME_ID);
    expect(rememberedThemeId("light")).toBe(DEFAULT_LIGHT_THEME_ID);
  });

  it("ignores a remembered id whose mode no longer matches", () => {
    store.set("flightdeck-theme-light", "gruvbox"); // a dark theme in the light slot
    expect(rememberedThemeId("light")).toBe(DEFAULT_LIGHT_THEME_ID);
  });

  it("applyThemeForMode applies and returns the remembered id", () => {
    applyTheme("gruvbox");
    applyTheme("light");
    expect(applyThemeForMode("dark")).toBe("gruvbox");
    expect(currentMode()).toBe("dark");
  });
});

describe("appearance mode (QL-784)", () => {
  it("defaults to the active theme's mode, with no OS following", () => {
    applyTheme("light");
    expect(appearanceMode()).toBe("light");
    expect(isFollowingSystem()).toBe(false);
  });

  it("follows Windows only when explicitly chosen", () => {
    setAppearanceMode("system");
    expect(appearanceMode()).toBe("system");
    expect(isFollowingSystem()).toBe(true);
  });

  it("an explicit light/dark flip ends the follow", () => {
    setAppearanceMode("system");
    toggleThemeMode();
    expect(isFollowingSystem()).toBe(false);
  });
});

describe("terminal palettes", () => {
  it("graphite has its own palette rather than the blue-tinted fallback", () => {
    const graphite = terminalThemeFor("graphite");
    expect(graphite).not.toBe(terminalThemeFor("dark"));
    expect(graphite.background).toBe("#07080A");
  });

  it("every registered theme resolves to a palette of its own", () => {
    // "light" deliberately shares Deep Cove's dark palette (Kove brand rule).
    for (const id of ["graphite", "dracula", "gruvbox", "nord", "high-contrast"]) {
      expect(terminalThemeFor(id)).not.toBe(terminalThemeFor("custom"));
    }
  });
});

// ---------------------------------------------------------------------
// Presets + contrast. Tokens are read from the real theme.css so the check
// covers what actually ships, not a copy.
// ---------------------------------------------------------------------
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { THEMES, THEME_TOKENS } = await import("./themes");
const { contrastRatio } = await import("./vscodeTheme");

const css = readFileSync(join(process.cwd(), "src", "theme.css"), "utf8");

function blockTokens(selectorRe: RegExp): Record<string, string> | null {
  const m = selectorRe.exec(css);
  if (!m) return null;
  const body = css.slice(m.index + m[0].length, css.indexOf("\n}", m.index + m[0].length));
  const out: Record<string, string> = {};
  for (const d of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
const baseTokens = blockTokens(/^:root \{/m)!;
function themeTokens(id: string): Record<string, string> {
  if (id === "dark") return baseTokens;
  const own = blockTokens(new RegExp(`:root\\[data-theme="${id}"\\] \\{`));
  return { ...baseTokens, ...(own ?? {}) };
}

const PRESET_IDS = ["github-dark", "github-light", "github-dark-hc", "one-dark-pro", "tokyo-night"];
// Every token a preset must define in its own block (not inherited from the
// Deep Cove base, which would silently leak blue into the preset).
const PRESET_REQUIRED = THEME_TOKENS.filter((t) => !/^--(font-|ease-)/.test(t));
const ANSI = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

describe("preset themes", () => {
  it("registers every preset with the right mode and a swatch matching its --bg", () => {
    for (const id of PRESET_IDS) {
      const t = THEMES.find((x) => x.id === id);
      expect(t, id).toBeDefined();
      expect(t!.swatch[0].toLowerCase(), `${id} swatch bg`).toBe(themeTokens(id)["--bg"].toLowerCase());
      expect(t!.mode).toBe(id === "github-light" ? "light" : "dark");
    }
  });

  it("defines every app token in the preset's own CSS block", () => {
    for (const id of PRESET_IDS) {
      const own = blockTokens(new RegExp(`:root\\[data-theme="${id}"\\] \\{`));
      expect(own, `${id} block`).not.toBeNull();
      expect(PRESET_REQUIRED.filter((t) => !(t in own!)), `${id} missing tokens`).toEqual([]);
    }
  });

  it("defines a complete terminal palette (16 ANSI + cursor + selection)", () => {
    for (const id of PRESET_IDS) {
      const t = terminalThemeFor(id) as Record<string, string>;
      expect(t, id).not.toBe(terminalThemeFor("custom"));
      for (const k of [...ANSI, "background", "foreground", "cursor", "cursorAccent", "selectionBackground"]) {
        expect(typeof t[k], `${id}.${k}`).toBe("string");
      }
    }
  });
});

// Existing themes that fail a pair are recorded here with the measured reason
// rather than silently edited (owner decides). A pair listed here must still
// FAIL; if someone fixes the theme the test goes red until the entry is removed.
// Deep Cove Light: --accent #1C72D0 on --bg #EFF3F8 measures 4.32:1 (needs 4.5).
const KNOWN_FAILS: Record<string, string[]> = {};

describe("WCAG AA contrast (4.5:1 on --bg) for every theme", () => {
  const pairs = ["--text", "--muted", "--accent"];
  for (const { id } of THEMES) {
    for (const fg of pairs) {
      const tk = themeTokens(id);
      const ratio = contrastRatio(tk[fg], tk["--bg"]);
      if ((KNOWN_FAILS[id] ?? []).includes(fg)) {
        it(`${id} ${fg} on --bg is a known failure (${ratio.toFixed(2)}:1)`, () => expect(ratio).toBeLessThan(4.5));
      } else {
        it(`${id} ${fg} on --bg >= 4.5 (${ratio.toFixed(2)}:1)`, () => expect(ratio).toBeGreaterThanOrEqual(4.5));
      }
    }
  }
});
