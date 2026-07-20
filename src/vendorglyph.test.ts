import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { vendorInitials } = await import("./VendorGlyph");

// The fallback registry (vendors.ts FALLBACK) is what's active without a
// backend, so these exercise the real derivation path.
describe("vendor glyph initials (UI-236)", () => {
  it("uses the first letters of a two-word name", () => {
    expect(vendorInitials("pwsh")).toBe("PW");
  });

  it("derives from the short name, not the raw id", () => {
    // "Claude Code" has short "Claude" in the registry -> CL, never "CC".
    expect(vendorInitials("claude")).toBe("CL");
  });

  it("falls back to the id for an unknown vendor", () => {
    expect(vendorInitials("opencode-local")).toMatch(/^[A-Z]{1,2}$/);
  });

  it("always returns something renderable", () => {
    for (const id of ["claude", "agy", "pwsh", "x", "", "a-b-c"]) {
      const s = vendorInitials(id);
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(2);
    }
  });
});
