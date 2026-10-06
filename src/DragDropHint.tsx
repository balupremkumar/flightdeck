import { useEffect, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface DragHover { name: string; tint: string; from: string }

export function DragDropHint() {
  const [hover, setHover] = useState<DragHover | null>(null);
  useEffect(() => {
    let disposed = false;
    const removers: Array<() => void> = [];
    const keep = (remove: () => void) => { if (disposed) remove(); else removers.push(remove); };
    try {
      const win = getCurrentWindow();
      win.listen<DragHover>("drag://hover", ({ payload }) => { if (!disposed) setHover(payload); }).then(keep).catch(() => {});
      win.listen("drag://hover-end", () => { if (!disposed) setHover(null); }).then(keep).catch(() => {});
    } catch { /* browser preview */ }
    return () => { disposed = true; removers.splice(0).forEach((remove) => remove()); };
  }, []);
  if (!hover) return null;
  return <div className="drag-drop-hint" style={{ "--drag-tint": hover.tint || "var(--accent)" } as CSSProperties}>
    <span className="drag-drop-hint-pill" role="status">Drop to move {hover.name} here</span>
  </div>;
}
