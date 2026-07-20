import type { PaneState } from "../store";
import type { Priority } from "./types";

// Severity ramp within the brand: grey -> blue -> gold -> red.
export const PRIORITY_COLORS: Record<Priority, string> = {
  LOW: "var(--st-idle)",
  MEDIUM: "var(--accent)",
  HIGH: "var(--st-waiting)",
  CRITICAL: "var(--st-error)",
};

// Vendor colours now come from the registry — see vendorColor() in src/vendors.ts.

// Live pane state -> dot colour, same ramp PaneView uses for `.pdot`.
export const STATE_COLORS: Record<PaneState, string> = {
  starting: "var(--st-starting)",
  running: "var(--st-running)",
  waiting: "var(--st-waiting)",
  permission: "var(--st-waiting)",
  idle: "var(--st-idle)",
  error: "var(--st-error)",
};

export const STATE_LABELS: Record<PaneState, string> = {
  starting: "starting",
  running: "running",
  waiting: "waiting on you",
  permission: "needs approval",
  idle: "idle",
  error: "error",
};
