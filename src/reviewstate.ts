// reviewstate.ts — UX-567: pure helper behind "mark reviewed, remaining
// count visible". Kept out of Review.tsx so the walk order is testable
// without mounting the drawer.
/** The next file after `current` that isn't reviewed yet, wrapping around the
 *  list once — so marking the last file reviewed can still land on an
 *  earlier one that got skipped out of order. Null once everything's done. */
export function nextUnreviewed(files: string[], current: string | null, reviewed: ReadonlySet<string>): string | null {
  if (files.length === 0) return null;
  const start = current ? files.indexOf(current) : -1;
  for (let i = 1; i <= files.length; i++) {
    const f = files[(start + i + files.length) % files.length];
    if (f !== current && !reviewed.has(f)) return f;
  }
  return null;
}
