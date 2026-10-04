// JsonlView.tsx — one row per JSON line (Phase 2, V2a). Lazy chunk.
//
// Each line is a one-line summary (chips for `type` / `message.role` plus a text
// preview, which is what Claude session records look like). Expanding a line
// splices its JSON tree rows into the same fixed-height list, so the whole file
// is one windowed list and 10k+ lines mount only what is on screen.
import { useCallback, useEffect, useMemo, useState } from "react";
import { countMatches } from "./findInViewer";
import { flattenJson, type JsonRow } from "./jsonflatten";
import { extractChips, parseJsonl } from "./jsonlparse";
import { JsonRowView, type TreeFind } from "./JsonTree";
import { useWindowed } from "./useWindowed";
import { ROW_H } from "./windowing";

type Display = { t: "line"; idx: number } | { t: "node"; idx: number; row: JsonRow };

const key = (idx: number, path: string) => `${idx}\u0000${path}`;

export default function JsonlView({ text, find }: { text: string; find?: TreeFind }) {
  const { records, invalid } = useMemo(() => parseJsonl(text), [text]);
  const [openLines, setOpenLines] = useState<Set<number>>(() => new Set());
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());

  const { display, lineAt } = useMemo(() => {
    const display: Display[] = [];
    const lineAt: number[] = new Array(records.length);
    records.forEach((rec, idx) => {
      lineAt[idx] = display.length;
      display.push({ t: "line", idx });
      if (openLines.has(idx) && rec.error === undefined) {
        const { rows } = flattenJson(rec.value, { isOpen: (p, d) => overrides.get(key(idx, p)) ?? d < 2 }, "$", 0);
        for (const row of rows) display.push({ t: "node", idx, row });
      }
    });
    return { display, lineAt };
  }, [records, openLines, overrides]);

  const toggleLine = useCallback((idx: number) => {
    setOpenLines((s) => { const n = new Set(s); if (!n.delete(idx)) n.add(idx); return n; });
  }, []);
  const toggleNode = useCallback((idx: number, row: JsonRow) => {
    setOverrides((m) => new Map(m).set(key(idx, row.path), !row.open));
  }, []);

  const { ref, onScroll, range, scrollToRow } = useWindowed(display.length);

  // Find: counts occurrences in each line's raw text, then walks the lines,
  // opening the current one so the match is actually on screen.
  const q = find?.query ?? "";
  const found = useMemo(() => {
    if (!q) return { total: 0, cum: [] as number[] };
    const cum: number[] = new Array(records.length);
    let total = 0;
    for (let i = 0; i < records.length; i++) { total += countMatches(records[i].raw, q); cum[i] = total; }
    return { total, cum };
  }, [records, q]);
  const onCount = find?.onCount;
  useEffect(() => { onCount?.(found.total); }, [found.total, onCount]);
  const activeRec = useMemo(() => {
    if (!found.total || !find) return -1;
    const target = find.index % found.total;
    let lo = 0, hi = found.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (found.cum[mid] > target) hi = mid; else lo = mid + 1; }
    return lo;
  }, [found, find]);
  useEffect(() => {
    if (activeRec < 0) return;
    if (records[activeRec].error === undefined) setOpenLines((s) => (s.has(activeRec) ? s : new Set(s).add(activeRec)));
  }, [activeRec, records]);
  useEffect(() => { if (activeRec >= 0) scrollToRow(lineAt[activeRec]); }, [activeRec, lineAt, scrollToRow]);

  return (
    <div className="jt">
      <div className="jt-bar" data-nofind>
        <span className="jt-info">
          {records.length.toLocaleString()} {records.length === 1 ? "row" : "rows"}
          {invalid > 0 && <span className="jl-bad-count"> · {invalid.toLocaleString()} invalid</span>}
        </span>
        <button className="prv-copy" disabled={openLines.size === 0} onClick={() => { setOpenLines(new Set()); setOverrides(new Map()); }}>
          Collapse all
        </button>
      </div>
      <div className="jt-scroll" ref={ref} onScroll={onScroll} role="tree" aria-label="JSON lines" tabIndex={0}>
        <div className="jt-sizer" style={{ height: display.length * ROW_H }}>
          <div className="jt-win" style={{ top: range.start * ROW_H }}>
            {display.slice(range.start, range.end).map((d, i) => {
              const at = range.start + i;
              if (d.t === "node") {
                return <JsonRowView key={at} row={d.row} indent={2} onToggle={(r) => toggleNode(d.idx, r)} />;
              }
              const rec = records[d.idx];
              const open = openLines.has(d.idx);
              if (rec.error !== undefined) {
                return (
                  <div key={at} className="jt-row jl-row jl-bad" role="treeitem" aria-level={1} style={{ height: ROW_H }} title={rec.error}>
                    <span className="jt-tog jt-tog-none" data-nofind aria-hidden="true" />
                    <span className="jl-no" data-nofind>{rec.line}</span>
                    <span className="jl-chip jl-chip-bad">invalid</span>
                    <span className="jl-err">{rec.error}</span>
                    <span className="jl-prev">{rec.raw.slice(0, 160)}</span>
                  </div>
                );
              }
              const c = extractChips(rec.value);
              return (
                <div key={at} className={"jt-row jl-row" + (d.idx === activeRec ? " jt-row-active" : "")} role="treeitem" aria-level={1} aria-expanded={open} style={{ height: ROW_H }}>
                  <button className="jt-tog" data-nofind onClick={() => toggleLine(d.idx)} aria-label={`${open ? "Collapse" : "Expand"} line ${rec.line}`}>
                    {open ? "▾" : "▸"}
                  </button>
                  <span className="jl-no" data-nofind>{rec.line}</span>
                  {c.type && <span className="jl-chip">{c.type}</span>}
                  {c.role && <span className="jl-chip jl-chip-role">{c.role}</span>}
                  <span className="jl-prev">{c.preview}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
