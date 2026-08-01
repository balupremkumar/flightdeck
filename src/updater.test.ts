import { afterEach, describe, expect, it, vi } from "vitest";

// The suite runs in node, which has no localStorage — same minimal stub
// trust.test.ts uses.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { getPendingReleaseNotes, clearPendingReleaseNotes } = await import("./updater");

// Pure round-trip of the UX-600 "what's new" data — checkForUpdate itself
// needs a live Tauri bridge, but the localStorage contract underneath it
// (what Settings reads back on the next boot) doesn't.
describe("pending release notes (UX-600 source data)", () => {
  afterEach(() => {
    clearPendingReleaseNotes();
  });

  it("returns null when nothing has been saved", () => {
    expect(getPendingReleaseNotes()).toBeNull();
  });

  it("round-trips a saved manifest", () => {
    localStorage.setItem("flightdeck-pending-release-notes", JSON.stringify({ version: "0.4.0", notes: "New things." }));
    expect(getPendingReleaseNotes()).toEqual({ version: "0.4.0", notes: "New things." });
  });

  it("clear removes it", () => {
    localStorage.setItem("flightdeck-pending-release-notes", JSON.stringify({ version: "0.4.0", notes: "x" }));
    clearPendingReleaseNotes();
    expect(getPendingReleaseNotes()).toBeNull();
  });

  it("ignores malformed JSON rather than throwing", () => {
    localStorage.setItem("flightdeck-pending-release-notes", "{not json");
    expect(getPendingReleaseNotes()).toBeNull();
  });

  it("ignores a shape that isn't a {version, notes} pair", () => {
    localStorage.setItem("flightdeck-pending-release-notes", JSON.stringify({ foo: "bar" }));
    expect(getPendingReleaseNotes()).toBeNull();
  });
});
