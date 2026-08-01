import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useUI, ZOOM_STEPS, nextZoomStep,
  navPush, navStep,
  pushOverlay, popOverlay, closeTopOverlay, overlayStackDepth, __resetOverlayStackForTests,
} from "./ui";

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

// UX-531: back/forward navigation stack. Pure functions, tested directly —
// the store's navBack/navForward actions are thin wrappers around these that
// also call openPreview, which touches document/window (see the zoom note
// above for why that's out of scope for plain-Node vitest).
describe("navigation stack (ui.ts, UX-531)", () => {
  it("navPush appends and moves the pointer to the new entry", () => {
    const a = navPush([], -1, "/a");
    expect(a).toEqual({ navHistory: ["/a"], navIndex: 0 });
    const b = navPush(a.navHistory, a.navIndex, "/b");
    expect(b).toEqual({ navHistory: ["/a", "/b"], navIndex: 1 });
  });

  it("navPush re-visiting the current entry is a no-op", () => {
    const a = navPush([], -1, "/a");
    const again = navPush(a.navHistory, a.navIndex, "/a");
    expect(again).toEqual(a);
  });

  it("navPush mid-history drops the forward branch, like a browser address bar", () => {
    let s = navPush([], -1, "/a");
    s = navPush(s.navHistory, s.navIndex, "/b");
    s = navPush(s.navHistory, s.navIndex, "/c"); // history: a,b,c  index 2
    const back = navStep(s.navHistory, s.navIndex, -1); // -> b, index 1
    const fresh = navPush(s.navHistory, back.index, "/d"); // opening /d from b drops c
    expect(fresh).toEqual({ navHistory: ["/a", "/b", "/d"], navIndex: 2 });
  });

  it("navStep walks back and forward, returning null at either end", () => {
    let s = navPush([], -1, "/a");
    s = navPush(s.navHistory, s.navIndex, "/b");
    const back = navStep(s.navHistory, s.navIndex, -1);
    expect(back).toEqual({ index: 0, path: "/a" });
    const pastStart = navStep(s.navHistory, 0, -1);
    expect(pastStart).toEqual({ index: 0, path: null });
    const forward = navStep(s.navHistory, 0, 1);
    expect(forward).toEqual({ index: 1, path: "/b" });
    const pastEnd = navStep(s.navHistory, 1, 1);
    expect(pastEnd).toEqual({ index: 1, path: null });
  });
});

// UX-542/543: the overlay stack — Esc must close exactly the top-most
// registered overlay, never more than one. useOverlayEsc itself (the
// React-hook wrapper) needs a DOM to exercise; these are the ordering rules
// it's built on, which is where the actual bug class lived.
describe("overlay stack (ui.ts, UX-542/543)", () => {
  beforeEach(__resetOverlayStackForTests);

  it("closeTopOverlay closes only the most-recently-pushed overlay", () => {
    const closedA = vi.fn();
    const closedB = vi.fn();
    pushOverlay(closedA);
    pushOverlay(closedB);
    const closedSomething = closeTopOverlay();
    expect(closedSomething).toBe(true);
    expect(closedB).toHaveBeenCalledTimes(1);
    expect(closedA).not.toHaveBeenCalled();
  });

  it("repeated closeTopOverlay calls unwind the stack one at a time (the bug this replaces: N listeners firing at once)", () => {
    const order: string[] = [];
    pushOverlay(() => order.push("outer"));
    pushOverlay(() => order.push("inner"));
    closeTopOverlay();
    closeTopOverlay();
    expect(order).toEqual(["inner", "outer"]);
  });

  it("closeTopOverlay on an empty stack returns false and closes nothing", () => {
    expect(closeTopOverlay()).toBe(false);
  });

  it("popOverlay removes a specific registration even if it isn't on top (a non-Esc close path, e.g. a scrim click)", () => {
    const closedA = vi.fn();
    const closedB = vi.fn();
    const idA = pushOverlay(closedA);
    pushOverlay(closedB);
    popOverlay(idA); // A closed itself some other way while B was still open
    expect(overlayStackDepth()).toBe(1);
    closeTopOverlay();
    expect(closedB).toHaveBeenCalledTimes(1);
    expect(closedA).not.toHaveBeenCalled();
  });
});
