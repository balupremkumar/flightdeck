import { describe, expect, it, vi } from "vitest";

// Same import guard as PaneView.test.ts: the module pulls in tauri IPC, which
// doesn't exist under vitest. The logic under test is pure.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

const { isPossiblyStuck, subagentChipLabel, subagentLabel, SUBAGENT_STALE_MS } =
  await import("./SubagentTreeView");

const NOW = 1_800_000_000_000;

function row(over: Partial<Parameters<typeof isPossiblyStuck>[0]> = {}) {
  return {
    id: "a1b2",
    agentType: "explore",
    description: null,
    tool: "Grep",
    startedMs: NOW - 600_000,
    lastActivityMs: NOW - 5_000,
    contextTokens: 1000,
    outputTokens: 200,
    turns: 3,
    finished: false,
    ...over,
  };
}

describe("isPossiblyStuck (QL-769)", () => {
  it("flags a running agent that has gone quiet past the threshold", () => {
    expect(isPossiblyStuck(row({ lastActivityMs: NOW - SUBAGENT_STALE_MS - 1 }), NOW)).toBe(true);
  });

  it("leaves a running agent alone while it is still writing", () => {
    expect(isPossiblyStuck(row({ lastActivityMs: NOW - 30_000 }), NOW)).toBe(false);
  });

  it("never flags a finished agent, however long ago it reported back", () => {
    expect(isPossiblyStuck(row({ finished: true, lastActivityMs: NOW - 86_400_000 }), NOW)).toBe(false);
  });

  it("does not flag exactly at the threshold — only past it", () => {
    expect(isPossiblyStuck(row({ lastActivityMs: NOW - SUBAGENT_STALE_MS }), NOW)).toBe(false);
  });
});

describe("subagentChipLabel (QL-769)", () => {
  it("counts the recently active ones when there are any", () => {
    expect(subagentChipLabel({ total: 7, recent: 3 })).toBe("3 agents");
  });

  it("falls back to the session total once nothing is active", () => {
    expect(subagentChipLabel({ total: 4, recent: 0 })).toBe("4 agents");
  });

  it("says agent, singular, for one", () => {
    expect(subagentChipLabel({ total: 1, recent: 1 })).toBe("1 agent");
    expect(subagentChipLabel({ total: 1, recent: 0 })).toBe("1 agent");
  });
});

describe("subagentLabel (QL-769)", () => {
  it("prefers the agent type recorded in the sidecar meta", () => {
    expect(subagentLabel(row({ agentType: "backend" }))).toBe("backend");
  });

  it("falls back to the id rather than inventing a generic name", () => {
    expect(subagentLabel(row({ agentType: null, id: "a0892689" }))).toBe("a0892689");
  });
});
