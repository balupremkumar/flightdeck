// QL-763: pure logic for folding a finished command's output (OSC 133 marks).
// Terminal.tsx owns the xterm side (markers, decorations); this file only does
// the arithmetic so it can be tested without a terminal.

/** What Terminal.tsx knows about one command, as buffer line numbers. */
export interface FoldMark {
  /** Stable identity (the prompt marker's id). */
  id: number;
  /** Line of the prompt (133;A). */
  promptLine: number;
  /** Line where the output began (133;C). Undefined: the command never produced a C. */
  outStart?: number;
  /** First line AFTER the output (cursor line when 133;D arrived). Undefined while running. */
  outEnd?: number;
  /** Exit code. Undefined while the command is still running. */
  exit?: number;
}

export interface FoldRange {
  id: number;
  promptLine: number;
  /** First hidden row. */
  start: number;
  /** Rows covered, always >= 1. */
  lines: number;
  exit: number;
}

/** Foldable ranges for every FINISHED command that printed something.
 *  A running command (no exit / no end), one with no output, or one whose
 *  bounds are inverted (nested / overlapping prompts) yields no range.
 *  `isBlank` trims trailing empty rows so the count matches what the user sees.
 *  Marks must be in buffer order; each range is clipped to the next prompt. */
export function computeFoldRanges(marks: readonly FoldMark[], isBlank: (line: number) => boolean = () => false): FoldRange[] {
  const out: FoldRange[] = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (m.exit === undefined || m.outStart === undefined || m.outEnd === undefined) continue;
    const next = marks[i + 1];
    const limit = next && next.promptLine > m.promptLine ? Math.min(m.outEnd, next.promptLine) : m.outEnd;
    // Output can't begin at or before its own prompt (a stale C from a nested prompt).
    const start = Math.max(m.outStart, m.promptLine + 1);
    let end = limit - 1; // inclusive
    while (end >= start && isBlank(end)) end--;
    const lines = end - start + 1;
    if (lines < 1) continue;
    out.push({ id: m.id, promptLine: m.promptLine, start, lines, exit: m.exit });
  }
  return out;
}

/** "▸ ls -la (12 lines, exit 0)". The command is whatever the prompt row
 *  holds, trimmed and capped so the summary stays one row. */
export function foldSummary(command: string, lines: number, exit: number, maxCommand = 80): string {
  let cmd = command.replace(/\s+/g, " ").trim();
  if (cmd.length > maxCommand) cmd = `${cmd.slice(0, maxCommand - 1)}…`;
  const n = `${lines} ${lines === 1 ? "line" : "lines"}`;
  return `▸ ${cmd ? `${cmd} ` : ""}(${n}, exit ${exit})`;
}

/** Folded-state transitions. Immutable so callers can compare by identity. */
export function toggleFold(folded: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(folded);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function foldAll(ranges: readonly FoldRange[]): Set<number> {
  return new Set(ranges.map((r) => r.id));
}

/** Ids of folded ranges that contain `line` (search hit, scroll-to). */
export function foldsContaining(ranges: readonly FoldRange[], folded: ReadonlySet<number>, line: number): number[] {
  return ranges.filter((r) => folded.has(r.id) && line >= r.start && line < r.start + r.lines).map((r) => r.id);
}

/** Drop ids that no longer have a range (scrolled out, or the command was edited away). */
export function pruneFolded(folded: ReadonlySet<number>, ranges: readonly FoldRange[]): Set<number> {
  const live = new Set(ranges.map((r) => r.id));
  return new Set([...folded].filter((id) => live.has(id)));
}
