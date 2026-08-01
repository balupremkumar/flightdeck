import { describe, expect, it } from "vitest";
import {
  addSnippet, removeSnippet, extractPlaceholders, fillPlaceholders,
  recordPrompt, historyFor, HISTORY_CAP, type Snippet, type PromptHistoryMap,
} from "./prompthistory";

describe("snippets (prompthistory.ts)", () => {
  it("addSnippet prepends a new snippet", () => {
    const { list, changed } = addSnippet([], "run the tests", () => "id1");
    expect(changed).toBe(true);
    expect(list).toEqual([{ id: "id1", text: "run the tests" }]);
  });

  it("addSnippet trims whitespace and rejects blank text", () => {
    const { list, changed } = addSnippet([], "   ");
    expect(changed).toBe(false);
    expect(list).toEqual([]);
  });

  it("addSnippet is a no-op when the exact text is already saved", () => {
    const existing: Snippet[] = [{ id: "a", text: "ping" }];
    const { list, changed } = addSnippet(existing, "ping");
    expect(changed).toBe(false);
    expect(list).toBe(existing);
  });

  it("removeSnippet drops only the matching id", () => {
    const list: Snippet[] = [{ id: "a", text: "x" }, { id: "b", text: "y" }];
    expect(removeSnippet(list, "a")).toEqual([{ id: "b", text: "y" }]);
  });
});

describe("placeholders (prompthistory.ts)", () => {
  it("extractPlaceholders finds distinct tokens in first-seen order", () => {
    expect(extractPlaceholders("fix {{file}} then run {{cmd}} on {{file}}")).toEqual(["file", "cmd"]);
  });

  it("extractPlaceholders returns [] when there are none", () => {
    expect(extractPlaceholders("run the tests")).toEqual([]);
  });

  it("fillPlaceholders substitutes every occurrence of a filled token", () => {
    const out = fillPlaceholders("fix {{file}} then check {{file}} again", { file: "App.tsx" });
    expect(out).toBe("fix App.tsx then check App.tsx again");
  });

  it("fillPlaceholders leaves an unfilled token untouched", () => {
    const out = fillPlaceholders("fix {{file}} using {{tool}}", { file: "App.tsx" });
    expect(out).toBe("fix App.tsx using {{tool}}");
  });

  it("fillPlaceholders treats a whitespace-only value as unfilled", () => {
    const out = fillPlaceholders("fix {{file}}", { file: "   " });
    expect(out).toBe("fix {{file}}");
  });
});

describe("per-vendor prompt history (prompthistory.ts)", () => {
  it("recordPrompt scopes history by vendor", () => {
    let map: PromptHistoryMap = {};
    map = recordPrompt(map, "claude", "run the tests");
    map = recordPrompt(map, "agy", "explain this file");
    expect(historyFor(map, "claude")).toEqual(["run the tests"]);
    expect(historyFor(map, "agy")).toEqual(["explain this file"]);
  });

  it("recordPrompt is newest-first and de-duplicates a repeat send", () => {
    let map: PromptHistoryMap = {};
    map = recordPrompt(map, "claude", "a");
    map = recordPrompt(map, "claude", "b");
    map = recordPrompt(map, "claude", "a"); // repeat — moves back to front, no duplicate
    expect(historyFor(map, "claude")).toEqual(["a", "b"]);
  });

  it("recordPrompt trims and ignores blank text", () => {
    const map = recordPrompt({}, "claude", "   ");
    expect(historyFor(map, "claude")).toEqual([]);
  });

  it("recordPrompt caps history at HISTORY_CAP entries", () => {
    let map: PromptHistoryMap = {};
    for (let i = 0; i < HISTORY_CAP + 5; i++) map = recordPrompt(map, "claude", `msg ${i}`);
    expect(historyFor(map, "claude")).toHaveLength(HISTORY_CAP);
    expect(historyFor(map, "claude")[0]).toBe(`msg ${HISTORY_CAP + 4}`); // newest first
  });

  it("historyFor returns [] for an unknown or null vendor", () => {
    expect(historyFor({}, "claude")).toEqual([]);
    expect(historyFor({}, null)).toEqual([]);
  });
});
