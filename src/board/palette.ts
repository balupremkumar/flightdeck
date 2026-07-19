import type { PaneState } from "../store";
import type { Priority, Vendor } from "./types";

// Severity ramp within the brand: grey -> blue -> gold -> red.
export const PRIORITY_COLORS: Record<Priority, string> = {
  LOW: "var(--st-idle)",
  MEDIUM: "var(--accent)",
  HIGH: "var(--st-waiting)",
  CRITICAL: "var(--st-error)",
};

export const VENDOR_COLORS: Record<Vendor, string> = {
  claude: "var(--agent-claude)", // indigo — light-safe pair in theme.css
  agy: "var(--accent)",
  pwsh: "var(--st-idle)",
};

// Live pane state -> dot colour, same ramp PaneView uses for `.pdot`.
export const STATE_COLORS: Record<PaneState, string> = {
  starting: "var(--st-starting)",
  running: "var(--st-running)",
  waiting: "var(--st-waiting)",
  idle: "var(--st-idle)",
  error: "var(--st-error)",
};

export const STATE_LABELS: Record<PaneState, string> = {
  starting: "starting",
  running: "running",
  waiting: "waiting on you",
  idle: "idle",
  error: "error",
};
