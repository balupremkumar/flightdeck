// toc.ts — table of contents for rendered markdown (QL-703). Pure.
//
// Walks the block tree in the same order renderBlocks() does (blockquote
// children included) so the slugger hands out the same ids, duplicates and all.
import { inlineText, makeSlugger } from "../markdown";
import type { BlockNode } from "../markdown";

export interface TocEntry { level: number; text: string; id: string }

/** A contents list only earns its space with this many headings. */
export const TOC_MIN = 3;

export function extractToc(blocks: BlockNode[], idPrefix = "prv-h-"): TocEntry[] {
  const slug = makeSlugger();
  const out: TocEntry[] = [];
  const walk = (bs: BlockNode[]) => {
    for (const b of bs) {
      if (b.type === "heading") {
        const text = inlineText(b.children);
        out.push({ level: b.level, text, id: idPrefix + slug(text) });
      } else if (b.type === "blockquote") walk(b.children);
    }
  };
  walk(blocks);
  return out;
}
