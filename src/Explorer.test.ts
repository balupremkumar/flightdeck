import { describe, expect, it, vi } from "vitest";

// The suite runs in node: stub the browser/Tauri surfaces Explorer.tsx pulls
// in at import time, the same way CommandPalette.test.ts does.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

const { MAX_ROWS, nextRowLimit, showMoreLabel, classifyDirError, dirErrorMessage } = await import("./Explorer");

// QL-744: the truncation notice grew an action. The cap still exists (a
// node_modules must never land in the DOM whole), but it's now a step, not a
// wall — and a folder small enough to render fully opens in one click.
describe("nextRowLimit (QL-744 show-more)", () => {
  it("reveals a small folder in full in one click", () => {
    expect(nextRowLimit(420, MAX_ROWS)).toBe(420);
    expect(nextRowLimit(1999, MAX_ROWS)).toBe(1999);
    expect(nextRowLimit(2000, MAX_ROWS)).toBe(2000);
  });

  it("steps a huge folder a page at a time instead of all at once", () => {
    expect(nextRowLimit(40000, 300)).toBe(600);
    expect(nextRowLimit(40000, 600)).toBe(900);
  });

  it("never overshoots the real entry count", () => {
    expect(nextRowLimit(2100, 1900)).toBe(2100);
  });

  it("is a no-op once everything is already shown", () => {
    expect(nextRowLimit(120, 120)).toBe(120);
  });
});

describe("showMoreLabel (QL-744)", () => {
  it("promises everything when the click really shows everything", () => {
    expect(showMoreLabel(420, MAX_ROWS)).toBe("Show all 420");
  });

  it("names the exact size of the next slice for a huge folder", () => {
    expect(showMoreLabel(40000, 300)).toBe("Show 300 more");
  });

  it("switches to show-all on the last step", () => {
    expect(showMoreLabel(2100, 1900)).toBe("Show all 2100");
  });
});

// QL-747: a denied or vanished folder used to render as an empty one, which
// reads as a fact ("nothing in here") rather than a failure.
describe("classifyDirError (QL-747)", () => {
  it("recognises Windows and unix permission failures", () => {
    expect(classifyDirError("Access is denied. (os error 5)")).toBe("denied");
    expect(classifyDirError(new Error("Permission denied (os error 13)"))).toBe("denied");
  });

  it("recognises a folder that isn't there any more", () => {
    expect(classifyDirError("The system cannot find the path specified. (os error 3)")).toBe("missing");
    expect(classifyDirError("No such file or directory (os error 2)")).toBe("missing");
  });

  it("falls back to 'other' for anything it can't name", () => {
    expect(classifyDirError("device not ready")).toBe("other");
    expect(classifyDirError(undefined)).toBe("other");
  });
});

describe("dirErrorMessage (QL-747)", () => {
  it("says the plain-English thing for the two named cases", () => {
    expect(dirErrorMessage("Access is denied. (os error 5)")).toBe("Access denied.");
    expect(dirErrorMessage("The system cannot find the path specified. (os error 3)")).toBe("Folder missing.");
  });

  it("keeps the backend's own words for an unnamed failure", () => {
    expect(dirErrorMessage("device not ready")).toBe("Couldn’t read this folder — device not ready");
  });

  it("shows only the first line, capped, so one row can't become a stack trace", () => {
    const msg = dirErrorMessage("boom\nat frame 1\nat frame 2");
    expect(msg).toBe("Couldn’t read this folder — boom");
    expect(dirErrorMessage("x".repeat(500)).length).toBeLessThan(200);
  });

  it("degrades to the generic line when the error stringifies to nothing", () => {
    expect(dirErrorMessage("")).toBe("Couldn’t read this folder.");
  });
});
