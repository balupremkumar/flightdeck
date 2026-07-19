import { useEffect, useState } from "react";
import { useApp } from "../store";
import { useUI } from "../ui";
import { IconClose } from "../Icons";
import { useBoardStore, makeId, LABEL_SWATCHES } from "./boardStore";
import { useVendors } from "../vendors";
import { usePaneStatus } from "./usePaneStatus";
import { STATE_COLORS, STATE_LABELS } from "./palette";
import type { Priority, Vendor } from "./types";

const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function CardDetail({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const card = useBoardStore((s) => {
    for (const list of Object.values(s.cards)) {
      const found = list.find((c) => c.id === cardId);
      if (found) return found;
    }
    return null;
  });
  const updateCard = useBoardStore((s) => s.updateCard);
  const deleteCard = useBoardStore((s) => s.deleteCard);
  const toggleChecklist = useBoardStore((s) => s.toggleChecklist);
  const addChecklistItem = useBoardStore((s) => s.addChecklistItem);
  const removeChecklistItem = useBoardStore((s) => s.removeChecklistItem);
  const addLabel = useBoardStore((s) => s.addLabel);
  const removeLabel = useBoardStore((s) => s.removeLabel);

  const workspaces = useApp((s) => s.workspaces);
  const requestConfirm = useUI((s) => s.requestConfirm);
  const pushToast = useUI((s) => s.pushToast);
  const vendors = useVendors((s) => s.vendors);

  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [newItem, setNewItem] = useState("");
  const [labelMenu, setLabelMenu] = useState(false);
  const status = usePaneStatus(card?.paneId);
  const ws = card?.wsId != null ? workspaces.find((w) => w.id === card.wsId) : undefined;

  useEffect(() => {
    setTitle(card?.title ?? "");
    setDescription(card?.description ?? "");
  }, [card?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!card) return null;

  const commitTitle = () => {
    const t = title.trim();
    if (t && t !== card.title) updateCard(card.id, { title: t });
    else setTitle(card.title);
  };
  const commitDescription = () => {
    if (description !== card.description) updateCard(card.id, { description });
  };
  const submitItem = () => {
    const t = newItem.trim();
    if (!t) return;
    addChecklistItem(card.id, t);
    setNewItem("");
  };
  const doDelete = () => {
    requestConfirm({
      title: `Delete "${card.title}"?`,
      body: "This removes the card and its checklist. It can't be undone.",
      confirmLabel: "Delete card",
      danger: true,
      onConfirm: () => {
        deleteCard(card.id);
        pushToast("info", "Card deleted");
        onClose();
      },
    });
  };
  const copyMarkdown = async () => {
    const lines = [`- [ ] **${card.title}** _(${card.priority})_`];
    if (card.description.trim()) lines.push(`  > ${card.description.trim()}`);
    for (const item of card.checklist) lines.push(`  - [${item.done ? "x" : " "}] ${item.text}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast("success", "Card copied as Markdown");
    } catch {
      pushToast("error", "Couldn't access the clipboard");
    }
  };

  const doneCount = card.checklist.filter((i) => i.done).length;
  const usedNames = new Set(card.labels.map((l) => l.name));

  return (
    <div className="ov-scrim" onMouseDown={onClose}>
      <div className="card-detail" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Card detail">
        <div className="cd-head">
          <input
            className="cd-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <button className="ov-x" onClick={onClose} title="Close"><IconClose size={15} /></button>
        </div>

        <div className="cd-body">
          <div className="cd-row">
            <label className="cd-label">Priority</label>
            <select className="cd-select" value={card.priority} onChange={(e) => updateCard(card.id, { priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (<option key={p} value={p}>{p}</option>))}
            </select>

            <label className="cd-label">Agent</label>
            <select
              className="cd-select"
              value={card.agent ?? ""}
              onChange={(e) => updateCard(card.id, { agent: (e.target.value || undefined) as Vendor | undefined })}
            >
              <option value="">Unassigned</option>
              {vendors.filter((v) => v.kind === "agent").map((v) => (<option key={v.id} value={v.id}>{v.label}</option>))}
            </select>
          </div>

          {status && (
            <div className="cd-pane-status">
              <span className="chip-agent-dot" style={{ background: STATE_COLORS[status.state] }} />
              Live in {ws?.name ?? "a workspace"} — {STATE_LABELS[status.state]}, updated {status.rel}
            </div>
          )}

          <div className="cd-section">
            <label className="cd-label">Description</label>
            <textarea
              className="cd-textarea"
              rows={3}
              placeholder="What's this task, and what does done look like?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={commitDescription}
            />
          </div>

          <div className="cd-section">
            <div className="cd-section-head">
              <label className="cd-label">Labels</label>
              <button type="button" className="cd-add-link" onClick={() => setLabelMenu((v) => !v)}>+ Add</button>
            </div>
            <div className="cd-labels">
              {card.labels.map((l) => (
                <span key={l.id} className="label-chip" style={{ background: `color-mix(in srgb, var(${l.colorVar}) 18%, transparent)`, color: `var(${l.colorVar})` }}>
                  {l.name}
                  <button type="button" className="label-x" onClick={() => removeLabel(card.id, l.id)} aria-label={`Remove ${l.name}`}>×</button>
                </span>
              ))}
              {card.labels.length === 0 && <span className="cd-empty-hint">No labels yet.</span>}
            </div>
            {labelMenu && (
              <div className="cd-swatch-menu">
                {LABEL_SWATCHES.filter((sw) => !usedNames.has(sw.name)).map((sw) => (
                  <button
                    key={sw.name}
                    type="button"
                    className="cd-swatch"
                    style={{ color: `var(${sw.colorVar})` }}
                    onClick={() => {
                      addLabel(card.id, { id: makeId("lbl"), name: sw.name, colorVar: sw.colorVar });
                      setLabelMenu(false);
                    }}
                  >
                    <span className="cd-swatch-dot" style={{ background: `var(${sw.colorVar})` }} />
                    {sw.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="cd-section">
            <div className="cd-section-head">
              <label className="cd-label">Checklist</label>
              {card.checklist.length > 0 && <span className="cd-progress-text">{doneCount}/{card.checklist.length}</span>}
            </div>
            {card.checklist.length > 0 && (
              <div className="card-checklist-bar cd-bar">
                <div className="card-checklist-fill" style={{ width: `${(doneCount / card.checklist.length) * 100}%` }} />
              </div>
            )}
            <div className="cd-checklist">
              {card.checklist.map((item) => (
                <div className="cd-check-row" key={item.id}>
                  <input type="checkbox" checked={item.done} onChange={() => toggleChecklist(card.id, item.id)} />
                  <span className={"cd-check-text" + (item.done ? " done" : "")}>{item.text}</span>
                  <button type="button" className="label-x" onClick={() => removeChecklistItem(card.id, item.id)} aria-label="Remove item">×</button>
                </div>
              ))}
            </div>
            <input
              className="cd-new-item"
              placeholder="Add a checklist item…"
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submitItem(); }
              }}
            />
          </div>
        </div>

        <div className="cd-foot">
          <button className="btn-danger" onClick={doDelete}>Delete card</button>
          <span className="board-spacer" />
          <button className="btn-ghost" onClick={copyMarkdown}>Copy as Markdown</button>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
