import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { collapseToasts } = await import("./ToastHost");
type Toast = Parameters<typeof collapseToasts>[0][number];

const t = (id: number, text: string, kind: Toast["kind"] = "info", extra: Partial<Toast> = {}): Toast =>
  ({ id, kind, text, ...extra }) as Toast;

// UI-625: a burst of the same message is one event to a person, not five, and
// a stack taller than a few rows stops being a notification.
describe("collapseToasts (UI-625)", () => {
  it("leaves distinct messages alone, in order", () => {
    const out = collapseToasts([t(1, "a"), t(2, "b")]);
    expect(out.map((g) => g.text)).toEqual(["a", "b"]);
    expect(out.every((g) => g.count === 1)).toBe(true);
  });

  it("folds a repeat onto the earlier row and counts it", () => {
    const out = collapseToasts([t(1, "Pane crashed", "error"), t(2, "Pane crashed", "error")]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
  });

  it("re-keys the row to the NEWEST id, which is what restarts its dismiss timer", () => {
    const out = collapseToasts([t(1, "x"), t(2, "x"), t(3, "x")]);
    expect(out[0].id).toBe(3);
    expect(out[0].ids).toEqual([1, 2, 3]);
    expect(out[0].count).toBe(3);
  });

  it("keeps the row where it first appeared rather than jumping it to the bottom", () => {
    const out = collapseToasts([t(1, "a"), t(2, "b"), t(3, "a")]);
    expect(out.map((g) => g.text)).toEqual(["a", "b"]);
    expect(out[0].count).toBe(2);
  });

  it("does not collapse the same words at a different severity", () => {
    const out = collapseToasts([t(1, "Merged", "success"), t(2, "Merged", "error")]);
    expect(out).toHaveLength(2);
  });

  it("does not collapse messages carrying different detail or links", () => {
    expect(collapseToasts([t(1, "Failed", "error", { detail: "one" }), t(2, "Failed", "error", { detail: "two" })])).toHaveLength(2);
    expect(collapseToasts([t(1, "Merged", "success", { url: "a" }), t(2, "Merged", "success", { url: "b" })])).toHaveLength(2);
  });

  it("carries a pre-counted toast's weight instead of resetting it to one", () => {
    // Forwards-compatible with the store collapsing repeats itself (HANDOFF).
    const out = collapseToasts([t(1, "x", "info", { count: 3 } as Partial<Toast>), t(2, "x")]);
    expect(out[0].count).toBe(4);
  });

  it("dismissing a collapsed row clears every toast behind it", () => {
    const out = collapseToasts([t(1, "x"), t(2, "y"), t(3, "x")]);
    expect(out[0].ids).toEqual([1, 3]);
  });
});
