import { create } from "zustand";
import type {
  BoardCards, BoardDoc, Card, CardTemplate, ChecklistItem, Column, ColumnId, Label, Priority, Vendor,
} from "./types";

// Deep Cove accents as theme tokens (not hex) so the board flips correctly in
// light mode. Column ramp reads grey -> azure -> ice -> aqua(done).
export const DEFAULT_COLUMNS: Column[] = [
  { id: "todo", name: "To Do", accent: "var(--st-idle)" },
  { id: "inprogress", name: "In Progress", accent: "var(--accent)", wip: 4 },
  { id: "review", name: "In Review", accent: "var(--ice)" },
  { id: "complete", name: "Complete", accent: "var(--aqua)" },
];

// UX-570: a user-added column still needs a colour — cycle the same ramp
// (then repeat) rather than leaving it grey forever.
const ACCENT_CYCLE = ["var(--st-idle)", "var(--accent)", "var(--ice)", "var(--aqua)", "var(--st-waiting)", "var(--agent-claude)"];

let seq = 1;
export function makeId(prefix = "card"): string {
  return `${prefix}-${seq++}`;
}
function makeColumnId(): ColumnId {
  return `col-${seq++}`;
}

function mkLabel(name: string, colorVar: string): Label {
  return { id: makeId("lbl"), name, colorVar };
}
function mkChecklist(items: Array<[string, boolean]>): ChecklistItem[] {
  return items.map(([text, done]) => ({ id: makeId("chk"), text, done }));
}

function card(partial: Partial<Card> & { title: string }): Card {
  return {
    id: makeId(),
    description: "",
    priority: "MEDIUM",
    labels: [],
    checklist: [],
    createdAt: Date.now(),
    ...partial,
  };
}

const L_GUIDE = mkLabel("guide", "--ice");

// Generic onboarding seed (QOL 292) — teaches the board's mechanics without
// shipping anyone's personal task list to a fresh install.
function seedCards(): BoardCards {
  return {
    todo: [
      card({
        title: "Drag a card into In Progress — an agent picks it up",
        priority: "HIGH",
        labels: [L_GUIDE],
        description: "Dropping a card into In Progress spawns an agent pane in your active workspace and links it to the card, so live status shows right here.",
      }),
      card({
        title: "Click a card to open its detail view",
        priority: "MEDIUM",
        labels: [L_GUIDE],
        checklist: mkChecklist([
          ["Add a description", false],
          ["Add labels and a checklist", false],
          ["Assign an agent", false],
        ]),
      }),
      card({ title: "Add your own tasks with + New Task", priority: "LOW", labels: [L_GUIDE] }),
    ],
    inprogress: [],
    review: [],
    complete: [
      card({ title: "Open the Board", priority: "LOW", labels: [L_GUIDE] }),
    ],
  };
}

// Apply fn to every card across every column, whatever the current column set is.
function mapCards(cards: BoardCards, fn: (c: Card) => Card): BoardCards {
  const next: BoardCards = {};
  for (const colId of Object.keys(cards)) next[colId] = cards[colId].map(fn);
  return next;
}

export function allCards(cards: BoardCards): Card[] {
  return Object.values(cards).flat();
}

export function archivedCardsOf(cards: BoardCards): Card[] {
  return allCards(cards).filter((c) => c.archived);
}

function findColumnOf(cards: BoardCards, cardId: string): ColumnId | null {
  for (const colId of Object.keys(cards)) if (cards[colId].some((c) => c.id === cardId)) return colId;
  return null;
}

interface UndoEntry {
  label: string;
  cards: BoardCards;
  columns: Column[];
}

interface BoardState {
  columns: Column[];
  cards: BoardCards;
  templates: CardTemplate[];
  /** UX-571: the one destructive action that can still be walked back — a
   *  toast reads this and offers "Undo". Single-level by design (matches the
   *  "toast with an undo affordance" shape the backlog item asks for, not a
   *  full history stack). */
  undo: UndoEntry | null;
  /** UX-573: set by the pane-side "jump to card" affordance so Board.tsx can
   *  open the right card's detail view once it mounts/renders. */
  focusCardId: string | null;

  setCards: (cards: BoardCards) => void;
  addCard: (colId: ColumnId, title: string, priority: Priority) => void;
  updateCard: (id: string, patch: Partial<Omit<Card, "id">>) => void;
  /** Permanent removal — used from the card detail's "Delete card" and the
   *  archive panel's "Delete forever". Prefer archiveCard for a soft delete. */
  deleteCard: (id: string) => void;
  moveCard: (id: string, target: ColumnId, index?: number) => void;
  reorderInColumn: (colId: ColumnId, from: number, to: number) => void;
  toggleChecklist: (cardId: string, itemId: string) => void;
  addChecklistItem: (cardId: string, text: string) => void;
  removeChecklistItem: (cardId: string, itemId: string) => void;
  addLabel: (cardId: string, label: Label) => void;
  removeLabel: (cardId: string, labelId: string) => void;
  linkPane: (cardId: string, wsId: number, paneId: number) => void;
  /** UI-157: record the PR opened from this card's pane. */
  setCardPr: (paneId: number, url: string) => void;
  unlinkPane: (cardId: string) => void;
  reset: () => void;

  // UX-570: custom columns.
  addColumn: (name: string) => void;
  renameColumn: (id: ColumnId, name: string) => void;
  /** Cards in the deleted column move into the nearest remaining column
   *  (never destroyed) — undo-able like any other destructive board action. */
  deleteColumn: (id: ColumnId) => void;
  reorderColumns: (from: number, to: number) => void;
  toggleColumnCollapsed: (id: ColumnId) => void;
  setColumnWip: (id: ColumnId, wip: number | undefined) => void;

  // UX-570: archive (hidden, recoverable).
  archiveCard: (id: string) => void;
  restoreCard: (id: string) => void;

  // UX-571: bulk actions, each undo-able as one step.
  bulkMove: (ids: string[], target: ColumnId) => void;
  bulkArchive: (ids: string[]) => void;
  bulkDelete: (ids: string[]) => void;
  bulkAddLabel: (ids: string[], label: Label) => void;
  undoLast: () => void;
  dismissUndo: () => void;

  // UX-574: card templates.
  saveAsTemplate: (cardId: string, name: string) => void;
  deleteTemplate: (id: string) => void;
  /** Returns the new card's id (or null if the template vanished). */
  createFromTemplate: (colId: ColumnId, templateId: string) => string | null;

  // UX-573: pane -> card deep link.
  setFocusCardId: (id: string | null) => void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  columns: DEFAULT_COLUMNS,
  cards: seedCards(),
  templates: [],
  undo: null,
  focusCardId: null,

  setCards: (cards) => set({ cards }),

  addCard: (colId, title, priority) =>
    set((s) => ({ cards: { ...s.cards, [colId]: [card({ title, priority }), ...(s.cards[colId] ?? [])] } })),

  updateCard: (id, patch) =>
    set((s) => ({ cards: mapCards(s.cards, (c) => (c.id === id ? { ...c, ...patch } : c)) })),

  deleteCard: (id) =>
    set((s) => {
      const source = findColumnOf(s.cards, id);
      if (!source) return s;
      const next = { ...s.cards };
      for (const colId of Object.keys(next)) next[colId] = next[colId].filter((c) => c.id !== id);
      return { cards: next, undo: { label: "Card deleted", cards: s.cards, columns: s.columns } };
    }),

  moveCard: (id, target, index) =>
    set((s) => {
      let moved: Card | undefined;
      const next: BoardCards = { ...s.cards };
      for (const colId of Object.keys(next)) {
        if (next[colId].some((c) => c.id === id)) {
          moved = next[colId].find((c) => c.id === id);
          next[colId] = next[colId].filter((c) => c.id !== id);
        }
      }
      if (!moved) return s;
      const list = (next[target] ?? []).slice();
      const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
      list.splice(at, 0, moved);
      next[target] = list;
      return { cards: next };
    }),

  reorderInColumn: (colId, from, to) =>
    set((s) => {
      const list = (s.cards[colId] ?? []).slice();
      if (from < 0 || from >= list.length || to < 0 || to >= list.length) return s;
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      return { cards: { ...s.cards, [colId]: list } };
    }),

  toggleChecklist: (cardId, itemId) =>
    set((s) => ({
      cards: mapCards(s.cards, (c) =>
        c.id === cardId ? { ...c, checklist: c.checklist.map((it) => (it.id === itemId ? { ...it, done: !it.done } : it)) } : c
      ),
    })),

  addChecklistItem: (cardId, text) =>
    set((s) => ({
      cards: mapCards(s.cards, (c) =>
        c.id === cardId ? { ...c, checklist: [...c.checklist, { id: makeId("chk"), text, done: false }] } : c
      ),
    })),

  removeChecklistItem: (cardId, itemId) =>
    set((s) => ({
      cards: mapCards(s.cards, (c) => (c.id === cardId ? { ...c, checklist: c.checklist.filter((it) => it.id !== itemId) } : c)),
    })),

  addLabel: (cardId, label) =>
    set((s) => ({ cards: mapCards(s.cards, (c) => (c.id === cardId ? { ...c, labels: [...c.labels, label] } : c)) })),

  removeLabel: (cardId, labelId) =>
    set((s) => ({
      cards: mapCards(s.cards, (c) => (c.id === cardId ? { ...c, labels: c.labels.filter((l) => l.id !== labelId) } : c)),
    })),

  linkPane: (cardId, wsId, paneId) =>
    set((s) => ({ cards: mapCards(s.cards, (c) => (c.id === cardId ? { ...c, wsId, paneId } : c)) })),

  // Keyed by pane, not card: the Review drawer knows which pane it handed off,
  // and the card that dispatched that pane is the one to annotate.
  setCardPr: (paneId, url) =>
    set((s) => ({ cards: mapCards(s.cards, (c) => (c.paneId === paneId ? { ...c, prUrl: url } : c)) })),

  unlinkPane: (cardId) =>
    set((s) => ({
      cards: mapCards(s.cards, (c) => {
        if (c.id !== cardId) return c;
        const next = { ...c };
        delete next.wsId;
        delete next.paneId;
        return next;
      }),
    })),

  reset: () => set({ columns: DEFAULT_COLUMNS, cards: seedCards(), undo: null }),

  // ---------------------------------------------------------------------
  // UX-570: custom columns
  // ---------------------------------------------------------------------

  addColumn: (name) =>
    set((s) => {
      const trimmed = name.trim();
      if (!trimmed) return s;
      const id = makeColumnId();
      const accent = ACCENT_CYCLE[s.columns.length % ACCENT_CYCLE.length];
      return {
        columns: [...s.columns, { id, name: trimmed, accent }],
        cards: { ...s.cards, [id]: [] },
      };
    }),

  renameColumn: (id, name) =>
    set((s) => {
      const trimmed = name.trim();
      if (!trimmed) return s;
      return { columns: s.columns.map((c) => (c.id === id ? { ...c, name: trimmed } : c)) };
    }),

  deleteColumn: (id) =>
    set((s) => {
      if (s.columns.length <= 1) return s; // never delete the last column
      const idx = s.columns.findIndex((c) => c.id === id);
      if (idx === -1) return s;
      const target = s.columns[idx + 1] ?? s.columns[idx - 1];
      const moving = s.cards[id] ?? [];
      const nextCards = { ...s.cards };
      delete nextCards[id];
      nextCards[target.id] = [...(nextCards[target.id] ?? []), ...moving];
      return {
        columns: s.columns.filter((c) => c.id !== id),
        cards: nextCards,
        undo: { label: `Column "${s.columns[idx].name}" deleted`, cards: s.cards, columns: s.columns },
      };
    }),

  reorderColumns: (from, to) =>
    set((s) => {
      if (from < 0 || from >= s.columns.length || to < 0 || to >= s.columns.length) return s;
      const list = s.columns.slice();
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      return { columns: list };
    }),

  toggleColumnCollapsed: (id) =>
    set((s) => ({ columns: s.columns.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c)) })),

  setColumnWip: (id, wip) =>
    set((s) => ({ columns: s.columns.map((c) => (c.id === id ? { ...c, wip } : c)) })),

  // ---------------------------------------------------------------------
  // UX-570: archive
  // ---------------------------------------------------------------------

  archiveCard: (id) =>
    set((s) => {
      if (!findColumnOf(s.cards, id)) return s;
      const now = Date.now();
      return {
        cards: mapCards(s.cards, (c) => (c.id === id ? { ...c, archived: true, archivedAt: now } : c)),
        undo: { label: "Card archived", cards: s.cards, columns: s.columns },
      };
    }),

  restoreCard: (id) =>
    set((s) => ({
      cards: mapCards(s.cards, (c) => {
        if (c.id !== id) return c;
        const next = { ...c, archived: false };
        delete next.archivedAt;
        return next;
      }),
    })),

  // ---------------------------------------------------------------------
  // UX-571: bulk actions + undo
  // ---------------------------------------------------------------------

  bulkMove: (ids, target) =>
    set((s) => {
      if (ids.length === 0) return s;
      const idSet = new Set(ids);
      const moving: Card[] = [];
      const next: BoardCards = {};
      for (const colId of Object.keys(s.cards)) {
        const keep: Card[] = [];
        for (const c of s.cards[colId]) {
          if (idSet.has(c.id)) moving.push(c);
          else keep.push(c);
        }
        next[colId] = keep;
      }
      if (moving.length === 0) return s;
      next[target] = [...(next[target] ?? []), ...moving];
      return { cards: next, undo: { label: `${moving.length} card${moving.length === 1 ? "" : "s"} moved`, cards: s.cards, columns: s.columns } };
    }),

  bulkArchive: (ids) =>
    set((s) => {
      if (ids.length === 0) return s;
      const idSet = new Set(ids);
      const now = Date.now();
      return {
        cards: mapCards(s.cards, (c) => (idSet.has(c.id) ? { ...c, archived: true, archivedAt: now } : c)),
        undo: { label: `${ids.length} card${ids.length === 1 ? "" : "s"} archived`, cards: s.cards, columns: s.columns },
      };
    }),

  bulkDelete: (ids) =>
    set((s) => {
      if (ids.length === 0) return s;
      const idSet = new Set(ids);
      const next: BoardCards = {};
      for (const colId of Object.keys(s.cards)) next[colId] = s.cards[colId].filter((c) => !idSet.has(c.id));
      return { cards: next, undo: { label: `${ids.length} card${ids.length === 1 ? "" : "s"} deleted`, cards: s.cards, columns: s.columns } };
    }),

  bulkAddLabel: (ids, label) =>
    set((s) => {
      if (ids.length === 0) return s;
      const idSet = new Set(ids);
      return {
        cards: mapCards(s.cards, (c) =>
          idSet.has(c.id) && !c.labels.some((l) => l.name === label.name) ? { ...c, labels: [...c.labels, label] } : c
        ),
      };
    }),

  undoLast: () =>
    set((s) => (s.undo ? { cards: s.undo.cards, columns: s.undo.columns, undo: null } : s)),

  dismissUndo: () => set({ undo: null }),

  // ---------------------------------------------------------------------
  // UX-574: card templates
  // ---------------------------------------------------------------------

  saveAsTemplate: (cardId, name) =>
    set((s) => {
      const c = allCards(s.cards).find((c) => c.id === cardId);
      if (!c) return s;
      const trimmed = name.trim() || c.title;
      const tmpl: CardTemplate = {
        id: makeId("tmpl"),
        name: trimmed,
        title: c.title,
        description: c.description,
        priority: c.priority,
        agent: c.agent,
        labels: c.labels,
        checklistText: c.checklist.map((i) => i.text),
      };
      return { templates: [...s.templates, tmpl] };
    }),

  deleteTemplate: (id) => set((s) => ({ templates: s.templates.filter((t) => t.id !== id) })),

  createFromTemplate: (colId, templateId) => {
    const tmpl = get().templates.find((t) => t.id === templateId);
    if (!tmpl) return null;
    const newCard = card({
      title: tmpl.title,
      description: tmpl.description,
      priority: tmpl.priority,
      agent: tmpl.agent,
      labels: tmpl.labels,
      checklist: mkChecklist(tmpl.checklistText.map((t) => [t, false] as [string, boolean])),
    });
    set((s) => ({ cards: { ...s.cards, [colId]: [newCard, ...(s.cards[colId] ?? [])] } }));
    return newCard.id;
  },

  // ---------------------------------------------------------------------
  // UX-573: pane -> card deep link
  // ---------------------------------------------------------------------

  setFocusCardId: (id) => set({ focusCardId: id }),
}));

// ---------------------------------------------------------------------------
// Persistence: session.ts stuffs/reads this via the opaque uiPrefs.board blob
// (BACKLOG 229). setBoardState migrates whatever shape it's handed — an old
// saved board (pre-UX-570) was a bare BoardCards object keyed by the 4 fixed
// column ids, with no `version`/`columns`/`templates` wrapper at all.
// ---------------------------------------------------------------------------

export function getBoardState(): BoardDoc {
  const s = useBoardStore.getState();
  return { version: 2, columns: s.columns, cards: s.cards, templates: s.templates };
}

function isBoardDocV2(raw: Record<string, unknown>): boolean {
  return raw.version === 2 && Array.isArray(raw.columns) && typeof raw.cards === "object" && raw.cards !== null;
}

function migrateBoardDoc(raw: unknown): BoardDoc {
  if (!raw || typeof raw !== "object") return { version: 2, columns: DEFAULT_COLUMNS, cards: seedCards(), templates: [] };
  const obj = raw as Record<string, unknown>;
  if (isBoardDocV2(obj)) {
    return {
      version: 2,
      columns: obj.columns as Column[],
      cards: obj.cards as BoardCards,
      templates: Array.isArray(obj.templates) ? (obj.templates as CardTemplate[]) : [],
    };
  }
  // Pre-UX-570 shape: a plain BoardCards object (no wrapper). Its cards were
  // always keyed by the 4 built-in column ids, so re-anchor them there.
  return { version: 2, columns: DEFAULT_COLUMNS, cards: obj as unknown as BoardCards, templates: [] };
}

// Every column must have a cards array, whichever branch produced the doc
// (a hand-edited or partially-written session doc shouldn't crash the board).
function normalizeBoardDoc(doc: BoardDoc): BoardDoc {
  const cards: BoardCards = { ...doc.cards };
  for (const col of doc.columns) if (!Array.isArray(cards[col.id])) cards[col.id] = [];
  return { ...doc, cards };
}

export function setBoardState(raw: unknown): void {
  const doc = normalizeBoardDoc(migrateBoardDoc(raw));
  useBoardStore.setState({ columns: doc.columns, cards: doc.cards, templates: doc.templates, undo: null });
}

export const LABEL_SWATCHES: Array<{ name: string; colorVar: string }> = [
  { name: "Azure", colorVar: "--accent" },
  { name: "Ice", colorVar: "--ice" },
  { name: "Aqua", colorVar: "--aqua" },
  { name: "Gold", colorVar: "--st-waiting" },
  { name: "Red", colorVar: "--red" },
  { name: "Indigo", colorVar: "--agent-claude" },
];

// VENDOR_META removed — vendor labels/colours come from the Rust registry via
// src/vendors.ts (vendorLabel / vendorShort / vendorColor). BACKLOG 216.

// ---------------------------------------------------------------------------
// UX-576: send-to-agent vendor rule — "last used for this repo". Keyed by
// workspace root (same convention as worktrees.ts's setup-command memory,
// `flightdeck-setup:<top>`) rather than the true git toplevel, so it needs no
// extra async round-trip on the dispatch path; a nested-repo workspace is the
// one edge case where that's an approximation, not the exact repo root.
// ---------------------------------------------------------------------------

const LAST_AGENT_PREFIX = "flightdeck-lastagent:";

export function lastAgentForRepo(root: string): Vendor | null {
  try {
    return localStorage.getItem(LAST_AGENT_PREFIX + root.toLowerCase()) || null;
  } catch {
    return null;
  }
}

export function rememberAgentForRepo(root: string, vendor: Vendor): void {
  try {
    localStorage.setItem(LAST_AGENT_PREFIX + root.toLowerCase(), vendor);
  } catch {
    /* non-persistent (private browsing / browser preview) — not fatal */
  }
}

// ---------------------------------------------------------------------------
// UX-573: pane -> card linkage, read from the pane side. Exported as a plain
// selector (findCardForPane) for one-off reads and a hook (useCardForPane)
// for a live-updating chip in PaneView. See board/README-handoff notes in the
// task report for the PaneView.tsx wiring (that file isn't owned here).
// ---------------------------------------------------------------------------

export function findCardForPane(cards: BoardCards, wsId: number, paneId: number): Card | null {
  return allCards(cards).find((c) => !c.archived && c.wsId === wsId && c.paneId === paneId) ?? null;
}

export function useCardForPane(wsId: number | undefined, paneId: number | undefined): Card | null {
  return useBoardStore((s) => (wsId == null || paneId == null ? null : findCardForPane(s.cards, wsId, paneId)));
}
