// format.ts — one home for user-facing formatting (UI-220/221/222).
// Three near-identical relTime copies had drifted (LeftPanel said "now",
// Broadcast said "just now", the queue said "3m" vs "3m ago"); every surface
// now shares these.

/** "just now" / "45s ago" / "12m ago" / "3h ago" / "2d ago". */
export function relTime(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Bare duration, no "ago" — for columns where the header says "for how long".
 *  "just now" / "3m" / "1h 5m". */
export function duration(since: number, now: number = Date.now()): string {
  const m = Math.floor((now - since) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Absolute local timestamp for tooltips (UI-221: every relative time must be
 *  hoverable for the real one). */
export function absTime(at: number): string {
  return new Date(at).toLocaleString();
}

/** Relative + absolute in one tooltip string. */
export function timeTitle(at: number): string {
  return `${relTime(at)} — ${absTime(at)}`;
}

/** UI-647: the display text and its hover title in one call, so a call site
 *  never has to invoke relTime/absTime separately (and never forgets the
 *  title). `<span title={r.title}>{r.text}</span>`. */
export function relTimeTitle(at: number, now: number = Date.now()): { text: string; title: string } {
  return { text: relTime(at, now), title: absTime(at) };
}

/** Thousands-separated integers (UI-222). */
export function num(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Compact token/byte-ish counts: 940, 1.2k, 45k. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

/** Human byte size for worktree/disk readouts (UI-187/230). */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** UI-648 truncation policy: paths keep both ends (drive/root + filename
 *  carry the meaning), so the cut goes in the middle. Always pair with a
 *  full-string tooltip — a truncated path can't be read in full otherwise. */
export function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  const keep = max - 1; // room for the ellipsis character
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + "…" + (tail > 0 ? s.slice(s.length - tail) : "");
}

/** UI-648 truncation policy: titles/labels carry their meaning up front, so
 *  the cut goes at the tail. Always pair with a full-string tooltip. */
export function tailEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return s.slice(0, max - 1) + "…";
}
