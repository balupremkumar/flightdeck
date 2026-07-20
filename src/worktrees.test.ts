import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { __testing } = await import("./worktrees");

describe("worktree branch slugs (UI-162)", () => {
  const { newSlug } = __testing;

  it("names the branch after the task label", () => {
    expect(newSlug("Fix login badge")).toMatch(/^fix-login-badge-[a-z0-9]+$/);
  });

  it("strips punctuation and collapses separators", () => {
    expect(newSlug("Fix: the __login__ badge!!")).toMatch(/^fix-the-login-badge-[a-z0-9]+$/);
  });

  it("caps very long titles so paths stay short (MAX_PATH)", () => {
    const slug = newSlug("a".repeat(120));
    const stem = slug.slice(0, slug.lastIndexOf("-"));
    expect(stem.length).toBeLessThanOrEqual(32);
  });

  it("falls back to an opaque id when there's no usable label", () => {
    expect(newSlug()).toMatch(/^p[a-z0-9]+$/);
    expect(newSlug("!!!")).toMatch(/^p[a-z0-9]+$/);
  });

  it("never collides on rapid successive calls", () => {
    const slugs = new Set(Array.from({ length: 50 }, () => newSlug("same title")));
    expect(slugs.size).toBe(50);
  });

  it("only ever emits git-legal branch characters", () => {
    for (const label of ["Feature/Sub thing", "café ☕ work", "  spaced  "]) {
      expect(newSlug(label)).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
