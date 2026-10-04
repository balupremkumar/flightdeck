// JsonTree.tsx — collapsible, type-coloured JSON viewer (Phase 2, V2a).
//
// Lazy chunk. Only open nodes are flattened and only the rows in view are
// mounted (windowing.ts), so a 5 MB document stays responsive. Invalid JSON is
// reported through onInvalid; the Preview shell then shows the text view with
// a banner, so this component never renders a half-parsed tree.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUI } from "../ui";
import { countMatches } from "./findInViewer";
import { flattenJson, parseJson, rowText, MAX_SHOWN, type JsonParseError, type JsonRow } from "./jsonflatten";
import { useWindowed } from "./useWindowed";
import { ROW_H } from "./windowing";

/** Find driver owned by the Preview shell; the view counts and navigates its own rows. */
export interface TreeFind { query: string; index: number; onCount: (n: number) => void }

const INITIAL_DEPTH = 2;

function copy(text: string, what: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => useUI.getState().pushToast("success", `${what} copied`))
    .catch(() => useUI.getState().pushToast("error", `Couldn’t copy the ${what.toLowerCase()}.`));
}

function copyValue(row: JsonRow) {
  copy(row.kind === "string" ? (row.node as string) : JSON.stringify(row.node, null, 2), "Value");
}

function Value({ row }: { row: JsonRow }) {
  switch (row.kind) {
    case "object": return <span className="jt-p">{row.open ? "{" : `{…}`}<span className="jt-count">{row.size} {row.size === 1 ? "key" : "keys"}</span></span>;
    case "array": return <span className="jt-p">{row.open ? "[" : `[…]`}<span className="jt-count">{row.size} {row.size === 1 ? "item" : "items"}</span></span>;
    case "string": {
      const s = row.node as string;
      return <span className="jt-str">“{s.length > MAX_SHOWN ? s.slice(0, MAX_SHOWN) + "…" : s}”</span>;
    }
    case "number": return <span className="jt-num">{String(row.node)}</span>;
    case "boolean": return <span className="jt-bool">{String(row.node)}</span>;
    default: return <span className="jt-null">null</span>;
  }
}

/** One tree row. Shared with JsonlView, which nests tree rows under a line. */
export function JsonRowView({ row, indent = 0, active, onToggle }: {
  row: JsonRow; indent?: number; active?: boolean; onToggle: (row: JsonRow) => void;
}) {
  const container = row.kind === "object" || row.kind === "array";
  return (
    <div
      className={"jt-row" + (active ? " jt-row-active" : "")}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={container && row.size > 0 ? row.open : undefined}
      style={{ height: ROW_H, paddingLeft: 10 + (row.depth + indent) * 16 }}
    >
      {container && row.size > 0 ? (
        <button className="jt-tog" data-nofind onClick={() => onToggle(row)} aria-label={(row.open ? "Collapse " : "Expand ") + row.path}>
          {row.open ? "▾" : "▸"}
        </button>
      ) : (
        <span className="jt-tog jt-tog-none" data-nofind aria-hidden="true" />
      )}
      {row.key !== null && (
        <>
          <span className={typeof row.key === "number" ? "jt-idx" : "jt-key"}>{row.key}</span>
          <span className="jt-p">: </span>
        </>
      )}
      <Value row={row} />
      <span className="jt-acts" data-nofind>
        <button className="prv-copy" onClick={() => copyValue(row)} title="Copy value">Value</button>
        <button className="prv-copy" onClick={() => copy(row.path, "Path")} title={`Copy path ${row.path}`}>Path</button>
      </span>
    </div>
  );
}

export default function JsonTree({ text, onInvalid, find }: {
  text: string;
  onInvalid: (e: JsonParseError) => void;
  find?: TreeFind;
}) {
  const parsed = useMemo(() => parseJson(text), [text]);
  const [depth, setDepth] = useState(INITIAL_DEPTH);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const invalidRef = useRef(onInvalid);
  invalidRef.current = onInvalid;

  useEffect(() => { if (!parsed.ok) invalidRef.current(parsed.error); }, [parsed]);

  const flat = useMemo(
    () => (parsed.ok
      ? flattenJson(parsed.value, { isOpen: (p, d) => overrides.get(p) ?? d < depth })
      : { rows: [] as JsonRow[], truncated: false }),
    [parsed, depth, overrides]
  );
  const rows = flat.rows;

  const toggle = useCallback((row: JsonRow) => {
    setOverrides((m) => new Map(m).set(row.path, !row.open));
  }, []);

  const { ref, onScroll, range, scrollToRow } = useWindowed(rows.length);

  // Find: counts occurrences over the rows as displayed, then walks them.
  const q = find?.query ?? "";
  const found = useMemo(() => {
    if (!q) return { total: 0, cum: [] as number[] };
    const cum: number[] = new Array(rows.length);
    let total = 0;
    for (let i = 0; i < rows.length; i++) { total += countMatches(rowText(rows[i]), q); cum[i] = total; }
    return { total, cum };
  }, [rows, q]);
  const onCount = find?.onCount;
  useEffect(() => { onCount?.(found.total); }, [found.total, onCount]);
  const activeRow = useMemo(() => {
    if (!found.total || !find) return -1;
    const target = find.index % found.total;
    let lo = 0, hi = found.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (found.cum[mid] > target) hi = mid; else lo = mid + 1; }
    return lo;
  }, [found, find]);
  useEffect(() => { scrollToRow(activeRow); }, [activeRow, scrollToRow]);

  if (!parsed.ok) return null;

  return (
    <div className="jt">
      <div className="jt-bar" data-nofind>
        <button className="prv-copy" onClick={() => { setDepth(Infinity); setOverrides(new Map()); }}>Expand all</button>
        <button className="prv-copy" onClick={() => { setDepth(1); setOverrides(new Map()); }}>Collapse all</button>
        <span className="jt-info">
          {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"} shown
          {flat.truncated && " (capped, collapse some branches to see the rest)"}
        </span>
      </div>
      <div className="jt-scroll" ref={ref} onScroll={onScroll} role="tree" aria-label="JSON" tabIndex={0}>
        <div className="jt-sizer" style={{ height: rows.length * ROW_H }}>
          <div className="jt-win" style={{ top: range.start * ROW_H }}>
            {rows.slice(range.start, range.end).map((r, i) => (
              <JsonRowView key={r.path} row={r} active={range.start + i === activeRow} onToggle={toggle} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
