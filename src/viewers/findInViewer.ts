// findInViewer.ts — Ctrl+F inside the preview (QL-702).
//
// Two layers. The pure part (offsets, chunk matching, next/prev) is unit
// tested. The DOM part walks the viewer's text nodes, finds matches across
// them (so a query can span syntax-highlight spans) and paints them with the
// CSS Custom Highlight API, which marks text without touching the React tree.

export function findOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const q = query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) out.push(i);
  return out;
}

export function countMatches(text: string, query: string): number {
  return findOffsets(text, query).length;
}

/** Wraps around: next from the last match goes to 0, prev from 0 to the last. */
export function nextIndex(cur: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  return (((cur + dir) % count) + count) % count;
}

export interface Chunk { text: string; block: number }
export interface Seg { chunk: number; start: number; end: number }

/** Matches across a sequence of text chunks. Chunks in the same `block` join
 *  seamlessly; a change of block acts as a line break no match can cross. */
export function findInChunks(chunks: Chunk[], query: string): Seg[][] {
  if (!query || chunks.length === 0) return [];
  const starts: number[] = [];
  let joined = "";
  chunks.forEach((c, i) => {
    if (i > 0 && c.block !== chunks[i - 1].block) joined += "\n";
    starts.push(joined.length);
    joined += c.text;
  });
  const offs = findOffsets(joined, query);
  const out: Seg[][] = [];
  for (const s of offs) {
    const e = s + query.length;
    // last chunk starting at or before s
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= s) lo = mid; else hi = mid - 1;
    }
    const segs: Seg[] = [];
    for (let c = lo; c < chunks.length && starts[c] < e; c++) {
      const a = Math.max(s, starts[c]) - starts[c];
      const b = Math.min(e, starts[c] + chunks[c].text.length) - starts[c];
      if (b > a) segs.push({ chunk: c, start: a, end: b });
    }
    if (segs.length) out.push(segs);
  }
  return out;
}

// ---------------------------------------------------------------------
// DOM layer
// ---------------------------------------------------------------------

const BLOCK_SEL = ".prv-line, p, li, td, th, h1, h2, h3, h4, h5, h6, .jt-row, .jt-bar";
const ALL = "prv-find";
const ACTIVE = "prv-find-active";

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

export function clearDomFind() {
  const r = registry();
  r?.delete(ALL);
  r?.delete(ACTIVE);
}

export interface DomFind {
  count: number;
  /** Marks match `i` as current and scrolls it into view. -1 clears the current mark. */
  setActive(i: number, scroll?: boolean): void;
}

export function scanDom(root: HTMLElement, query: string): DomFind {
  const nodes: Text[] = [];
  const chunks: Chunk[] = [];
  const blockIds = new Map<Element, number>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const el = t.parentElement;
    if (!el || !t.data || el.closest("[data-nofind]")) continue;
    const blk = el.closest(BLOCK_SEL) ?? root;
    let id = blockIds.get(blk);
    if (id === undefined) { id = blockIds.size; blockIds.set(blk, id); }
    nodes.push(t);
    chunks.push({ text: t.data, block: id });
  }
  const matches = findInChunks(chunks, query);
  const reg = registry();
  const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  const ranges = matches.map((segs) => {
    const r = document.createRange();
    const a = segs[0], b = segs[segs.length - 1];
    r.setStart(nodes[a.chunk], a.start);
    r.setEnd(nodes[b.chunk], b.end);
    return r;
  });
  if (reg && HighlightCtor) reg.set(ALL, new HighlightCtor(...ranges));
  else clearDomFind();
  return {
    count: ranges.length,
    setActive(i, scroll = true) {
      if (!reg || !HighlightCtor) return;
      const r = ranges[i];
      if (!r) { reg.delete(ACTIVE); return; }
      reg.set(ACTIVE, new HighlightCtor(r));
      if (scroll) r.startContainer.parentElement?.scrollIntoView({ block: "center" });
    },
  };
}
