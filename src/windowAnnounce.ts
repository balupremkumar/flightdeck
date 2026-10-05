import { useSyncExternalStore } from "react";

// One polite live-region message for this window (rendered by Cockpit as an
// always-present sr-only status). The region has to be in the DOM BEFORE its text
// changes or screen readers stay silent, so callers announce a beat after mount.

let text = "";
const listeners = new Set<() => void>();

export function announce(message: string): void {
  text = message;
  listeners.forEach((l) => l());
}

export function useAnnouncement(): string {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => text,
    () => text,
  );
}
