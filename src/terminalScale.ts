/** Compensate native webview zoom while preserving the pane's own font size. */
export function terminalFontPx(paneFontPx: number, zoom: number): number {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.round((paneFontPx / scale) * 100) / 100;
}
