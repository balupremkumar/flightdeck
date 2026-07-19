import { COLUMNS, VENDOR_META } from "./boardStore";
import type { BoardCards, Card } from "./types";

function cardToMarkdown(c: Card): string {
  const bits: string[] = [`- [${c.checklist.length && c.checklist.every((i) => i.done) ? "x" : " "}] **${c.title}** _(${c.priority})_`];
  if (c.agent) bits[0] += ` — ${VENDOR_META[c.agent].label}`;
  if (c.labels.length) bits[0] += ` [${c.labels.map((l) => l.name).join(", ")}]`;
  if (c.description.trim()) bits.push(`  > ${c.description.trim().replace(/\n/g, "\n  > ")}`);
  for (const item of c.checklist) {
    bits.push(`  - [${item.done ? "x" : " "}] ${item.text}`);
  }
  return bits.join("\n");
}

// Whole-board export (BACKLOG D30). One card = one checkbox line, with its
// own checklist nested underneath. Kept to plain Markdown, no board-specific
// syntax, so it pastes cleanly into a PR description or a notes file.
export function exportBoardMarkdown(cards: BoardCards): string {
  const lines: string[] = ["# Board export", ""];
  for (const col of COLUMNS) {
    lines.push(`## ${col.name}`, "");
    if (cards[col.id].length === 0) {
      lines.push("_No cards._", "");
      continue;
    }
    for (const c of cards[col.id]) lines.push(cardToMarkdown(c), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
