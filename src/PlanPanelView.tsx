// PlanPanelView.tsx — QL-770: read the plan without leaving the cockpit.
//
// Plan mode ends with an ExitPlanMode tool call whose input IS the plan
// document (markdown). In a 6-pane grid that document is unreadable: it scrolls
// past inside an 80-column terminal while five other agents print over the top
// of it. This renders it properly, from the transcript, and answers the prompt
// by typing at the pane's own PTY — the same keystroke the TUI is waiting for,
// not a side channel.
//
// Deliberately NOT an alert: a new plan gets a quiet header chip in the waiting
// tone and nothing else. No bell, no toast, no attention-queue entry (see the
// notification ruling) — a plan is something to read when you look, not an
// interrupt.
//
// Markdown goes through markdown.ts (the parser behind the file preview), not
// through Preview.tsx: the renderer there is bound to a file path on disk for
// image/link resolution, and a plan has no file. Same AST, same prv-* styling,
// no dangerouslySetInnerHTML anywhere.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useOverlayEsc } from "./ui";
import { parseMarkdown, isExternalHref, type BlockNode, type InlineNode } from "./markdown";
import { IconClose } from "./Icons";
import { absTime, relTime, tailEllipsis } from "./format";
import "./preview.css";
import "./planpanel.css";

export interface PlanEntry {
  id: string;
  plan: string;
  atMs: number;
  /** true approved, false rejected, null = the transcript records no answer
   *  yet. Never guessed — a null renders as "awaiting your answer", not as a
   *  rejection. */
  approved: boolean | null;
}

// --- What the two actions actually send -----------------------------------
//
// The Claude Code plan prompt is a numbered select in the TUI:
//   1. Yes, and auto-accept edits
//   2. Yes, and manually approve edits
//   3. No, keep planning
// The number keys pick an option outright, so approving is one keystroke.
//
// 2 is the default here on purpose: approving from a panel in another window
// should not also hand over blanket edit approval. Change to "1" for
// auto-accept, or "\r" to take whichever option the TUI has highlighted.
export const PLAN_APPROVE_KEYS = "2";
// Refine sends nothing — it hands the pane back to you with the cursor in it,
// so you type the change you want in your own words (option 3 in the prompt
// above is the equivalent if you would rather answer with a keystroke: "3").
export const PLAN_REFINE_KEYS = "";

/** The plan the header chip is about: the newest one, and only while the
 *  transcript records no answer to it. An answered plan (either way) is
 *  history — the drawer's archive still has it. */
export function pendingPlan(plans: PlanEntry[]): PlanEntry | null {
  const newest = plans[0];
  return newest && newest.approved == null ? newest : null;
}

/** Row/heading label for a plan: its first markdown heading, else its first
 *  non-empty line. Clipped — a plan's first line can be a paragraph. */
export function planTitle(md: string, max = 72): string {
  const lines = md.split(/\r?\n/);
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  const raw = heading ? heading.replace(/^#{1,6}\s+/, "") : (lines.find((l) => l.trim()) ?? "");
  return tailEllipsis(raw.trim().replace(/\s+/g, " "), max) || "Untitled plan";
}

/** Honest one-word state. `null` says nothing about approval, because the
 *  transcript said nothing about it. */
export function planStatusLabel(p: PlanEntry): string {
  return p.approved === true ? "approved" : p.approved === false ? "not approved" : "awaiting your answer";
}

// --- Markdown rendering ----------------------------------------------------

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "strong":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "code":
        return <code key={i} className="prv-icode">{n.text}</code>;
      case "image":
        // A plan is not a file on disk, so there is no base path to resolve a
        // relative image against — the alt text is all that can honestly show.
        return <span key={i} className="prv-img-broken">{n.alt || "image"}</span>;
      case "link": {
        const external = isExternalHref(n.href);
        return (
          <a
            key={i}
            className="prv-link"
            href={external ? n.href : undefined}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              // Only http(s)/mailto/tel leave the app. Anything else (a repo
              // path, a custom scheme) is text here — plan documents are model
              // output and must never reach the shell opener.
              if (external) openUrl(n.href).catch(() => { /* best-effort */ });
            }}
          >
            {renderInline(n.children)}
          </a>
        );
      }
    }
  });
}

function renderBlocks(blocks: BlockNode[]): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "heading": {
        const H = (`h${b.level}` as unknown) as "h1";
        return <H key={i} className={`prv-h prv-h${b.level}`}>{renderInline(b.children)}</H>;
      }
      case "paragraph":
        return <p key={i}>{renderInline(b.children)}</p>;
      case "hr":
        return <hr key={i} />;
      case "blockquote":
        return <blockquote key={i} className="prv-quote">{renderBlocks(b.children)}</blockquote>;
      case "list": {
        const body = b.items.map((it, j) => (
          <li key={j} className={it.checked !== undefined ? "prv-task" : undefined}>
            {it.checked !== undefined && <input type="checkbox" checked={it.checked} readOnly disabled />}
            <span>{renderInline(it.children)}</span>
          </li>
        ));
        return b.ordered ? <ol key={i} className="prv-list">{body}</ol> : <ul key={i} className="prv-list">{body}</ul>;
      }
      case "table":
        return (
          <table key={i} className="prv-table">
            <thead>
              <tr>{b.header.map((c, ci) => <th key={ci} style={{ textAlign: b.align[ci] ?? undefined }}>{renderInline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ textAlign: b.align[ci] ?? undefined }}>{renderInline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        );
      case "code":
        return <pre key={i} className="prv-fence-body plan-fence">{b.code}</pre>;
    }
  });
}

interface PlanPanelProps {
  open: boolean;
  onClose: () => void;
  paneName: string;
  /** Newest first, straight from pane_plans (usage.rs). */
  plans: PlanEntry[];
  /** Types PLAN_APPROVE_KEYS at this pane's PTY. */
  onApprove: () => void;
  /** Focuses the pane so the next thing typed goes to the agent. */
  onRefine: () => void;
}

export function PlanPanel({ open, onClose, paneName, plans, onApprove, onRefine }: PlanPanelProps) {
  useOverlayEsc(open, onClose);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Opening always lands on the newest plan; picking one from the archive
  // sticks until this closes again.
  useEffect(() => { if (open) setSelectedId(null); }, [open]);

  const selected = useMemo(
    () => plans.find((p) => p.id === selectedId) ?? plans[0] ?? null,
    [plans, selectedId]
  );
  const blocks = useMemo(() => (selected ? parseMarkdown(selected.plan) : []), [selected]);

  if (!open) return null;

  const answered = selected?.approved != null;

  return createPortal(
    <div className="planpanel-scrim" onMouseDown={onClose}>
      <aside
        className="planpanel"
        role="dialog"
        aria-label={`${paneName} plan`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="planpanel-head">
          <div className="planpanel-titles">
            <span className="planpanel-title">{selected ? planTitle(selected.plan) : "No plan yet"}</span>
            {selected && (
              <span className="planpanel-sub" title={absTime(selected.atMs)}>
                {paneName} · {selected.atMs ? relTime(selected.atMs) : "time unknown"} · {planStatusLabel(selected)}
              </span>
            )}
          </div>
          <button className="planpanel-x" onClick={onClose} title="Close (Esc)" aria-label="Close plan panel">
            <IconClose size={14} />
          </button>
        </div>

        {!selected ? (
          <div className="planpanel-empty">This session hasn’t proposed a plan yet.</div>
        ) : (
          <div className="planpanel-body prv-md">{renderBlocks(blocks)}</div>
        )}

        {selected && (
          <div className="planpanel-actions">
            <button
              className="planpanel-approve"
              disabled={answered}
              onClick={onApprove}
              title={
                answered
                  ? `Already ${planStatusLabel(selected)} — nothing left to answer.`
                  : `Types “${PLAN_APPROVE_KEYS}” at ${paneName}: yes, and keep approving edits manually.`
              }
            >
              Approve
            </button>
            <button
              className="planpanel-refine"
              onClick={onRefine}
              title={`Focus ${paneName} so you can type the change you want.`}
            >
              Refine…
            </button>
            <span className="planpanel-note">
              {answered
                ? "Answered already — this is the archived copy."
                : "Approve answers the prompt in the pane itself."}
            </span>
          </div>
        )}

        {plans.length > 1 && (
          <div className="planpanel-archive">
            <div className="planpanel-archive-head">Earlier plans in this session</div>
            {plans.map((p) => (
              <button
                key={p.id}
                className={"planpanel-arc-row" + (p.id === selected?.id ? " current" : "")}
                onClick={() => setSelectedId(p.id)}
                title={absTime(p.atMs)}
              >
                <span className="planpanel-arc-title">{planTitle(p.plan, 44)}</span>
                <span className={"planpanel-arc-state s-" + (p.approved === true ? "yes" : p.approved === false ? "no" : "open")}>
                  {planStatusLabel(p)}
                </span>
                <span className="planpanel-arc-when">{p.atMs ? relTime(p.atMs) : ""}</span>
              </button>
            ))}
          </div>
        )}
      </aside>
    </div>,
    document.body
  );
}

/** Tooltip for the header chip — one line, says what it is and what a click
 *  does. Lives here so the chip and the drawer can't drift apart. */
export function planChipTitle(p: PlanEntry, now: number = Date.now()): string {
  return `${planTitle(p.plan, 60)} — plan proposed ${relTime(p.atMs, now)}, ${planStatusLabel(p)}. Click to read it.`;
}
