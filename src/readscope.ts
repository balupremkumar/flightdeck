import { invoke } from "@tauri-apps/api/core";
import { useApp, type Workspace } from "./store";

/** Rust returns this exact string when a content read is outside the allowed
 *  roots (src-tauri/src/readscope.rs). */
export const OUTSIDE_SCOPE = "outside-read-scope";

export function isOutsideScopeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.trim() === OUTSIDE_SCOPE;
}

/** Workspace roots plus pane cwds (a worktree pane's cwd IS its worktree),
 *  deduped case-insensitively with slash and trailing-separator differences
 *  ignored. First spelling wins. */
export function collectReadRoots(workspaces: Workspace[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (!p) return;
    const key = p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const w of workspaces) {
    add(w.root);
    for (const p of w.panes) { add(p.cwd); add(p.worktreePath); }
  }
  return out;
}

const DEBOUNCE_MS = 200;

/** Push the roots to Rust whenever the set changes. Call once at startup;
 *  returns an unsubscribe. The initial state is pushed too (after the debounce),
 *  so a hydrate that landed before this call is not missed. */
export function syncReadRoots(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastKey: string | undefined;
  const schedule = () => {
    const roots = collectReadRoots(useApp.getState().workspaces);
    const key = JSON.stringify(roots.map((r) => r.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()));
    if (key === lastKey) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      lastKey = key;
      invoke("set_read_roots", { roots }).catch(() => { lastKey = undefined; });
    }, DEBOUNCE_MS);
  };
  const unsub = useApp.subscribe(schedule);
  schedule();
  return () => { unsub(); if (timer) clearTimeout(timer); };
}
