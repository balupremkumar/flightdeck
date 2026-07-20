// Shared Kanban types. Kept separate from Board.tsx so the store, card row,
// and detail modal can all import without circular deps.

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// Mirrors the real launchable vendor ids used by NewWorkspace/PaneView
// (store.ts PaneModel.vendor) — not the aspirational Agent list from the
// old seed data, so a card's agent can actually be dispatched to a pane.
// Vendor ids come from the Rust registry at runtime (see src/vendors.ts).
// A union type here would structurally block adding an agent (BACKLOG 217).
export type Vendor = string;

export type ColumnId = "todo" | "inprogress" | "review" | "complete";

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
}

export interface Column {
  id: ColumnId;
  name: string;
  accent: string; // theme.css var() expression
  wip?: number; // soft WIP limit — warns, never blocks
}

export type BoardCards = Record<ColumnId, Card[]>;
