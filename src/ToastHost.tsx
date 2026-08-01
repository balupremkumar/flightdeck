import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUI, type Toast } from "./ui";
import "./overlays.css";
// UX-578/UX-591: the commit link + expandable-detail affordances added below
// are cross-cutting (toasts fire from any surface), but Review.tsx/ui.ts are
// this session's only owned files with CSS — the rules live in review.css's
// "Toasts" section rather than the unowned overlays.css.
import "./review.css";

function ToastItem({ id, kind, text, url, detail }: Toast) {
  const dismiss = useUI((s) => s.dismissToast);
  // Pause-on-hover (UI-18): an error toast shouldn't vanish mid-read. While
  // hovered no timer runs; after mouse-leave a shorter one finishes the job.
  // UX-591: expanding the detail pauses it the same way — reading a stack
  // trace shouldn't race a 3.5s clock.
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wasHovered = useRef(false);
  useEffect(() => {
    if (hovered || expanded) {
      wasHovered.current = true;
      return; // paused — no timer while the pointer is on the toast or it's expanded
    }
    const t = window.setTimeout(() => dismiss(id), wasHovered.current ? 2000 : 3500);
    return () => window.clearTimeout(t);
  }, [id, dismiss, hovered, expanded]);
  return (
    <div
      className={"toast toast-" + kind}
      onClick={() => { if (!detail) dismiss(id); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="toast-row">
        <span className="toast-dot" />
        <span className="toast-text">{text}</span>
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
          <button className="toast-close" onClick={(e) => { e.stopPropagation(); dismiss(id); }} title="Dismiss">
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
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map((t) => <ToastItem key={t.id} {...t} />)}
    </div>
  );
}
