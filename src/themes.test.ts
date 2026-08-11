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
