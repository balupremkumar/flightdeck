import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { IconBoard, IconWipe, IconPlus, IconClose, IconChevron } from "./Icons";
import { useApp } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import "./Board.css";
import { useBoardStore, archivedCardsOf, lastAgentForRepo, rememberAgentForRepo } from "./board/boardStore";
import { useVendors, agentVendors, vendorShort } from "./vendors";
import { spawnPane } from "./worktrees";
import type { DiffSummary } from "./worktrees";
import { cachedInvoke } from "./poll";
import { CardItem } from "./board/CardItem";
import { CardDetail } from "./board/CardDetail";
import { exportBoardMarkdown } from "./board/markdown";
import { PRIORITY_COLORS } from "./board/palette";
import type { Card, Column, ColumnId, Priority, Vendor } from "./board/types";

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

// UX-570: manage-columns toolbar trigger.
function IconColumns({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.6" y="3.4" width="4.6" height="13.2" rx="1.1" />
      <rect x="7.9" y="3.4" width="4.6" height="13.2" rx="1.1" />
      <rect x="13.2" y="3.4" width="4.2" height="13.2" rx="1.1" />
    </svg>
  );
}

// UX-570: archive toolbar trigger.
function IconArchive({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3.6" width="14" height="3.4" rx="1" />
      <path d="M4.2 7.4 V14.6 a1.3 1.3 0 0 0 1.3 1.3 h9 a1.3 1.3 0 0 0 1.3-1.3 V7.4" />
      <path d="M8 10.6 H12" />
    </svg>
  );
}

// UX-574: template picker toolbar trigger.
function IconTemplate({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.4" y="3.4" width="13.2" height="13.2" rx="2" />
      <path d="M3.4 8 H16.6" />
      <path d="M8 8 V16.6" />
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
// rather than repeating one generic "No tasks yet" everywhere. Keyed by the
// seed column ids — a user-added custom column (UX-570) falls back to a
// generic line below since there's no way to know its intent in advance.
const EMPTY_COPY: Record<string, string> = {
  todo: "No tasks yet. Add one below.",
  inprogress: "Drag a card here to dispatch it to an agent pane.",
  review: "Drag a card here once it's ready for review.",
  complete: "Drag a card here when it's done.",
};

export function Board() {
  const columns = useBoardStore((s) => s.columns);
  const cards = useBoardStore((s) => s.cards);
  const templates = useBoardStore((s) => s.templates);
  const undo = useBoardStore((s) => s.undo);
  const focusCardId = useBoardStore((s) => s.focusCardId);
  const addCard = useBoardStore((s) => s.addCard);
  const moveCard = useBoardStore((s) => s.moveCard);
  const reorderInColumn = useBoardStore((s) => s.reorderInColumn);
  const linkPane = useBoardStore((s) => s.linkPane);
  const reset = useBoardStore((s) => s.reset);
  const addColumn = useBoardStore((s) => s.addColumn);
  const renameColumn = useBoardStore((s) => s.renameColumn);
  const deleteColumn = useBoardStore((s) => s.deleteColumn);
  const reorderColumns = useBoardStore((s) => s.reorderColumns);
  const toggleColumnCollapsed = useBoardStore((s) => s.toggleColumnCollapsed);
  const restoreCard = useBoardStore((s) => s.restoreCard);
  const deleteCard = useBoardStore((s) => s.deleteCard);
  const bulkMove = useBoardStore((s) => s.bulkMove);
  const bulkArchive = useBoardStore((s) => s.bulkArchive);
  const bulkDelete = useBoardStore((s) => s.bulkDelete);
  const undoLast = useBoardStore((s) => s.undoLast);
  const dismissUndo = useBoardStore((s) => s.dismissUndo);
  const deleteTemplate = useBoardStore((s) => s.deleteTemplate);
  const createFromTemplate = useBoardStore((s) => s.createFromTemplate);
  const setFocusCardId = useBoardStore((s) => s.setFocusCardId);

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
  const boardColumnsRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "ALL">("ALL");
  const [agentFilter, setAgentFilter] = useState<Vendor | "ALL">("ALL");
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  // UX-575: only cards currently dispatched to a pane that's actually still open.
  const [liveOnly, setLiveOnly] = useState(false);
  const filtering = query.trim() !== "" || priorityFilter !== "ALL" || agentFilter !== "ALL" || liveOnly;
  const manualOrder = sortMode === "manual" && !filtering;

  // UX-571: bulk-select checkboxes, independent of the single-card keyboard
  // selection above. Shift-click extends the range within one column.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastCheckedRef = useRef<string | null>(null);

  // UX-570: archive panel + manage-columns popover + template picker.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState<{ x: number; y: number } | null>(null);
  const [editingColId, setEditingColId] = useState<ColumnId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newColName, setNewColName] = useState("");
  const [templatePos, setTemplatePos] = useState<{ x: number; y: number } | null>(null);

  // UI-164: priority-stripe legend popover, portalled like the card menus.
  const [legendPos, setLegendPos] = useState<{ x: number; y: number } | null>(null);
  // UX-542/543: shared overlay stack (ui.ts) — Esc handling for each of these
  // three menus, mousedown-outside stays its own local listener below.
  useOverlayEsc(!!legendPos, () => setLegendPos(null));
  useEffect(() => {
    if (!legendPos) return;
    const close = () => setLegendPos(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [legendPos]);

  useOverlayEsc(!!manageOpen, () => { setManageOpen(null); setEditingColId(null); });
  useEffect(() => {
    if (!manageOpen) return;
    const close = () => { setManageOpen(null); setEditingColId(null); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [manageOpen]);

  useOverlayEsc(!!templatePos, () => setTemplatePos(null));
  useEffect(() => {
    if (!templatePos) return;
    const close = () => setTemplatePos(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [templatePos]);

  useEffect(() => {
    if (showComposer) composerInputRef.current?.focus();
  }, [showComposer]);

  // UX-571: the undo toast auto-dismisses — the destructive action already
  // happened, this is just a closing window to walk it back.
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => dismissUndo(), 7000);
    return () => window.clearTimeout(t);
  }, [undo, dismissUndo]);

  // UX-573: a pane-side "jump to card" click (PaneView handoff) lands here.
  useEffect(() => {
    if (!focusCardId) return;
    setDetailId(focusCardId);
    setFocusCardId(null);
  }, [focusCardId, setFocusCardId]);

  function findColumn(id: string): ColumnId | null {
    for (const col of columns) if (cards[col.id]?.some((c) => c.id === id)) return col.id;
    return null;
  }

  // Cards that actually belong on the board face — archived ones never do.
  function activeCards(colId: ColumnId): Card[] {
    return (cards[colId] ?? []).filter((c) => !c.archived);
  }

  function visibleCards(colId: ColumnId): Card[] {
    let list = activeCards(colId);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((c) => c.title.toLowerCase().includes(q) || c.labels.some((l) => l.name.toLowerCase().includes(q)));
    }
    if (priorityFilter !== "ALL") list = list.filter((c) => c.priority === priorityFilter);
    if (agentFilter !== "ALL") list = list.filter((c) => c.agent === agentFilter);
    if (liveOnly) list = list.filter((c) => c.paneId != null && workspaces.some((w) => w.panes.some((p) => p.id === c.paneId)));
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
    // UX-576: explicit pick, then the card's own assigned agent, then the
    // "last used for this repo" rule, and only then whichever agent happens
    // to be first installed — the override on the "Send to…" menu always wins.
    const vendor: Vendor = vendorOverride ?? card.agent ?? lastAgentForRepo(ws.root) ?? agentVendors().find((a) => a.installed)?.id ?? "claude";
    // UI-38: worktree prep can take a few seconds; without a pending state the
    // card sits there looking like the drop did nothing.
    setDispatching((d) => new Set(d).add(card.id));
    // UI-162: the dispatched worktree/branch takes the card's title.
    void spawnPane(activeId, vendor, ws.root, undefined, card.title)
      .then((newPaneId) => {
        if (newPaneId != null) {
          linkPane(card.id, activeId, newPaneId);
          rememberAgentForRepo(ws.root, vendor);
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
    const inProgress = columns.find((c) => c.id === "inprogress")?.id ?? columns[Math.min(1, columns.length - 1)]?.id;
    if (source && inProgress && source !== inProgress) moveCard(card.id, inProgress);
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
      const list = cards[target] ?? [];
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

  // UX-572: edge autoscroll while dragging a card. Scrolls the horizontal
  // column strip when the pointer nears the left/right viewport edge, and the
  // column list currently under the pointer when it nears the top/bottom —
  // driven off the pointer position from the native `dragover` stream (React's
  // onDragOver only fires on elements the drag is directly over, which isn't
  // enough once the pointer is over the gap between columns).
  useEffect(() => {
    if (!dragId) return;
    const EDGE = 64;
    const MAX_SPEED = 18;
    let x = 0;
    let y = 0;
    let raf = 0;
    function onDragOver(e: globalThis.DragEvent) {
      x = e.clientX;
      y = e.clientY;
    }
    function speed(distIntoEdge: number): number {
      return Math.min(MAX_SPEED, Math.max(2, Math.ceil((distIntoEdge / EDGE) * MAX_SPEED)));
    }
    function tick() {
      const el = boardColumnsRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (x > r.left && x - r.left < EDGE) el.scrollLeft -= speed(EDGE - (x - r.left));
        else if (x < r.right && r.right - x < EDGE) el.scrollLeft += speed(EDGE - (r.right - x));
      }
      const hovered = document.elementFromPoint(x, y)?.closest<HTMLElement>(".col-list");
      if (hovered) {
        const r = hovered.getBoundingClientRect();
        if (y > r.top && y - r.top < EDGE) hovered.scrollTop -= speed(EDGE - (y - r.top));
        else if (y < r.bottom && r.bottom - y < EDGE) hovered.scrollTop += speed(EDGE - (r.bottom - y));
      }
      raf = requestAnimationFrame(tick);
    }
    window.addEventListener("dragover", onDragOver);
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      cancelAnimationFrame(raf);
    };
  }, [dragId]);

  // UX-571: toggle a card into/out of the bulk-select set. Shift-click
  // extends a contiguous range within the same column (matches the file
  // Explorer / list-picker convention elsewhere in the app).
  function toggleCheck(id: string, opts: { shiftKey: boolean }) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (opts.shiftKey && lastCheckedRef.current && lastCheckedRef.current !== id) {
        const colId = findColumn(id);
        const lastColId = findColumn(lastCheckedRef.current);
        if (colId && colId === lastColId) {
          const list = visibleCards(colId);
          const a = list.findIndex((c) => c.id === id);
          const b = list.findIndex((c) => c.id === lastCheckedRef.current);
          if (a !== -1 && b !== -1) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) next.add(list[i].id);
            lastCheckedRef.current = id;
            return next;
          }
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      lastCheckedRef.current = id;
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function doBulkMove(target: ColumnId) {
    if (!target || selectedIds.size === 0) return;
    bulkMove(Array.from(selectedIds), target);
    clearSelection();
  }

  function doBulkArchive() {
    if (selectedIds.size === 0) return;
    bulkArchive(Array.from(selectedIds));
    clearSelection();
  }

  function doBulkDelete() {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    requestConfirm({
      title: `Delete ${n} card${n === 1 ? "" : "s"}?`,
      body: "A short Undo window appears on the board right after.",
      confirmLabel: "Delete cards",
      danger: true,
      onConfirm: () => { bulkDelete(Array.from(selectedIds)); clearSelection(); },
    });
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
        const i = columns.findIndex((c) => c.id === colId);
        const next = columns[i + (e.key === "ArrowRight" ? 1 : -1)];
        if (next) performMove(selectedId, next.id);
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && manualOrder) {
        e.preventDefault();
        const list = cards[colId] ?? [];
        const from = list.findIndex((c) => c.id === selectedId);
        const to = e.key === "ArrowUp" ? from - 1 : from + 1;
        if (to >= 0 && to < list.length) reorderInColumn(colId, from, to);
      } else if (e.key === "Escape") {
        setSelectedId(null);
        clearSelection();
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, detailId, cards, columns, manualOrder]);

  function submitComposer() {
    const title = composerTitle.trim();
    if (!title) return;
    addCard(columns[0]?.id ?? "todo", title, composerPriority);
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
      body: "Every card, column, checklist and label is discarded and the board goes back to its seed contents. This can't be undone.",
      confirmLabel: "Reset board",
      danger: true,
      onConfirm: () => {
        cancelComposer();
        setSelectedId(null);
        clearSelection();
        reset();
      },
    });
  }

  async function doExport() {
    try {
      await navigator.clipboard.writeText(exportBoardMarkdown(columns, cards));
      pushToast("success", "Board copied as Markdown");
    } catch {
      pushToast("error", "Couldn't access the clipboard");
    }
  }

  // UX-570: manage-columns popover actions.
  function startRenameCol(col: Column) {
    setEditingColId(col.id);
    setRenameDraft(col.name);
  }
  function commitRenameCol() {
    if (editingColId) renameColumn(editingColId, renameDraft);
    setEditingColId(null);
  }
  function submitAddColumn() {
    const name = newColName.trim();
    if (!name) return;
    addColumn(name);
    setNewColName("");
  }
  function confirmDeleteColumn(col: Column) {
    if (columns.length <= 1) return;
    const count = activeCards(col.id).length;
    requestConfirm({
      title: `Delete "${col.name}"?`,
      body:
        (count > 0
          ? `${count} card${count === 1 ? "" : "s"} in this column move to the neighbouring column — nothing is lost. `
          : "This column has no cards. ") + "Undo is available right after from the board toast.",
      confirmLabel: "Delete column",
      danger: true,
      onConfirm: () => { deleteColumn(col.id); setManageOpen(null); },
    });
  }

  function confirmDeleteForever(c: Card) {
    requestConfirm({
      title: `Delete "${c.title}" forever?`,
      body: "This permanently removes the card and its checklist.",
      confirmLabel: "Delete forever",
      danger: true,
      onConfirm: () => deleteCard(c.id),
    });
  }

  const total = columns.reduce((n, col) => n + activeCards(col.id).length, 0);
  const archived = archivedCardsOf(cards);
  const dragSource = dragId ? findColumn(dragId) : null;
  const firstColId = columns[0]?.id;

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
          <button
            type="button"
            className="board-icon-btn"
            title="Manage columns: add, rename, reorder, collapse or delete"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setManageOpen({ x: r.left, y: r.bottom + 6 });
            }}
          >
            <IconColumns size={15} />
          </button>
          <button
            type="button"
            className="board-icon-btn"
            title="Create a card from a saved template"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setTemplatePos({ x: r.left, y: r.bottom + 6 });
            }}
          >
            <IconTemplate size={15} />
          </button>
          <button
            type="button"
            className={"board-icon-btn" + (archived.length > 0 ? " board-icon-btn-badged" : "")}
            title={`Archived cards (${archived.length}) — hidden but recoverable`}
            onClick={() => setArchiveOpen(true)}
          >
            <IconArchive size={15} />
            {archived.length > 0 && <span className="board-icon-badge">{archived.length}</span>}
          </button>
          <button className="board-icon-btn" title="Copy board as Markdown" onClick={doExport}><IconExport size={16} /></button>
          <button className="board-icon-btn board-icon-btn-danger" title="Reset board: discards every card and column" onClick={refresh}><IconWipe size={17} /></button>
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
          {/* UX-575: cut straight to what's actually running right now. */}
          <label className="board-toggle" title="Show only cards linked to a pane that's still open">
            <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />
            Live panes only
          </label>
        </div>
        <div className="board-project-chip">
          <span className="board-project-name">flightdeck</span>
          <span className="board-project-count">{total}</span>
        </div>
        {/* UX-571: bulk action bar — appears once anything is checked. */}
        {selectedIds.size > 0 && (
          <div className="bulk-bar">
            <span className="bulk-count">{selectedIds.size} selected</span>
            <select
              className="board-filter"
              value=""
              onChange={(e) => { if (e.target.value) doBulkMove(e.target.value); }}
            >
              <option value="">Move to…</option>
              {columns.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </select>
            <button type="button" className="btn-ghost" onClick={doBulkArchive}>Archive</button>
            <button type="button" className="btn-danger" onClick={doBulkDelete}>Delete</button>
            <span className="board-spacer" />
            <button type="button" className="btn-ghost" onClick={clearSelection}>Clear selection</button>
          </div>
        )}
      </div>

      <div
        className="board-columns"
        ref={boardColumnsRef}
        onClick={(e) => { if (e.target === e.currentTarget) { setSelectedId(null); clearSelection(); } }}
      >
        {columns.map((col) => {
          const list = visibleCards(col.id);
          const activeCount = activeCards(col.id).length;
          const overLimit = col.wip != null && activeCount > col.wip;
          const isFirst = col.id === firstColId;
          return (
            <div
              key={col.id}
              className={`col${dragOverCol === col.id ? " col-drop-active" : ""}${col.collapsed ? " col-collapsed" : ""}`}
              style={{ "--col-accent": col.accent } as CSSProperties}
              onDragOver={handleColDragOver}
              onDragEnter={() => handleColDragEnter(col.id)}
              onDragLeave={handleColDragLeave}
              onDrop={() => handleDrop(col.id)}
            >
              <div className="col-accent" style={{ background: col.accent }} />
              <div className="col-header">
                <button
                  type="button"
                  className="col-collapse-btn"
                  title={col.collapsed ? "Expand column" : "Collapse column"}
                  onClick={() => toggleColumnCollapsed(col.id)}
                >
                  <IconChevron size={11} style={{ transform: col.collapsed ? "rotate(-90deg)" : undefined }} />
                </button>
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
                  {activeCount}{col.wip != null ? `/${col.wip}` : ""}
                </span>
                {isFirst && (
                  <button type="button" className="col-add-btn" title="New task" onClick={() => setShowComposer(true)}>
                    <IconPlus size={12} />
                  </button>
                )}
              </div>
              <div className="col-list">
                {isFirst && showComposer && (
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
                {list.length === 0 && !(isFirst && showComposer) && (
                  <div className="col-empty">
                    <span className="col-empty-icon"><IconBoard size={16} /></span>
                    <span>{filtering ? "No cards match" : (EMPTY_COPY[col.id] ?? (isFirst ? "No cards yet. Add one below." : "Drag a card here."))}</span>
                  </div>
                )}
                {list.map((card) => (
                  <CardItem
                    key={card.id}
                    card={card}
                    colId={col.id}
                    isDragging={dragId === card.id}
                    isSelected={selectedId === card.id}
                    isChecked={selectedIds.has(card.id)}
                    isCompleting={completing.has(card.id)}
                    isDispatching={dispatching.has(card.id)}
                    insertLine={dragOverCard && dragOverCard.id === card.id ? (dragOverCard.before ? "before" : "after") : null}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onCardDragOver={handleCardDragOver}
                    onSelect={setSelectedId}
                    onToggleCheck={toggleCheck}
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

      {/* UX-570: manage columns — add / rename / reorder / collapse / delete, one place. */}
      {manageOpen && createPortal(
        <div
          className="bd-pop manage-columns-pop"
          style={{ top: manageOpen.y, left: manageOpen.x }}
          onMouseDown={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Manage columns"
        >
          <div className="bd-pop-head">Columns</div>
          {columns.map((col, i) => (
            <div key={col.id} className="mc-row">
              {editingColId === col.id ? (
                <input
                  className="mc-rename-input"
                  value={renameDraft}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={commitRenameCol}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitRenameCol(); }
                    else if (e.key === "Escape") { e.preventDefault(); setEditingColId(null); }
                  }}
                />
              ) : (
                <button type="button" className="mc-name-btn" onClick={() => startRenameCol(col)} title="Click to rename">
                  {col.name}
                </button>
              )}
              <span className="mc-count">{activeCards(col.id).length}</span>
              <button type="button" className="mc-icon-btn" title="Move earlier" disabled={i === 0} onClick={() => reorderColumns(i, i - 1)}>‹</button>
              <button type="button" className="mc-icon-btn" title="Move later" disabled={i === columns.length - 1} onClick={() => reorderColumns(i, i + 1)}>›</button>
              <button type="button" className="mc-icon-btn" title={col.collapsed ? "Expand" : "Collapse"} onClick={() => toggleColumnCollapsed(col.id)}>
                <IconChevron size={10} style={{ transform: col.collapsed ? "rotate(-90deg)" : undefined }} />
              </button>
              <button
                type="button"
                className="mc-icon-btn mc-delete"
                title={columns.length <= 1 ? "The board needs at least one column" : "Delete column"}
                disabled={columns.length <= 1}
                onClick={() => confirmDeleteColumn(col)}
              >
                <IconClose size={10} />
              </button>
            </div>
          ))}
          <div className="mc-add-row">
            <input
              className="mc-add-input"
              placeholder="New column name…"
              value={newColName}
              onChange={(e) => setNewColName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitAddColumn(); } }}
            />
            <button type="button" className="btn-primary mc-add-btn" onClick={submitAddColumn}>Add</button>
          </div>
        </div>,
        document.body
      )}

      {/* UX-574: create a card from a saved template. */}
      {templatePos && createPortal(
        <div
          className="bd-pop template-pop"
          style={{ top: templatePos.y, left: templatePos.x }}
          onMouseDown={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Create from template"
        >
          <div className="bd-pop-head">Create from template</div>
          {templates.length === 0 && (
            <div className="bd-pop-hint bd-pop-empty">No templates yet — open a card and "Save as template".</div>
          )}
          {templates.map((t) => (
            <div key={t.id} className="template-pop-row">
              <button
                type="button"
                className="bd-pop-item template-use-btn"
                onClick={() => {
                  if (!firstColId) return;
                  const id = createFromTemplate(firstColId, t.id);
                  setTemplatePos(null);
                  if (id) pushToast("success", `Created "${t.title}" from "${t.name}"`);
                }}
              >
                {t.name}
              </button>
              <button
                type="button"
                className="template-del-btn"
                title="Delete this template"
                onClick={(e) => { e.stopPropagation(); deleteTemplate(t.id); }}
                aria-label={`Delete template ${t.name}`}
              >
                <IconClose size={10} />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}

      {/* UX-570: archive panel — hidden cards, always recoverable. */}
      {archiveOpen && createPortal(
        <div className="ov-scrim" onMouseDown={() => setArchiveOpen(false)}>
          <div className="archive-panel" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Archived cards">
            <div className="cd-head">
              <div className="archive-title">Archived cards ({archived.length})</div>
              <button className="ov-x" onClick={() => setArchiveOpen(false)} title="Close"><IconClose size={15} /></button>
            </div>
            <div className="archive-body">
              {archived.length === 0 && <div className="cd-empty-hint archive-empty">Nothing archived. Archive a card from its detail view to hide it here without deleting it.</div>}
              {archived.map((c) => (
                <div key={c.id} className="archive-row">
                  <span className="archive-row-title">{c.title}</span>
                  <span
                    className="chip chip-priority"
                    style={{ color: PRIORITY_COLORS[c.priority], borderColor: PRIORITY_COLORS[c.priority], background: `color-mix(in srgb, ${PRIORITY_COLORS[c.priority]} 14%, transparent)` }}
                  >
                    {c.priority}
                  </span>
                  <span className="board-spacer" />
                  <button type="button" className="btn-ghost" onClick={() => restoreCard(c.id)}>Restore</button>
                  <button type="button" className="btn-danger" onClick={() => confirmDeleteForever(c)}>Delete forever</button>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* UX-571: undo toast for the last destructive board action. */}
      {undo && (
        <div className="undo-toast" role="status">
          <span className="undo-text">{undo.label}</span>
          <button type="button" className="undo-btn" onClick={undoLast}>Undo</button>
          <button type="button" className="undo-dismiss" onClick={dismissUndo} aria-label="Dismiss">
            <IconClose size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
