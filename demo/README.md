# Flightdeck demo reel

`reel.html` + `reel.js` are a standalone, self-contained motion-graphics recreation of the Flightdeck cockpit (Deep Cove theme) — autoplays on load, no build step, no dependency on the running app.

The engine is a deterministic master clock: every visual (scene opacity, camera transform, cursor path, typed text, captions) is a pure function of `t` (seconds since reel start). Normal playback drives `t` from `requestAnimationFrame`. Loading `reel.html?at=SECONDS` renders one exact paused frame at that timestamp with no animation running — use this to check framing/clipping/captions before burning a full recording.

To re-record: `npm install`, `npx playwright install chromium`, then `npm run record`. The rendered video lands at `out/flightdeck-demo.webm`.
