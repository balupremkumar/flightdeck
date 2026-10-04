// H3: Settings search. Pure logic, no React.
//
// The index is read from what Settings actually rendered (every `.set-row-name`
// with its `.set-row-sub`, plus the shortcut rows), grouped by the section's
// `.set-label`. Settings is hand-written JSX, so a parallel declarative table
// would drift the first time someone added a row; scanning the output cannot.

export interface SettingEntry {
  label: string;
  description: string;
  section: string;
  /** The rendered row, so a result can scroll to it. Absent in tests. */
  el?: HTMLElement;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Every searchable setting under `root` (the Settings body). */
export function collectSettingEntries(root: ParentNode): SettingEntry[] {
  const out: SettingEntry[] = [];
  for (const sec of Array.from(root.querySelectorAll<HTMLElement>(".set-section"))) {
    const section = clean(sec.querySelector(".set-label")?.textContent) || "Settings";
    for (const nameEl of Array.from(sec.querySelectorAll<HTMLElement>(".set-row-name"))) {
      const label = clean(nameEl.textContent);
      if (!label) continue;
      const box = nameEl.closest<HTMLElement>(".set-row-t") ?? nameEl.parentElement ?? nameEl;
      out.push({
        label,
        description: clean(box.querySelector(".set-row-sub")?.textContent),
        section,
        el: nameEl.closest<HTMLElement>(".set-row") ?? box,
      });
    }
    for (const row of Array.from(sec.querySelectorAll<HTMLElement>(".kbd-row"))) {
      const label = clean(row.firstElementChild?.textContent);
      if (!label) continue;
      out.push({ label, description: clean(row.querySelector(".kbd-keys")?.textContent).replace(/Change$/, "").trim(), section, el: row });
    }
  }
  return out;
}

/** Entries matching `query` (case-insensitive) on label, description or section
 *  name, best first: label hits, then description hits, then rows that match
 *  only because their section does. Ties keep page order. */
export function matchSettings<T extends SettingEntry>(entries: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const ranked: { e: T; rank: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const rank = e.label.toLowerCase().includes(needle) ? 0
      : e.description.toLowerCase().includes(needle) ? 1
      : e.section.toLowerCase().includes(needle) ? 2
      : -1;
    if (rank >= 0) ranked.push({ e, rank, i });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return ranked.map((r) => r.e);
}

/** `text` split into runs, the case-insensitive occurrences of `query` flagged. */
export function highlightRuns(text: string, query: string): { text: string; hit: boolean }[] {
  const needle = query.trim().toLowerCase();
  const hay = text.toLowerCase();
  // A handful of Unicode cases change length when lowercased, which would
  // misalign the offsets; fall back to unhighlighted text rather than lie.
  if (!needle || hay.length !== text.length) return [{ text, hit: false }];
  const runs: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, from)) {
    if (at > from) runs.push({ text: text.slice(from, at), hit: false });
    runs.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) runs.push({ text: text.slice(from), hit: false });
  return runs.length ? runs : [{ text, hit: false }];
}
