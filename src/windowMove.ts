import { invoke } from "@tauri-apps/api/core";
import { useApp } from "./store";
import { useUI } from "./ui";
import { get as getSession, releaseWorkspace, type TerminalSnapshot } from "./paneSessions";
import { toDraft } from "./session";
import { logEvent } from "./applog";
import type { PaneTransfer } from "./transferSnap";

// Phase 4 "Move workspace to new window", source side (docs/plans/phase4-multiwindow.md
// section 2, addendum item 3). The order is the whole point:
//
//   1. pane_pause every pane: Rust keeps buffering output but stops emitting it,
//      and answers the ring offset it stopped at.
//   2. snapshot every pane: catch up to that offset, drain xterm, serialise.
//   3. ws_transfer: Rust assigns the workspace to a new window, parks the snapshot,
//      creates the window. Nothing has left this window yet, so a failure here is
//      undone by pane_resume.
//   4. releaseWorkspace: release every session (no pty_kill), THEN detach the
//      workspace from the store, so the orphan sweep finds nothing to dispose.
//
// The target paints the serialised screen and attaches for the bytes after the
// paused offset. A pane that could not be serialised falls back to the full ring
// replay, the same path a crashed window takes.

export type MoveResult = { ok: true; label: string } | { ok: false; reason: string };

const refuse = (reason: string, toast = true): MoveResult => {
  if (toast) useUI.getState().pushToast("info", reason);
  return { ok: false, reason };
};

async function resumeAll(modelIds: number[]): Promise<void> {
  for (const modelId of modelIds) {
    try {
      await invoke("pane_resume", { modelId });
    } catch (e) {
      logEvent("warn", "windowMove", `pane_resume ${modelId} failed after an aborted move: ${String(e)}`);
    }
  }
}

export type MoveTarget = { kind: "new" } | { kind: "label"; label: string };

export const moveWorkspaceToNewWindow = (wsId: number): Promise<MoveResult> => moveWorkspace(wsId, { kind: "new" });

/** "Move workspace to window...": the same pause, serialise, release order; the target
 *  takes it over `win://adopt` instead of booting with it. */
export const moveWorkspaceToWindow = (wsId: number, label: string): Promise<MoveResult> => moveWorkspace(wsId, { kind: "label", label });

async function moveWorkspace(wsId: number, target: MoveTarget): Promise<MoveResult> {
  const ws = useApp.getState().workspaces.find((w) => w.id === wsId);
  if (!ws) return refuse("That workspace is gone.", false);

  // A pane whose pty_spawn is still in flight has no pty id yet. Releasing it now
  // would hit the entry.disposed guard in Terminal.tsx and kill the just-spawned
  // agent, so wait for it to finish starting instead.
  for (const p of ws.panes) {
    const s = getSession(p.id);
    if (!s || s.disposed || !s.ptyId) {
      return refuse(`${p.title || p.vendor} is still starting. Move the workspace once it is running.`);
    }
  }

  const paused: number[] = [];
  const seqs = new Map<number, number>();
  try {
    for (const p of ws.panes) {
      seqs.set(p.id, await invoke<number>("pane_pause", { modelId: p.id }));
      paused.push(p.id);
    }
  } catch (e) {
    await resumeAll(paused);
    logEvent("warn", "windowMove", `pane_pause failed: ${String(e)}`);
    return refuse("Couldn't move the workspace: one of its panes isn't running.");
  }

  const panes: Record<number, PaneTransfer> = {};
  for (const p of ws.panes) {
    const s = getSession(p.id);
    const seq = seqs.get(p.id) ?? 0;
    let snap: TerminalSnapshot | null = null;
    try {
      snap = s?.api.snapshot ? await s.api.snapshot(seq) : null;
    } catch (e) {
      logEvent("warn", "windowMove", `snapshot of pane ${p.id} failed, the ring will replay instead: ${String(e)}`);
    }
    panes[p.id] = { serialized: snap?.serialized ?? null, seq, cols: snap?.cols ?? s?.term.cols ?? 0, rows: snap?.rows ?? s?.term.rows ?? 0 };
  }

  // Edits during the drain (a rename, a restart) belong in what moves.
  const live = useApp.getState().workspaces.find((w) => w.id === wsId);
  if (!live) {
    await resumeAll(paused);
    return refuse("That workspace was closed while it was being moved.");
  }
  // The drain awaited: a pane may have been added, removed, or caught mid-spawn. Releasing
  // a pane that is not in the snapshot, or one still spawning, kills it (entry.disposed).
  const snapped = new Set(ws.panes.map((p) => p.id));
  const stable = live.panes.length === snapped.size && live.panes.every((p) => {
    const s = getSession(p.id);
    return snapped.has(p.id) && !!s && !s.disposed && !!s.ptyId;
  });
  if (!stable) {
    await resumeAll(paused);
    return refuse("The workspace changed while it was being moved. Try again once its panes are running.");
  }

  let label: string;
  try {
    label = await invoke<string>("ws_transfer", {
      wsSnapshot: { workspaceId: wsId, transfer: { workspace: live, panes }, slice: toDraft([live], wsId) },
      target,
    });
  } catch (e) {
    await resumeAll(paused);
    logEvent("error", "windowMove", `ws_transfer failed: ${String(e)}`);
    return refuse(target.kind === "new" ? "Couldn't open a new window. The workspace stays here." : "Couldn't move the workspace to that window. It stays here.");
  }

  // The source stayed interactive during that await: release only what was snapshotted.
  releaseWorkspace(wsId, snapped);
  return { ok: true, label };
}
