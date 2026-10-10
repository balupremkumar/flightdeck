import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as s from "./settingsStore";
import { APP_VERSION as version } from "./version";

vi.mock("./ui", () => ({ useUI: vi.fn() }));
vi.mock("./persist", () => ({ isMainWindow: vi.fn() }));
vi.mock("./updater", () => ({ getPendingReleaseNotes: vi.fn(), clearPendingReleaseNotes: vi.fn() }));

const terminalKey = "flightdeck-terminal-settings";
const agentKey = "flightdeck-agent-settings";
let css: Map<string, string>;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  });
  localStorage.clear();
  css = new Map();
  vi.stubGlobal("document", { documentElement: { style: {
    setProperty: (key: string, value: string) => { css.set(key, value); },
  } } });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("CustomEvent", class<T> extends Event {
    detail: T | undefined;
    constructor(type: string, init?: CustomEventInit<T>) {
      super(type, init);
      this.detail = init?.detail;
    }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function store(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}
function read(key: string) { return JSON.parse(localStorage.getItem(key)!); }

describe("defaults and storage recovery", () => {
  const getters = [
    [terminalKey, s.getTerminalSettings, s.DEFAULT_TERMINAL_SETTINGS],
    [s.READING_SETTINGS_KEY, s.getReadingSettings, s.DEFAULT_READING_SETTINGS],
    [agentKey, s.getAgentSettings, s.DEFAULT_AGENT_SETTINGS],
    [s.EDITOR_SETTINGS_KEY, s.getEditorSettings, s.DEFAULT_EDITOR_SETTINGS],
    ["flightdeck-shortcuts", s.getShortcuts, s.DEFAULT_SHORTCUTS],
  ] as const;
  it.each(getters)("returns defaults for absent or broken JSON at %s", (key, get, defaults) => {
    expect(get()).toEqual(defaults);
    localStorage.setItem(key, "{broken");
    expect(get()).toEqual(defaults);
  });
  it("recovers defaults when storage is inaccessible", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("denied"); });
    for (const [, get, defaults] of getters) expect(get()).toEqual(defaults);
    expect(s.getStartupBehavior()).toBe("reopen");
    expect(s.getMultiwindow()).toBe(true);
    expect(s.getWindowDrag()).toBe(true);
    expect(s.getMemoryCeilingMb()).toBe(s.DEFAULT_MEMORY_CEILING_MB);
    expect(s.hooksInstalled()).toBe(false);
  });
});

describe("numeric bounds and reading settings", () => {
  it.each([
    [5, 5], [-1, 1], [20, 10], ["4.5", 4.5], [undefined, 6],
    ["bad", 6], [NaN, 6], [Infinity, 6],
  ])("clampNum(%s) returns %s", (input, expected) => {
    expect(s.clampNum(input, 1, 10, 6)).toBe(expected);
  });
  it("clamps reading fields at both ends and rejects an unknown width", () => {
    store(s.READING_SETTINGS_KEY, { previewFontSize: 1, uiTextScale: 5, previewLineHeight: 1, previewWidth: "wide" });
    expect(s.getReadingSettings()).toEqual({
      previewFontSize: s.PREVIEW_FONT_RANGE.min, uiTextScale: s.UI_TEXT_SCALE_RANGE.max,
      previewLineHeight: s.PREVIEW_LH_RANGE.min, previewWidth: "medium",
    });
    store(s.READING_SETTINGS_KEY, { previewFontSize: 100, uiTextScale: 0, previewLineHeight: 3, previewWidth: "full" });
    expect(s.getReadingSettings()).toEqual({
      previewFontSize: s.PREVIEW_FONT_RANGE.max, uiTextScale: s.UI_TEXT_SCALE_RANGE.min,
      previewLineHeight: s.PREVIEW_LH_RANGE.max, previewWidth: "full",
    });
  });
  it.each([{}, null, { previewFontSize: "bad", uiTextScale: "bad", previewLineHeight: "bad" }])(
    "falls back for missing or unparseable reading fields (%s)", (value) => {
      store(s.READING_SETTINGS_KEY, value);
      expect(s.getReadingSettings()).toEqual(s.DEFAULT_READING_SETTINGS);
    },
  );
  it("persists partial reading edits, merges prior fields and applies CSS", () => {
    s.saveReadingSettings({ previewFontSize: 18, previewWidth: "narrow" });
    const next = s.saveReadingSettings({ uiTextScale: 1.2 });
    expect(next).toEqual({ previewFontSize: 18, previewWidth: "narrow", uiTextScale: 1.2, previewLineHeight: 1.6 });
    expect(read(s.READING_SETTINGS_KEY)).toEqual(next);
    expect(s.getReadingSettings()).toEqual(next);
    expect(Object.fromEntries(css)).toEqual({ "--prv-fs": "18px", "--prv-lh": "1.6", "--prv-width": "70ch", "--ui-fs-scale": "1.2" });
  });
  it.each(["narrow", "medium", "full"] as const)("applies the %s preview width", (width) => {
    store(s.READING_SETTINGS_KEY, { ...s.DEFAULT_READING_SETTINGS, previewWidth: width });
    s.applyReadingSettings();
    expect(css.get("--prv-width")).toBe(s.PREVIEW_WIDTHS[width].css);
    expect(s.PREVIEW_WIDTHS[width].label.length).toBeGreaterThan(0);
  });
});

describe("terminal settings", () => {
  it("merges older settings with new defaults", () => {
    store(terminalKey, { fontSize: 15 });
    expect(s.getTerminalSettings()).toEqual({ ...s.DEFAULT_TERMINAL_SETTINGS, fontSize: 15 });
    expect(s.TERMINAL_FONTS).toContain(s.DEFAULT_TERMINAL_SETTINGS.fontFamily);
  });
  it("persists partial changes and broadcasts the merged settings", () => {
    const listener = vi.fn();
    window.addEventListener("flightdeck-terminal-settings-changed", listener);
    s.saveTerminalSettings({ fontSize: 16 });
    const next = s.saveTerminalSettings({ cursorStyle: "bar", copyOnSelect: false, rightClick: "menu" });
    expect(next).toEqual({ ...s.DEFAULT_TERMINAL_SETTINGS, fontSize: 16, cursorStyle: "bar", copyOnSelect: false, rightClick: "menu" });
    expect(read(terminalKey)).toEqual(next);
    expect(s.getTerminalSettings()).toEqual(next);
    expect((listener.mock.calls[1][0] as CustomEvent).detail).toEqual(next);
  });
  it("clamps the options sent to xterm and falls back for non-finite values", () => {
    expect(s.terminalReadabilityOptions()).toEqual({ minimumContrastRatio: 4.5, lineHeight: 1 });
    expect(s.terminalReadabilityOptions({ ...s.DEFAULT_TERMINAL_SETTINGS, minimumContrastRatio: 99, lineHeight: 0 })).toEqual({ minimumContrastRatio: s.CONTRAST_RANGE.max, lineHeight: s.TERM_LINE_HEIGHT_RANGE.min });
    expect(s.terminalReadabilityOptions({ ...s.DEFAULT_TERMINAL_SETTINGS, minimumContrastRatio: 0, lineHeight: 99 })).toEqual({ minimumContrastRatio: s.CONTRAST_RANGE.min, lineHeight: s.TERM_LINE_HEIGHT_RANGE.max });
    expect(s.terminalReadabilityOptions({ ...s.DEFAULT_TERMINAL_SETTINGS, minimumContrastRatio: NaN, lineHeight: Infinity })).toEqual({ minimumContrastRatio: 4.5, lineHeight: 1 });
    store(terminalKey, { minimumContrastRatio: 7, lineHeight: 1.5 });
    expect(s.terminalReadabilityOptions()).toEqual({ minimumContrastRatio: 7, lineHeight: 1.5 });
  });
});

describe("stored terminal field validation", () => {
  const valid: s.TerminalSettings = {
    fontFamily: " Custom Mono ", fontSize: 13.75, cursorStyle: "underline",
    scrollback: 1234.5, minimumContrastRatio: 5.25, lineHeight: 1.325,
    copyOnSelect: false, rightClick: "menu",
  };

  it.each([
    ["fontFamily", ""], ["fontFamily", 42], ["fontFamily", null],
    ["fontSize", "13.75"], ["fontSize", "abc"], ["fontSize", 0], ["fontSize", -1], ["fontSize", null],
    ["scrollback", "1234"], ["scrollback", -5], ["scrollback", null],
    ["cursorStyle", "unknown"], ["cursorStyle", null],
    ["rightClick", "unknown"], ["rightClick", null],
    ["copyOnSelect", "false"], ["copyOnSelect", 0], ["copyOnSelect", null],
    ["minimumContrastRatio", "bad"], ["lineHeight", "bad"],
  ] as Array<[keyof s.TerminalSettings, unknown]>)("defaults invalid %s (%s) while preserving other fields", (field, value) => {
    store(terminalKey, { ...valid, [field]: value });
    expect(s.getTerminalSettings()).toEqual({ ...valid, [field]: s.DEFAULT_TERMINAL_SETTINGS[field] });
  });

  it.each([
    ["fontSize", NaN], ["fontSize", Infinity], ["fontSize", -Infinity],
    ["scrollback", NaN], ["scrollback", Infinity], ["scrollback", -Infinity],
    ["minimumContrastRatio", NaN], ["minimumContrastRatio", Infinity],
    ["lineHeight", NaN], ["lineHeight", Infinity],
  ] as Array<[keyof s.TerminalSettings, number]>)("defaults non-finite %s (%s)", (field, value) => {
    // JSON cannot encode NaN or Infinity, so inject them at the parsed-object boundary.
    store(terminalKey, valid);
    vi.spyOn(JSON, "parse").mockReturnValueOnce({ ...valid, [field]: value });
    expect(s.getTerminalSettings()).toEqual({ ...valid, [field]: s.DEFAULT_TERMINAL_SETTINGS[field] });
  });

  it.each([
    [0, 99, s.CONTRAST_RANGE.min, s.TERM_LINE_HEIGHT_RANGE.max],
    [99, 0, s.CONTRAST_RANGE.max, s.TERM_LINE_HEIGHT_RANGE.min],
  ])("clamps stored contrast %s and line height %s", (contrast, height, expectedContrast, expectedHeight) => {
    store(terminalKey, { ...valid, minimumContrastRatio: contrast, lineHeight: height });
    expect(s.getTerminalSettings()).toEqual({ ...valid, minimumContrastRatio: expectedContrast, lineHeight: expectedHeight });
  });

  it.each(["block", "underline", "bar"] as const)("preserves all valid fields with cursor %s exactly", (cursorStyle) => {
    const stored = { ...valid, cursorStyle };
    store(terminalKey, stored);
    expect(s.getTerminalSettings()).toEqual(stored);
  });

  it("preserves zero scrollback and a small positive font size without invented limits", () => {
    const stored = { ...valid, fontFamily: " ", fontSize: 0.125, scrollback: 0, copyOnSelect: true, rightClick: "paste" };
    store(terminalKey, stored);
    expect(s.getTerminalSettings()).toEqual(stored);
    store(terminalKey, { ...stored, fontSize: 1000, scrollback: 1000000 });
    expect(s.getTerminalSettings()).toEqual({ ...stored, fontSize: 1000, scrollback: 1000000 });
  });

  it("drops extra keys and returns exactly the eight terminal fields", () => {
    store(terminalKey, { ...valid, extra: "ignored", nested: { fontSize: 99 } });
    expect(s.getTerminalSettings()).toEqual(valid);
    expect(Object.keys(s.getTerminalSettings()).sort()).toEqual(Object.keys(s.DEFAULT_TERMINAL_SETTINGS).sort());
  });

  it("defaults every missing field in an empty stored object", () => {
    store(terminalKey, {});
    expect(s.getTerminalSettings()).toEqual(s.DEFAULT_TERMINAL_SETTINGS);
  });
});

describe("colour contrast", () => {
  it.each([["rgb(12, 34, 56)", [12, 34, 56]], ["rgba(1, 2, 3, 0.5)", [1, 2, 3]], ["rgb(4 5 6)", [4, 5, 6]], ["garbage", null], ["#ffffff", null]])(
    "parses %s", (input, expected) => { expect(s.parseRgb(input as string)).toEqual(expected); },
  );
  it("matches known luminances and symmetric WCAG ratios", () => {
    expect(s.luminance([0, 0, 0])).toBe(0);
    expect(s.luminance([255, 255, 255])).toBeCloseTo(1, 12);
    expect(s.luminance([255, 0, 0])).toBeCloseTo(0.2126, 12);
    expect(s.luminance([128, 128, 128])).toBeCloseTo(0.2158605, 7);
    expect(s.contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 12);
    expect(s.contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 12);
    expect(s.contrastRatio([128, 128, 128], [128, 128, 128])).toBe(1);
  });
  it.each([[0, 0, 0], [255, 255, 255]] as Array<[number, number, number]>)("adjusts grey against %s to the requested ratio", (r, g, b) => {
    const bg: [number, number, number] = [r, g, b];
    const adjusted = s.adjustForContrast([128, 128, 128], bg, 7);
    expect(s.contrastRatio(adjusted, bg)).toBeGreaterThanOrEqual(7);
    expect(adjusted.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)).toBe(true);
  });
  it("leaves sufficient contrast alone and uses the endpoint for an impossible ratio", () => {
    const fg: [number, number, number] = [255, 255, 255];
    expect(s.adjustForContrast(fg, [0, 0, 0], 7)).toBe(fg);
    expect(s.adjustForContrast(fg, fg, 1)).toBe(fg);
    expect(s.adjustForContrast([128, 128, 128], [0, 0, 0], 22)).toEqual([255, 255, 255]);
  });
});

describe("shortcuts", () => {
  it("has unique default ids and combos without fixed collisions", () => {
    expect(new Set(s.DEFAULT_SHORTCUTS.map((x) => x.id)).size).toBe(s.DEFAULT_SHORTCUTS.length);
    expect(new Set(s.DEFAULT_SHORTCUTS.map((x) => x.combo)).size).toBe(s.DEFAULT_SHORTCUTS.length);
    for (const item of s.DEFAULT_SHORTCUTS) expect(s.FIXED_SHORTCUTS.map((x) => x.combo)).not.toContain(item.combo);
    for (const item of [...s.FIXED_SHORTCUTS, ...s.CONTEXTUAL_SHORTCUTS]) {
      expect(item.id).not.toBe(""); expect(item.label).not.toBe(""); expect(item.combo).not.toBe("");
    }
    for (const item of s.CONTEXTUAL_SHORTCUTS) expect(item.context).not.toBe("");
  });
  it("persists multiple overrides then restores the defaults", () => {
    s.saveShortcut("settings", "Ctrl+Alt+S");
    s.saveShortcut("toggle-panel", "Alt+B");
    expect(read("flightdeck-shortcuts")).toEqual({ settings: "Ctrl+Alt+S", "toggle-panel": "Alt+B" });
    expect(s.getShortcuts().map((x) => x.combo)).toEqual(["Ctrl+Alt+S", "Alt+B"]);
    expect(s.DEFAULT_SHORTCUTS.map((x) => x.combo)).toEqual(["Ctrl+,", "Ctrl+B"]);
    s.resetShortcuts();
    expect(localStorage.getItem("flightdeck-shortcuts")).toBeNull();
    expect(s.getShortcuts()).toEqual(s.DEFAULT_SHORTCUTS);
  });
  it("replaces broken override JSON when saving", () => {
    localStorage.setItem("flightdeck-shortcuts", "broken");
    s.saveShortcut("settings", "Alt+S");
    expect(s.getShortcuts()[0].combo).toBe("Alt+S");
    expect(s.getShortcuts()[1]).toEqual(s.DEFAULT_SHORTCUTS[1]);
  });
  it.each(["Control", "Alt", "Shift", "Meta"])("ignores modifier-only %s", (key) => {
    expect(s.formatCombo({ key } as KeyboardEvent)).toBeNull();
  });
  it("formats modifiers in order, uppercases letters and retains named keys", () => {
    expect(s.formatCombo({ key: "b", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true } as KeyboardEvent)).toBe("Ctrl+Alt+Shift+Meta+B");
    expect(s.formatCombo({ key: "ArrowLeft", altKey: true } as KeyboardEvent)).toBe("Alt+ArrowLeft");
    expect(s.formatCombo({ key: ",", ctrlKey: true } as KeyboardEvent)).toBe("Ctrl+,");
    expect(s.formatCombo({ key: "a" } as KeyboardEvent)).toBe("A");
  });
});

describe("agents and migrations", () => {
  it("round-trips agent settings and fills missing nested maps", () => {
    const next: s.AgentSettings = { defaultVendor: "codex", flags: { codex: "--flag" }, binaryPaths: { codex: "C:/bin/codex" }, chatDetail: "verbose", openClaudeIn: "quiet" };
    s.saveAgentSettings(next);
    expect(read(agentKey)).toEqual(next);
    expect(s.getAgentSettings()).toEqual(next);
    store(agentKey, { openClaudeIn: "unknown" });
    expect(s.getAgentSettings()).toEqual(s.DEFAULT_AGENT_SETTINGS);
  });
  it.each(["chat", "quiet", "terminal"] as const)("accepts the %s opening view", (openClaudeIn) => {
    store(agentKey, { openClaudeIn });
    expect(s.getAgentSettings()).toEqual({ ...s.DEFAULT_AGENT_SETTINGS, openClaudeIn });
  });
  const migrations = [
    ["quiet", s.migrateQuietDefault, s.QUIET_DEFAULT_MIGRATION_KEY, "chat", "quiet"],
    ["terminal", s.migrateTerminalDefault, s.TERMINAL_DEFAULT_MIGRATION_KEY, "quiet", "terminal"],
  ] as const;
  describe.each(migrations)("%s migration", (_name, migrate, flag, from, to) => {
    it("runs once, flags completion and preserves other fields", () => {
      const previous = { ...s.DEFAULT_AGENT_SETTINGS, openClaudeIn: from, defaultVendor: "codex", flags: { codex: "--flag" }, binaryPaths: { codex: "custom" } };
      store(agentKey, previous);
      expect(migrate()).toBe(true);
      expect(localStorage.getItem(flag)).toBe("1");
      expect(read(agentKey)).toEqual({ ...previous, openClaudeIn: to });
      store(agentKey, previous);
      expect(migrate()).toBe(false);
      expect(read(agentKey)).toEqual(previous);
    });
    it.each(["chat", "quiet", "terminal", undefined].filter((view) => view !== from))("preserves a non-target view (%s)", (view) => {
      const previous = { defaultVendor: "codex", openClaudeIn: view };
      store(agentKey, previous);
      const raw = localStorage.getItem(agentKey);
      expect(migrate()).toBe(false);
      expect(localStorage.getItem(flag)).toBe("1");
      expect(localStorage.getItem(agentKey)).toBe(raw);
    });
    it("flags absent or malformed settings without creating or replacing them", () => {
      expect(migrate()).toBe(false);
      expect(localStorage.getItem(flag)).toBe("1");
      expect(localStorage.getItem(agentKey)).toBeNull();
      localStorage.removeItem(flag);
      localStorage.setItem(agentKey, "broken");
      expect(migrate()).toBe(false);
      expect(localStorage.getItem(flag)).toBe("1");
      expect(localStorage.getItem(agentKey)).toBe("broken");
    });
  });
  it("applies both historical migrations in boot order", () => {
    store(agentKey, { openClaudeIn: "chat" });
    expect(s.migrateQuietDefault()).toBe(true);
    expect(s.migrateTerminalDefault()).toBe(true);
    expect(s.getAgentSettings().openClaudeIn).toBe("terminal");
  });
});

describe("editor settings", () => {
  it.each([null, {}, { editor: 1, command: "code" }, { editor: "custom", command: null }])("rejects malformed editor settings (%s)", (value) => {
    store(s.EDITOR_SETTINGS_KEY, value);
    expect(s.getEditorSettings()).toEqual(s.DEFAULT_EDITOR_SETTINGS);
  });
  it("round-trips a custom editor", () => {
    const next: s.EditorSettings = { editor: "custom", command: 'edit "{file}" {line} {col}' };
    s.saveEditorSettings(next);
    expect(read(s.EDITOR_SETTINGS_KEY)).toEqual(next);
    expect(s.getEditorSettings()).toEqual(next);
    expect(s.DEFAULT_EDITOR_SETTINGS).toEqual({ editor: "vscode", command: s.EDITOR_PRESETS.vscode.command });
  });
  it.each(Object.entries(s.EDITOR_PRESETS))("resolves the %s preset with a spaced Windows path", (_id, preset) => {
    const file = "C:\\My Project\\main.ts";
    const resolved = s.resolveEditorCommand(preset.command, file, 12, 3);
    expect(preset.label).not.toBe("");
    expect(resolved).toContain(`"${file}`);
    expect(resolved).toContain("12");
    expect(resolved).not.toMatch(/\{(file|line|col)\}/);
  });
  it("substitutes every occurrence and defaults omitted positions to one", () => {
    expect(s.resolveEditorCommand("{file} {file} {line}:{col} {line}:{col}", "a.ts")).toBe("a.ts a.ts 1:1 1:1");
    expect(s.resolveEditorCommand("{line}:{col}", "a.ts", 8)).toBe("8:1");
    expect(s.resolveEditorCommand("{line}:{col}", "a.ts", 8, 2)).toBe("8:2");
  });
});

describe("startup and windows", () => {
  it("defaults to reopen and round-trips both startup behaviours", () => {
    expect(s.getStartupBehavior()).toBe("reopen");
    for (const value of ["launcher", "reopen"] as const) {
      s.saveStartupBehavior(value);
      expect(localStorage.getItem("flightdeck-startup")).toBe(value);
      expect(s.getStartupBehavior()).toBe(value);
    }
  });
  it.each([
    ["flightdeck-multiwindow", s.getMultiwindow, s.saveMultiwindow],
    ["flightdeck-window-drag", s.getWindowDrag, s.saveWindowDrag],
  ] as const)("round-trips %s and broadcasts changes", (key, get, save) => {
    const listener = vi.fn();
    window.addEventListener(s.WINDOW_DRAG_EVENT, listener);
    expect(get()).toBe(true);
    save(false);
    expect(get()).toBe(false);
    expect(localStorage.getItem(key)).toBe("0");
    save(true);
    expect(get()).toBe(true);
    expect(localStorage.getItem(key)).toBe("1");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("version and release information", () => {
  it("keeps both version exports in step with package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(s.APP_VERSION).toBe(pkg.version);
    expect(s.APP_VERSION).toBe(version);
  });
  it.each([
    [null, { version: "1.2.3", notes: "New feature" }, true],
    ["1.2.2", { version: "1.2.3", notes: "New feature" }, true],
    ["1.2.3", { version: "1.2.3", notes: "New feature" }, false],
    [null, null, false],
    [null, { version: "1.2.2", notes: "Old feature" }, false],
    [null, { version: "1.2.3", notes: " \n\t " }, false],
  ] as const)("decides whether notes should show (%s, %s)", (seen, pending, expected) => {
    expect(s.shouldShowWhatsNew("1.2.3", seen, pending)).toBe(expected);
  });
  it("exports the seen-version key and dated changelog entries", () => {
    expect(s.WHATSNEW_SEEN_KEY).toBe("flightdeck-whatsnew-seen-version");
    expect(s.CHANGELOG.length).toBeGreaterThan(0);
    for (const entry of s.CHANGELOG) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.text.trim()).not.toBe("");
    }
    const dates = s.CHANGELOG.map((entry) => entry.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

describe("memory ceiling", () => {
  it.each([
    [NaN, 1024], [Infinity, 1024], [-1, 1024], [0, 1024], [1, 64],
    [64, 64], [128.6, 129], [65536, 65536], [999999, 65536],
  ])("clamps %s MB to %s", (input, expected) => {
    expect(s.clampMemoryCeiling(input)).toBe(expected);
  });
  it("uses the default for absent or malformed storage and clamps stored numbers", () => {
    expect(s.getMemoryCeilingMb()).toBe(s.DEFAULT_MEMORY_CEILING_MB);
    localStorage.setItem(s.MEMORY_CEILING_KEY, "bad");
    expect(s.getMemoryCeilingMb()).toBe(s.DEFAULT_MEMORY_CEILING_MB);
    localStorage.setItem(s.MEMORY_CEILING_KEY, "1");
    expect(s.getMemoryCeilingMb()).toBe(s.MIN_MEMORY_CEILING_MB);
    localStorage.setItem(s.MEMORY_CEILING_KEY, "999999");
    expect(s.getMemoryCeilingMb()).toBe(s.MAX_MEMORY_CEILING_MB);
  });
  it("persists and broadcasts the clamped value", () => {
    const listener = vi.fn();
    window.addEventListener(s.MEMORY_CEILING_EVENT, listener);
    expect(s.setMemoryCeilingMb(1)).toBe(s.MIN_MEMORY_CEILING_MB);
    expect(localStorage.getItem(s.MEMORY_CEILING_KEY)).toBe("64");
    expect(s.getMemoryCeilingMb()).toBe(s.MIN_MEMORY_CEILING_MB);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe(s.MIN_MEMORY_CEILING_MB);
  });
});

describe("hook status cache and text", () => {
  it("sets, removes and broadcasts the cached installation state", () => {
    const listener = vi.fn();
    window.addEventListener(s.HOOKS_CHANGED_EVENT, listener);
    expect(s.hooksInstalled()).toBe(false);
    s.setHooksInstalled(true);
    expect(localStorage.getItem(s.HOOKS_INSTALLED_KEY)).toBe("1");
    expect(s.hooksInstalled()).toBe(true);
    s.setHooksInstalled(false);
    expect(localStorage.getItem(s.HOOKS_INSTALLED_KEY)).toBeNull();
    expect(s.hooksInstalled()).toBe(false);
    expect(listener.mock.calls.map(([e]) => (e as CustomEvent).detail)).toEqual([true, false]);
  });
  const status: s.HookStatus = { relayInstalled: true, hooksDir: "hooks", settingsPath: "settings", settingsInstalled: true, settingsError: null, lastEventAgeMs: null };
  it("prioritises loading, settings errors and missing relay", () => {
    expect(s.hookStatusLine(null)).toBe("Checking\u2026");
    expect(s.hookStatusLine({ ...status, settingsError: "Cannot read settings", relayInstalled: false })).toBe("Cannot read settings");
    expect(s.hookStatusLine({ ...status, relayInstalled: false })).toBe("Flightdeck's relay script is missing \u2014 restart Flightdeck, then install.");
  });
  it.each([true, false])("describes installation and hook age (installed=%s)", (settingsInstalled) => {
    const where = settingsInstalled ? "Installed in ~/.claude" : "On for every Claude pane Flightdeck starts";
    expect(s.hookStatusLine({ ...status, settingsInstalled }, 100000)).toBe(`${where} \u2014 waiting for the first hook to fire.`);
    expect(s.hookStatusLine({ ...status, settingsInstalled, lastEventAgeMs: 45000 }, 100000)).toBe(`${where} \u2014 last hook 45s ago.`);
    vi.spyOn(Date, "now").mockReturnValue(100000);
    expect(s.hookStatusLine({ ...status, settingsInstalled, lastEventAgeMs: 0 })).toBe(`${where} \u2014 last hook just now.`);
  });
});

describe("non-persistent operation", () => {
  it("still applies settings and broadcasts when storage writes fail", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    const dispatch = vi.spyOn(window, "dispatchEvent");
    expect(s.saveReadingSettings({ previewFontSize: 18 }).previewFontSize).toBe(18);
    expect(css.get("--prv-fs")).toBe("18px");
    expect(s.saveTerminalSettings({ fontSize: 16 }).fontSize).toBe(16);
    expect(() => s.saveAgentSettings(s.DEFAULT_AGENT_SETTINGS)).not.toThrow();
    expect(() => s.saveEditorSettings(s.DEFAULT_EDITOR_SETTINGS)).not.toThrow();
    expect(() => s.saveStartupBehavior("launcher")).not.toThrow();
    expect(() => s.saveShortcut("settings", "Alt+S")).not.toThrow();
    expect(() => s.resetShortcuts()).not.toThrow();
    s.saveMultiwindow(false);
    s.saveWindowDrag(false);
    expect(s.setMemoryCeilingMb(2048)).toBe(2048);
    s.setHooksInstalled(true);
    s.setHooksInstalled(false);
    expect(dispatch).toHaveBeenCalledTimes(6);
    expect(s.migrateQuietDefault()).toBe(false);
    expect(s.migrateTerminalDefault()).toBe(false);
    expect(localStorage.getItem(s.QUIET_DEFAULT_MIGRATION_KEY)).toBeNull();
    expect(localStorage.getItem(s.TERMINAL_DEFAULT_MIGRATION_KEY)).toBeNull();
  });
});

describe("corrupted stored values (found by the T4/T5 test packs)", () => {
  it("falls back to the default preview width for inherited object keys", () => {
    store(s.READING_SETTINGS_KEY, { previewWidth: "toString" });
    expect(s.getReadingSettings().previewWidth).toBe(s.DEFAULT_READING_SETTINGS.previewWidth);
  });
  it.each(["null", "42", '"abc"', "[1,2]", "true"])("ignores terminal settings that are not an object: %s", (stored) => {
    localStorage.setItem(terminalKey, stored);
    expect(s.getTerminalSettings()).toEqual(s.DEFAULT_TERMINAL_SETTINGS);
  });
  it.each(["null", "42", '"abc"', "[1,2]", "true"])("ignores shortcut overrides that are not an object: %s", (stored) => {
    localStorage.setItem("flightdeck-shortcuts", stored);
    expect(s.getShortcuts()).toEqual(s.DEFAULT_SHORTCUTS);
    s.saveShortcut(s.DEFAULT_SHORTCUTS[0].id, "Ctrl+Alt+Q");
    expect(s.getShortcuts()[0].combo).toBe("Ctrl+Alt+Q");
  });
  it("only accepts the two known startup behaviours", () => {
    for (const stored of ["garbage", "", "REOPEN", "null"]) {
      localStorage.setItem("flightdeck-startup", stored);
      expect(s.getStartupBehavior(), stored).toBe("reopen");
    }
    localStorage.setItem("flightdeck-startup", "launcher");
    expect(s.getStartupBehavior()).toBe("launcher");
  });
});
