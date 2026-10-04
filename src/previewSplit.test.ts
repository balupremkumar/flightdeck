import { describe, expect, it, beforeEach } from "vitest";
import {
  normalizeMode, clampSplitSize, isSplitActive, loadMode, loadSplitSize,
  PREVIEW_MODE_KEY, PREVIEW_SPLIT_SIZE_KEY, PREVIEW_DEFAULT_PCT, PREVIEW_MIN_PCT, PREVIEW_MAX_PCT,
} from "./previewSplit";

function stubStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe("preview split mode persistence", () => {
  beforeEach(() => stubStorage());
  it("defaults to drawer", () => expect(loadMode()).toBe("drawer"));
  it("restores split", () => { stubStorage({ [PREVIEW_MODE_KEY]: "split" }); expect(loadMode()).toBe("split"); });
  it("garbage falls back to drawer", () => {
    expect(normalizeMode("sideways")).toBe("drawer");
    expect(normalizeMode(null)).toBe("drawer");
  });
  it("size defaults to 38 and restores a saved value", () => {
    expect(loadSplitSize()).toBe(PREVIEW_DEFAULT_PCT);
    stubStorage({ [PREVIEW_SPLIT_SIZE_KEY]: "45" });
    expect(loadSplitSize()).toBe(45);
  });
});

describe("clampSplitSize", () => {
  it("keeps in-range values", () => expect(clampSplitSize(40)).toBe(40));
  it("enforces preview >= 20", () => expect(clampSplitSize(5)).toBe(PREVIEW_MIN_PCT));
  it("enforces grid >= 30 (preview <= 70)", () => expect(clampSplitSize(95)).toBe(PREVIEW_MAX_PCT));
  it("non-numbers use the default", () => {
    expect(clampSplitSize("abc")).toBe(PREVIEW_DEFAULT_PCT);
    expect(clampSplitSize(NaN)).toBe(PREVIEW_DEFAULT_PCT);
    expect(clampSplitSize(undefined)).toBe(PREVIEW_DEFAULT_PCT);
    expect(clampSplitSize("")).toBe(PREVIEW_DEFAULT_PCT);
  });
});

describe("isSplitActive", () => {
  it("needs split mode and at least one tab", () => {
    expect(isSplitActive("split", 1)).toBe(true);
    expect(isSplitActive("split", 0)).toBe(false);
    expect(isSplitActive("drawer", 3)).toBe(false);
  });
});
