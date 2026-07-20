import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PREFERENCE_KEYS, SESSION_KEYS, SESSION_KEY_PREFIXES } from "./storageKeys";

// Scans the real source rather than trusting a hand-kept list. "Reset all
// settings" previously listed two keys that don't exist (flightdeck-ui-scale,
// flightdeck-colorblind) while missing the ones that do (flightdeck-uiscale,
// flightdeck-cb-safe), so those settings silently survived a reset. This test
// makes that class of drift fail loudly instead.
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "storageKeys.ts") out.push(p);
  }
  return out;
}

const files = sourceFiles(join(process.cwd(), "src"));
const source = files.map((f) => readFileSync(f, "utf8")).join("\n");

// Many keys live in module constants (`const RECENTS_KEY = "flightdeck-…"`)
// rather than inline in the localStorage call, so match complete quoted
// literals. Requiring a CLOSING quote is what excludes template fragments like
// `flightdeck-backup-${date}` (a filename) and `flightdeck-setup:${repo}`
// (a prefix family, checked separately below).
const LITERAL = /["'`](flightdeck-[a-z0-9-]+)["'`]/g;
const PREFIX = /`(flightdeck-[a-z0-9-]+:)\$\{/g;

const usedKeys = new Set([...source.matchAll(LITERAL)].map((m) => m[1]));
const usedPrefixes = new Set([...source.matchAll(PREFIX)].map((m) => m[1]));

describe("persisted storage keys", () => {
  it("finds keys to check (the scanner itself works)", () => {
    expect(usedKeys.size).toBeGreaterThan(10);
    expect(usedKeys.has("flightdeck-theme-id")).toBe(true);
  });

  it("classifies every key the source actually uses", () => {
    const known = new Set<string>([...PREFERENCE_KEYS, ...SESSION_KEYS]);
    const unclassified = [...usedKeys].filter((k) => !known.has(k));
    expect(unclassified, `Unclassified storage keys — add them to PREFERENCE_KEYS or SESSION_KEYS: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("lists no key the source never uses (catches typo'd names)", () => {
    const phantom = [...PREFERENCE_KEYS, ...SESSION_KEYS].filter((k) => !usedKeys.has(k));
    expect(phantom, `Keys listed but never used — likely a typo: ${phantom.join(", ")}`).toEqual([]);
  });

  it("classifies every prefixed key family", () => {
    const unclassified = [...usedPrefixes].filter(
      (p) => !SESSION_KEY_PREFIXES.some((known) => known === p)
    );
    expect(unclassified, `Unclassified key prefixes: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("keeps preferences and session state disjoint", () => {
    const overlap = PREFERENCE_KEYS.filter((k) => (SESSION_KEYS as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
  });

  it("never lets a reset touch working state", () => {
    // Recent folders / last-active times are what you were doing, not how you
    // like things — a colour reset must not wipe them.
    for (const k of SESSION_KEYS) {
      expect((PREFERENCE_KEYS as readonly string[]).includes(k)).toBe(false);
    }
  });
});
