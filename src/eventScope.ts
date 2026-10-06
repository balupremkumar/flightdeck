import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Listen for an event Rust sends to THIS window with `emit_to(label, ...)`.
 *  The plain `listen()` from @tauri-apps/api/event targets Any, so it also receives
 *  events emitted to every other window: with two windows open, a `win://adopt` meant
 *  for the target was acked by the source too, and the moved workspace was lost
 *  (live Canary 2026-10-06). Outside Tauri (browser preview, single-window e2e mock
 *  with no window metadata) `getCurrentWindow()` throws, so fall back to `listen()`. */
export function listenHere<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  let win: ReturnType<typeof getCurrentWindow>;
  try {
    win = getCurrentWindow();
  } catch {
    return listen<T>(event, handler);
  }
  return win.listen<T>(event, handler);
}
