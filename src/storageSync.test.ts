import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 4 S13: a `storage` event from another window re-dispatches the same-context
// events Settings fires locally, so settings apply live in every window.

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const events: { type: string; detail: unknown }[] = [];
class FakeCustomEvent { constructor(public type: string, init: { detail?: unknown } = {}) { this.detail = init.detail; } detail: unknown; }
vi.stubGlobal("CustomEvent", FakeCustomEvent);
const listeners = new Map<string, (e: unknown) => void>();
vi.stubGlobal("window", {
  localStorage,
  dispatchEvent: (e: FakeCustomEvent) => { events.push({ type: e.type, detail: e.detail }); return true; },
  addEventListener: (t: string, fn: (e: unknown) => void) => void listeners.set(t, fn),
});

const boot = vi.fn();
vi.mock("./themes", () => ({ bootAppearance: () => boot() }));

const { actionsFor, applyStorageChange, armStorageSync } = await import("./storageSync");

beforeEach(() => { store.clear(); events.length = 0; boot.mockReset(); });

describe("actionsFor", () => {
  it("maps each live-apply setting to its re-apply", () => {
    expect(actionsFor("flightdeck-terminal-settings")).toEqual(["terminal"]);
    expect(actionsFor("flightdeck-memory-ceiling")).toEqual(["memory"]);
    expect(actionsFor("flightdeck-hooks-installed")).toEqual(["hooks"]);
    expect(actionsFor("flightdeck-reading-settings")).toEqual(["reading"]);
    for (const k of ["flightdeck-theme-id", "flightdeck-theme-custom", "flightdeck-accent", "flightdeck-cb-safe", "flightdeck-reduced-motion", "flightdeck-appearance-mode"]) {
      expect(actionsFor(k)).toEqual(["appearance"]);
    }
  });

  it("ignores keys that are not live settings, and treats clear() as everything", () => {
    expect(actionsFor("flightdeck-session-snapshots")).toEqual([]);
    expect(actionsFor("flightdeck-cmdp-recent")).toEqual([]);
    expect(actionsFor(null)).toHaveLength(5);
  });
});

describe("applyStorageChange", () => {
  it("re-dispatches the terminal settings event with the stored value", () => {
    store.set("flightdeck-terminal-settings", JSON.stringify({ fontSize: 19 }));
    applyStorageChange("flightdeck-terminal-settings");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("flightdeck-terminal-settings-changed");
    expect((events[0].detail as { fontSize: number }).fontSize).toBe(19);
  });

  it("re-dispatches memory ceiling and hooks events", () => {
    store.set("flightdeck-memory-ceiling", "2048");
    store.set("flightdeck-hooks-installed", "1");
    applyStorageChange("flightdeck-memory-ceiling");
    applyStorageChange("flightdeck-hooks-installed");
    expect(events).toEqual([
      { type: "flightdeck-memory-ceiling-changed", detail: 2048 },
      { type: "flightdeck-hooks-changed", detail: true },
    ]);
  });

  it("re-applies the theme through bootAppearance, once per change", () => {
    applyStorageChange("flightdeck-theme-id");
    expect(boot).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("does nothing for an unrelated key", () => {
    applyStorageChange("flightdeck-explorer-width");
    expect(boot).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("armStorageSync", () => {
  it("registers one storage listener that applies the changed key and ignores sessionStorage", () => {
    armStorageSync();
    const fn = listeners.get("storage")!;
    expect(fn).toBeTypeOf("function");
    fn({ key: "flightdeck-theme-id", storageArea: {} });
    expect(boot).not.toHaveBeenCalled();
    fn({ key: "flightdeck-theme-id", storageArea: localStorage });
    expect(boot).toHaveBeenCalledTimes(1);
  });
});
