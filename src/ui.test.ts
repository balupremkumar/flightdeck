import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUI, ZOOM_STEPS, nextZoomStep } from "./ui";

// The store is a singleton; reset the observable slice this file touches
// before each test.
const resetFeed = () => useUI.setState({ feed: [] });

describe("notification feed (ui.ts)", () => {
  beforeEach(resetFeed);

  it("pushNotifyEvent: a fresh pane+state pushes a new row with repeats=1", () => {
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 10, vendor: "claude", state: "waiting" });
    const feed = useUI.getState().feed;
    expect(feed).toHaveLength(1);
    expect(feed[0].repeats).toBe(1);
  });

  it("pushNotifyEvent: a repeat of the same pane+state within the collapse window bumps repeats instead of stacking a new row", () => {
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 10, vendor: "claude", state: "waiting" });
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 10, vendor: "claude", state: "waiting" });
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 10, vendor: "claude", state: "waiting" });
    const feed = useUI.getState().feed;
    expect(feed).toHaveLength(1);
    expect(feed[0].repeats).toBe(3);
  });

  it("pushNotifyEvent: a different pane or a different state on the same pane still pushes a new row", () => {
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 10, vendor: "claude", state: "waiting" });
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 11, vendor: "agy", state: "waiting" });
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 10, vendor: "claude", state: "error" });
    expect(useUI.getState().feed).toHaveLength(3);
  });

  it("pushNotifyEvent: a repeat outside the collapse window pushes a new row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 10, vendor: "claude", state: "waiting" });
    vi.setSystemTime(6 * 60_000); // past FEED_COLLAPSE_WINDOW_MS (5 min)
    useUI.getState().pushNotifyEvent({ wsId: 1, wsName: "ws", paneId: 10, vendor: "claude", state: "waiting" });
    expect(useUI.getState().feed).toHaveLength(2);
    vi.useRealTimers();
  });
});

// stepUiZoom/setUiZoom/resetUiZoom all call applyUiScale, which touches
// `document`/`window` — this project's vitest runs in plain Node (no jsdom),
// so those actions can't be exercised directly in this file. nextZoomStep is
// exported specifically so the stepping ALGORITHM (the load-bearing logic
// both Settings > UI size and the Ctrl+=/-/0 shortcut share) is still under
// test; see Cockpit.tsx/Settings.tsx for the thin DOM-touching call sites.
describe("whole-app zoom stepping (ui.ts)", () => {
  it("ZOOM_STEPS is ascending and includes 1 (100%, the reset target)", () => {
    expect(ZOOM_STEPS).toEqual([...ZOOM_STEPS].sort((a, b) => a - b));
    expect(ZOOM_STEPS).toContain(1);
  });

  it("steps up/down through exact values", () => {
    expect(nextZoomStep(1, 1)).toBe(1.1);
    expect(nextZoomStep(1, -1)).toBe(0.95);
  });

  it("clamps at the top and bottom of ZOOM_STEPS", () => {
    expect(nextZoomStep(ZOOM_STEPS[ZOOM_STEPS.length - 1], 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(nextZoomStep(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0]);
  });

  it("an off-step value (legacy 1.12/1.25 'Comfortable/Large') always moves the requested direction, never the wrong way", () => {
    expect(nextZoomStep(1.12, 1)).toBe(1.2); // nearest step above
    expect(nextZoomStep(1.12, -1)).toBe(1.1); // nearest step below — not accidentally larger
    expect(nextZoomStep(1.25, 1)).toBe(1.35);
    expect(nextZoomStep(1.25, -1)).toBe(1.2);
  });

  it("an off-step value already past every step in a direction stays put", () => {
    expect(nextZoomStep(2, 1)).toBe(2); // above the top step — zooming in further does nothing
    expect(nextZoomStep(0.5, -1)).toBe(0.5); // below the bottom step — zooming out further does nothing
  });
});
