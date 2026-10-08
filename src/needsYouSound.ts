// needsYouSound.ts — soft chime when a pane enters a needs-you state (permission,
// error, or genuine question). One sound per 4s globally, one per pane per 30s.
// Suppressed when window AND pane are both focused. Respects localStorage settings.

import type { Workspace } from "./store";

const ENABLED_KEY = "flightdeck-sound-needs-you";
const VOLUME_KEY = "flightdeck-sound-volume";
const MIN_GLOBAL_INTERVAL_MS = 4000;
const MIN_PANE_INTERVAL_MS = 30000;

// Lazy AudioContext, persisted for the session's lifetime.
let audioContext: AudioContext | null = null;

// Rate limiting state. Initialize to -Infinity so first call is always allowed.
let lastGlobalSoundAt = -Infinity;
const lastPaneSoundAt = new Map<number, number>();

/** Read toggle from localStorage with try/catch and default. */
function isEnabled(): boolean {
  try {
    const val = localStorage.getItem(ENABLED_KEY);
    // Settings writes "1"/"0"; older builds wrote "true"/"false".
    // Both off values disable; absent or any other value defaults to true.
    return val !== "0" && val !== "false";
  } catch {
    return true; // non-persistent, safe default
  }
}

/** Read volume from localStorage (0-100) with try/catch and default. */
function getVolume(): number {
  try {
    const val = localStorage.getItem(VOLUME_KEY);
    if (!val) return 40;
    const num = parseInt(val, 10);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 40;
  } catch {
    return 40; // non-persistent, safe default
  }
}

/** True if the window is focused and the given pane is focused within its workspace. */
function isPaneFocused(paneId: number, activeWorkspaceId: number | null, workspaces: Workspace[]): boolean {
  if (!document.hasFocus()) return false;
  if (activeWorkspaceId === null) return false;
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  return ws?.focused === paneId;
}

/** Synthesize a soft two-note chime (~250ms). Attack is quick, decay is gentle. */
function synthesizeChime(ctx: AudioContext, volume: number): void {
  try {
    const now = ctx.currentTime;
    const noteDuration = 0.08; // 80ms per note
    const gapDuration = 0.02; // 20ms gap

    const createNote = (freqHz: number, startTime: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freqHz;
      osc.connect(gain);
      gain.connect(ctx.destination);

      // Quick attack (10ms), then linear decay to end.
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(volume * 0.3, startTime + 0.01);
      gain.gain.linearRampToValueAtTime(0, startTime + noteDuration);

      osc.start(startTime);
      osc.stop(startTime + noteDuration);
    };

    // First note: 500Hz, second note: 800Hz.
    createNote(500, now);
    createNote(800, now + noteDuration + gapDuration);
  } catch {
    // Synthesize errors are non-critical (audio unavailable, suspended context, etc).
  }
}

/** Attempt to create/resume the AudioContext. Non-throwing; returns null if unavailable. */
function ensureAudioContext(): AudioContext | null {
  try {
    if (audioContext) {
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }
      return audioContext;
    }

    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return null;

    audioContext = new Ctx();
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
    return audioContext;
  } catch {
    return null; // AudioContext unavailable (autoplay-blocked, no speaker, etc).
  }
}

/** Fire a needs-you chime for the given pane if rate limits and focus state allow. */
export function playNeedsYouChime(
  paneId: number,
  activeWorkspaceId: number | null,
  workspaces: Workspace[]
): void {
  if (!isEnabled()) return;

  const currentTime = now();
  if (currentTime - lastGlobalSoundAt < MIN_GLOBAL_INTERVAL_MS) return;
  const paneLast = lastPaneSoundAt.get(paneId) ?? -Infinity;
  if (currentTime - paneLast < MIN_PANE_INTERVAL_MS) return;

  if (isPaneFocused(paneId, activeWorkspaceId, workspaces)) return;

  const ctx = ensureAudioContext();
  if (!ctx) return;

  lastGlobalSoundAt = currentTime;
  lastPaneSoundAt.set(paneId, currentTime);

  const volume = getVolume() / 100;
  synthesizeChime(ctx, volume);
}

/** Exported for testing: reset rate limiting. Useful for test isolation. */
export function _resetRateLimitingForTest(): void {
  lastGlobalSoundAt = -Infinity;
  lastPaneSoundAt.clear();
}

/** Exported for testing: reset AudioContext. Useful for test isolation. */
export function _resetAudioContextForTest(): void {
  audioContext = null;
}

/** Exported for testing: read the last global sound time. */
export function _getLastGlobalSoundAtForTest(): number {
  return lastGlobalSoundAt;
}

/** Exported for testing: read the last sound time for a pane. */
export function _getLastPaneSoundAtForTest(paneId: number): number {
  return lastPaneSoundAt.get(paneId) ?? 0;
}

/** Exported for testing: inject a mock clock. */
export interface Clock {
  now(): number;
}

let injectedClock: Clock | null = null;

export function _setClockForTest(clock: Clock | null): void {
  injectedClock = clock;
}

// Override Date.now() when a test clock is injected.
function now(): number {
  return injectedClock ? injectedClock.now() : Date.now();
}

/** Exported for testing: check focus suppression without playing. */
export function shouldSuppressSoundForTest(
  paneId: number,
  activeWorkspaceId: number | null,
  workspaces: Workspace[]
): boolean {
  return isPaneFocused(paneId, activeWorkspaceId, workspaces);
}

/** Exported for testing: get the stored volume (0-100). */
export function getStoredVolume(): number {
  return getVolume();
}

/** Exported for testing: get the enabled state. */
export function getEnabledState(): boolean {
  return isEnabled();
}

/** Use the same values and key as Settings. */
export function setEnabledState(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch { /* storage unavailable */ }
}
