import type { DragEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Card, ColumnId } from "./types";
import { PRIORITY_COLORS, STATE_COLORS, STATE_LABELS } from "./palette";
import { vendorColor, vendorShort } from "../vendors";
import { usePaneStatus } from "./usePaneStatus";

interface CardItemProps {
  card: Card;
  colId: ColumnId;
  isDragging: boolean;
  isSelected: boolean;
  isCompleting: boolean;
  insertLine: "before" | "after" | null;
  onDragStart: (e: DragEvent<HTMLDivElement>, card: Card) => void;
  onDragEnd: () => void;
  onCardDragOver: (e: DragEvent<HTMLDivElement>, card: Card) => void;
  /** UI-38: worktree prep is in flight for this card. */
  isDispatching?: boolean;
  onSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
}

export function CardItem({
  card,
  isDragging,
  isSelected,
  isCompleting,
  insertLine,
  onDragStart,
  onDragEnd,
  onCardDragOver,
  isDispatching,
  onSelect,
  onOpenDetail,
}: CardItemProps) {
  const status = usePaneStatus(card.paneId);
  const doneCount = card.checklist.filter((i) => i.done).length;
  const hasChecklist = card.checklist.length > 0;

  return (
    <div className="card-slot">
      {insertLine === "before" && <div className="card-insert" />}
      <div
        className={
          "card" +
          (isDragging ? " card-source" : "") +
          (isSelected ? " card-selected" : "") +
          (isCompleting ? " card-pop" : "")
        }
        style={isDragging ? undefined : { borderLeft: `2px solid ${PRIORITY_COLORS[card.priority]}` }}
        draggable
        tabIndex={0}
        role="button"
        aria-label={card.title}
        onDragStart={(e) => onDragStart(e, card)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => onCardDragOver(e, card)}
        onClick={() => onSelect(card.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(card.id);
          }
        }}
      >
        {!isDragging && (
          <>
            <span className="card-grip" aria-hidden="true">
              <span /><span /><span /><span /><span /><span />
            </span>
            <button
              type="button"
              className="card-title"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetail(card.id);
              }}
              // UI-31: the card title is already the focusable element, so
              // letting focus imply selection completes the keyboard path
              // (Tab to a card, arrows move it, Esc deselects) without
              // inventing a second selection concept.
              onFocus={() => onSelect(card.id)}
              title="Open card"
            >
              {card.title}
            </button>

            {/* UI-157: the PR this card's agent opened — the card stays the
                thread from task to agent to review. */}
            {isDispatching && (
              <span className="card-dispatching">Preparing worktree…</span>
            )}
            {card.prUrl && (
              <button
                type="button"
                className="card-pr"
                title={card.prUrl}
                onClick={(e) => { e.stopPropagation(); void openUrl(card.prUrl!).catch(() => {}); }}
              >
                pull request ↗
              </button>
            )}

            {card.labels.length > 0 && (
              <div className="card-labels">
                {card.labels.map((l) => (
                  <span key={l.id} className="label-chip" style={{ background: `color-mix(in srgb, var(${l.colorVar}) 18%, transparent)`, color: `var(${l.colorVar})` }}>
                    {l.name}
                  </span>
                ))}
              </div>
            )}

            {hasChecklist && (
              <div className="card-checklist-bar" title={`${doneCount}/${card.checklist.length} done`}>
                <div className="card-checklist-fill" style={{ width: `${(doneCount / card.checklist.length) * 100}%` }} />
              </div>
            )}

            <div className="card-chips">
              <span
                className="chip chip-priority"
                style={{
                  color: PRIORITY_COLORS[card.priority],
                  borderColor: PRIORITY_COLORS[card.priority],
                  background: `color-mix(in srgb, ${PRIORITY_COLORS[card.priority]} 14%, transparent)`,
                }}
              >
                {card.priority}
              </span>
              {card.agent && !status && (
                <span className="chip chip-agent">
                  <span
                    className="chip-agent-dot"
                    style={{
                      background: vendorColor(card.agent),
                      boxShadow: `0 0 6px color-mix(in srgb, ${vendorColor(card.agent)} 50%, transparent)`,
                    }}
                  />
                  {vendorShort(card.agent)}
                </span>
              )}
              {status && (
                <span className="chip chip-agent chip-live" title={`${STATE_LABELS[status.state]} — updated ${status.rel}`}>
                  <span className={`chip-agent-dot dot-${status.state}`} style={{ background: STATE_COLORS[status.state] }} />
                  {card.agent ? vendorShort(card.agent) : "agent"} · {status.rel}
                </span>
              )}
              {hasChecklist && (
                <span className="chip chip-checklist">
                  {doneCount}/{card.checklist.length}
                </span>
              )}
            </div>
          </>
        )}
      </div>
      {insertLine === "after" && <div className="card-insert" />}
    </div>
  );
}
