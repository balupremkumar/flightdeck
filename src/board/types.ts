// Shared Kanban types. Kept separate from Board.tsx so the store, card row,
// and detail modal can all import without circular deps.

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// Mirrors the real launchable vendor ids used by NewWorkspace/PaneView
// (store.ts PaneModel.vendor) — not the aspirational Agent list from the
// old seed data, so a card's agent can actually be dispatched to a pane.
// Vendor ids come from the Rust registry at runtime (see src/vendors.ts).
// A union type here would structurally block adding an agent (BACKLOG 217).
export type Vendor = string;

// UX-570: columns are now user-defined (add/rename/reorder/delete), so the id
// can no longer be a fixed union — same reasoning as Vendor above. Column ids
// are stable slugs (see makeColumnId) so a persisted board keeps working
// after a rename.
export type ColumnId = string;

export interface Label {
  id: string;
  name: string;
  colorVar: string; // theme.css custom-property name, e.g. "--accent"
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  agent?: Vendor;
  labels: Label[];
  checklist: ChecklistItem[];
  createdAt: number;
  // Set once this card has been dispatched to a live agent pane.
  wsId?: number;
  paneId?: number;
  // UI-157: the pull request opened from this card's agent branch, so the card
  // stays the thread that ties task -> agent -> review.
  prUrl?: string;
  // UX-570: archived cards are hidden from the board but recoverable from the
  // Archive panel — never destroyed until an explicit "Delete forever".
  archived?: boolean;
  archivedAt?: number;
}

export interface Column {
  id: ColumnId;
  name: string;
  accent: string; // theme.css var() expression
  wip?: number; // soft WIP limit — warns, never blocks
  // UX-570: collapsed columns show only their header + count, freeing width
  // for the columns still being worked.
  collapsed?: boolean;
}

export type BoardCards = Record<ColumnId, Card[]>;

// UX-574: a saved card shape for recurring tasks. Checklist items are saved
// as plain text (never "done" — a fresh card from a template always starts
// clean). No column/agent-live-state fields: a template describes a card,
// not a dispatch.
export interface CardTemplate {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: Priority;
  agent?: Vendor;
  labels: Label[];
  checklistText: string[];
}

// The whole persisted board document (uiPrefs.board in the session doc).
// Versioned so boardStore's migration can tell an old plain-BoardCards blob
// (pre-UX-570) apart from the current shape.
export interface BoardDoc {
  version: 2;
  columns: Column[];
  cards: BoardCards;
  templates: CardTemplate[];
}
