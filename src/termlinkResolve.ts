// termlinkResolve.ts — Phase 1 L3: resolves link candidates against the file
// system. This is a TEMPORARY SHIM for the L2 contract (src/pathcheck.ts,
// `resolveExisting(raws, bases)`).
//
// SWAP WHEN L2 MERGES: replace this ENTIRE file's contents with the single line
//     export { resolveExisting as resolveCandidates, type PathHit } from "./pathcheck";
// Nothing else in the app imports pathcheck.ts for terminal links, so that is
// the only edit. (Terminal.tsx and termlinks.ts import `resolveCandidates` and
// `PathHit` from here.)
import { invoke } from "@tauri-apps/api/core";
import { normalizeSegments } from "./linkify";

export interface PathHit { input: string; path: string; isDir: boolean }
type ResolveFn = (raws: string[], bases: string[]) => Promise<(PathHit | null)[]>;

// import.meta.glob (not a bare dynamic import) so the build does not fail while
// pathcheck.ts does not exist yet: an absent file simply yields an empty map.
const real = import.meta.glob<{ resolveExisting: ResolveFn }>("./pathcheck.ts");

const isAbs = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
const isUnc = (p: string) => p.startsWith("\\\\") || p.startsWith("//");

function join(base: string, raw: string): string {
  const win = /^[A-Za-z]:/.test(base) || base.includes("\\");
  const merged = normalizeSegments([...base.split(/[\\/]+/).filter(Boolean), ...raw.split(/[\\/]+/)]);
  return win ? merged.join("\\") : "/" + merged.join("/");
}

const TTL_MS = 2000;
const dirCache = new Map<string, { at: number; p: Promise<Map<string, boolean>> }>();
function listDir(dir: string): Promise<Map<string, boolean>> {
  const now = Date.now();
  const hit = dirCache.get(dir);
  if (hit && now - hit.at < TTL_MS) return hit.p;
  const p = invoke<{ name: string; dir: boolean }[]>("fs_list_dir", { path: /^[A-Za-z]:$/.test(dir) ? dir + "\\" : dir })
    .then((es) => new Map(es.map((e) => [e.name.toLowerCase(), e.dir] as const)))
    .catch(() => new Map<string, boolean>());
  dirCache.set(dir, { at: now, p });
  return p;
}

async function existsFallback(abs: string): Promise<boolean | null> {
  if (isUnc(abs)) return null;
  const i = Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/"));
  if (i <= 0) return null;
  const names = await listDir(abs.slice(0, i));
  const isDir = names.get(abs.slice(i + 1).toLowerCase());
  return isDir === undefined ? null : isDir;
}

async function fallback(raws: string[], bases: string[]): Promise<(PathHit | null)[]> {
  return Promise.all(raws.map(async (raw) => {
    if (!raw || isUnc(raw)) return null;
    const tries = isAbs(raw) ? [raw] : bases.filter((b) => b && !isUnc(b)).map((b) => join(b, raw));
    for (const abs of tries) {
      const isDir = await existsFallback(abs);
      if (isDir !== null) return { input: raw, path: abs, isDir };
    }
    return null;
  }));
}

/** For each raw path: absolute as-is, else against each base in order; the
 *  first that exists, or null. Same contract as pathcheck.resolveExisting. */
export async function resolveCandidates(raws: string[], bases: string[]): Promise<(PathHit | null)[]> {
  if (!raws.length) return [];
  const load = real["./pathcheck.ts"];
  if (load) {
    try { return await (await load()).resolveExisting(raws, bases); } catch { /* fall through */ }
  }
  return fallback(raws, bases);
}
