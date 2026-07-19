import { create } from "zustand";
import type { BoardCards, Card, ChecklistItem, Column, ColumnId, Label, Priority } from "./types";

// Deep Cove accents as theme tokens (not hex) so the board flips correctly in
// light mode. Column ramp reads grey -> azure -> ice -> aqua(done).
export const COLUMNS: Column[] = [
  { id: "todo", name: "To Do", accent: "var(--st-idle)" },
  { id: "inprogress", name: "In Progress", accent: "var(--accent)", wip: 4 },
  { id: "review", name: "In Review", accent: "var(--ice)" },
  { id: "complete", name: "Complete", accent: "var(--aqua)" },
];

let seq = 1;
export function makeId(prefix = "card"): string {
  return `${prefix}-${seq++}`;
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

const L_RUST = mkLabel("Rust", "--agent-claude");
const L_UI = mkLabel("UI", "--ice");
const L_INFRA = mkLabel("Infra", "--st-waiting");

function seedCards(): BoardCards {
  return {
    todo: [
      card({ title: "Vendor adapter trait + registry (Rust)", priority: "HIGH", labels: [L_RUST] }),
      card({ title: "Pattern-based per-vendor status + auth-required", priority: "MEDIUM", labels: [L_RUST] }),
      card({ title: "Windows clean shutdown — Ctrl+C then Job Object", priority: "HIGH", labels: [L_INFRA] }),
      card({
        title: "SQLite persistence — survive app restart",
        priority: "HIGH",
        labels: [L_INFRA],
        description: "Workspaces/panes/layout/presets/scrollback/events survive a full restart; restore on reopen.",
        checklist: mkChecklist([
          ["Schema (workspaces/panes/sessions/scrollback)", false],
          ["Batched scrollback flush (~4KB/2s)", false],
          ["Restore on reopen", false],
        ]),
      }),
      card({ title: "First-run CLI detection (installed + logged in)", priority: "MEDIUM", labels: [L_INFRA] }),
      card({ title: "Settings screen + multiple themes", priority: "MEDIUM", labels: [L_UI] }),
      card({ title: "Explorer file-tree panel", priority: "LOW" }),
      card({ title: "Frameless window + custom title bar", priority: "LOW", labels: [L_UI] }),
      card({ title: "Kimi adapter (activate on subscribe)", priority: "LOW" }),
      card({ title: "Local LLM via LM Studio / Qwen", priority: "LOW" }),
    ],
    inprogress: [
      card({
        title: "Kanban card → dispatch an agent pane",
        priority: "HIGH",
        agent: "claude",
        labels: [L_UI],
        description: "Dropping a card into In Progress spawns/assigns an agent pane and links the card to it.",
        checklist: mkChecklist([
          ["Dispatch on drop", true],
          ["Live status dot on the card", true],
          ["Card detail view", false],
        ]),
      }),
      card({ title: "Kanban board polish + real data", priority: "MEDIUM", agent: "claude", labels: [L_UI] }),
      card({ title: "agy concurrency — sticky workspace trust (Rust)", priority: "MEDIUM", agent: "agy", labels: [L_RUST] }),
    ],
    review: [
      card({ title: "Multi-workspace — stacked & background", priority: "HIGH" }),
      card({ title: "Per-pane working directory", priority: "MEDIUM" }),
      card({ title: "Notification bell + waiting dots", priority: "MEDIUM" }),
      card({ title: "Resizable split panes", priority: "MEDIUM" }),
    ],
    complete: [
      card({ title: "Phase 0 spike — live PTY on Windows", priority: "CRITICAL" }),
      card({ title: "agy interactive in a real terminal — confirmed", priority: "CRITICAL" }),
      card({ title: "Tauri 2 + React 19 scaffold", priority: "MEDIUM" }),
      card({ title: "New Workspace dialog + per-pane agents", priority: "MEDIUM" }),
      card({ title: "Live per-pane status (activity-based)", priority: "MEDIUM" }),
    ],
  };
}

function mapCards(cards: BoardCards, fn: (c: Card) => Card): BoardCards {
  const next = {} as BoardCards;
  for (const col of COLUMNS) next[col.id] = cards[col.id].map(fn);
  return next;
}

interface BoardState {
  cards: BoardCards;
  setCards: (cards: BoardCards) => void;
  addCard: (colId: ColumnId, title: string, priority: Priority) => void;
  updateCard: (id: string, patch: Partial<Omit<Card, "id">>) => void;
  deleteCard: (id: string) => void;
  moveCard: (id: string, target: ColumnId, index?: number) => void;
  reorderInColumn: (colId: ColumnId, from: number, to: number) => void;
  toggleChecklist: (cardId: string, itemId: string) => void;
  addChecklistItem: (cardId: string, text: string) => void;
  removeChecklistItem: (cardId: string, itemId: string) => void;
  addLabel: (cardId: string, label: Label) => void;
  removeLabel: (cardId: string, labelId: string) => void;
  linkPane: (cardId: string, wsId: number, paneId: number) => void;
  unlinkPane: (cardId: string) => void;
  reset: () => void;
}

export const useBoardStore = create<BoardState>((set) => ({
  cards: seedCards(),

  setCards: (cards) => set({ cards }),

  addCard: (colId, title, priority) =>
    set((s) => ({ cards: { ...s.cards, [colId]: [card({ title, priority }), ...s.cards[colId]] } })),

  updateCard: (id, patch) =>
    set((s) => ({ cards: mapCards(s.cards, (c) => (c.id === id ? { ...c, ...patch } : c)) })),

  deleteCard: (id) =>
    set((s) => {
      const next = { ...s.cards };
      for (const col of COLUMNS) next[col.id] = next[col.id].filter((c) => c.id !== id);
      return { cards: next };
    }),

  moveCard: (id, target, index) =>
    set((s) => {
      let moved: Card | undefined;
      const next: BoardCards = { ...s.cards };
      for (const col of COLUMNS) {
        if (next[col.id].some((c) => c.id === id)) {
          moved = next[col.id].find((c) => c.id === id);
          next[col.id] = next[col.id].filter((c) => c.id !== id);
        }
      }
      if (!moved) return s;
      const list = next[target].slice();
      const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
      list.splice(at, 0, moved);
      next[target] = list;
      return { cards: next };
    }),

  reorderInColumn: (colId, from, to) =>
    set((s) => {
      const list = s.cards[colId].slice();
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

  reset: () => set({ cards: seedCards() }),
}));

// Clean, React-free surface for a future persistence layer to read/hydrate
// the whole board (per BACKLOG D28 — "persist board to disk", not built here).
export function getBoardState(): BoardCards {
  return useBoardStore.getState().cards;
}
export function setBoardState(cards: BoardCards): void {
  useBoardStore.setState({ cards });
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
