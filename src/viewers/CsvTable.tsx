import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clampWidth, detectHeader, nextSort, parseCsv, parseNumber, sortedOrder, visibleRange, type SortDir } from "./csv";
import "./viewers.css";

const ROW_H = 24;
const DEFAULT_W = 160;

export default function CsvTable({ text, path }: { text: string; path: string }) {
  const parsed = useMemo(() => parseCsv(text, path), [text, path]);
  const hasHeader = useMemo(() => detectHeader(parsed.rows), [parsed]);
  const from = hasHeader ? 1 : 0;
  const cols = parsed.columns;

  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [resizing, setResizing] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // new file: reset view state
  useEffect(() => { setSort(null); setWidths({}); setSel(null); }, [text, path]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport(el.clientHeight);
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const order = useMemo(
    () => (sort ? sortedOrder(parsed.rows, sort.col, sort.dir, from) : null),
    [parsed, sort, from],
  );
  const total = parsed.rows.length - from;
  const rowAt = (v: number) => (order ? order[v] : v + from);

  const colW = (c: number) => widths[c] ?? DEFAULT_W;
  const gridW = useMemo(() => {
    let w = 0;
    for (let c = 0; c < cols; c++) w += widths[c] ?? DEFAULT_W;
    return w;
  }, [widths, cols]);

  const range = visibleRange(scrollTop, ROW_H, viewport, total);
  const gutterW = Math.max(56, String(total).length * 9 + 24);

  const onSort = (c: number) => {
    const cur = sort?.col === c ? sort.dir : null;
    const nxt = nextSort(cur);
    setSort(nxt ? { col: c, dir: nxt } : null);
  };

  const startResize = useCallback((e: React.PointerEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[c] ?? DEFAULT_W;
    setResizing(c);
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [c]: clampWidth(startW + ev.clientX - startX) }));
    const up = () => {
      setResizing(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [widths]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!sel) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      const v = parsed.rows[sel.r]?.[sel.c] ?? "";
      navigator.clipboard?.writeText(v).catch(() => {});
      e.preventDefault();
      return;
    }
    const d = e.key === "ArrowDown" ? [1, 0] : e.key === "ArrowUp" ? [-1, 0] : e.key === "ArrowRight" ? [0, 1] : e.key === "ArrowLeft" ? [0, -1] : null;
    if (!d) return;
    e.preventDefault();
    // move in visual order
    const vis = order ? order.indexOf(sel.r) : sel.r - from;
    const nv = Math.max(0, Math.min(total - 1, vis + d[0]));
    const nc = Math.max(0, Math.min(cols - 1, sel.c + d[1]));
    setSel({ r: rowAt(nv), c: nc });
    const el = scrollRef.current;
    if (el) {
      const top = nv * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = top + ROW_H * 2 - el.clientHeight;
    }
  };

  if (!parsed.rows.length) return <div className="csv-empty">Empty file.</div>;

  const header = hasHeader ? parsed.rows[0] : null;
  const rows: React.ReactNode[] = [];
  for (let v = range.start; v < range.end; v++) {
    const r = rowAt(v);
    const row = parsed.rows[r];
    const cells: React.ReactNode[] = [];
    for (let c = 0; c < cols; c++) {
      const val = row[c] ?? "";
      const selected = sel?.r === r && sel.c === c;
      cells.push(
        <div
          key={c}
          role="gridcell"
          aria-selected={selected}
          className={"csv-cell" + (val !== "" && parseNumber(val) !== null ? " num" : "")}
          style={{ width: colW(c) }}
          title={val.length > 24 ? val : undefined}
          onClick={() => setSel({ r, c })}
        >
          {val}
        </div>,
      );
    }
    rows.push(
      <div key={r} role="row" className={"csv-row" + (v % 2 ? " odd" : "")} style={{ top: v * ROW_H, height: ROW_H, lineHeight: `${ROW_H}px` }}>
        <div className="csv-gutter" style={{ width: gutterW }}>{r - from + 1}</div>
        {cells}
      </div>,
    );
  }

  const heads: React.ReactNode[] = [];
  for (let c = 0; c < cols; c++) {
    const label = header ? header[c] ?? "" : `Col ${c + 1}`;
    const dir = sort?.col === c ? sort.dir : null;
    heads.push(
      <div key={c} className="csv-th-wrap" role="columnheader" aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : "none"} style={{ width: colW(c) }}>
        <button type="button" className="csv-th" onClick={() => onSort(c)} title={`Sort by ${label}`}>
          <span className="csv-th-label">{label}</span>
          {dir && <span className="csv-th-sort" aria-hidden="true">{dir === "asc" ? "▲" : "▼"}</span>}
        </button>
        <div
          className={"csv-resize" + (resizing === c ? " active" : "")}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label}`}
          onPointerDown={(e) => startResize(e, c)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>,
    );
  }

  return (
    <div className="csv-viewer">
      <div
        ref={scrollRef}
        className="csv-scroll"
        role="grid"
        aria-rowcount={total}
        aria-colcount={cols}
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div className="csv-head" role="row" style={{ height: ROW_H + 4, lineHeight: `${ROW_H + 4}px`, width: gridW + gutterW }}>
          <div className="csv-gutter" style={{ width: gutterW }}>#</div>
          {heads}
        </div>
        <div style={{ position: "relative", height: total * ROW_H, width: gridW + gutterW }}>{rows}</div>
      </div>
      <div className="csv-foot">
        <span>{total.toLocaleString()} {total === 1 ? "row" : "rows"}</span>
        <span>{cols} {cols === 1 ? "column" : "columns"}</span>
        {parsed.ragged && <span className="warn">Rows have uneven column counts; short rows are padded.</span>}
        <span className="grow" />
        {sel && <span>R{(order ? order.indexOf(sel.r) : sel.r - from) + 1} C{sel.c + 1} (Ctrl+C copies)</span>}
      </div>
    </div>
  );
}
