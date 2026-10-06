/** Pure pointer drag core. Coordinates are local CSS pixels and never sent to Rust. */
export interface DragPayload {
  kind: "workspace"; id: number; tearable: boolean; name: string; tint: string; panes: number;
}
export interface RailDragState {
  payload: DragPayload | null;
  x: number; y: number; dragging: boolean; armed: boolean;
  over: number | null; suppressClick: boolean; refused: boolean;
}
export type RailDragAction =
  | { type: "arm"; payload: DragPayload }
  | { type: "disarm" | "cancel" | "refused" }
  | { type: "reorder"; id: number; over: number };
export type RailDragEvent =
  | { type: "press"; x: number; y: number; payload: DragPayload }
  | { type: "move"; x: number; y: number; inside: boolean; over: number | null; reorder: boolean }
  | { type: "release"; inside: boolean }
  | { type: "escape" | "end" | "click" }
  | { type: "state"; phase: "armed" | "torn" | "refused" };
export const idleRailDrag = (): RailDragState => ({ payload: null, x: 0, y: 0, dragging: false, armed: false, over: null, suppressClick: false, refused: false });
export const canTearOut = (_workspaceCount: number): boolean => true;
export const pointerDragEnabled = (multiwindow: boolean, windowDrag: boolean): boolean => multiwindow && windowDrag;

export function stepRailDrag(state: RailDragState, event: RailDragEvent): { state: RailDragState; actions: RailDragAction[] } {
  let next = { ...state };
  const actions: RailDragAction[] = [];
  if (event.type === "press") {
    next = { ...idleRailDrag(), payload: event.payload, x: event.x, y: event.y };
  } else if (event.type === "click") {
    next.suppressClick = false;
  } else if (event.type === "end" || event.type === "escape") {
    if (event.type === "escape" && state.dragging) actions.push({ type: "cancel" });
    next = { ...idleRailDrag(), suppressClick: state.suppressClick };
  } else if (event.type === "state" && state.payload) {
    if (event.phase === "refused" && !state.refused) {
      actions.push({ type: "refused" });
      next.refused = true;
    }
    if (event.phase === "torn" || event.phase === "refused") next.over = null;
  } else if (event.type === "move" && state.payload) {
    if (!state.dragging && Math.hypot(event.x - state.x, event.y - state.y) < 5) return { state, actions };
    next.dragging = true;
    next.suppressClick = true;
    next.over = event.inside && event.reorder ? event.over : null;
    if (!event.inside && !state.armed) {
      next.armed = true;
      actions.push({ type: "arm", payload: state.payload });
    }
  } else if (event.type === "release" && state.payload) {
    // Rust owns releases outside the source window.
    if (!event.inside && state.armed) return { state, actions };
    if (state.armed) actions.push({ type: "disarm" });
    else if (state.dragging && state.over != null && state.over !== state.payload.id) {
      actions.push({ type: "reorder", id: state.payload.id, over: state.over });
    }
    next = { ...idleRailDrag(), suppressClick: state.suppressClick };
  }
  return { state: next, actions };
}
