// windowing.ts — fixed-row-height windowing shared by the JSON tree and JSONL
// viewers, so a 10k-row file mounts ~40 DOM rows rather than 10k.

export const ROW_H = 24;

export interface WindowRange { start: number; end: number }

export function windowRange(scrollTop: number, viewport: number, total: number, rowH = ROW_H, overscan = 12): WindowRange {
  if (total <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowH);
  const last = Math.ceil((top + Math.max(viewport, rowH)) / rowH);
  return { start: Math.max(0, first - overscan), end: Math.min(total, last + overscan) };
}
