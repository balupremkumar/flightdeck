const hintedPanes = new Set<number>();

export function takeSelectHint(paneId: number, ctx: {
  button: number;
  shift: boolean;
  mouseTracking: boolean;
  agentVendor: boolean;
}): boolean {
  if (ctx.button !== 0 || ctx.shift || !ctx.mouseTracking || !ctx.agentVendor || hintedPanes.has(paneId)) {
    return false;
  }
  hintedPanes.add(paneId);
  return true;
}

export function resetSelectHints(): void {
  hintedPanes.clear();
}
