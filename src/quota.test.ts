import { describe, it, expect } from "vitest";
import { quotaLevel, quotaFill, resetLabel, hasQuotaData, quotaTooltip, type PlanUsage } from "./quota";

const win = (usedTokens: number, pct: number | null = null, resetsAt: number | null = null) =>
  ({ usedTokens, windowStart: 0, resetsAt, pct });

describe("quotaLevel", () => {
  it("shifts at 75% and 90%, and never alarms without a cap", () => {
    expect(quotaLevel(null)).toBe("");
    expect(quotaLevel(0.74)).toBe("");
    expect(quotaLevel(0.75)).toBe("warn");
    expect(quotaLevel(0.89)).toBe("warn");
    expect(quotaLevel(0.9)).toBe("crit");
    expect(quotaLevel(1.4)).toBe("crit");
  });
});

describe("quotaFill", () => {
  it("clamps to the bar", () => {
    expect(quotaFill(null)).toBe(0);
    expect(quotaFill(0.456)).toBe(46);
    expect(quotaFill(1.4)).toBe(100);
    expect(quotaFill(-1)).toBe(0);
  });
});

describe("resetLabel", () => {
  const now = 1_000_000_000;
  it("reads minutes, hours and days; blank when unknown or past", () => {
    expect(resetLabel(null, now)).toBe("");
    expect(resetLabel(now - 1, now)).toBe("");
    expect(resetLabel(now + 12 * 60_000, now)).toBe("resets in 12m");
    expect(resetLabel(now + (2 * 60 + 5) * 60_000, now)).toBe("resets in 2h 05m");
    expect(resetLabel(now + 72 * 3_600_000, now)).toBe("resets in 3d");
  });
});

describe("hasQuotaData / quotaTooltip", () => {
  const empty: PlanUsage = { fiveHour: win(0), weekly: win(0), source: "estimated" };
  it("hides with no Claude data", () => {
    expect(hasQuotaData(null)).toBe(false);
    expect(hasQuotaData(empty)).toBe(false);
    expect(hasQuotaData({ ...empty, weekly: win(5) })).toBe(true);
  });
  it("labels an estimate and states the method", () => {
    const t = quotaTooltip({ fiveHour: win(1500), weekly: win(90_000), source: "estimated" }, 0);
    expect(t).toContain("Estimated from local sessions");
    expect(t).toContain("5-hour: 1.5k tokens");
  });
  it("credits Claude when the reset is reported", () => {
    const t = quotaTooltip({ fiveHour: win(1, 1, 3_600_000), weekly: win(1), source: "claude-reported" }, 0);
    expect(t).toContain("reported by Claude Code");
    expect(t).toContain("(100%), resets in 1h 00m");
  });
});
