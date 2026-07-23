// capture.mjs — deterministic, frame-stepped video capture over CDP virtual time.
//
// Technique: Emulation.setVirtualTimePolicy("pause") before navigation, then
// repeated "advance" budgets of exactly one frame (1000/60 ms). Every timer,
// rAF and CSS transition/animation in the page is driven by that same virtual
// clock, so a capture is bit-for-bit reproducible — no dropped frames, no
// timing drift between the mock's scripted pane output and what's on screen
// when we screenshot. Verified against this app before building the full
// rig: Vite's HMR websocket still connects under a paused clock, the mock's
// setTimeout-scripted terminal output advances exactly on budget, and CSS
// `transform`/`transform-origin`/`left` transitions interpolate linearly
// with virtual ms (see demo/_video-blockers.md for the throwaway probes).
//
// Each `advance()` is followed by a short REAL wait — the CDP round trip and
// the renderer's paint are real wall-clock work even though the page's own
// clock is virtual; skipping this wait captures stale frames.
import fs from "node:fs";
import path from "node:path";

export const FPS = 60;
export const FRAME_MS = 1000 / FPS;

export class FrameCapture {
  /**
   * @param {import('playwright').Page} page
   * @param {import('playwright').CDPSession} client
   * @param {string} dir  output directory for numbered PNG frames
   */
  constructor(page, client, dir) {
    this.page = page;
    this.client = client;
    this.dir = dir;
    this.frameIndex = 0;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Advance the page's virtual clock by `ms` and let the CDP round trip settle. */
  async advance(ms) {
    await this.client.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: ms });
    await new Promise((r) => setTimeout(r, 22));
  }

  /** Capture exactly one PNG frame at the current state, without advancing time. */
  async captureFrame() {
    const { data } = await this.client.send("Page.captureScreenshot", { format: "png" });
    const name = `frame-${String(this.frameIndex).padStart(6, "0")}.png`;
    fs.writeFileSync(path.join(this.dir, name), Buffer.from(data, "base64"));
    this.frameIndex += 1;
    return this.frameIndex - 1;
  }

  /** Advance one frame-step and capture it. The unit the whole rig is built on. */
  async step() {
    await this.advance(FRAME_MS);
    return this.captureFrame();
  }

  /** Hold the scene for `ms`, capturing a frame every 1/60s. Returns frame count. */
  async hold(ms) {
    const n = Math.max(1, Math.round(ms / FRAME_MS));
    for (let i = 0; i < n; i++) await this.step();
    return n;
  }

  /** Advance without capturing — for skipping settle time that shouldn't be on camera. */
  async fastForward(ms) {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(remaining, 500);
      await this.advance(step);
      remaining -= step;
    }
  }

  /** Current frame index — use as a bookmark for scene/loop ranges. */
  bookmark() {
    return this.frameIndex;
  }

  /** Elapsed video time in seconds at 60fps. */
  get seconds() {
    return this.frameIndex / FPS;
  }
}
