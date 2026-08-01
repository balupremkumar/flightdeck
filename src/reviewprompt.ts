// reviewprompt.ts — UX-568/UX-569: pure prompt-building logic behind the
// Review drawer's "send selected diff lines to the agent" and "explain this
// diff" actions. Kept out of Review.tsx (which owns the DOM selection
// reading — untestable without jsdom, see ui.ts's applyUiScale for the same
// split) so the actual prompt text is unit-testable.
import type { PatchLineNo } from "./difflines";

/** The lowest/highest real file line number (new-side, falling back to
 *  old-side for a pure deletion) covered by patch lines [startIdx, endIdx].
 *  Null when the range is entirely hunk headers / meta lines (no file line
 *  to point at) — the caller falls back to just naming the file. */
export function fileLineRange(nos: PatchLineNo[], startIdx: number, endIdx: number): { start: number; end: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = startIdx; i <= endIdx; i++) {
    const n = nos[i];
    if (!n) continue;
    const v = n.newLine ?? n.oldLine;
    if (v == null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? null : { start: lo, end: hi };
}

/** UX-568: the prompt sent to a pane for a diff-line selection — the file
 *  (and its real line range, when resolvable) so the agent knows exactly
 *  what it's looking at, followed by the raw selected lines as a fenced
 *  block. `startIdx`/`endIdx` are patch-line indices (into `patchLines` /
 *  `nos`, same indexing as difflines.ts's mapPatchLines output) and may
 *  arrive in either order — a selection can be made bottom-to-top. */
export function buildLineCommentPrompt(
  file: string,
  patchLines: string[],
  nos: PatchLineNo[],
  startIdx: number,
  endIdx: number
): string {
  const a = Math.min(startIdx, endIdx);
  const b = Math.max(startIdx, endIdx);
  const range = fileLineRange(nos, a, b);
  const header = range ? `${file}:${range.start}${range.end !== range.start ? `-${range.end}` : ""}` : file;
  const snippet = patchLines.slice(a, b + 1).join("\n");
  return `${header}\n\`\`\`\n${snippet}\n\`\`\`\n`;
}

// UX-569: a raw patch is pasted into a live terminal — an unbounded one
// (a generated file, a huge rename) would flood the agent's input. Cap it at
// a size that's still plenty of context for "explain this diff" without
// risking a multi-MB paste.
export const EXPLAIN_PATCH_MAX_CHARS = 8000;

/** Truncates `patch` to at most `maxChars`, cutting at the end of the last
 *  whole line inside the budget (never mid-line) and appending a clear,
 *  unambiguous marker naming how much was left out. A patch already inside
 *  the budget is returned unchanged. */
export function truncatePatchForPrompt(patch: string, maxChars: number = EXPLAIN_PATCH_MAX_CHARS): string {
  if (patch.length <= maxChars) return patch;
  const head = patch.slice(0, maxChars);
  const cut = head.lastIndexOf("\n");
  const kept = cut > 0 ? head.slice(0, cut) : head;
  const omitted = patch.length - kept.length;
  return `${kept}\n… [truncated — ${omitted} more character${omitted === 1 ? "" : "s"} not shown] …`;
}

/** UX-569: "explain this diff" — the whole (capped) patch for `file`,
 *  framed as a question rather than just dumping the text. */
export function buildExplainPrompt(file: string, patch: string, maxChars: number = EXPLAIN_PATCH_MAX_CHARS): string {
  const body = truncatePatchForPrompt(patch, maxChars);
  return `Explain this diff for ${file}:\n\`\`\`diff\n${body}\n\`\`\`\n`;
}
