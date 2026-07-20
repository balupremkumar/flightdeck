import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { PaneView } from "./PaneView";
import { useApp, type Workspace } from "./store";
import { useUI } from "./ui";
import { IconWorkspace } from "./Icons";
import { defaultCycle } from "./vendors";
import { spawnPane } from "./worktrees";

// Arrange N panes into rows; each divider is draggable so any pane can be resized.
function rows(n: number): number[][] {
  switch (n) {
    case 0: return [];
    case 1: return [[0]];
    case 2: return [[0, 1]];
    case 3: return [[0, 1, 2]];
    case 4: return [[0, 1], [2, 3]];
    case 5: return [[0, 1, 2], [3, 4]];
    case 6: return [[0, 1, 2], [3, 4, 5]];
    default: {
      const cols = Math.ceil(Math.sqrt(n));
      const r: number[][] = [];
      for (let i = 0; i < n; i += cols) r.push(Array.from({ length: Math.min(cols, n - i) }, (_, k) => i + k));
      return r;
    }
  }
}

export function PaneGrid({ ws }: { ws: Workspace }) {
  const movePane = useApp((s) => s.movePane);
  // Focus mode: id of the solo'd pane, or null for the normal grid. Local to this
  // workspace's grid (not global state) — deliberately not persisted.
  const [maximized, setMaximized] = useState<number | null>(null);
  // Native HTML5 drag-reorder: index being dragged + index currently under the cursor.
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // UI-226: PaneView is memoised, so its callbacks must be referentially stable
  // or the memo is defeated. They take the pane/index as an argument and read
  // live drag state from a ref — a comparator that merely ignored callback
  // identity would leave stale closures and silently break drop targets.
  // The ref is written by the handlers themselves, not during render: a drag
  // whose start and drop land in the same tick (fast pointer, or a synthetic
  // event sequence) would otherwise read a value React hadn't committed yet.
  const dragFromRef = useRef<number | null>(null);

  const toggleMaximize = useCallback((paneId: number) => {
    setMaximized((m) => (m === paneId ? null : paneId));
  }, []);
  const onDragStart = useCallback((idx: number) => { dragFromRef.current = idx; setDragFrom(idx); }, []);
  const onDragEnter = useCallback((idx: number) => {
    if (dragFromRef.current !== null) setDragOverIdx(idx);
  }, []);
  const onDragEnd = useCallback(() => { dragFromRef.current = null; setDragFrom(null); setDragOverIdx(null); }, []);
  const onDropHere = useCallback((idx: number) => {
    const from = dragFromRef.current;
    if (from !== null && from !== idx) movePane(ws.id, from, idx);
    dragFromRef.current = null;
    setDragFrom(null);
    setDragOverIdx(null);
  }, [movePane, ws.id]);

  // Mirror focus mode into the UI store (UI-145) so notifications can stand down.
  useEffect(() => {
    useUI.getState().setMaximizedPaneId(maximized);
    return () => useUI.getState().setMaximizedPaneId(null);
  }, [maximized]);

  // If the maximized pane was closed out from under it, fall back to the grid.
  useEffect(() => {
    if (maximized != null && !ws.panes.some((p) => p.id === maximized)) setMaximized(null);
  }, [maximized, ws.panes]);

  if (ws.panes.length === 0) return (
    <div className="grid-empty">
      <IconWorkspace size={26} />
      <div className="grid-empty-title">No panes in this workspace</div>
      {/* UI-223: an empty state should name the way out of it. */}
      <div className="grid-empty-sub">
        Every pane here was closed. Add one to keep working in {ws.name} — or press <kbd>Ctrl</kbd>+<kbd>K</kbd> for the command palette.
      </div>
      <button
        className="grid-empty-add"
        onClick={() => void spawnPane(ws.id, defaultCycle()[0], ws.root)}
      >
        + Add a pane
      </button>
    </div>
  );
  const layout = rows(ws.panes.length);

  return (
    <PanelGroup direction="vertical" className={"pg" + (maximized != null ? " pg-maximized" : "")}>
      {layout.map((row, ri) => (
        <Fragment key={ri}>
          {ri > 0 && <PanelResizeHandle className="rz rz-v" />}
          <Panel minSize={10} className="pg-row">
            <PanelGroup direction="horizontal">
              {row.map((idx, ci) => {
                const pane = ws.panes[idx];
                return (
                  <Fragment key={pane.id}>
                    {ci > 0 && <PanelResizeHandle className="rz rz-h" />}
                    <Panel minSize={10} className="pg-cell">
                      <PaneView
                        wsId={ws.id}
                        pane={pane}
                        index={idx}
                        maximized={maximized === pane.id}
                        onToggleMaximize={toggleMaximize}
                        canReorder={ws.panes.length > 1}
                        dragging={dragFrom === idx}
                        dragOver={dragOverIdx === idx && dragFrom !== null && dragFrom !== idx}
                        onDragStart={onDragStart}
                        onDragEnter={onDragEnter}
                        onDragEnd={onDragEnd}
                        onDropHere={onDropHere}
                      />
                    </Panel>
                  </Fragment>
                );
              })}
            </PanelGroup>
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
