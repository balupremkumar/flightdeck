import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUI, type Toast } from "./ui";
import "./overlays.css";
// UX-578/UX-591: the commit link + expandable-detail affordances added below
// are cross-cutting (toasts fire from any surface), but Review.tsx/ui.ts are
// this session's only owned files with CSS — the rules live in review.css's
// "Toasts" section rather than the unowned overlays.css.
import "./review.css";

/** UI-625: the maximum number of toast rows on screen at once. Beyond this the
 *  stack stops being a notification and starts being a wall — the older ones
 *  collapse into a single "+N more" line. */
const MAX_VISIBLE = 4;
/** How long an overflowed (never-shown) toast survives before it is dropped.
 *  Without this the tail of a burst would surface minutes later, out of
 *  context, as the visible ones expire. */
const OVERFLOW_TTL_MS = 4000;

/** A run of identical toasts folded into one row. `ids` is every source toast
 *  it stands for, so dismissing the row clears all of them; `id` is the
 *  NEWEST of those, which is what keys the row — a fresh repeat therefore
 *  remounts the item and restarts its dismiss timer. */
interface ToastGroup extends Toast {
  ids: number[];
  count: number;
}

/** Two toasts collapse when the user would read them as the same message. */
function sameMessage(a: Toast, b: Toast) {
  return a.kind === b.kind && a.text === b.text && a.url === b.url && a.detail === b.detail;
}

export function collapseToasts(toasts: Toast[]): ToastGroup[] {
  const groups: ToastGroup[] = [];
  for (const t of toasts) {
    // `count` is optional on the store's Toast today (ui.ts is owned elsewhere;
    // see HANDOFF). Reading it defensively means this stays correct whether the
    // store pre-collapses repeats or hands us one entry per push.
    const weight = (t as { count?: number }).count ?? 1;
    const prev = [...groups].reverse().find((g) => sameMessage(g, t));
    if (prev) {
      prev.count += weight;
      prev.ids.push(t.id);
      prev.id = t.id; // re-key: the repeat resets the group's dismiss timer
    } else {
      groups.push({ ...t, ids: [t.id], count: weight });
    }
  }
  return groups;
}

function ToastItem({ id, ids, kind, text, url, detail, count }: ToastGroup) {
  const dismissOne = useUI((s) => s.dismissToast);
  // Pause-on-hover (UI-18): an error toast shouldn't vanish mid-read. While
  // hovered no timer runs; after mouse-leave a shorter one finishes the job.
  // UX-591: expanding the detail pauses it the same way — reading a stack
  // trace shouldn't race a 3.5s clock.
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wasHovered = useRef(false);
  // Kept in a ref so the dismiss callback is stable: it feeds the timer effect
  // below, and a new identity on every render would restart the clock each
  // time any other toast arrived.
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onDismiss = useCallback(() => { idsRef.current.forEach((n) => dismissOne(n)); }, [dismissOne]);
  useEffect(() => {
    if (hovered || expanded) {
      wasHovered.current = true;
      return; // paused — no timer while the pointer is on the toast or it's expanded
    }
    const t = window.setTimeout(onDismiss, wasHovered.current ? 2000 : 3500);
    return () => window.clearTimeout(t);
  }, [id, onDismiss, hovered, expanded]);
  return (
    <div
      className={"toast toast-" + kind}
      onClick={() => { if (!detail) onDismiss(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="toast-row">
        <span className="toast-dot" />
        <span className="toast-text">{text}</span>
        {/* UI-625: a repeat of the same message increments this instead of
            adding another row — five identical crash toasts read as "×5". */}
        {count > 1 && (
          <span className="toast-count" aria-label={`repeated ${count} times`}>{count}</span>
        )}
        {/* UX-591: per-pane (and any other) error detail, reachable instead of
            truncated — collapsed by default, expands in place. */}
        {detail && (
          <button
            className="toast-expand"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            aria-expanded={expanded}
            title={expanded ? "Hide details" : "Show details"}
          >
            {expanded ? "less" : "details"}
          </button>
        )}
        {!detail && (
          <button className="toast-close" onClick={(e) => { e.stopPropagation(); onDismiss(); }} title="Dismiss">
            ×
          </button>
        )}
      </div>
      {/* UX-578: the merge-commit link, opened via plugin-opener rather than
          a normal <a> so it goes to the OS browser, not the webview. */}
      {url && (
        <button
          className="toast-link"
          onClick={(e) => { e.stopPropagation(); void openUrl(url).catch(() => {}); }}
        >
          View commit ↗
        </button>
      )}
      {expanded && detail && <pre className="toast-detail">{detail}</pre>}
    </div>
  );
}

export function ToastHost() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);

  const groups = collapseToasts(toasts);
  // The stack renders oldest-at-top, newest nearest the corner. When it
  // overflows the newest MAX_VISIBLE stay — a burst's latest message is the
  // one worth reading — and the older remainder becomes a single count row.
  const visible = groups.slice(-MAX_VISIBLE);
  const hidden = groups.slice(0, Math.max(0, groups.length - MAX_VISIBLE));
  const hiddenIds = hidden.flatMap((g) => g.ids);

  // Overflowed toasts never get a ToastItem, so nothing would ever time them
  // out; they would resurface later as the visible ones expire. Drop them on
  // their own clock instead.
  const hiddenKey = hiddenIds.join(",");
  useEffect(() => {
    if (!hiddenKey) return;
    const ids = hiddenKey.split(",").map(Number);
    const t = window.setTimeout(() => ids.forEach((n) => dismiss(n)), OVERFLOW_TTL_MS);
    return () => window.clearTimeout(t);
  }, [hiddenKey, dismiss]);

  if (groups.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {hidden.length > 0 && (
        <div className="toast-overflow">+{hidden.reduce((n, g) => n + g.count, 0)} more</div>
      )}
      {visible.map((g) => <ToastItem key={g.id} {...g} />)}
    </div>
  );
}
