// TranscriptView.tsx — UX-546 per-pane transcript browser: a searchable/
// scrollable view of this pane's run history. The terminal already keeps
// scrollback (xterm.js's own buffer); this reads it via
// TerminalHandle.getScrollbackText — see HANDOFF EDITS for the small
// Terminal.tsx addition this expects. Until that lands, `getScrollback`
// returns null and the browser shows an honest "not available yet" state
// rather than pretending to work.
//
// Named *View* (not Transcript.tsx) deliberately: this filesystem is
// case-insensitive, and transcript.ts (the pure logic module this imports)
// already claims "Transcript" as a module specifier — `Transcript.tsx` and
// `transcript.ts` would resolve to the same module on Windows/macOS and
// silently shadow each other.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOverlayEsc } from "./ui";
import { IconClose } from "./Icons";
import { searchTranscript, toLines } from "./transcript";
import "./panes.css";

export interface TranscriptProps {
  open: boolean;
  onClose: () => void;
  paneName: string;
  /** Returns the full scrollback as plain text, or null if unavailable. */
  getScrollback: () => string | null;
}

export function Transcript({ open, onClose, paneName, getScrollback }: TranscriptProps) {
  useOverlayEsc(open, onClose);
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState<string | null>(null);
  // Snapshot the scrollback the moment this opens — a live-updating browser
  // would fight the user's scroll position and search selection every time
  // the agent prints something; re-open to see fresh output.
  useEffect(() => {
    if (open) setRaw(getScrollback());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const lines = useMemo(() => (raw != null ? toLines(raw) : []), [raw]);
  const matches = useMemo(() => searchTranscript(lines, query), [lines, query]);
  const [matchIdx, setMatchIdx] = useState(0);
  useEffect(() => setMatchIdx(0), [query]);

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!matches.length || !bodyRef.current) return;
    const target = matches[Math.min(matchIdx, matches.length - 1)];
    bodyRef.current.querySelector<HTMLElement>(`[data-line="${target.index}"]`)?.scrollIntoView({ block: "center" });
  }, [matchIdx, matches]);

  if (!open) return null;

  const isBlank = raw != null && (lines.length === 0 || (lines.length === 1 && lines[0] === ""));
  const step = (dir: 1 | -1) => {
    if (!matches.length) return;
    setMatchIdx((i) => (i + dir + matches.length) % matches.length);
  };

  return createPortal(
    <div className="transcript-backdrop" onMouseDown={onClose}>
      <div
        className="transcript"
        role="dialog"
        aria-modal="true"
        aria-label={`${paneName} transcript`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="transcript-head">
          <span className="transcript-title">{paneName} — transcript</span>
          <input
            className="transcript-search"
            placeholder="Search this pane's history…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            }}
            autoFocus
          />
          {query && <span className="transcript-count">{matches.length ? `${matchIdx + 1}/${matches.length}` : "0/0"}</span>}
          <button className="transcript-x" onClick={onClose} title="Close (Esc)" aria-label="Close transcript">
            <IconClose size={14} />
          </button>
        </div>
        {raw == null ? (
          <div className="transcript-empty">
            Transcript isn't wired up for this pane yet — it needs a small terminal-side addition (see HANDOFF EDITS in the build report).
          </div>
        ) : isBlank ? (
          <div className="transcript-empty">Nothing's been printed in this pane yet.</div>
        ) : (
          <div className="transcript-body" ref={bodyRef}>
            {lines.map((l, i) => {
              const isCurrent = matches.length > 0 && matches[Math.min(matchIdx, matches.length - 1)].index === i;
              const isHit = !isCurrent && query.trim() && l.toLowerCase().includes(query.trim().toLowerCase());
              return (
                <div key={i} data-line={i} className={"transcript-line" + (isCurrent ? " current" : isHit ? " hit" : "")}>
                  {l || " "}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
