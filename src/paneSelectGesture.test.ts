import { describe, expect, it, vi } from "vitest";
import { shouldBulkSelect } from "./paneSelectGesture";

describe("shouldBulkSelect", () => {
  it.each(["phead", "pband"])("selects with Shift on a .%s descendant", (className) => {
    const header = { className };
    const closest = vi.fn(() => header);

    expect(shouldBulkSelect(true, { closest })).toBe(true);
    expect(closest).toHaveBeenCalledWith(".phead, .pband");
  });

  it("lets Shift inside the terminal body pass through", () => {
    const closest = vi.fn(() => null);

    expect(shouldBulkSelect(true, { closest })).toBe(false);
    expect(closest).toHaveBeenCalledWith(".phead, .pband");
  });

  it("does not select without Shift on a .phead descendant", () => {
    const closest = vi.fn(() => ({ className: "phead" }));

    expect(shouldBulkSelect(false, { closest })).toBe(false);
    expect(closest).not.toHaveBeenCalled();
  });

  it("does not select with a null target", () => {
    expect(shouldBulkSelect(true, null)).toBe(false);
    expect(shouldBulkSelect(false, null)).toBe(false);
  });
});
