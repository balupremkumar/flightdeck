import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { IconBoard, IconWipe, IconPlus } from "./Icons";
import { useApp } from "./store";
import { useUI } from "./ui";
import "./Board.css";
import { useBoardStore, COLUMNS } from "./board/boardStore";
import { useVendors, agentVendors, vendorShort } from "./vendors";
import { spawnPane } from "./worktrees";
import type { DiffSummary } from "./worktrees";
import { cachedInvoke } from "./poll";
import { CardItem } from "./board/CardItem";
import { CardDetail } from "./board/CardDetail";
import { exportBoardMarkdown } from "./board/markdown";
import { PRIORITY_COLORS } from "./board/palette";
import type { Card, ColumnId, Priority, Vendor } from "./board/types";

type SortMode = "manual" | "priority" | "newest";
const PRIORITY_RANK: Record<Priority, number> = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function IconExport({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3 V12.5" />
      <path d="M6.5 9 L10 12.5 L13.5 9" />
      <path d="M4 15.5 H16" />
    </svg>
  );
}

// UI-164: priority-stripe legend trigger.
function IconInfo({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 9.2 V14.2" />
      <circle cx="10" cy="6.3" r="0.4" fill="currentColor" />
    </svg>
  );
}

// UI-164: the meaning behind PRIORITY_COLORS' grey -> blue -> gold -> red ramp.
const PRIORITY_LEGEND: Record<Priority, string> = {
  LOW: "No urgency — pick up when nothing higher is queued.",
  MEDIUM: "Default weight — normal queue order.",
  HIGH: "Needs attention soon — pulled ahead of Medium/Low.",
  CRITICAL: "Urgent or blocking — treat as jump-the-queue.",
};

// ui-states: an empty column is onboarding, not a dead end, so each one says
// what belongs there in terms of what the USER does next (drag, not "wait"),
// rather than repeating one generic "No tasks yet" everywhere. To Do is the
// one column cards can be typed straight into, so its copy points at the
// composer instead of a drag gesture.
const EMPTY_COPY: Record<ColumnId, string> = {
  todo: "No tasks yet. Add one below.",
  inprogress: "Drag a card here to dispatch it to an agent pane.",
  review: "Drag a card here once it's ready for review.",
  complete: "Drag a card here when it's done.",
};

export function Board() {
  const cards = useBoardStore((s) => s.cards);
  const addCard = useBoardStore((s) => s.addCard);
  const moveCard = useBoardStore((s) => s.moveCard);
  const reorderInColumn = useBoardStore((s) => s.reorderInColumn);
  const linkPane = useBoardStore((s) => s.linkPane);
  const reset = useBoardStore((s) => s.reset);

  const activeId = useApp((s) => s.activeId);
  const workspaces = useApp((s) => s.workspaces);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);
  const vendors = useVendors((s) => s.vendors);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ColumnId | null>(null);
  const [dragOverCard, setDragOverCard] = useState<{ id: string; before: boolean } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // UI-38: cards mid-dispatch, so the wait is visible on the card itself.
  const [dispatching, setDispatching] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Set<string>>(new Set());
  const [showComposer, setShowComposer] = useState(false);
  const [composerTitle, setComposerTitle] = useState("");
  const [composerPriority, setComposerPriority] = useState<Priority>("MEDIUM");
  const composerInputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "ALL">("ALL");
  const [agentFilter, setAgentFilter] = useState<Vendor | "ALL">("ALL");
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  const filtering = query.trim() !== "" || priorityFilter !== "ALL" || agentFilter !== "ALL";
  const manualOrder = sortMode === "manual" && !filtering;

  // UI-164: priority-stripe legend popover, portalled like the card menus.
  const [legendPos, setLegendPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!legendPos) return;
    const close = () => setLegendPos(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLegendPos(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true); // capture: xterm swallows Escape otherwise
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey, true); };
  }, [legendPos]);

  useEffect(() => {
    if (showComposer) composerInputRef.current?.focus();
  }, [showComposer]);

  function findColumn(id: string): ColumnId | null {
    for (const col of COLUMNS) if (cards[col.id].some((c) => c.id === id)) return col.id;
    return null;
  }

  function visibleCards(colId: ColumnId): Card[] {
    let list = cards[colId];
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((c) => c.title.toLowerCase().includes(q) || c.labels.some((l) => l.name.toLowerCase().includes(q)));
    }
    if (priorityFilter !== "ALL") list = list.filter((c) => c.priority === priorityFilter);
    if (agentFilter !== "ALL") list = list.filter((c) => c.agent === agentFilter);
    if (sortMode === "priority") list = [...list].sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
    else if (sortMode === "newest") list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }

  // Card -> pane dispatch (BACKLOG D11 / R7): dropping (or moving) a card into
  // In Progress spawns an agent pane rooted at the active workspace and links
  // the card to it, so its live state can drive the card's status dot. Goes
  // through the async worktree-aware spawn path — a dispatched agent gets its
  // own isolated worktree exactly like a hand-added pane.
  // UI-158: `vendorOverride` lets "Send to agent…" pick a vendor explicitly,
  // instead of only ever falling back to the card's preset agent or whichever
  // agent happens to be first installed.
  function dispatchToPane(card: Card, vendorOverride?: Vendor) {
    if (card.paneId != null && workspaces.some((w) => w.panes.some((p) => p.id === card.paneId))) return; // already live
    if (activeId == null) {
      pushToast("info", "Open a workspace to dispatch this card to an agent pane.");
      return;
    }
    const ws = workspaces.find((w) => w.id === activeId);
    if (!ws) return;
    // Prefer an explicit override, then the card's agent, else the first installed agent the registry knows.
    const vendor: Vendor = vendorOverride ?? card.agent ?? agentVendors().find((a) => a.installed)?.id ?? "claude";
    // UI-38: worktree prep can take a few seconds; without a pending state the
    // card sits there looking like the drop did nothing.
    setDispatching((d) => new Set(d).add(card.id));
    // UI-162: the dispatched worktree/branch takes the card's title.
    void spawnPane(activeId, vendor, ws.root, undefined, card.title)
      .then((newPaneId) => {
        if (newPaneId != null) {
          linkPane(card.id, activeId, newPaneId);
          pushToast("success", `Dispatched "${card.title}" to ${vendorShort(vendor)}`);
        } else {
          pushToast("error", `Couldn't dispatch "${card.title}" — the pane didn't start.`);
        }
      })
      .catch((e) => pushToast("error", `Couldn't dispatch "${card.title}": ${String(e)}`))
      .finally(() => setDispatching((d) => { const n = new Set(d); n.delete(card.id); return n; }));
  }

  // UI-158: card context action — pick the vendor instead of taking whatever
  // dispatchToPane would default to. Moves the card into In Progress too, same
  // as the drag path, so a dispatched card's column always matches reality.
  function sendToAgent(card: Card, vendor: Vendor) {
    const source = findColumn(card.id);
    if (source && source !== "inprogress") moveCard(card.id, "inprogress");
    dispatchToPane(card, vendor);
  }

  function flashComplete(id: string) {
    setCompleting((s) => new Set(s).add(id));
    window.setTimeout(() => {
      setCompleting((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }, 650);
  }

  function finishMove(id: string, target: ColumnId, source: ColumnId, card: Card | undefined, index?: number) {
    moveCard(id, target, index);
    if (target === "inprogress" && source !== "inprogress" && card) dispatchToPane(card);
    if (target === "complete" && source !== "complete") flashComplete(id);
  }

  // UI-163: honesty gate, not a hard block — a card's linked pane can still be
  // sitting on unmerged work when the card itself gets dragged to Done, and
  // nothing else in the UI says so. Checked live (not from the stale status
  // dot) so it reflects whatever the pane's worktree actually holds right now.
  async function unmergedDiffFor(card: Card): Promise<{ files: number; added: number; deleted: number } | null> {
    if (card.paneId == null) return null;
    const pane = workspaces.flatMap((w) => w.panes).find((p) => p.id === card.paneId);
    if (!pane) return null;
    try {
      const s = await cachedInvoke<DiffSummary>("git_diff_summary", { cwd: pane.cwd, base: pane.baseBranch ?? null }, 5000);
      return s.files.length > 0 ? { files: s.files.length, added: s.totalAdded, deleted: s.totalDeleted } : null;
    } catch {
      return null; // can't read the diff — don't block on an unknown
    }
  }

  function performMove(id: string, target: ColumnId, index?: number) {
    const source = findColumn(id);
    if (!source || (source === target && index === undefined)) return;
    const card = cards[source]?.find((c) => c.id === id);
    if (target === "complete" && source !== "complete" && card) {
      void unmergedDiffFor(card).then((diff) => {
        if (!diff) { finishMove(id, target, source, card, index); return; }
        requestConfirm({
          title: "Move to Done with unmerged work?",
          body:
            `"${card.title}"'s pane still has ${diff.files} file${diff.files === 1 ? "" : "s"} of changes ` +
            `(+${diff.added}/−${diff.deleted}) that haven't been merged back. Moving it to Done doesn't merge or ` +
            `discard that work — it stays exactly where it is in the pane's worktree until you deal with it.`,
          confirmLabel: "Move to Done anyway",
          onConfirm: () => finishMove(id, target, source, card, index),
        });
      });
      return;
    }
    finishMove(id, target, source, card, index);
  }

  function handleDragStart(e: DragEvent<HTMLDivElement>, card: Card) {
    const node = e.currentTarget;
    const rect = node.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    const ghost = node.cloneNode(true) as HTMLDivElement;
    ghost.style.position = "fixed";
    ghost.style.top = "-9999px";
    ghost.style.left = "-9999px";
    ghost.style.width = `${rect.width}px`;
    ghost.style.transform = "scale(1.02) rotate(1.5deg)";
    ghost.style.boxShadow = "0 18px 40px rgba(0, 0, 0, 0.55)";
    ghost.style.opacity = "0.92";
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, offsetX, offsetY);
    e.dataTransfer.effectAllowed = "move";
    window.setTimeout(() => {
      ghost.parentNode?.removeChild(ghost);
    }, 0);

    setDragId(card.id);
    setSelectedId(card.id);
  }

  function handleDragEnd() {
    setDragId(null);
    setDragOverCol(null);
    setDragOverCard(null);
  }

  function handleColDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (e.target === e.currentTarget) setDragOverCard(null);
  }

  function handleColDragEnter(colId: ColumnId) {
    if (dragId) setDragOverCol(colId);
  }

  function handleColDragLeave(e: DragEvent<HTMLDivElement>) {
    const related = e.relatedTarget as Node | null;
    if (!related || !e.currentTarget.contains(related)) {
      setDragOverCol(null);
      setDragOverCard(null);
    }
  }

  function handleCardDragOver(e: DragEvent<HTMLDivElement>, card: Card) {
    e.preventDefault();
    if (!dragId || dragId === card.id || !manualOrder) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDragOverCard((prev) => (prev && prev.id === card.id && prev.before === before ? prev : { id: card.id, before }));
  }

  function handleDrop(target: ColumnId) {
    setDragOverCol(null);
    const dropOnCard = dragOverCard;
    setDragOverCard(null);
    if (!dragId) return;
    const source = findColumn(dragId);
    if (!source) {
      setDragId(null);
      return;
    }

    if (manualOrder && dropOnCard && dropOnCard.id !== dragId) {
      const list = cards[target];
      let idx = list.findIndex((c) => c.id === dropOnCard.id);
      if (idx === -1) idx = list.length;
      else if (!dropOnCard.before) idx += 1;
      if (source === target) {
        const from = list.findIndex((c) => c.id === dragId);
        let to = idx;
        if (from < to) to -= 1;
        reorderInColumn(target, from, to);
      } else {
        performMove(dragId, target, idx);
      }
    } else if (source !== target) {
      performMove(dragId, target);
    }
    setDragId(null);
  }

  // Keyboard card moves (BACKLOG D24): select a card by clicking it, then
  // Left/Right moves it a column over, Up/Down reorders it in place (manual
  // sort only — filtered/sorted views can't express a stable manual index).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!selectedId || detailId) return;
      const el = e.target as HTMLElement | null;
      if (el && /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
      const colId = findColumn(selectedId);
      if (!colId) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const i = COLUMNS.findIndex((c) => c.id === colId);
        const next = COLUMNS[i + (e.key === "ArrowRight" ? 1 : -1)];
        if (next) performMove(selectedId, next.id);
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && manualOrder) {
        e.preventDefault();
        const list = cards[colId];
        const from = list.findIndex((c) => c.id === selectedId);
        const to = e.key === "ArrowUp" ? from - 1 : from + 1;
        if (to >= 0 && to < list.length) reorderInColumn(colId, from, to);
      } else if (e.key === "Escape") {
        setSelectedId(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, detailId, cards, manualOrder]);

  function submitComposer() {
    const title = composerTitle.trim();
    if (!title) return;
    addCard("todo", title, composerPriority);
    setComposerTitle("");
    setComposerPriority("MEDIUM");
    setShowComposer(false);
  }

  function cancelComposer() {
    setComposerTitle("");
    setComposerPriority("MEDIUM");
    setShowComposer(false);
  }

  // Destructive: throws away every card and re-seeds. Same guard as the other
  // destructive actions — it sits next to "Copy as Markdown" with equal weight.
  function refresh() {
    requestConfirm({
      title: "Reset the board?",
      body: "Every card, checklist and label is discarded and the board goes back to its seed contents. This can't be undone.",
      confirmLabel: "Reset board",
      danger: true,
      onConfirm: () => {
        cancelComposer();
        setSelectedId(null);
        reset();
      },
    });
  }

  async function doExport() {
    try {
      await navigator.clipboard.writeText(exportBoardMarkdown(cards));
      pushToast("success", "Board copied as Markdown");
    } catch {
      pushToast("error", "Couldn't access the clipboard");
    }
  }

  const total = COLUMNS.reduce((n, col) => n + cards[col.id].length, 0);
  const dragSource = dragId ? findColumn(dragId) : null;

  return (
    <div className="board">
      <div className="board-header">
        <div className="board-title-row">
          <span className="board-glyph"><IconBoard size={18} /></span>
          <div className="board-title-group">
            <div className="board-title">Board</div>
            <div className="board-subtitle">drag a card to In Progress to dispatch it to an agent pane</div>
          </div>
          <span className="board-spacer" />
          <button className="board-icon-btn" title="Copy board as Markdown" onClick={doExport}><IconExport size={16} /></button>
          <button className="board-icon-btn board-icon-btn-danger" title="Reset board: discards every card" onClick={refresh}><IconWipe size={17} /></button>
          <button className="board-new-btn" onClick={() => setShowComposer(true)}><IconPlus size={15} /> New Task</button>
        </div>
        <div className="board-toolbar">
          <input
            className="board-search"
            type="text"
            placeholder="Search title or label…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="board-filter" value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as Priority | "ALL")}>
            <option value="ALL">All priorities</option>
            {PRIORITIES.map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
          {/* UI-164: what the card-face priority stripe's colours mean. */}
          <button
            type="button"
            className="board-icon-btn board-legend-btn"
            title="What do the priority colours mean?"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setLegendPos({ x: r.left, y: r.bottom + 6 });
            }}
          >
            <IconInfo size={16} />
          </button>
          <select className="board-filter" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value as Vendor | "ALL")}>
            <option value="ALL">All agents</option>
            {vendors.filter((v) => v.kind === "agent").map((v) => (<option key={v.id} value={v.id}>{v.label}</option>))}
          </select>
          <select className="board-filter" value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
            <option value="manual">Manual order</option>
            <option value="priority">Sort: Priority</option>
            <option value="newest">Sort: Newest</option>
          </select>
        </div>
        <div className="board-project-chip">
          <span className="board-project-name">flightdeck</span>
          <span className="board-project-count">{total}</span>
        </div>
      </div>

      <div className="board-columns" onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}>
        {COLUMNS.map((col) => {
          const list = visibleCards(col.id);
          const overLimit = col.wip != null && cards[col.id].length > col.wip;
          return (
            <div
              key={col.id}
              className={`col${dragOverCol === col.id ? " col-drop-active" : ""}`}
              style={{ "--col-accent": col.accent } as CSSProperties}
              onDragOver={handleColDragOver}
              onDragEnter={() => handleColDragEnter(col.id)}
              onDragLeave={handleColDragLeave}
              onDrop={() => handleDrop(col.id)}
            >
              <div className="col-accent" style={{ background: col.accent }} />
              <div className="col-header">
                <span className="col-icon" style={{ background: col.accent }} />
                <span className="col-name">{col.name.toUpperCase()}</span>
                <span
                  className={"col-count" + (overLimit ? " col-count-over" : "")}
                  title={
                    col.wip == null
                      ? undefined
                      : overLimit
                        // UI-24: turning red without saying why leaves the user
                        // guessing whether they broke something.
                        ? `Over the WIP limit of ${col.wip}. Too much in flight at once means slower finishes — this is a nudge, not a block.`
                        : `WIP limit ${col.wip} — a soft cap on how much sits here at once.`
                  }
                >
                  {cards[col.id].length}{col.wip != null ? `/${col.wip}` : ""}
                </span>
                {col.id === "todo" && (
                  <button type="button" className="col-add-btn" title="New task" onClick={() => setShowComposer(true)}>
                    <IconPlus size={12} />
                  </button>
                )}
              </div>
              <div className="col-list">
                {col.id === "todo" && showComposer && (
                  <div className="card card-composer">
                    <input
                      ref={composerInputRef}
                      className="composer-input"
                      type="text"
                      placeholder="Task title…"
                      value={composerTitle}
                      onChange={(e) => setComposerTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          submitComposer();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelComposer();
                        }
                      }}
                    />
                    <div className="composer-row">
                      <select className="composer-select" value={composerPriority} onChange={(e) => setComposerPriority(e.target.value as Priority)}>
                        <option value="LOW">Low</option>
                        <option value="MEDIUM">Medium</option>
                        <option value="HIGH">High</option>
                        <option value="CRITICAL">Critical</option>
                      </select>
                      <span className="board-spacer" />
                      <button type="button" className="composer-cancel" onClick={cancelComposer}>Cancel</button>
                      <button type="button" className="composer-add" onClick={submitComposer}>Add</button>
                    </div>
                  </div>
                )}
                {list.length === 0 && !(col.id === "todo" && showComposer) && (
                  <div className="col-empty">
                    <span className="col-empty-icon"><IconBoard size={16} /></span>
                    <span>{filtering ? "No cards match" : EMPTY_COPY[col.id]}</span>
                  </div>
                )}
                {list.map((card) => (
                  <CardItem
                    key={card.id}
                    card={card}
                    colId={col.id}
                    isDragging={dragId === card.id}
                    isSelected={selectedId === card.id}
                    isCompleting={completing.has(card.id)}
                    isDispatching={dispatching.has(card.id)}
                    insertLine={dragOverCard && dragOverCard.id === card.id ? (dragOverCard.before ? "before" : "after") : null}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onCardDragOver={handleCardDragOver}
                    onSelect={setSelectedId}
                    onOpenDetail={setDetailId}
                    onSendToAgent={sendToAgent}
                  />
                ))}
                {dragOverCol === col.id && dragSource && dragSource !== col.id && !dragOverCard && (
                  <div className="drop-slot">Drop here</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {detailId && <CardDetail cardId={detailId} onClose={() => setDetailId(null)} />}

      {legendPos && createPortal(
        <div
          className="bd-pop pri-legend"
          style={{ top: legendPos.y, left: legendPos.x }}
          onMouseDown={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Priority colour legend"
        >
          <div className="bd-pop-head">Priority stripe</div>
          {PRIORITIES.map((p) => (
            <div key={p} className="pri-legend-row">
              <span className="pri-legend-dot" style={{ background: PRIORITY_COLORS[p] }} />
              <span className="pri-legend-name">{p}</span>
              <span className="pri-legend-desc">{PRIORITY_LEGEND[p]}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
