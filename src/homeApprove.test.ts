import { describe, expect, it, vi } from "vitest";
import { approveGuarded, APPROVE_STALE } from "./homeApprove";
import type { PaneModel } from "./store";

// Red team finding 10: Approve sends a bare key, so the "still a permission prompt"
// check has to be the last thing before the write, not something an await gap sits behind.

const MENU = ["Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No"];
const pane = (state: PaneModel["state"]) => ({ id: 5, vendor: "claude", cwd: "C:\\r", state, epoch: 0 }) as PaneModel;

describe("approveGuarded", () => {
  it("sends the key when the prompt is unchanged and still a permission prompt", async () => {
    const write = vi.fn(async () => {});
    const r = await approveGuarded({ vendor: "claude", shown: { lines: MENU, seq: 10 }, refresh: async () => ({ lines: MENU, seq: 10 }), readPane: () => pane("permission"), write });
    expect(r).toBeNull();
    expect(write).toHaveBeenCalledWith("\r");
  });

  it("sends nothing when the output moved while re-peeking", async () => {
    const write = vi.fn(async () => {});
    const r = await approveGuarded({ vendor: "claude", shown: { lines: MENU, seq: 10 }, refresh: async () => ({ lines: MENU, seq: 11 }), readPane: () => pane("permission"), write });
    expect(r).toBe(APPROVE_STALE);
    expect(write).not.toHaveBeenCalled();
  });

  it("sends nothing when the pane left the permission state during the re-peek", async () => {
    const write = vi.fn(async () => {});
    let state: PaneModel["state"] = "permission";
    const r = await approveGuarded({
      vendor: "claude", shown: { lines: MENU, seq: 10 },
      refresh: async () => { state = "running"; return { lines: MENU, seq: 10 }; },
      readPane: () => pane(state), write,
    });
    expect(r).toBe(APPROVE_STALE);
    expect(write).not.toHaveBeenCalled();
  });

  it("the pane state is read again immediately before the write: a flip after the first check still blocks it", async () => {
    const write = vi.fn(async () => {});
    const reads = [pane("permission"), pane("running")];
    const r = await approveGuarded({
      vendor: "claude", shown: { lines: MENU, seq: 10 }, refresh: async () => ({ lines: MENU, seq: 10 }),
      readPane: () => reads.shift() ?? pane("running"), write,
    });
    expect(r).toBe(APPROVE_STALE);
    expect(write).not.toHaveBeenCalled();
  });
});
