import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge before importing the module under test.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const { cachedInvoke, invalidateCwd } = await import("./poll");

describe("cachedInvoke", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invalidateCwd(""); // clears everything — every key contains ""
  });

  it("dedupes concurrent callers into one in-flight request", async () => {
    invokeMock.mockImplementation(() => new Promise((r) => setTimeout(() => r("ok"), 5)));
    // Six panes on one repo asking at once — the storm this exists to kill.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => cachedInvoke<string>("git_status", { cwd: "D:/repo" }))
    );
    expect(results).toEqual(Array(6).fill("ok"));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("serves from cache inside the TTL and refetches after it", async () => {
    invokeMock.mockResolvedValue("v1");
    await cachedInvoke("git_status", { cwd: "D:/r" }, 10_000);
    await cachedInvoke("git_status", { cwd: "D:/r" }, 10_000);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // TTL of 0 always misses.
    await cachedInvoke("git_status", { cwd: "D:/r" }, 0);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("keys separately per argument set", async () => {
    invokeMock.mockResolvedValue("x");
    await cachedInvoke("git_status", { cwd: "D:/a" });
    await cachedInvoke("git_status", { cwd: "D:/b" });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("git missing"));
    await expect(cachedInvoke("git_status", { cwd: "D:/f" })).rejects.toThrow("git missing");
    invokeMock.mockResolvedValueOnce("recovered");
    await expect(cachedInvoke("git_status", { cwd: "D:/f" })).resolves.toBe("recovered");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("invalidateCwd forces the next call to refetch", async () => {
    invokeMock.mockResolvedValue("a");
    await cachedInvoke("git_status", { cwd: "D:/merge-me" }, 10_000);
    invalidateCwd("D:/merge-me");
    await cachedInvoke("git_status", { cwd: "D:/merge-me" }, 10_000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
