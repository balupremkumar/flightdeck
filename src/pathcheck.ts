/**
 * Batched, short-TTL "does this path exist" lookup backed by the Rust
 * `paths_exist` command. Calls made in the same tick share one invoke.
 */
import { invoke } from "@tauri-apps/api/core";

export interface PathHit {
  input: string;
  path: string;
  isDir: boolean;
}

const TTL_MS = 2000;

const cache = new Map<string, { at: number; hit: PathHit | null }>();
let queue: { raw: string; bases: string[]; resolve: (h: PathHit | null) => void }[] = [];
let scheduled = false;

const inTauri = () => "__TAURI_INTERNALS__" in globalThis;
const key = (raw: string, bases: string[]) => JSON.stringify([raw, bases]);

async function flush() {
  scheduled = false;
  const batch = queue;
  queue = [];
  // Group by identical base lists so each invoke carries one bases array.
  const groups = new Map<string, typeof batch>();
  for (const q of batch) {
    const k = JSON.stringify(q.bases);
    const g = groups.get(k);
    if (g) g.push(q);
    else groups.set(k, [q]);
  }
  await Promise.all(
    [...groups.values()].map(async (g) => {
      const raws = [...new Set(g.map((q) => q.raw))];
      let hits: (PathHit | null)[] = [];
      try {
        hits = await invoke<(PathHit | null)[]>("paths_exist", { raws, bases: g[0].bases });
      } catch {
        hits = [];
      }
      const byRaw = new Map<string, PathHit | null>();
      raws.forEach((r, i) => byRaw.set(r, hits[i] ?? null));
      const now = Date.now();
      for (const q of g) {
        const hit = byRaw.get(q.raw) ?? null;
        cache.set(key(q.raw, q.bases), { at: now, hit });
        q.resolve(hit);
      }
    }),
  );
}

export function resolveExisting(raws: string[], bases: string[]): Promise<(PathHit | null)[]> {
  if (!inTauri()) return Promise.resolve(raws.map(() => null));
  const now = Date.now();
  return Promise.all(
    raws.map((raw) => {
      const k = key(raw, bases);
      const c = cache.get(k);
      if (c && now - c.at < TTL_MS) return Promise.resolve(c.hit);
      if (c) cache.delete(k);
      return new Promise<PathHit | null>((resolve) => {
        queue.push({ raw, bases, resolve });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
    }),
  );
}

/** Test hook. */
export function _resetPathcheckCache() {
  cache.clear();
}
