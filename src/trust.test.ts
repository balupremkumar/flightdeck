import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The suite runs in node, which has no localStorage. A minimal stub keeps this
// dependency-free (adding jsdom for one module would be a heavy trade).
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const { isRepoTrusted, trustRepo, untrustRepo, trustedRepos } = await import("./trust");

describe("repo trust (K0a)", () => {
  beforeEach(() => localStorage.clear());

  it("starts untrusted — the whole point is an explicit decision", () => {
    expect(isRepoTrusted("D:\\Dev\\ai")).toBe(false);
  });

  it("remembers a trusted repo", () => {
    trustRepo("D:\\Dev\\ai");
    expect(isRepoTrusted("D:\\Dev\\ai")).toBe(true);
  });

  it("matches case- and separator-insensitively, like Windows paths do", () => {
    trustRepo("D:\\Dev\\ai");
    expect(isRepoTrusted("d:/dev/AI")).toBe(true);
    expect(isRepoTrusted("D:\\Dev\\ai\\")).toBe(true);
  });

  it("does NOT trust a sibling or parent by accident", () => {
    trustRepo("D:\\Dev\\ai");
    expect(isRepoTrusted("D:\\Dev\\ai-other")).toBe(false);
    expect(isRepoTrusted("D:\\Dev")).toBe(false);
  });

  it("never double-records the same repo", () => {
    trustRepo("D:\\Dev\\ai");
    trustRepo("D:\\Dev\\ai");
    trustRepo("d:/dev/ai");
    expect(trustedRepos()).toHaveLength(1);
  });

  it("revokes cleanly and leaves others alone", () => {
    trustRepo("D:\\a");
    trustRepo("D:\\b");
    untrustRepo("d:/A");
    expect(isRepoTrusted("D:\\a")).toBe(false);
    expect(isRepoTrusted("D:\\b")).toBe(true);
  });

  it("treats corrupt storage as untrusted rather than throwing", () => {
    localStorage.setItem("flightdeck-trusted-repos", "{not json");
    expect(isRepoTrusted("D:\\anything")).toBe(false);
    expect(trustedRepos()).toEqual([]);
  });

  it("ignores non-string junk in the stored list", () => {
    localStorage.setItem("flightdeck-trusted-repos", JSON.stringify(["D:\\ok", 42, null]));
    expect(trustedRepos()).toEqual(["D:\\ok"]);
  });
});
