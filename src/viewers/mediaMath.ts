// Pure helpers for the image viewer (zoom math, size formatting).

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;
export const ZOOM_STEP = 1.25;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** One zoom step in (dir > 0) or out (dir < 0). */
export function stepZoom(z: number, dir: number): number {
  return clampZoom(dir > 0 ? z * ZOOM_STEP : z / ZOOM_STEP);
}

/** Scale that fits the whole image inside the box, never upscaling past 100%. */
export function fitScale(imgW: number, imgH: number, boxW: number, boxH: number): number {
  if (!(imgW > 0 && imgH > 0 && boxW > 0 && boxH > 0)) return 1;
  return clampZoom(Math.min(1, boxW / imgW, boxH / imgH));
}

export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)}%`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
