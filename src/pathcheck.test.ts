import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { resolveExisting, _resetPathcheckCache } from "./pathcheck";

const g = globalThis as Record<string, unknown>;
const mocked = vi.mocked(invoke);

beforeEach(() => {
  g.__TAURI_INTERNALS__ = {};
  _resetPathcheckCache();
  mocked.mockReset();
  mocked.mockImplementation(async (_c: string, a?: unknown) => {
    const { raws } = a as { raws: string[] };
    return raws.map((r) => (r === "missing" ? null : { input: r, path: "C:\\" + r, isDir: false }));
  });
});
afterEach(() => {
  delete g.__TAURI_INTERNALS__;
  vi.useRealTimers();
});

describe("resolveExisting", () => {
  it("returns hits and nulls from invoke", async () => {
    const r = await resolveExisting(["a", "missing"], ["B"]);
    expect(r[0]).toEqual({ input: "a", path: "C:\\a", isDir: false });
    expect(r[1]).toBeNull();
    expect(mocked).toHaveBeenCalledWith("paths_exist", { raws: ["a", "missing"], bases: ["B"] });
  });

  it("serves repeats from cache", async () => {
    await resolveExisting(["a"], ["B"]);
    await resolveExisting(["a"], ["B"]);
    expect(mocked).toHaveBeenCalledTimes(1);
    await resolveExisting(["a"], ["other"]);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("batches same-tick calls into one invoke", async () => {
    const [x, y] = await Promise.all([resolveExisting(["a"], ["B"]), resolveExisting(["c", "a"], ["B"])]);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][1]).toEqual({ raws: ["a", "c"], bases: ["B"] });
    expect(x[0]?.input).toBe("a");
    expect(y.map((h) => h?.input)).toEqual(["c", "a"]);
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers();
    await resolveExisting(["a"], ["B"]);
    vi.advanceTimersByTime(1900);
    await resolveExisting(["a"], ["B"]);
    expect(mocked).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    await resolveExisting(["a"], ["B"]);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("returns nulls outside Tauri without invoking", async () => {
    delete g.__TAURI_INTERNALS__;
    expect(await resolveExisting(["a", "b"], ["B"])).toEqual([null, null]);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("resolves null when invoke rejects", async () => {
    mocked.mockRejectedValueOnce(new Error("boom"));
    expect(await resolveExisting(["a"], ["B"])).toEqual([null]);
  });
});
