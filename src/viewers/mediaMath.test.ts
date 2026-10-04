import { describe, it, expect } from "vitest";
import { clampZoom, stepZoom, fitScale, zoomLabel, formatBytes, MAX_ZOOM, MIN_ZOOM } from "./mediaMath";

describe("mediaMath", () => {
  it("clamps zoom", () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
  });
  it("steps in and out and stays bounded", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1.25);
    expect(stepZoom(1, -1)).toBeCloseTo(0.8);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
  it("fits without upscaling", () => {
    expect(fitScale(2000, 1000, 1000, 1000)).toBeCloseTo(0.5);
    expect(fitScale(100, 100, 1000, 1000)).toBe(1);
    expect(fitScale(0, 0, 10, 10)).toBe(1);
  });
  it("labels zoom", () => expect(zoomLabel(1.25)).toBe("125%"));
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("");
  });
});
