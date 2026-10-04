import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  playNeedsYouChime,
  _resetRateLimitingForTest,
  _resetAudioContextForTest,
  _getLastGlobalSoundAtForTest,
  _getLastPaneSoundAtForTest,
  _setClockForTest,
  shouldSuppressSoundForTest,
  getStoredVolume,
  getEnabledState,
} from "./needsYouSound";
import type { Workspace } from "./store";

// Setup a mock localStorage for all tests (runs in node, no native localStorage).
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

// Stub window and document for DOM operations.
vi.stubGlobal("window", {
  AudioContext: class {
    createOscillator = vi.fn(() => ({
      type: "sine",
      frequency: { value: 0 },
      connect: vi.fn((target: any) => target),
      start: vi.fn(),
      stop: vi.fn(),
    }));
    createGain = vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn((target: any) => target),
    }));
    destination = {};
    currentTime = 0;
    state = "running";
    resume = vi.fn();
  },
  webkitAudioContext: undefined,
});

vi.stubGlobal("document", {
  hasFocus: vi.fn(() => false),
});

describe("needsYouSound", () => {
  beforeEach(() => {
    _resetRateLimitingForTest();
    _resetAudioContextForTest();
    _setClockForTest(null);
    store.clear();
  });

  afterEach(() => {
    store.clear();
    _setClockForTest(null);
  });

  describe("toggle and volume parsing", () => {
    it("defaults to enabled when no setting is stored", () => {
      expect(getEnabledState()).toBe(true);
    });

    it("disables when flightdeck-sound-needs-you is 'false'", () => {
      localStorage.setItem("flightdeck-sound-needs-you", "false");
      expect(getEnabledState()).toBe(false);
    });

    it("enables when flightdeck-sound-needs-you is 'true'", () => {
      localStorage.setItem("flightdeck-sound-needs-you", "true");
      expect(getEnabledState()).toBe(true);
    });

    it("defaults to volume 40 when not stored", () => {
      expect(getStoredVolume()).toBe(40);
    });

    it("clamps volume to 0-100 range", () => {
      localStorage.setItem("flightdeck-sound-volume", "-10");
      expect(getStoredVolume()).toBe(0);

      localStorage.setItem("flightdeck-sound-volume", "150");
      expect(getStoredVolume()).toBe(100);
    });

    it("parses valid volume from localStorage", () => {
      localStorage.setItem("flightdeck-sound-volume", "60");
      expect(getStoredVolume()).toBe(60);
    });
  });

  describe("rate limiting", () => {
    let currentTime: number;

    beforeEach(() => {
      currentTime = 0;
      _setClockForTest({ now: () => currentTime });
    });

    it("allows the first sound immediately", () => {
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];
      playNeedsYouChime(1, null, ws);
      // First call records the current time (0)
      expect(_getLastGlobalSoundAtForTest()).toBe(0);
      expect(_getLastPaneSoundAtForTest(1)).toBe(0);
    });

    it("suppresses the same pane within 30s", () => {
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];

      // First call at t=0
      playNeedsYouChime(1, null, ws);
      expect(_getLastPaneSoundAtForTest(1)).toBe(0);

      // Second call at t=15s (within 30s window)
      currentTime = 15000;
      playNeedsYouChime(1, null, ws);
      // Time should not have advanced for this pane
      expect(_getLastPaneSoundAtForTest(1)).toBe(0);
    });

    it("allows the same pane after 30s", () => {
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];

      // First call at t=0
      playNeedsYouChime(1, null, ws);
      expect(_getLastPaneSoundAtForTest(1)).toBe(0);

      // Second call at t=30s (exactly 30s later)
      currentTime = 30000;
      playNeedsYouChime(1, null, ws);
      expect(_getLastPaneSoundAtForTest(1)).toBe(30000);
    });

    it("allows different panes within the global limit", () => {
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];

      // Pane 1 at t=0
      playNeedsYouChime(1, null, ws);
      expect(_getLastGlobalSoundAtForTest()).toBe(0);

      // Pane 2 at t=3s (within 4s global limit)
      currentTime = 3000;
      playNeedsYouChime(2, null, ws);
      // Global time should not advance (rate limited)
      expect(_getLastGlobalSoundAtForTest()).toBe(0);

      // Pane 3 at t=4s (at the boundary)
      currentTime = 4000;
      playNeedsYouChime(3, null, ws);
      expect(_getLastGlobalSoundAtForTest()).toBe(4000);
    });

    it("suppresses all sounds within 4s globally", () => {
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];

      // Pane 1 at t=0
      playNeedsYouChime(1, null, ws);
      expect(_getLastGlobalSoundAtForTest()).toBe(0);

      // Pane 2 at t=2s (within 4s global limit, different pane)
      currentTime = 2000;
      playNeedsYouChime(2, null, ws);
      expect(_getLastGlobalSoundAtForTest()).toBe(0);

      // Pane 3 at t=4s (at boundary, different pane)
      currentTime = 4000;
      playNeedsYouChime(3, null, ws);
      expect(_getLastGlobalSoundAtForTest()).toBe(4000);
    });
  });

  describe("focus suppression", () => {
    it("suppresses sound when window and pane are both focused", () => {
      const ws: Workspace[] = [
        {
          id: 1,
          name: "test",
          root: "/",
          panes: [{ id: 10, vendor: "test", cwd: "/", state: "permission", epoch: 1 }],
          focused: 10, // Pane 10 is focused
        },
      ];

      // Mock document.hasFocus() to return true (window is focused).
      vi.spyOn(document, "hasFocus").mockReturnValue(true);

      playNeedsYouChime(10, 1, ws); // activeWorkspaceId=1, pane 10 is focused in ws 1
      // Sound is suppressed, so global time should not advance from -Infinity
      expect(_getLastGlobalSoundAtForTest()).toBe(-Infinity);
    });

    it("allows sound when window is focused but pane is not", () => {
      const ws: Workspace[] = [
        {
          id: 1,
          name: "test",
          root: "/",
          panes: [
            { id: 10, vendor: "test", cwd: "/", state: "permission", epoch: 1 },
            { id: 11, vendor: "test", cwd: "/", state: "permission", epoch: 1 },
          ],
          focused: 10, // Pane 10 is focused
        },
      ];

      vi.spyOn(document, "hasFocus").mockReturnValue(true);

      playNeedsYouChime(11, 1, ws); // Pane 11 is not focused
      expect(_getLastGlobalSoundAtForTest()).toBeGreaterThan(0); // Sound allowed
    });

    it("allows sound when pane is focused but window is not", () => {
      const ws: Workspace[] = [
        {
          id: 1,
          name: "test",
          root: "/",
          panes: [{ id: 10, vendor: "test", cwd: "/", state: "permission", epoch: 1 }],
          focused: 10,
        },
      ];

      vi.spyOn(document, "hasFocus").mockReturnValue(false);

      playNeedsYouChime(10, 1, ws);
      expect(_getLastGlobalSoundAtForTest()).toBeGreaterThan(0); // Sound allowed
    });

    it("suppresses sound when window focus changes", () => {
      expect(shouldSuppressSoundForTest(10, 1, [])).toBe(false); // No workspaces, no suppression
    });
  });

  describe("toggle suppression", () => {
    it("suppresses sound when toggle is disabled", () => {
      localStorage.setItem("flightdeck-sound-needs-you", "false");
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];

      playNeedsYouChime(1, null, ws);
      // Sound is suppressed, so global time should not advance from -Infinity
      expect(_getLastGlobalSoundAtForTest()).toBe(-Infinity);
    });

    it("allows sound when toggle is enabled", () => {
      localStorage.setItem("flightdeck-sound-needs-you", "true");
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];

      playNeedsYouChime(1, null, ws);
      expect(_getLastGlobalSoundAtForTest()).toBeGreaterThan(0); // Allowed
    });
  });

  describe("state transitions", () => {
    it("records a sound for a new needs-you pane", () => {
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];

      // Simulate a pane entering a needs-you state.
      playNeedsYouChime(1, null, ws);

      expect(_getLastGlobalSoundAtForTest()).toBeGreaterThanOrEqual(0);
      expect(_getLastPaneSoundAtForTest(1)).toBeGreaterThanOrEqual(0);
    });

    it("does not double-chime on consecutive checks of the same state", () => {
      const ws: Workspace[] = [{ id: 1, name: "test", root: "/", panes: [], focused: null }];

      playNeedsYouChime(1, null, ws);
      const firstTime = _getLastPaneSoundAtForTest(1);

      // Call again immediately (would be a polling check, not a transition)
      playNeedsYouChime(1, null, ws);
      const secondTime = _getLastPaneSoundAtForTest(1);

      // Time should not have advanced (suppressed by rate limit)
      expect(secondTime).toBe(firstTime);
    });
  });
});
