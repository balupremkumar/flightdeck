// Guards per-pane transfer staging, replacement and consume-once retrieval.
import { beforeEach, describe, it, expect } from "vitest";
import { stageTransfers, takeTransfer, _clearTransfersForTests } from "./transferSnap";
import type { PaneTransfer } from "./transferSnap";

beforeEach(() => {
  _clearTransfersForTests();
});

describe("transfer snapshots", () => {
  it("returns the staged transfer once", () => {
    const transfer: PaneTransfer = {
      serialized: "terminal screen",
      seq: 128,
      cols: 80,
      rows: 24,
    };

    stageTransfers({ 7: transfer });

    expect(takeTransfer(7)).toEqual({
      serialized: "terminal screen",
      seq: 128,
      cols: 80,
      rows: 24,
    });
    expect(takeTransfer(7)).toBeUndefined();
  });

  it("stages several string-keyed panes for independent retrieval by numeric id", () => {
    const first: PaneTransfer = { serialized: "first", seq: 10, cols: 80, rows: 24 };
    const second: PaneTransfer = { serialized: "second", seq: 20, cols: 120, rows: 40 };
    const third: PaneTransfer = { serialized: "third", seq: 30, cols: 100, rows: 32 };

    stageTransfers({ "7": first, "42": second, "105": third });

    expect(takeTransfer(999)).toBeUndefined();
    expect(takeTransfer(42)).toEqual({ serialized: "second", seq: 20, cols: 120, rows: 40 });
    expect(takeTransfer(7)).toEqual({ serialized: "first", seq: 10, cols: 80, rows: 24 });
    expect(takeTransfer(105)).toEqual({ serialized: "third", seq: 30, cols: 100, rows: 32 });
    expect(takeTransfer(42)).toBeUndefined();
  });

  it("keeps the later transfer when the same pane is staged twice", () => {
    const earlier: PaneTransfer = { serialized: "old", seq: 10, cols: 80, rows: 24 };
    const later: PaneTransfer = { serialized: "new", seq: 20, cols: 120, rows: 40 };

    stageTransfers({ 7: earlier });
    stageTransfers({ 7: later });

    expect(takeTransfer(7)).toEqual({ serialized: "new", seq: 20, cols: 120, rows: 40 });
    expect(takeTransfer(7)).toBeUndefined();
  });

  it("round-trips a null serialised snapshot unchanged", () => {
    const transfer: PaneTransfer = { serialized: null, seq: 50, cols: 80, rows: 24 };

    stageTransfers({ 7: transfer });

    expect(takeTransfer(7)).toEqual({ serialized: null, seq: 50, cols: 80, rows: 24 });
    expect(takeTransfer(7)).toBeUndefined();
  });
});
