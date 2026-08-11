import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

const { pendingPlan, planTitle, planStatusLabel, planChipTitle, PLAN_APPROVE_KEYS, PLAN_REFINE_KEYS } =
  await import("./PlanPanelView");

const NOW = 1_800_000_000_000;
const plan = (over: Partial<{ id: string; plan: string; atMs: number; approved: boolean | null }> = {}) => ({
  id: "toolu_1",
  plan: "# Ship the thing\n\nstep one",
  atMs: NOW - 60_000,
  approved: null as boolean | null,
  ...over,
});

describe("pendingPlan (QL-770)", () => {
  it("is the newest plan while no answer has been recorded", () => {
    const p = plan();
    expect(pendingPlan([p, plan({ id: "toolu_0", approved: true })])?.id).toBe("toolu_1");
  });

  it("is nothing once the newest plan has been answered either way", () => {
    expect(pendingPlan([plan({ approved: true })])).toBeNull();
    expect(pendingPlan([plan({ approved: false })])).toBeNull();
  });

  it("ignores an older unanswered plan when a newer one was answered", () => {
    const newest = plan({ id: "toolu_2", approved: true });
    const older = plan({ id: "toolu_1", approved: null });
    expect(pendingPlan([newest, older])).toBeNull();
  });

  it("is nothing when the session has no plans at all", () => {
    expect(pendingPlan([])).toBeNull();
  });
});

describe("planTitle (QL-770)", () => {
  it("uses the plan's first markdown heading", () => {
    expect(planTitle("# Wave 5: subagent tree\n\nbody")).toBe("Wave 5: subagent tree");
  });

  it("finds a heading that isn't on the first line", () => {
    expect(planTitle("intro line\n\n## The actual plan\n\nbody")).toBe("The actual plan");
  });

  it("falls back to the first non-empty line", () => {
    expect(planTitle("\n\njust a paragraph of plan\nmore")).toBe("just a paragraph of plan");
  });

  it("clips a long title and collapses whitespace", () => {
    const out = planTitle("#   a really    long heading " + "x".repeat(200), 30);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out).toContain("a really long heading");
  });

  it("never returns an empty label", () => {
    expect(planTitle("   \n\n  ")).toBe("Untitled plan");
  });
});

describe("planStatusLabel (QL-770)", () => {
  it("reports what the transcript actually recorded", () => {
    expect(planStatusLabel(plan({ approved: true }))).toBe("approved");
    expect(planStatusLabel(plan({ approved: false }))).toBe("not approved");
  });

  it("says the answer is outstanding rather than guessing a rejection", () => {
    expect(planStatusLabel(plan({ approved: null }))).toBe("awaiting your answer");
  });
});

describe("plan action keystrokes (QL-770)", () => {
  it("approves with the TUI's manual-approve option, not auto-accept", () => {
    // If this ever changes to "1" (auto-accept edits) or "\r" (whatever is
    // highlighted), that is a deliberate widening of what one click hands over.
    expect(PLAN_APPROVE_KEYS).toBe("2");
  });

  it("sends nothing for refine — it hands the pane back instead", () => {
    expect(PLAN_REFINE_KEYS).toBe("");
  });
});

describe("planChipTitle (QL-770)", () => {
  it("names the plan, when it arrived and where it stands", () => {
    const t = planChipTitle(plan(), NOW);
    expect(t).toContain("Ship the thing");
    expect(t).toContain("1m ago");
    expect(t).toContain("awaiting your answer");
  });
});
