// showcase.mjs — the premium Flightdeck product reel.
//
// Technique: deterministic frame-stepped capture over CDP virtual time
// (Emulation.setVirtualTimePolicy). Every timer, rAF and CSS transition in
// the page — including the mock's scripted terminal output and our own
// camera/cursor/caption rig — advances on the same paused-then-budgeted
// clock the Node side owns, so a render is bit-for-bit reproducible and
// nothing is ever captured mid-tween. Validated against this exact app
// (Vite HMR websocket, React state, CSS `transform`/`transform-origin`
// transitions, Playwright click/fill actions) with throwaway probes before
// this file was written — see demo/_video-blockers.md for what those found.
//
// Run from demo/, with the Vite dev server already up at :1420:
//   node showcase.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { FrameCapture } from "./lib/capture.mjs";
import { composeScore, writeWav } from "./lib/music.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "out");
const FRAMES_DIR = path.join(OUT, "frames-hero");
const URL = "http://localhost:1420";
const W = 1440, H = 900;

fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
fs.mkdirSync(FRAMES_DIR, { recursive: true });

const mock = fs.readFileSync(path.join(__dirname, "mock-tauri.js"), "utf8");
const rigJs = fs.readFileSync(path.join(__dirname, "lib", "rig.js"), "utf8");
const rigCss = fs.readFileSync(path.join(__dirname, "lib", "rig.css"), "utf8");
new Function(mock); // fail fast on a mock syntax error rather than record a broken take

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("[mock]") || t.startsWith("[fd-rig]")) return;
  if (m.type() === "warning" || m.type() === "error") console.log(`[console:${m.type()}]`, t);
});

await page.addInitScript(mock);
await page.addInitScript(() => {
  try {
    // Deep Cove dark — also the app's own default (themes.ts DEFAULT_THEME_ID),
    // set explicitly rather than relying on the default so a stray localStorage
    // value from a previous run can't silently flip the recording to light.
    localStorage.setItem("flightdeck-theme-id", "dark");
    localStorage.setItem("flightdeck-theme", "dark"); // legacy fallback key, belt & braces
  } catch { /* non-persistent */ }
});

const client = await page.context().newCDPSession(page);
await client.send("Network.enable");
await client.send("Page.enable");
await client.send("Emulation.setVirtualTimePolicy", { policy: "pause" });

const capture = new FrameCapture(page, client, FRAMES_DIR);

// Generous, open-ended warm-up rather than a fixed budget — the dev server
// can take longer to respond when it's mid-recompile from an unrelated
// concurrent edit elsewhere in the repo (observed directly during this
// build: a transient ReferenceError from a src/Settings.tsx HMR update
// landing mid-render — see demo/_video-blockers.md). Polling for actual
// page readiness instead of assuming a fixed virtual-time budget is enough.
let loaded = false;
page.goto(URL, { waitUntil: "load" }).then(() => { loaded = true; }).catch((e) => console.warn("[showcase] nav error:", e.message));
for (let i = 0; i < 60 && !loaded; i++) await capture.advance(300); // up to 18s virtual / real
if (!loaded) console.warn("[showcase] page load not confirmed after warm-up — continuing anyway");
log("app loaded");

async function ensureRig() {
  const present = await page.evaluate(() => !!window.__fd).catch(() => false);
  if (present) return;
  // Vite serves this dev server live — an edit landing elsewhere in the repo
  // mid-render can trigger a full HMR reload, which wipes our injected rig
  // (and resets React state) since it isn't part of the app bundle. Rig
  // install is idempotent, so just redo it and carry on.
  console.warn("[showcase] rig missing (likely an HMR reload) — reinstalling");
  await page.addStyleTag({ content: rigCss }).catch(() => {});
  await page.evaluate(rigJs).catch((e) => console.warn("[showcase] rig reinstall failed:", e.message));
  await capture.hold(300);
}

await page.addStyleTag({ content: rigCss });
await page.evaluate(rigJs);
for (let i = 0; i < 4; i++) await capture.advance(150);
log("rig installed");

// --- Rig call wrappers (Node -> window.__fd) --------------------------------
const R = {
  camera: (target, opts) => page.evaluate(([t, o]) => window.__fd.camera(t, o), [target, opts]),
  resetCamera: (ms) => page.evaluate((ms) => window.__fd.resetCamera(ms), ms),
  spotlight: (target, opts) => page.evaluate(([t, o]) => window.__fd.spotlight(t, o), [target, opts]),
  clearSpotlight: () => page.evaluate(() => window.__fd.clearSpotlight()),
  showCursor: () => page.evaluate(() => window.__fd.showCursor()),
  hideCursor: () => page.evaluate(() => window.__fd.hideCursor()),
  cursorToEl: (sel, opts) => page.evaluate(([s, o]) => window.__fd.cursorToEl(s, o), [sel, opts]),
  cursorTo: (x, y, ms) => page.evaluate(([x, y, ms]) => window.__fd.cursorTo(x, y, ms), [x, y, ms]),
  press: () => page.evaluate(() => window.__fd.press()),
  release: () => page.evaluate(() => window.__fd.release()),
  keys: (labels) => page.evaluate((labels) => window.__fd.keys(labels), labels),
  hideKeys: () => page.evaluate(() => window.__fd.hideKeys()),
  caption: (t, s, opts) => page.evaluate(([t, s, o]) => window.__fd.caption(t, s, o), [t, s, opts]),
  hideCaption: () => page.evaluate(() => window.__fd.hideCaption()),
  card: (t, tag) => page.evaluate(([t, tag]) => window.__fd.card(t, tag), [t, tag]),
  hideCard: () => page.evaluate(() => window.__fd.hideCard()),
  dip: (on) => page.evaluate((on) => window.__fd.dip(on), on),
};

// --- Scene bookmarks (frame index ranges, for loop extraction + QA) --------
const bookmarks = {};
const markStart = (name) => { bookmarks[name] = { start: capture.frameIndex }; log("scene start:", name); };
const markEnd = (name) => { bookmarks[name].end = capture.frameIndex; log("scene end:", name, `(${((bookmarks[name].end - bookmarks[name].start) / 60).toFixed(1)}s)`); };

// --- Action helpers ----------------------------------------------------------
async function clickAt(selector, opts = {}) {
  const loc = page.locator(selector).first();
  const box = await loc.boundingBox().catch(() => null);
  if (!box) { console.warn("[showcase] clickAt: not found:", selector); return null; }
  const x = box.x + box.width * (opts.px ?? 0.5);
  const y = box.y + box.height * (opts.py ?? 0.5);
  await R.showCursor();
  await R.cursorTo(x, y, opts.travelMs ?? 620);
  await capture.hold(opts.travelMs ?? 620);
  await R.press();
  await capture.hold(130);
  await loc.click({ force: true, timeout: 4000 }).catch((e) => console.warn("[showcase] click failed:", selector, e.message));
  await R.release();
  await capture.hold(opts.settleMs ?? 260);
  return { x, y };
}

async function moveCursorTo(selector, opts = {}) {
  const box = await page.locator(selector).first().boundingBox().catch(() => null);
  if (!box) { console.warn("[showcase] moveCursorTo: not found:", selector); return null; }
  const x = box.x + box.width * (opts.px ?? 0.5);
  const y = box.y + box.height * (opts.py ?? 0.5);
  await R.showCursor();
  await R.cursorTo(x, y, opts.travelMs ?? 700);
  await capture.hold(opts.travelMs ?? 700);
  return { x, y };
}

async function typeInto(selector, text, opts = {}) {
  await page.locator(selector).click({ force: true, timeout: 4000 }).catch(() => {});
  await capture.hold(120);
  for (const ch of text) {
    await page.keyboard.insertText(ch);
    await capture.hold(opts.perChar ?? 42);
  }
  await capture.hold(opts.tail ?? 300);
}

async function selectVendor(slotIndex, vendorId) {
  const sel = `.slot-list .slot-row:nth-child(${slotIndex + 1}) .vsel`;
  await page.locator(sel).selectOption(vendorId, { force: true }).catch((e) => console.warn("[showcase] selectVendor failed:", e.message));
  await capture.hold(240);
}

// Synthetic HTML5 drag: native OS-level drag hangs under headless Chromium
// automation (confirmed with a throwaway probe — both Locator.dragTo() and a
// manual mouse down/move/up sequence stalled indefinitely). Board.tsx's drag
// handlers only read React state set from onDragStart/onDrop, not the
// DataTransfer payload, so dispatching real DragEvents with a short REAL
// wait between each (so React can flush state and re-render before the next
// handler reads it) reproduces the same result deterministically. The
// visible cursor + card lift are our own rig, driven in lockstep.
async function dragCardToColumn(cardSelector, colIndex, opts = {}) {
  await page.evaluate((sel) => document.querySelector(sel)?.setAttribute("data-fd-drag", "1"), cardSelector);
  const marked = '[data-fd-drag="1"]';
  const cardBox = await page.locator(marked).boundingBox().catch(() => null);
  const colBox = await page.evaluate((idx) => {
    const el = document.querySelectorAll(".col")[idx];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, colIndex);
  if (!cardBox || !colBox) { console.warn("[showcase] dragCardToColumn: missing geometry"); return; }

  const sx = cardBox.x + cardBox.width / 2, sy = cardBox.y + cardBox.height / 2;
  const tx = colBox.x + colBox.width / 2, ty = colBox.y + 230;

  await R.showCursor();
  await R.cursorTo(sx, sy, 700);
  await capture.hold(700);
  await R.press();
  await capture.hold(160);

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    window.__fdDt = new DataTransfer();
    el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: window.__fdDt }));
  }, marked);
  await capture.hold(120);

  const STEPS = 10;
  for (let i = 1; i <= STEPS; i++) {
    const x = sx + (tx - sx) * (i / STEPS);
    const y = sy + (ty - sy) * (i / STEPS);
    await R.cursorTo(x, y, 85);
    await page.evaluate((idx) => {
      const el = document.querySelectorAll(".col")[idx];
      el.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: window.__fdDt }));
      el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__fdDt }));
    }, colIndex);
    await capture.hold(85);
  }

  await page.evaluate((idx) => {
    document.querySelectorAll(".col")[idx].dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__fdDt }));
  }, colIndex);
  await capture.hold(140);
  await page.evaluate((sel) => {
    document.querySelector(sel)?.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: window.__fdDt }));
    document.querySelector(sel)?.removeAttribute("data-fd-drag");
  }, marked);
  await R.release();
  await capture.hold(opts.settleMs ?? 260);
}

// Zoom-tracking helper: push in on the Nth open pane (0-based, DOM order),
// centred properly regardless of where it sits in the grid — relies on the
// rig's camera() recentring fix (demo/lib/rig.js). Playwright's Locator.nth
// indexes only matching elements, so this is robust to non-.pane siblings
// under .wsgrid (unlike a raw :nth-of-type CSS selector).
//
// Targets a point ~30% down the pane, not its geometric centre: a pane is
// tall but its live text (header + the first several lines of output) sits
// near the top — centring on the full pane's midpoint punches in on mostly
// empty terminal body (confirmed with a QA frame: a full-pane centre punch
// at 1.9x showed nothing but blank terminal background).
async function cameraToPane(index, opts = {}) {
  const box = await page.locator(".pane").nth(index).boundingBox().catch(() => null);
  if (!box) { console.warn("[showcase] cameraToPane: pane not found:", index); return; }
  await R.camera({ x: box.x + box.width / 2, y: box.y + box.height * 0.3 }, opts);
}

async function dip(holdMs = 300) {
  await R.dip(true);
  await capture.hold(holdMs);
  await R.dip(false);
  await capture.hold(holdMs);
}

// =============================================================================
// (a) Title card
// =============================================================================
markStart("title");
await ensureRig();
await R.card("Flightdeck", "Four agents. One screen.");
await capture.hold(350);
await capture.hold(1750);
await R.hideCard();
await capture.hold(500);
markEnd("title");

await dip(260);

// =============================================================================
// (b) Create a workspace — isolation + worktree setup
// =============================================================================
markStart("worktrees");
await ensureRig();
await R.caption("Start with a folder", "Pick a project — Flightdeck detects whether it's a git repo.");
await capture.hold(300);
await R.camera(".dir", { scale: 1.35, ms: 1800 });
await typeInto(".dir .path", "C:\\dev\\acme-api", { perChar: 40 });
await capture.hold(500);
await R.hideCaption();
await capture.hold(200);

// NewWorkspace's initial slot cycle (defaultCycle()) is a ONE-TIME snapshot
// taken in a useState initializer at mount — before detect_vendors resolves
// (confirmed with a throwaway probe: a QA frame late in this exact scene
// still showed Pane 3/4 as "Claude Code"/"Antigravity", not Codex/Kimi).
// vendorList() is still on the FALLBACK array (claude/agy only) at that
// instant, so the 4-slot cycle repeats claude/agy regardless of what's in
// mock-tauri.js's VENDORS. This is the same race the original file's
// `selectVendor(3, "pwsh")` was already working around — reinstated here for
// the two new vendors so the grid shows all four distinct agents. By the
// time these calls run, the <select> options themselves ARE populated
// (that list re-renders reactively off the store, unlike the one-shot
// initial value), so selecting by id works even though the defaults didn't.
await selectVendor(2, "codex");
await selectVendor(3, "kimi");

await R.caption("Isolation is the default", "Every agent gets its own git worktree and branch — parallel agents can't overwrite each other.");
await moveCursorTo(".isolate-row", { travelMs: 900 });
await R.camera(".isolate-row", { scale: 1.6, ms: 1500 });
await capture.hold(2200);
await R.hideCaption();
await capture.hold(200);

await R.caption("Setup runs first", "A fresh worktree has no node_modules — Flightdeck runs your setup command before the agent starts.");
await moveCursorTo(".setup-input", { travelMs: 700 });
await R.camera(".setup-input", { scale: 1.65, ms: 1400 });
await capture.hold(1600);
await capture.hold(400);
await R.hideCaption();
await R.resetCamera(1200);
await capture.hold(600);

await clickAt(".btn-primary", { travelMs: 700 });
// Trust prompt: mandatory, not optional — the Antigravity slot needs a
// folder-trust confirm before ANY pane spawns. Its timing is not tightly
// bound to the Create click (observed anywhere from ~200ms to several
// seconds later, and occasionally the first click doesn't register at all —
// confirmed flaky with throwaway probes, see demo/_video-blockers.md), so
// this polls generously and retries the click rather than assuming either.
async function dismissTrustIfPresent(budgetMs) {
  const steps = Math.round(budgetMs / 150);
  for (let i = 0; i < steps; i++) {
    if ((await page.locator(".confirm-modal .btn-primary").count()) > 0) {
      // force:true — Playwright's actionability "stable" check polls via
      // rAF, which never fires while the CDP virtual clock is paused (root
      // cause of an intermittent hang, found with a throwaway probe: the
      // modal was found every time, but a non-forced click on it hung for
      // the full 30s default timeout). Every other click in this file
      // already forces for the same reason; this one was the one miss.
      await page.locator(".confirm-modal .btn-primary").click({ force: true, timeout: 2000 }).catch(() => {});
      await capture.hold(200);
      return true;
    }
    await capture.hold(150);
  }
  return false;
}
let trustSeen = await dismissTrustIfPresent(4000);
if (!trustSeen && (await page.locator(".pane").count()) === 0) {
  console.warn("[showcase] trust modal missed first pass — retrying Create click");
  await page.locator(".btn-primary").first().click({ force: true, timeout: 3000 }).catch(() => {});
  await capture.hold(300);
  trustSeen = await dismissTrustIfPresent(4000);
}
if (!trustSeen) console.warn("[showcase] trust modal never appeared — workspace may have 0 panes");
await capture.hold(800);
markEnd("worktrees");

await dip(260);

// =============================================================================
// (c) The grid, alive — four differentiated agents
// =============================================================================
markStart("grid");
await ensureRig();
await R.resetCamera(0);
await R.caption("Claude, Antigravity, Codex and Kimi — one screen", "Every pane is a real terminal — status, branch, diff and token use live in each header.");
await capture.hold(500);
await R.camera(".wsgrid", { scale: 1.12, ms: 1300 });
await capture.hold(1300);
await capture.hold(500);
await R.hideCaption();
await capture.hold(200);

// Zoom-tracking: the camera actively follows the action, punching into each
// agent's own terminal in turn rather than sitting on one static wide shot.
for (let i = 0; i < 4; i++) {
  await cameraToPane(i, { scale: 1.9, ms: 800 });
  await capture.hold(800);
  await capture.hold(450);
}
await R.camera(".wsgrid", { scale: 1.1, ms: 850 });
await capture.hold(850);
await capture.hold(250);

await R.caption("You can see what changed", "The +/− badge is that agent's diff against its base branch, live as it works.");
await moveCursorTo(".pdiff", { travelMs: 700 });
await R.camera(".pdiff", { scale: 1.85, ms: 1400 });
await capture.hold(2200);
await R.hideCaption();
await R.resetCamera(1200);
await capture.hold(1000);
markEnd("grid");

await dip(260);

// =============================================================================
// (d) Attention — the core value
// =============================================================================
markStart("attention");
await ensureRig();
// The claude-approval pane's script fires its permission prompt ~5.6s after
// spawn (see mock-tauri.js) — by this point in the timeline it has long
// since landed, but poll defensively rather than assume.
let blocked = 0;
for (let i = 0; i < 20 && blocked === 0; i++) {
  blocked = await page.locator(".pattn.permission").count();
  if (blocked === 0) await capture.hold(200);
}
if (blocked > 0) {
  // The workspace tile's severity ring + count badge (left panel) is the
  // more user-visible attention surface now — show it before the pane-level
  // detail.
  const needyTileSel = '.lp-ws[class*="needy-"]';
  if (await page.locator(needyTileSel).count()) {
    await R.caption("Flagged where you're already looking", "The workspace tile shows exactly what needs you, before you even open it.");
    await R.camera(needyTileSel, { scale: 1.9, ms: 1300 });
    await capture.hold(1900);
    await R.hideCaption();
    await R.resetCamera(1000);
    await capture.hold(400);
  }
  await R.caption("One agent needs you", "Approval prompts are detected and ranked first, so nothing blocked sits unnoticed.");
  await moveCursorTo(".pattn.permission", { travelMs: 800 });
  await R.spotlight(".pattn.permission", { strength: 0.55, ms: 1200 });
  await R.camera(".pattn.permission", { scale: 1.85, ms: 1500 });
  await capture.hold(3000);
} else {
  console.warn("[showcase] no approval state reached — scene continues without it");
}
await R.hideCaption();
await R.clearSpotlight();
await capture.hold(300);

await R.keys(["Ctrl", "Shift", "A"]);
await page.keyboard.down("Control");
await page.keyboard.down("Shift");
await page.keyboard.press("A");
await page.keyboard.up("Shift");
await page.keyboard.up("Control");
await capture.hold(500);
await R.hideKeys();
await capture.hold(200);

if (await page.locator(".aq-panel").isVisible().catch(() => false)) {
  await R.resetCamera(1400);
  await R.caption("The attention queue", "Everything waiting on you, across every workspace — approvals first, longest-waiting first.", { side: "top" });
  await R.camera(".aq-panel", { scale: 1.3, ms: 1600 });
  await capture.hold(3000);
  await R.hideCaption();
  await page.keyboard.press("Escape");
} else {
  console.warn("[showcase] attention queue did not open — scene skipped");
}
await capture.hold(300);
await R.resetCamera(1200);
await capture.hold(600);
markEnd("attention");

await dip(260);

// =============================================================================
// (e) Review money shot — diff, split view, merge back
// =============================================================================
markStart("review");
await ensureRig();
await R.caption("Review before you merge", "Open any agent's work as a diff — no switching to a terminal or an editor.", { side: "top" });
await capture.hold(300);
await clickAt(".pdiff", { travelMs: 700 });
await capture.hold(1200);
await R.camera(".rv-patch-bar", { scale: 1.3, ms: 1600 });
await capture.hold(1400);
await R.hideCaption();
await capture.hold(200);

await R.caption("Side by side, word by word", "Split view and intra-line highlighting show exactly what changed.", { side: "top" });
const splitBtn = page.locator(".rv-patch-bar .rv-ic[aria-pressed]").first();
if (await splitBtn.count()) {
  await clickAt(".rv-patch-bar .rv-ic[aria-pressed]", { travelMs: 600 });
}
await capture.hold(2500);
await R.hideCaption();
await capture.hold(200);

await R.caption("Land it, or hand it off", "Merge back locally, or push the branch and open a pull request.", { side: "top" });
await moveCursorTo(".rv-foot", { travelMs: 700 });
await R.camera(".rv-foot", { scale: 1.5, ms: 1400 });
await capture.hold(1600);
if (await page.locator(".rv-merge").count()) {
  await clickAt(".rv-merge", { travelMs: 500 });
}
await capture.hold(1500);
await R.hideCaption();
await R.resetCamera(1100);
await capture.hold(500);
await page.keyboard.press("Escape");
await capture.hold(400);
markEnd("review");

await dip(260);

// =============================================================================
// (f) Board — drag to dispatch
// =============================================================================
markStart("board");
await ensureRig();
await R.caption("Dispatch work from a board", "Drop a card into In Progress and an agent picks it up — on a branch named after the task.");
await capture.hold(300);
await clickAt(".lp-app", { travelMs: 700 }); // Board nav item in the left rail
await capture.hold(1200);
await R.camera(".board", { scale: 1.08, ms: 1600 });
await capture.hold(1400);
await R.hideCaption();
await capture.hold(200);

await dragCardToColumn(".card", 1, { settleMs: 400 }); // 1 = "In Progress"
await capture.hold(600);

await R.caption("Live, on the card", "The agent's status shows right where you dropped it.");
await R.camera(".col:nth-of-type(2)", { scale: 1.4, ms: 1400 });
await capture.hold(2200);
await R.hideCaption();
await R.resetCamera(1100);
await capture.hold(500);
markEnd("board");

await dip(260);

// =============================================================================
// (g) Theme montage
// =============================================================================
markStart("themes");
await ensureRig();
await page.keyboard.press("Control+,");
await capture.hold(500);
await page.evaluate(() => {
  const secs = [...document.querySelectorAll(".set-section")];
  const appearance = secs.find((s) => s.querySelector(".set-label")?.textContent?.trim() === "Appearance");
  appearance?.scrollIntoView({ block: "start" });
});
await capture.hold(300);
await R.camera(".theme-grid", { scale: 1.25, ms: 1600 });
await capture.hold(1600);
await R.caption("Make it yours", "Six built-in themes, or import your own.");
await capture.hold(500);
// Deep Cove Dark closes the loop (not "— Light" — this cut stays dark
// throughout; the owner rejected the earlier light-theme cut).
for (const label of ["Dracula", "Gruvbox Dark", "Nord", "Deep Cove — Dark"]) {
  const tile = page.locator(`.theme-tile[title="${label}"]`);
  if (await tile.count()) await tile.click({ force: true, timeout: 3000 }).catch(() => {});
  await capture.hold(680);
}
await R.hideCaption();
await R.resetCamera(1200);
await capture.hold(400);
await page.keyboard.press("Escape");
await capture.hold(400);

// Zoom HUD flourish — whole-app zoom is another "make it yours" control,
// cheap to show right where the theme picker already has the caption up.
await R.caption("Zoom to taste", "Ctrl and +/− scales the whole cockpit.");
await page.keyboard.press("Control+=");
await capture.hold(120);
await page.keyboard.press("Control+=");
await capture.hold(700);
await page.keyboard.press("Control+0");
await capture.hold(600);
await R.hideCaption();
await capture.hold(300);
markEnd("themes");

await dip(260);

// =============================================================================
// (g.5) Live demo callout — short beat before the end card
// =============================================================================
markStart("livedemo");
await ensureRig();
await R.resetCamera(0);
await R.caption("Try it yourself", "Live demo — kove.nz/flightdeck-demo");
await capture.hold(2200);
await R.hideCaption();
await capture.hold(200);
markEnd("livedemo");

await dip(280);

// =============================================================================
// (h) End card
// =============================================================================
markStart("endcard");
await ensureRig();
await R.hideCursor();
await R.card("Flightdeck", "Local-first. No account. Windows. — kove.nz/flightdeck-demo");
await capture.hold(400);
await capture.hold(2000);
markEnd("endcard");

const totalFrames = capture.frameIndex;
log("capture complete:", totalFrames, "frames", `(${(totalFrames / 60).toFixed(1)}s)`);

await browser.close();

fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify({ fps: 60, width: 2880, height: 1800, totalFrames, bookmarks }, null, 2),
);

// =============================================================================
// Encode: master webm (vp9) + mp4 (h264), poster, and four feature loops
// extracted directly from the frame sequence (no re-encode-of-a-re-encode
// quality loss).
// =============================================================================
function ffmpeg(args, label) {
  log("ffmpeg:", label);
  execFileSync(ffmpegPath, args, { stdio: "inherit" });
}

const framesGlob = path.join(FRAMES_DIR, "frame-%06d.png");

const videoOnlyWebm = path.join(OUT, "_video-only.webm");
const videoOnlyMp4 = path.join(OUT, "_video-only.mp4");

ffmpeg(
  ["-y", "-framerate", "60", "-i", framesGlob,
   "-vf", "scale=1440:900:flags=lanczos", "-pix_fmt", "yuv420p",
   "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "20", "-quality", "good", "-cpu-used", "2", "-row-mt", "1",
   videoOnlyWebm],
  "master .webm (video only)",
);

ffmpeg(
  ["-y", "-framerate", "60", "-i", framesGlob,
   "-vf", "scale=1440:900:flags=lanczos", "-pix_fmt", "yuv420p",
   "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-movflags", "+faststart",
   videoOnlyMp4],
  "master .mp4 (video only)",
);

// =============================================================================
// Score: generative, scene-synced, rights-clean (demo/lib/music.mjs). Built
// straight from the bookmarks this exact render produced, so a chord change
// / pulse entrance / riser lands on the render's own scene timestamps, not a
// hand-tuned cue sheet that can drift out of sync on a re-render.
// =============================================================================
const manifest = { fps: 60, width: 2880, height: 1800, totalFrames, bookmarks };
const score = composeScore(manifest);
const wavPath = path.join(OUT, "score.wav");
writeWav(wavPath, score.pcm, score.sampleRate);
log("score.wav <-", score.seconds.toFixed(1) + "s",
  `bed ${score.stats.padBedRmsDbfs.toFixed(1)}dBFS RMS, peak ${score.stats.mixPeakDbfs.toFixed(1)}dBFS`);
for (const e of score.events) log("  cue:", e.name, "@", e.atSec.toFixed(2) + "s");

// Mux: video stream copied as-is (no re-encode-of-a-re-encode loss), audio
// encoded per container (aac for mp4, opus for webm). The four loop-*.mp4
// below are cut directly from the silent frame sequence and stay silent —
// they're autoplay background loops, not the scored piece.
ffmpeg(
  ["-y", "-i", videoOnlyMp4, "-i", wavPath,
   "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
   path.join(OUT, "flightdeck-showcase.mp4")],
  "mux .mp4 + aac score",
);
ffmpeg(
  ["-y", "-i", videoOnlyWebm, "-i", wavPath,
   "-c:v", "copy", "-c:a", "libopus", "-b:a", "128k", "-shortest",
   path.join(OUT, "flightdeck-showcase.webm")],
  "mux .webm + opus score",
);
fs.rmSync(videoOnlyMp4, { force: true });
fs.rmSync(videoOnlyWebm, { force: true });

// Poster: a settled, caption-free wide shot of the grid scene — all four
// vendor labels (Claude / Antigravity / Codex / Kimi) legible in their pane
// headers, dark theme. Offset +508 lands in the second wide "re-establish"
// hold, right after the pane-to-pane tracking loop and well clear of both
// the caption and the camera transition (see the grid scene above).
const posterFrame = bookmarks.grid ? bookmarks.grid.start + 508 : Math.floor(totalFrames / 2);
const posterSrc = path.join(FRAMES_DIR, `frame-${String(posterFrame).padStart(6, "0")}.png`);
fs.copyFileSync(posterSrc, path.join(OUT, "poster.png"));
log("poster.png <-", path.basename(posterSrc));

// Feature loops — direct frame-range extraction, 1440x900@60.
const LOOPS = [
  { name: "loop-worktrees", scene: "worktrees" },
  { name: "loop-attention", scene: "attention" },
  { name: "loop-review", scene: "review" },
  { name: "loop-board", scene: "board" },
];
for (const { name, scene } of LOOPS) {
  const b = bookmarks[scene];
  if (!b) { console.warn("[showcase] no bookmark for loop:", scene); continue; }
  const start = b.start;
  const count = Math.min(b.end - b.start, 15 * 60); // cap at 15s
  ffmpeg(
    ["-y", "-framerate", "60", "-start_number", String(start), "-i", framesGlob, "-frames:v", String(count),
     "-vf", "scale=1440:900:flags=lanczos", "-pix_fmt", "yuv420p",
     "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-movflags", "+faststart",
     path.join(OUT, `${name}.mp4`)],
    `${name} (${(count / 60).toFixed(1)}s)`,
  );
}

log("done. See", OUT);
