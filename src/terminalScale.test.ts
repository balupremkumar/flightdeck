import { describe, expect, it } from "vitest";
import { terminalFontPx } from "./terminalScale";

describe("terminal font compensation", () => {
  it.each([[1, 12.5], [1.2, 10.42], [1.5, 8.33]])(
    "compensates zoom %s to %s CSS px", (zoom, expected) => {
      expect(terminalFontPx(12.5, zoom)).toBe(expected);
      expect(terminalFontPx(12.5, zoom) * zoom).toBeCloseTo(12.5, 1);
    },
  );

  it.each([0, -1, NaN, Infinity, -Infinity])("ignores invalid zoom %s", (zoom) => {
    expect(terminalFontPx(12.5, zoom)).toBe(12.5);
  });

  it("preserves per-pane font choices", () => {
    expect(terminalFontPx(18, 1.2)).toBe(15);
  });
});
