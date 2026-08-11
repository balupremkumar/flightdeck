import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

// The suite runs in node: no localStorage and no window. Same minimal stubs
// CommandPalette.test.ts uses, plus a dispatchEvent recorder so the live-apply
// broadcast can be asserted (QL-742).
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
const dispatched: Array<{ type: string; detail: unknown }> = [];
vi.stubGlobal("window", {
  dispatchEvent: (e: CustomEvent) => { dispatched.push({ type: e.type, detail: e.detail }); return true; },
});

const {
  resolveEditorCommand, shouldShowWhatsNew, EDITOR_PRESETS, cpuLevelClass, memoryLevelClass,
  clampMemoryCeiling, getMemoryCeilingMb, setMemoryCeilingMb,
  DEFAULT_MEMORY_CEILING_MB, MIN_MEMORY_CEILING_MB, MAX_MEMORY_CEILING_MB, MEMORY_CEILING_EVENT,
  hookStatusLine, hooksInstalled, setHooksInstalled, HOOKS_CHANGED_EVENT,
} = await import("./Settings");
import type { HookStatus } from "./Settings";

describe("resolveEditorCommand (UX-517)", () => {
  it("fills {file} and {line}", () => {
    expect(resolveEditorCommand('code --goto "{file}:{line}"', "src\\App.tsx", 42)).toBe(
      'code --goto "src\\App.tsx:42"'
    );
  });

  it("defaults the line to 1 when none is given", () => {
    expect(resolveEditorCommand("subl {file}:{line}", "a.ts")).toBe("subl a.ts:1");
  });

  it("fills every occurrence of the placeholder, not just the first", () => {
    expect(resolveEditorCommand("{file} {file}", "x.ts", 3)).toBe("x.ts x.ts");
  });

  it("resolves every shipped preset without leaving a placeholder behind", () => {
    for (const { command } of Object.values(EDITOR_PRESETS)) {
      const resolved = resolveEditorCommand(command, "a.ts", 7);
      expect(resolved).not.toContain("{file}");
      expect(resolved).not.toContain("{line}");
    }
  });
});

describe("shouldShowWhatsNew (UX-600)", () => {
  it("shows nothing once the version has been acknowledged", () => {
    expect(shouldShowWhatsNew("0.4.0", "0.4.0", { version: "0.4.0", notes: "x" })).toBe(false);
  });

  it("shows when the version is new and pending notes match it", () => {
    expect(shouldShowWhatsNew("0.4.0", "0.3.0", { version: "0.4.0", notes: "New stuff." })).toBe(true);
  });

  it("stays quiet when there's no pending manifest at all (e.g. a manual install)", () => {
    expect(shouldShowWhatsNew("0.4.0", "0.3.0", null)).toBe(false);
  });

  it("stays quiet when the pending notes are for a DIFFERENT version", () => {
    expect(shouldShowWhatsNew("0.4.0", "0.3.0", { version: "0.5.0", notes: "future" })).toBe(false);
  });

  it("stays quiet when the manifest notes were empty", () => {
    expect(shouldShowWhatsNew("0.4.0", "0.3.0", { version: "0.4.0", notes: "   " })).toBe(false);
  });

  it("stays quiet on a first-ever run with no seen version but no pending manifest either", () => {
    expect(shouldShowWhatsNew("0.4.0", null, null)).toBe(false);
  });
});

// UI-633: threshold colours in Settings > Diagnostics. A flat table is the
// normal case; only a reading that needs a look is allowed to draw the eye.
describe("pane-health threshold colours (UI-633)", () => {
  it("leaves an ordinary CPU reading uncoloured", () => {
    expect(cpuLevelClass(0)).toBe("");
    expect(cpuLevelClass(42.5)).toBe("");
  });

  it("warns at a saturated core and escalates at two", () => {
    expect(cpuLevelClass(90)).toBe("diag-warn");
    expect(cpuLevelClass(150)).toBe("diag-warn");
    expect(cpuLevelClass(200)).toBe("diag-crit");
    expect(cpuLevelClass(640)).toBe("diag-crit");
  });

  it("takes the memory verdict from the backend's own compare", () => {
    expect(memoryLevelClass({ memoryMb: 300, memoryWarnMb: 1024, overMemoryWarn: false })).toBe("");
    expect(memoryLevelClass({ memoryMb: 1100, memoryWarnMb: 1024, overMemoryWarn: true })).toBe("diag-warn");
  });

  it("escalates to critical at double the SAME threshold, never a second invented one", () => {
    expect(memoryLevelClass({ memoryMb: 2048, memoryWarnMb: 1024, overMemoryWarn: true })).toBe("diag-crit");
    // A configured-down ceiling moves both levels together.
    expect(memoryLevelClass({ memoryMb: 300, memoryWarnMb: 128, overMemoryWarn: true })).toBe("diag-crit");
  });

  it("falls back to the echoed threshold if an older backend sent no boolean", () => {
    expect(memoryLevelClass({ memoryMb: 1100, memoryWarnMb: 1024 })).toBe("diag-warn");
  });

  it("stays flat when the backend sent no threshold at all", () => {
    expect(memoryLevelClass({ memoryMb: 99_999 })).toBe("");
  });
});

// UX-596/QL-742: the ceiling was a backend argument nobody ever passed. These
// pin the two things that made it inert — a value that survives, and a clamp
// that agrees with health.rs so Settings can't show a number the backend
// would silently replace.
describe("memory ceiling setting (UX-596 / QL-742)", () => {
  beforeEach(() => { store.clear(); dispatched.length = 0; });

  it("defaults to the same 1024 MB the backend falls back to", () => {
    expect(getMemoryCeilingMb()).toBe(DEFAULT_MEMORY_CEILING_MB);
    expect(DEFAULT_MEMORY_CEILING_MB).toBe(1024);
  });

  it("round-trips a configured ceiling", () => {
    expect(setMemoryCeilingMb(2048)).toBe(2048);
    expect(getMemoryCeilingMb()).toBe(2048);
  });

  it("clamps to health.rs's own bounds rather than offering a value it would reject", () => {
    expect(clampMemoryCeiling(1)).toBe(MIN_MEMORY_CEILING_MB);
    expect(clampMemoryCeiling(1_000_000)).toBe(MAX_MEMORY_CEILING_MB);
    expect(clampMemoryCeiling(1024.6)).toBe(1025);
  });

  it("never resolves to 0 or NaN — a 0 ceiling would flag every pane forever", () => {
    expect(clampMemoryCeiling(NaN)).toBe(DEFAULT_MEMORY_CEILING_MB);
    expect(clampMemoryCeiling(0)).toBe(DEFAULT_MEMORY_CEILING_MB);
    expect(clampMemoryCeiling(-512)).toBe(DEFAULT_MEMORY_CEILING_MB);
    expect(clampMemoryCeiling(Infinity)).toBe(DEFAULT_MEMORY_CEILING_MB);
  });

  it("repairs a corrupt stored value instead of trusting it", () => {
    store.set("flightdeck-memory-ceiling", "not-a-number");
    expect(getMemoryCeilingMb()).toBe(DEFAULT_MEMORY_CEILING_MB);
    store.set("flightdeck-memory-ceiling", "9999999");
    expect(getMemoryCeilingMb()).toBe(MAX_MEMORY_CEILING_MB);
  });

  it("broadcasts the clamped value so the always-on poll re-samples at once", () => {
    setMemoryCeilingMb(4);
    expect(dispatched).toEqual([{ type: MEMORY_CEILING_EVENT, detail: MIN_MEMORY_CEILING_MB }]);
  });
});

describe("Claude Code hooks row (QL-720)", () => {
  const base: HookStatus = {
    relayInstalled: true,
    hooksDir: String.raw`C:\data\hooks`,
    settingsPath: String.raw`C:\Users\Me\.claude\settings.json`,
    settingsInstalled: false,
    settingsError: null,
    lastEventAgeMs: null,
  };

  beforeEach(() => { store.clear(); dispatched.length = 0; });

  it("says what is actually true, not what should be", () => {
    expect(hookStatusLine(null)).toBe("Checking…");
    expect(hookStatusLine(base)).toContain("Not installed");
    expect(hookStatusLine({ ...base, settingsInstalled: true })).toContain("waiting for the first hook");
    expect(hookStatusLine({ ...base, settingsInstalled: true, lastEventAgeMs: 120_000 }, 1_000_000)).toBe(
      "Installed — last hook 2m ago."
    );
  });

  // A settings.json we refuse to touch (BOM, bad JSON) must SAY so — the whole
  // point of refusing is that the user can go and fix it.
  it("surfaces the backend's refusal reason ahead of everything else", () => {
    const s = { ...base, settingsInstalled: true, settingsError: "settings.json starts with a byte-order mark." };
    expect(hookStatusLine(s)).toBe("settings.json starts with a byte-order mark.");
  });

  // "Installed" with no relay on disk is a real state (app data wiped) and it
  // must not read as working.
  it("calls out a missing relay before claiming anything about the settings file", () => {
    expect(hookStatusLine({ ...base, relayInstalled: false, settingsInstalled: true })).toContain("relay script is missing");
  });

  it("caches the installed flag and broadcasts every change", () => {
    expect(hooksInstalled()).toBe(false);
    setHooksInstalled(true);
    expect(hooksInstalled()).toBe(true);
    setHooksInstalled(false);
    expect(hooksInstalled()).toBe(false);
    expect(dispatched).toEqual([
      { type: HOOKS_CHANGED_EVENT, detail: true },
      { type: HOOKS_CHANGED_EVENT, detail: false },
    ]);
  });
});
