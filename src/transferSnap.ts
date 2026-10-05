// Phase 4 hybrid workspace transfer, target side: what the source window's
// terminal looked like when its pane was paused, handed over through window_boot
// and consumed once by the new terminal (Terminal.tsx) before it attaches.
//
// File naming (CLAUDE.md): never differ only by case from a component file.

/** One pane as the source window left it. `seq` is the ring offset pane_pause
 *  returned: the serialised screen covers every byte up to it, so the target asks
 *  pty_attach for the bytes after it. `serialized` is null when the source could
 *  not serialise (addon missing, buffer too big): the target then replays the
 *  whole ring, which is the same path a crashed window takes. */
export interface PaneTransfer {
  serialized: string | null;
  seq: number;
  cols: number;
  rows: number;
}

const staged = new Map<number, PaneTransfer>();

export function stageTransfers(byPane: Record<number, PaneTransfer>): void {
  for (const [id, t] of Object.entries(byPane)) staged.set(Number(id), t);
}

/** Consumed once, at session creation: a later respawn must not replay it. */
export function takeTransfer(modelId: number): PaneTransfer | undefined {
  const t = staged.get(modelId);
  staged.delete(modelId);
  return t;
}

/** Test helper. */
export function _clearTransfersForTests(): void {
  staged.clear();
}
