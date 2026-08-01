// prompthistory.ts — shared, persisted prompt data for Broadcast.tsx (and,
// via HANDOFF, the command palette): saved snippets with {{placeholder}}
// support (UX-552) and per-vendor sent-prompt history (UX-551). Pure
// functions throughout (no React/DOM) so every rule here is directly
// testable — load/save are the only bits that touch localStorage, guarded
// the same way every other persisted slice in this app is (ui.ts, Settings).

export interface Snippet {
  id: string;
  text: string;
}

const SNIPPETS_KEY = "flightdeck-broadcast-snippets";

export function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* non-persistent */ }
  return [];
}

export function saveSnippets(list: Snippet[]) {
  try { localStorage.setItem(SNIPPETS_KEY, JSON.stringify(list)); } catch { /* non-persistent */ }
}

/** Adds `text` as a new snippet unless an identical one is already saved.
 *  Returns the new list — `changed` tells the caller whether anything
 *  actually happened (so a "Save current message" button can toast
 *  "Already saved" instead of a false-positive success). */
export function addSnippet(list: Snippet[], text: string, makeId: () => string = () => `snip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`): { list: Snippet[]; changed: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return { list, changed: false };
  if (list.some((s) => s.text === trimmed)) return { list, changed: false };
  return { list: [{ id: makeId(), text: trimmed }, ...list], changed: true };
}

export function removeSnippet(list: Snippet[], id: string): Snippet[] {
  return list.filter((s) => s.id !== id);
}

// ---------------------------------------------------------------------
// Placeholders (UX-552): a snippet can carry `{{name}}` tokens. Insertion
// asks for each distinct token once (first-seen order) and substitutes.
// ---------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Distinct placeholder names in `text`, first-seen order, deduplicated. */
export function extractPlaceholders(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/** Substitutes every `{{name}}` with `values[name]`. A token with no
 *  supplied value (or an empty one) is left as-is, so a half-filled snippet
 *  never silently loses the placeholder text. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const v = values[name];
    return v && v.trim() ? v : whole;
  });
}

// ---------------------------------------------------------------------
// Per-vendor prompt history (UX-551): what was actually sent, newest first,
// deduplicated, capped, persisted, keyed by vendor id so claude/agy/pwsh
// recall separately — an agy-flavoured prompt has no business surfacing
// when you're about to type at a shell pane.
// ---------------------------------------------------------------------

export type PromptHistoryMap = Record<string, string[]>;

const HISTORY_KEY = "flightdeck-prompt-history";
export const HISTORY_CAP = 30;

export function loadPromptHistory(): PromptHistoryMap {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* non-persistent */ }
  return {};
}

export function savePromptHistory(map: PromptHistoryMap) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(map)); } catch { /* non-persistent */ }
}

/** Records `text` as sent to `vendor` — newest first, de-duplicated (a
 *  repeat send moves back to the front rather than appearing twice), capped
 *  at HISTORY_CAP. Returns a new map (immutable, safe to feed straight into
 *  a zustand-style setter). Blank text is a no-op. */
export function recordPrompt(map: PromptHistoryMap, vendor: string, text: string): PromptHistoryMap {
  const trimmed = text.trim();
  if (!trimmed || !vendor) return map;
  const existing = map[vendor] ?? [];
  const next = [trimmed, ...existing.filter((t) => t !== trimmed)].slice(0, HISTORY_CAP);
  return { ...map, [vendor]: next };
}

/** The recall list for one vendor, newest first. Empty (never null) when
 *  there's no vendor or no history, so callers never need a null-guard. */
export function historyFor(map: PromptHistoryMap, vendor: string | null | undefined): string[] {
  if (!vendor) return [];
  return map[vendor] ?? [];
}
