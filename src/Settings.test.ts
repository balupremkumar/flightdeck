import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { resolveEditorCommand, shouldShowWhatsNew, EDITOR_PRESETS, cpuLevelClass, memoryLevelClass } =
  await import("./Settings");

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
