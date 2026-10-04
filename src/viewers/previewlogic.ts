// previewlogic.ts — small pure rules the preview drawer leans on (Phase 2 polish).

// ---- outside-read-scope boot race ----

/** The roots push to Rust is debounced 200 ms (readscope.ts), so a preview that
 *  opens at launch can be refused before the roots land. */
export const BOOT_WINDOW_MS = 3000;
export const SCOPE_RETRY_MS = 800;

/** How long to wait before retrying an outside-read-scope failure, or null for
 *  "show the panel now". Retries once, and only during the first seconds. */
export function scopeRetryDelay(msSinceStart: number, alreadyRetried: boolean): number | null {
  return !alreadyRetried && msSinceStart < BOOT_WINDOW_MS ? SCOPE_RETRY_MS : null;
}

// ---- follow file on disk (QL-704) ----

export interface FileStat { mtime_ms: number; size: number }
export const FOLLOW_POLL_MS = 2000;

/** First observation is a baseline, never a change. */
export function statChanged(prev: FileStat | null, next: FileStat): boolean {
  return prev !== null && (prev.mtime_ms !== next.mtime_ms || prev.size !== next.size);
}

export function shouldPoll(s: { follow: boolean; drawerOpen: boolean; windowVisible: boolean; loaded: boolean }): boolean {
  return s.follow && s.drawerOpen && s.windowVisible && s.loaded;
}

export function atBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 8): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/** Scroll target after content changed: the bottom if it was there, else unchanged. */
export function scrollAfterReload(wasBottom: boolean, prevTop: number, scrollHeight: number, clientHeight: number): number {
  return wasBottom ? Math.max(0, scrollHeight - clientHeight) : prevTop;
}
