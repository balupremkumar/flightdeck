// LogLines.tsx — coloured, windowed log viewer (Phase 2, V3). Lazy chunk.
//
// One fixed-height row per line, so a 100k-line log mounts only what is on
// screen. Opens at the end of the file (that is where a log's news is) and
// stays there across follow reloads while the reader has not scrolled away.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { countMatches } from "./findInViewer";
import { classifyLines, timestampEnd } from "./logview";
import { atBottom } from "./previewlogic";
import { useWindowed } from "./useWindowed";
import { ROW_H } from "./windowing";
import type { TreeFind } from "./JsonTree";

export default function LogView({ text, targetLine, find }: { text: string; targetLine?: number; find?: TreeFind }) {
  const lines = useMemo(() => {
    const l = text.split(/\r?\n/);
    if (l.length > 1 && l[l.length - 1] === "") l.pop(); // trailing newline is not a line
    return l;
  }, [text]);
  const levels = useMemo(() => classifyLines(lines), [lines]);
  const { ref, onScroll, range, scrollToRow } = useWindowed(lines.length);

  const stuck = useRef(true);
  const scrolled = useCallback(() => {
    if (ref.current) stuck.current = atBottom(ref.current);
    onScroll();
  }, [ref, onScroll]);

  const first = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current && targetLine) { first.current = false; stuck.current = false; return; }
    first.current = false;
    if (stuck.current) { el.scrollTop = el.scrollHeight; onScroll(); }
  }, [lines.length, ref, onScroll, targetLine]);

  useEffect(() => {
    if (targetLine && targetLine >= 1 && targetLine <= lines.length) scrollToRow(targetLine - 1);
  }, [targetLine, lines.length, scrollToRow]);

  const q = find?.query ?? "";
  const found = useMemo(() => {
    if (!q) return { total: 0, cum: [] as number[] };
    const cum: number[] = new Array(lines.length);
    let total = 0;
    for (let i = 0; i < lines.length; i++) { total += countMatches(lines[i], q); cum[i] = total; }
    return { total, cum };
  }, [lines, q]);
  const onCount = find?.onCount;
  useEffect(() => { onCount?.(found.total); }, [found.total, onCount]);
  const activeLine = useMemo(() => {
    if (!found.total || !find) return -1;
    const target = find.index % found.total;
    let lo = 0, hi = found.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (found.cum[mid] > target) hi = mid; else lo = mid + 1; }
    return lo;
  }, [found, find]);
  useEffect(() => { if (activeLine >= 0) { stuck.current = false; scrollToRow(activeLine); } }, [activeLine, scrollToRow]);

  return (
    <div className="jt lg">
      <div className="jt-bar" data-nofind>
        <span className="jt-info">{lines.length.toLocaleString()} {lines.length === 1 ? "line" : "lines"}</span>
        <button
          className="prv-copy"
          onClick={() => { const el = ref.current; if (el) { stuck.current = true; el.scrollTop = el.scrollHeight; onScroll(); } }}
        >
          Jump to end
        </button>
      </div>
      <div className="jt-scroll" ref={ref} onScroll={scrolled} role="log" aria-label="Log file" tabIndex={0}>
        <div className="jt-sizer" style={{ height: lines.length * ROW_H }}>
          <div className="jt-win" style={{ top: range.start * ROW_H }}>
            {lines.slice(range.start, range.end).map((l, i) => {
              const at = range.start + i;
              const ts = timestampEnd(l);
              const cls =
                "jt-row lg-row lg-" + levels[at] +
                (at === activeLine ? " jt-row-active" : "") +
                (at + 1 === targetLine ? " lg-hit" : "");
              return (
                <div key={at} className={cls} style={{ height: ROW_H }}>
                  <span className="jl-no" data-nofind>{at + 1}</span>
                  {ts > 0 ? <><span className="lg-ts">{l.slice(0, ts)}</span>{l.slice(ts)}</> : l}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
