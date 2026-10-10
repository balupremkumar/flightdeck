import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useVendors, armVendorHotReload, vendorList, agentVendors, vendorMeta,
  vendorLabel, vendorShort, accentCss, vendorAccentOverrides,
  setVendorAccentOverride, vendorColor, defaultCycle, type VendorInfo,
} from "./vendors";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const vendor = (id: string, extra: Partial<VendorInfo> = {}): VendorInfo => ({
  id, label: `Agent ${id}`, short: id.toUpperCase(), kind: "agent", accent: "--aqua",
  installed: false, detail: "", authState: "unknown", authDetail: "", quietSeconds: 3,
  installHint: "", installUrl: "", needsTrust: false, ...extra,
});

beforeEach(() => {
  useVendors.setState(useVendors.getInitialState(), true);
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset().mockResolvedValue(() => {});
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("vendor registry", () => {
  it("starts with fallback metadata and excludes shells from agents", () => {
    expect(useVendors.getState().loaded).toBe(false);
    expect(vendorList().map((v) => v.id)).toEqual(["claude", "agy", "codex", "pwsh"]);
    expect(agentVendors().map((v) => v.id)).toEqual(["claude", "agy", "codex"]);
    expect(vendorLabel("claude")).toBe("Claude Code");
    expect(vendorShort("codex")).toBe("Codex");
    expect(vendorMeta("codex")).toMatchObject({ quietSeconds: 6, needsTrust: true, accent: "--agent-codex" });
  });
  it("uses current store metadata and returns a complete unknown placeholder", () => {
    const custom = vendor("custom");
    useVendors.setState({ vendors: [custom] });
    expect(vendorList()).toEqual([custom]);
    expect(vendorMeta("custom")).toBe(custom);
    expect(vendorLabel("custom")).toBe("Agent custom");
    expect(vendorShort("custom")).toBe("CUSTOM");
    expect(vendorMeta("missing")).toEqual(vendor("missing", { label: "missing", short: "missing", accent: "--muted" }));
    expect(vendorLabel("missing")).toBe("missing");
    expect(vendorShort("missing")).toBe("missing");
  });
  it("loads detected vendors once and allows an explicit refresh", async () => {
    const first = [vendor("first", { installed: true })];
    vi.mocked(invoke).mockResolvedValueOnce(first).mockResolvedValueOnce([vendor("second")]);
    await useVendors.getState().load();
    expect(invoke).toHaveBeenCalledWith("detect_vendors");
    expect(vendorList()).toEqual(first);
    expect(useVendors.getState().loaded).toBe(true);
    await useVendors.getState().load();
    expect(invoke).toHaveBeenCalledTimes(1);
    await useVendors.getState().refresh();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(vendorList().map((v) => v.id)).toEqual(["second"]);
  });
  it.each([[], null])("keeps the fallback on an unusable detection result (%s)", async (result) => {
    const fallback = vendorList();
    vi.mocked(invoke).mockResolvedValue(result);
    await useVendors.getState().load();
    expect(vendorList()).toBe(fallback);
    expect(useVendors.getState().loaded).toBe(false);
  });
  it("keeps metadata when detection rejects", async () => {
    const fallback = vendorList();
    vi.mocked(invoke).mockRejectedValue(new Error("host unavailable"));
    await useVendors.getState().refresh();
    expect(vendorList()).toBe(fallback);
    expect(useVendors.getState().loaded).toBe(false);
  });
  it("arms one hot reload listener", () => {
    armVendorHotReload();
    armVendorHotReload();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith("vendors://changed", expect.any(Function));
  });
});

describe("vendor accents", () => {
  it("wraps theme tokens and preserves literal colours", () => {
    expect(accentCss("--aqua")).toBe("var(--aqua)");
    expect(accentCss("#3FD79B")).toBe("#3FD79B");
    expect(vendorColor("claude")).toBe("var(--agent-claude)");
    expect(vendorColor("missing")).toBe("var(--muted)");
    useVendors.setState({ vendors: [vendor("custom", { accent: "#3FD79B" })] });
    expect(vendorColor("custom")).toBe("#3FD79B");
  });
  it("reads persisted overrides and tolerates malformed JSON", () => {
    expect(vendorAccentOverrides()).toEqual({});
    localStorage.setItem("flightdeck-vendor-accents", '{"claude":"#123456"}');
    expect(vendorAccentOverrides()).toEqual({ claude: "#123456" });
    localStorage.setItem("flightdeck-vendor-accents", "{");
    expect(vendorAccentOverrides()).toEqual({});
  });
  it("persists, applies and removes overrides while notifying subscribers", () => {
    const before = vendorList();
    const subscriber = vi.fn();
    const unsubscribe = useVendors.subscribe(subscriber);
    try {
      setVendorAccentOverride("claude", "#123456");
      setVendorAccentOverride("codex", "#654321");
      expect(vendorAccentOverrides()).toEqual({ claude: "#123456", codex: "#654321" });
      expect(vendorColor("claude")).toBe("#123456");
      expect(vendorList()).not.toBe(before);
      expect(vendorList()).toEqual(before);
      expect(subscriber).toHaveBeenCalledTimes(2);
      setVendorAccentOverride("claude", null);
      expect(vendorAccentOverrides()).toEqual({ codex: "#654321" });
      expect(vendorColor("claude")).toBe("var(--agent-claude)");
    } finally { unsubscribe(); }
  });
});

describe("defaultCycle", () => {
  it("prefers installed agents in registry order and excludes installed shells", () => {
    useVendors.setState({ vendors: [vendor("absent"), vendor("b", { installed: true }), vendor("shell", { kind: "shell", installed: true }), vendor("a", { installed: true })] });
    expect(defaultCycle()).toEqual(["b", "a"]);
  });
  it("falls back to all known agents, then pwsh when no agents exist", () => {
    expect(defaultCycle()).toEqual(["claude", "agy", "codex"]);
    useVendors.setState({ vendors: [vendor("shell", { kind: "shell" })] });
    expect(defaultCycle()).toEqual(["pwsh"]);
    useVendors.setState({ vendors: [] });
    expect(defaultCycle()).toEqual(["pwsh"]);
  });
});
