// revealInTree.ts — "show this path in the Explorer PANEL" (not the OS file
// manager; that is reveal.ts). A request opens the panel and queues the path;
// the mounted Explorer subscribes, and one that mounts later (the panel was
// closed) picks the queued path up with takePendingReveal().
import { useUI } from "./ui";

let pending: string | null = null;
const subs = new Set<(path: string) => void>();

export function requestReveal(path: string): void {
  pending = path;
  useUI.getState().setExplorerOpen(true);
  for (const fn of [...subs]) fn(path);
}

export function takePendingReveal(): string | null {
  const p = pending;
  pending = null;
  return p;
}

export function subscribeReveal(fn: (path: string) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
