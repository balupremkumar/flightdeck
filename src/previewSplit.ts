// previewSplit.ts — pure logic for QL-708 (pin the Preview as a vertical split
// beside the pane grid). DOM-free so it is testable without a renderer.

export type PreviewMode = "drawer" | "split";

export const PREVIEW_MODE_KEY = "flightdeck-preview-mode";
export const PREVIEW_SPLIT_SIZE_KEY = "flightdeck-preview-split-size";

/** Preview takes at least this much of the width, grid at least GRID_MIN. */
export const PREVIEW_MIN_PCT = 20;
export const GRID_MIN_PCT = 30;
export const PREVIEW_DEFAULT_PCT = 38;
export const PREVIEW_MAX_PCT = 100 - GRID_MIN_PCT;

export function normalizeMode(v: unknown): PreviewMode {
  return v === "split" ? "split" : "drawer";
}

export function clampSplitSize(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return PREVIEW_DEFAULT_PCT;
  return Math.min(PREVIEW_MAX_PCT, Math.max(PREVIEW_MIN_PCT, n));
}

/** The split only exists while it is pinned AND something is open: closing the
 *  last tab collapses it (the pin itself is remembered for the next open). */
export function isSplitActive(mode: PreviewMode, tabCount: number): boolean {
  return mode === "split" && tabCount > 0;
}

export function loadMode(): PreviewMode {
  try { return normalizeMode(localStorage.getItem(PREVIEW_MODE_KEY)); } catch { return "drawer"; }
}
export function loadSplitSize(): number {
  try { return clampSplitSize(localStorage.getItem(PREVIEW_SPLIT_SIZE_KEY)); } catch { return PREVIEW_DEFAULT_PCT; }
}
