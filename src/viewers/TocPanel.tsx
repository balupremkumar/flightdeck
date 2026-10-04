// TocPanel.tsx — QL-703: collapsible contents list floated top-right of the
// rendered markdown. Lazy chunk (keeps the main bundle flat). Native <details>
// keeps it keyboard and screen-reader friendly; data-nofind keeps its text out
// of Ctrl+F so every heading is not counted twice.
import { useMemo } from "react";
import type { BlockNode } from "../markdown";
import { extractToc, TOC_MIN } from "./toc";

export default function TocPanel({ blocks }: { blocks: BlockNode[] }) {
  const entries = useMemo(() => extractToc(blocks), [blocks]);
  if (entries.length < TOC_MIN) return null;
  const base = Math.min(...entries.map((e) => e.level));
  return (
    <details className="prv-toc" data-nofind>
      <summary>Contents ({entries.length})</summary>
      <ul>
        {entries.map((e, i) => (
          <li key={i} style={{ paddingLeft: (e.level - base) * 12 }}>
            <button
              className="prv-toc-item"
              title={e.text}
              onClick={() => document.getElementById(e.id)?.scrollIntoView({ block: "start", behavior: "smooth" })}
            >
              {e.text}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
