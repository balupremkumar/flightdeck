import { describe, expect, it, vi } from "vitest";

// PaneView pulls in the terminal + tauri IPC on import; the pure header logic
// under test doesn't touch either (same pattern as Settings.test.ts). Terminal
// itself is stubbed: its xterm addon imports don't resolve under vitest.
vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

const { aheadBehindLabel, aheadBehindTitle, pruneProcSamples, stableProcName, PROC_STABLE_MS } =
  await import("./PaneView");

describe("aheadBehindLabel (QL-740)", () => {
  it("shows both directions compactly", () => {
    expect(aheadBehindLabel(2, 1)).toBe("↑2 ↓1");
  });

  it("shows only the direction that has commits", () => {
    expect(aheadBehindLabel(3, 0)).toBe("↑3");
    expect(aheadBehindLabel(0, 4)).toBe("↓4");
  });

  it("says nothing when in sync", () => {
    expect(aheadBehindLabel(0, 0)).toBe("");
  });

  it("says nothing when there is no upstream (null, not zero)", () => {
    expect(aheadBehindLabel(null, null)).toBe("");
    expect(aheadBehindLabel(undefined, undefined)).toBe("");
  });
});

describe("aheadBehindTitle (QL-740)", () => {
  it("spells the counts out, singular and plural", () => {
    expect(aheadBehindTitle(1, 0)).toBe(" — 1 unpushed commit");
    expect(aheadBehindTitle(2, 3)).toBe(" — 2 unpushed commits, 3 behind upstream");
  });

  it("is empty when there's nothing to add to the tooltip", () => {
    expect(aheadBehindTitle(0, 0)).toBe("");
    expect(aheadBehindTitle(null, null)).toBe("");
  });
});

// QL-743: the header used to flip claude → node → pwsh during a build because
// every procName change renamed the pane. These are the two halves of the damp.
describe("stableProcName (QL-743)", () => {
  it("holds off until a name has owned the pane long enough", () => {
    const samples = [{ name: "claude", at: 0 }];
    expect(stableProcName(samples, PROC_STABLE_MS - 1)).toBeNull();
    expect(stableProcName(samples, PROC_STABLE_MS)).toBe("claude");
  });

  it("ignores transient children mid-build and keeps the long-lived root", () => {
    // claude for 20s, then a burst of one-second build processes.
    const samples = [
      { name: "claude", at: 0 },
      { name: "node", at: 20000 },
      { name: "pwsh", at: 21000 },
      { name: "node", at: 22000 },
      { name: "claude", at: 23000 },
    ];
    expect(stableProcName(samples, 23500)).toBe("claude");
  });

  it("never renames to a name that only just appeared", () => {
    const samples = [
      { name: "claude", at: 0 },
      { name: "node", at: 10000 },
    ];
    expect(stableProcName(samples, 10500)).toBe("claude"); // node hasn't earned it yet
  });

  it("eventually adopts a genuinely new long-running process", () => {
    const samples = pruneProcSamples(
      [{ name: "claude", at: 0 }, { name: "pwsh", at: 60000 }],
      90000
    );
    expect(stableProcName(samples, 90000)).toBe("pwsh");
  });

  it("has nothing to say with no samples", () => {
    expect(stableProcName([], 10000)).toBeNull();
  });
});

describe("pruneProcSamples (QL-743)", () => {
  it("drops samples older than the window but keeps the one still current", () => {
    const kept = pruneProcSamples(
      [{ name: "claude", at: 0 }, { name: "node", at: 1000 }, { name: "claude", at: 2000 }],
      40000,
      30000
    );
    expect(kept).toEqual([{ name: "claude", at: 10000 }]); // clipped to the window edge
  });

  it("leaves everything inside the window alone", () => {
    const samples = [{ name: "claude", at: 5000 }, { name: "node", at: 9000 }];
    expect(pruneProcSamples(samples, 10000, 30000)).toEqual(samples);
  });

  it("keeps a bounded history under sustained churn", () => {
    let samples: { name: string; at: number }[] = [];
    for (let t = 0; t < 600000; t += 1000) {
      samples.push({ name: t % 2 ? "node" : "claude", at: t });
      samples = pruneProcSamples(samples, t, 30000);
    }
    expect(samples.length).toBeLessThanOrEqual(32);
  });
});
