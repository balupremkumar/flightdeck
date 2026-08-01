import { beforeEach, describe, expect, it } from "vitest";

// The suite runs in node, which has no localStorage — lastAgentForRepo /
// rememberAgentForRepo (UX-576) read/write it. A minimal stub keeps this
// dependency-free (same pattern as trust.test.ts).
const store = new Map<string, string>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

import {
  useBoardStore, DEFAULT_COLUMNS, getBoardState, setBoardState,
  lastAgentForRepo, rememberAgentForRepo, findCardForPane,
} from "./boardStore";
import type { BoardCards, Label } from "./types";

function firstCardId(colId: string): string {
  return useBoardStore.getState().cards[colId][0].id;
}

describe("boardStore", () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
    useBoardStore.setState({ templates: [], undo: null, focusCardId: null });
    store.clear();
  });

  describe("columns (UX-570)", () => {
    it("addColumn: appends with its own cards bucket", () => {
      useBoardStore.getState().addColumn("Blocked");
      const s = useBoardStore.getState();
      const last = s.columns[s.columns.length - 1];
      expect(last.name).toBe("Blocked");
      expect(s.cards[last.id]).toEqual([]);
    });

    it("addColumn: ignores a blank name", () => {
      const before = useBoardStore.getState().columns.length;
      useBoardStore.getState().addColumn("   ");
      expect(useBoardStore.getState().columns).toHaveLength(before);
    });

    it("renameColumn: updates the name in place, keeping the id (and its cards)", () => {
      const id = useBoardStore.getState().columns[0].id;
      useBoardStore.getState().renameColumn(id, "Backlog");
      expect(useBoardStore.getState().columns[0].name).toBe("Backlog");
      expect(useBoardStore.getState().columns[0].id).toBe(id);
    });

    it("reorderColumns: moves a column to a new position", () => {
      useBoardStore.getState().reorderColumns(0, 2);
      const ids = useBoardStore.getState().columns.map((c) => c.id);
      expect(ids[2]).toBe("todo");
    });

    it("toggleColumnCollapsed: flips collapsed on just that column", () => {
      useBoardStore.getState().toggleColumnCollapsed("review");
      const s = useBoardStore.getState();
      expect(s.columns.find((c) => c.id === "review")?.collapsed).toBe(true);
      expect(s.columns.find((c) => c.id === "todo")?.collapsed).toBeFalsy();
      useBoardStore.getState().toggleColumnCollapsed("review");
      expect(useBoardStore.getState().columns.find((c) => c.id === "review")?.collapsed).toBe(false);
    });

    it("deleteColumn: moves its cards into the neighbouring column and is undo-able", () => {
      useBoardStore.getState().addCard("review", "in review card", "MEDIUM");
      const before = JSON.stringify(useBoardStore.getState().cards);
      useBoardStore.getState().deleteColumn("review");
      const s = useBoardStore.getState();
      expect(s.columns.some((c) => c.id === "review")).toBe(false);
      // its lone card landed in "complete" (the next column after review)
      expect(s.cards.complete.some((c) => c.title === "in review card")).toBe(true);
      expect(s.undo?.label).toContain("deleted");

      useBoardStore.getState().undoLast();
      expect(JSON.stringify(useBoardStore.getState().cards)).toBe(before);
      expect(useBoardStore.getState().columns.some((c) => c.id === "review")).toBe(true);
    });

    it("deleteColumn: refuses to remove the last column", () => {
      useBoardStore.setState({ columns: [DEFAULT_COLUMNS[0]], cards: { todo: [] } });
      useBoardStore.getState().deleteColumn("todo");
      expect(useBoardStore.getState().columns).toHaveLength(1);
    });
  });

  describe("archive (UX-570)", () => {
    it("archiveCard: hides it from allCards-by-column without deleting it, and is undo-able", () => {
      const id = firstCardId("todo");
      const before = useBoardStore.getState().cards.todo.length;
      useBoardStore.getState().archiveCard(id);
      const s = useBoardStore.getState();
      const card = s.cards.todo.find((c) => c.id === id)!;
      expect(card.archived).toBe(true);
      expect(s.cards.todo).toHaveLength(before); // still present, just flagged
      expect(s.undo?.label).toBe("Card archived");

      useBoardStore.getState().undoLast();
      expect(useBoardStore.getState().cards.todo.find((c) => c.id === id)?.archived).toBeUndefined();
    });

    it("restoreCard: clears the archived flag", () => {
      const id = firstCardId("todo");
      useBoardStore.getState().archiveCard(id);
      useBoardStore.getState().restoreCard(id);
      const card = useBoardStore.getState().cards.todo.find((c) => c.id === id)!;
      expect(card.archived).toBe(false);
      expect(card.archivedAt).toBeUndefined();
    });
  });

  describe("bulk actions + undo (UX-571)", () => {
    it("bulkMove: moves every id into the target column as one undo-able step", () => {
      const a = firstCardId("todo");
      useBoardStore.getState().addCard("todo", "second", "LOW");
      const b = useBoardStore.getState().cards.todo[0].id; // addCard unshifts
      useBoardStore.getState().bulkMove([a, b], "review");
      const s = useBoardStore.getState();
      expect(s.cards.review.map((c) => c.id)).toEqual(expect.arrayContaining([a, b]));
      expect(s.cards.todo.some((c) => c.id === a || c.id === b)).toBe(false);

      useBoardStore.getState().undoLast();
      expect(useBoardStore.getState().cards.review.some((c) => c.id === a || c.id === b)).toBe(false);
    });

    it("bulkArchive: flags every id archived in one step", () => {
      const a = firstCardId("todo");
      const b = useBoardStore.getState().cards.todo[1].id;
      useBoardStore.getState().bulkArchive([a, b]);
      const s = useBoardStore.getState();
      expect(s.cards.todo.find((c) => c.id === a)?.archived).toBe(true);
      expect(s.cards.todo.find((c) => c.id === b)?.archived).toBe(true);
    });

    it("bulkDelete: removes every id and is undo-able", () => {
      const a = firstCardId("todo");
      const countBefore = useBoardStore.getState().cards.todo.length;
      useBoardStore.getState().bulkDelete([a]);
      expect(useBoardStore.getState().cards.todo).toHaveLength(countBefore - 1);
      useBoardStore.getState().undoLast();
      expect(useBoardStore.getState().cards.todo).toHaveLength(countBefore);
      expect(useBoardStore.getState().undo).toBeNull();
    });

    it("bulkAddLabel: adds the label once per card, never duplicating an existing name", () => {
      const label: Label = { id: "lbl-x", name: "urgent", colorVar: "--accent" };
      const a = firstCardId("todo");
      useBoardStore.getState().bulkAddLabel([a], label);
      useBoardStore.getState().bulkAddLabel([a], label); // second call, same name
      const card = useBoardStore.getState().cards.todo.find((c) => c.id === a)!;
      expect(card.labels.filter((l) => l.name === "urgent")).toHaveLength(1);
    });

    it("undo is a single level — a second undoLast() after dismissal is a no-op", () => {
      const a = firstCardId("todo");
      useBoardStore.getState().deleteCard(a);
      useBoardStore.getState().dismissUndo();
      const before = JSON.stringify(useBoardStore.getState().cards);
      useBoardStore.getState().undoLast();
      expect(JSON.stringify(useBoardStore.getState().cards)).toBe(before);
    });
  });

  describe("templates (UX-574)", () => {
    it("saveAsTemplate then createFromTemplate reproduces the card shape, checklist reset to undone", () => {
      const id = firstCardId("todo"); // seed card 2 has a checklist
      const seedTitle = useBoardStore.getState().cards.todo.find((c) => c.id === id)!.title;
      useBoardStore.getState().updateCard(id, {
        checklist: [{ id: "c1", text: "step one", done: true }, { id: "c2", text: "step two", done: false }],
      });
      useBoardStore.getState().saveAsTemplate(id, "My template");
      const tmpl = useBoardStore.getState().templates[0];
      expect(tmpl.name).toBe("My template");
      expect(tmpl.title).toBe(seedTitle);
      expect(tmpl.checklistText).toEqual(["step one", "step two"]);

      const newId = useBoardStore.getState().createFromTemplate("todo", tmpl.id);
      expect(newId).not.toBeNull();
      const created = useBoardStore.getState().cards.todo.find((c) => c.id === newId)!;
      expect(created.title).toBe(seedTitle);
      expect(created.checklist.map((i) => i.text)).toEqual(["step one", "step two"]);
      expect(created.checklist.every((i) => !i.done)).toBe(true); // never starts pre-done
    });

    it("createFromTemplate: returns null for a vanished template id", () => {
      expect(useBoardStore.getState().createFromTemplate("todo", "nope")).toBeNull();
    });

    it("deleteTemplate: removes it from the list", () => {
      const id = firstCardId("todo");
      useBoardStore.getState().saveAsTemplate(id, "T");
      const tid = useBoardStore.getState().templates[0].id;
      useBoardStore.getState().deleteTemplate(tid);
      expect(useBoardStore.getState().templates).toHaveLength(0);
    });
  });

  describe("pane linkage selector (UX-573)", () => {
    it("findCardForPane: finds the live, non-archived card linked to a wsId/paneId pair", () => {
      const id = firstCardId("todo");
      useBoardStore.getState().linkPane(id, 5, 42);
      const found = findCardForPane(useBoardStore.getState().cards, 5, 42);
      expect(found?.id).toBe(id);
    });

    it("findCardForPane: ignores an archived card even if still linked", () => {
      const id = firstCardId("todo");
      useBoardStore.getState().linkPane(id, 5, 42);
      useBoardStore.getState().archiveCard(id);
      expect(findCardForPane(useBoardStore.getState().cards, 5, 42)).toBeNull();
    });

    it("findCardForPane: null when nothing matches", () => {
      expect(findCardForPane(useBoardStore.getState().cards, 999, 999)).toBeNull();
    });
  });

  describe("UX-576: last-used-agent-per-repo rule", () => {
    it("round-trips through localStorage, case-insensitively", () => {
      expect(lastAgentForRepo("D:\\Dev\\proj")).toBeNull();
      rememberAgentForRepo("D:\\Dev\\proj", "claude");
      expect(lastAgentForRepo("d:\\dev\\proj")).toBe("claude");
    });

    it("is scoped per repo root", () => {
      rememberAgentForRepo("D:\\a", "claude");
      rememberAgentForRepo("D:\\b", "agy");
      expect(lastAgentForRepo("D:\\a")).toBe("claude");
      expect(lastAgentForRepo("D:\\b")).toBe("agy");
    });
  });

  describe("persistence migration (backward compatibility)", () => {
    it("getBoardState/setBoardState round-trip the current shape", () => {
      useBoardStore.getState().addColumn("Blocked");
      const doc = getBoardState();
      useBoardStore.getState().reset();
      setBoardState(doc);
      expect(useBoardStore.getState().columns.some((c) => c.name === "Blocked")).toBe(true);
    });

    it("migrates a pre-UX-570 board: a bare BoardCards object with no version/columns wrapper", () => {
      const legacy: BoardCards = {
        todo: [{ id: "old-1", title: "Legacy card", description: "", priority: "HIGH", labels: [], checklist: [], createdAt: 1 }],
        inprogress: [],
        review: [],
        complete: [{ id: "old-2", title: "Legacy done", description: "", priority: "LOW", labels: [], checklist: [], createdAt: 2 }],
      };
      setBoardState(legacy);
      const s = useBoardStore.getState();
      // Lands on the default column set (the only ones the old ids could mean).
      expect(s.columns.map((c) => c.id)).toEqual(DEFAULT_COLUMNS.map((c) => c.id));
      expect(s.cards.todo[0].title).toBe("Legacy card");
      expect(s.cards.complete[0].title).toBe("Legacy done");
      expect(s.templates).toEqual([]);
    });

    it("migrates gracefully from garbage input (undefined, null, a string) without throwing", () => {
      expect(() => setBoardState(undefined)).not.toThrow();
      expect(useBoardStore.getState().columns.length).toBeGreaterThan(0);
      expect(() => setBoardState(null)).not.toThrow();
      expect(() => setBoardState("not an object")).not.toThrow();
    });

    it("normalizes a doc missing a cards array for one of its columns", () => {
      setBoardState({ version: 2, columns: DEFAULT_COLUMNS, cards: { todo: [] }, templates: [] });
      const s = useBoardStore.getState();
      for (const col of s.columns) expect(Array.isArray(s.cards[col.id])).toBe(true);
    });
  });
});
