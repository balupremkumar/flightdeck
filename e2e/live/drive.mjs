// Live driver for a running Canary build (WebView2 remote-debugging port 9333, see launch.mjs).
// All input goes through CDP (Playwright keyboard/mouse/evaluate). No OS-level input, no foreground calls.
//
// Production builds do not expose the app's modules, so terminal text is read through the app's own
// Rust command `pane_tail` (ANSI-stripped tail of the pane's replay ring), keyed by the modelId the
// frontend passes to `pty_spawn` (recorded by an init script that wraps invoke).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PORT = 9333;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPAWN_LOG = `(() => {
  const T = window.__TAURI_INTERNALS__;
  if (!T || T.__fdWrapped) return;
  T.__fdWrapped = true;
  const inv = T.invoke.bind(T);
  window.__fdSpawns = window.__fdSpawns || [];
  T.invoke = (c, a, o) => {
    const p = inv(c, a, o);
    if (c === "pty_spawn") {
      const rec = { modelId: a && a.modelId, vendor: a && a.vendor, cwd: a && a.cwd, focusMode: !!(a && a.focusMode), t: Date.now() };
      window.__fdSpawns.push(rec);
      Promise.resolve(p).then((id) => { rec.ptyId = id; }, (e) => { rec.err = String(e); });
    }
    return p;
  };
})();`;

export function canaryPid() {
  return Number(readFileSync(path.join(here, ".canary.pid"), "utf8"));
}

/** Connect over CDP and return { browser, ctx, page } for the main app page. */
export async function connect() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  await ctx.addInitScript(SPAWN_LOG);
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = ctx.pages().find((p) => /tauri\.localhost|localhost:1420/.test(p.url()) && !/devtools/.test(p.url()));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("no app page found: " + ctx.pages().map((p) => p.url()).join(", "));
  // The init script only covers future loads; wrap the current page too.
  await page.evaluate(SPAWN_LOG);
  return { browser, ctx, page };
}

export const invoke = (page, cmd, args = {}) =>
  page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

export const getLocal = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

/** Merge test settings into the same localStorage keys the Settings UI writes, then reload. */
export async function applyTestSettings(page, { flags = {}, openClaudeIn = "terminal", mute = true } = {}) {
  await page.evaluate(({ flags, openClaudeIn, mute }) => {
    const j = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "") ?? d; } catch { return d; } };
    const agents = j("flightdeck-agent-settings", {});
    localStorage.setItem("flightdeck-agent-settings", JSON.stringify({
      ...agents, defaultVendor: "claude", openClaudeIn, flags: { ...(agents.flags ?? {}), ...flags },
    }));
    // The harness drives the "Reopen last session?" prompt; 0.6.3 made silent reopen the default.
    localStorage.setItem("flightdeck-startup", "launcher");
    // The "quiet" default is chosen per pane here, so make sure the one-shot 0.6.1 migration cannot interfere.
    if (mute) {
      const n = j("flightdeck-notify-settings", {});
      const off = (o) => Object.fromEntries(Object.keys({ starting: 0, running: 0, idle: 0, waiting: 0, permission: 0, error: 0 }).map((k) => [k, false]));
      localStorage.setItem("flightdeck-notify-settings", JSON.stringify({
        ...n, sound: false, osToast: false, osToastOn: off(), dnd: true,
      }));
      // Settings writes "0"/"1" but needsYouSound.ts only honours "false": set both facts.
      localStorage.setItem("flightdeck-sound-needs-you", "false");
    }
  }, { flags, openClaudeIn, mute });
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".launcher, .cockpit, .pane", { timeout: 30000 });
  // The init script can run before Tauri injects __TAURI_INTERNALS__; wrap again now (idempotent).
  await page.evaluate(SPAWN_LOG);
}

/** Ctrl+, then pick a Settings section by its nav label. */
export async function openSettings(page, section) {
  await page.locator('button[title^="Settings"]').first().click();
  await page.waitForTimeout(500);
  if (section) await page.getByText(section, { exact: true }).first().click();
  await page.waitForTimeout(300);
}
export const closeSettings = async (page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(200); };

/** Drive the first-run launcher: N panes of one vendor on a folder, no worktree isolation. */
export async function createWorkspace(page, { root, count = 2, vendor = "claude" }) {
  await page.waitForSelector(".launcher .dir .path", { timeout: 20000 });
  await page.locator(".launcher .tiles .tile").filter({ hasText: new RegExp(`^\\s*${count}\\s*$`) }).first().click();
  await page.fill(".launcher .dir .path", root);
  await page.waitForTimeout(800);
  const iso = page.locator(".launcher .isolate-row input[type=checkbox]");
  if (await iso.count() && await iso.isChecked()) await iso.uncheck();
  const sels = page.locator(".launcher .vsel");
  for (let i = 0; i < await sels.count(); i++) await sels.nth(i).selectOption(vendor);
  await page.click(".launcher .btn-primary");
  await page.waitForSelector(".pane", { timeout: 30000 });
}

export const panes = (page) => page.locator(".pane");

/** modelIds in pane order (latest spawn per modelId), from the recorded pty_spawn calls. */
export async function spawnLog(page) {
  return page.evaluate(() => window.__fdSpawns ?? []);
}
export async function modelIds(page) {
  const log = await spawnLog(page);
  const latest = new Map();
  for (const s of log) latest.set(s.modelId, s);
  // Spawns that happened before the wrapper was installed are found by probing pane_tail.
  for (let id = 1; id <= 16; id++) {
    if (latest.has(id)) continue;
    try { await invoke(page, "pane_tail", { modelId: id, maxBytes: 1024 }); latest.set(id, { modelId: id, focusMode: null }); } catch { /* no live pty */ }
  }
  return [...latest.values()].sort((a, b) => a.modelId - b.modelId);
}

export const tail = async (page, modelId, bytes = 65536) => (await invoke(page, "pane_tail", { modelId, maxBytes: bytes })).lines;
export const tailSeq = async (page, modelId) => (await invoke(page, "pane_tail", { modelId, maxBytes: 1024 })).seq;

/** Focus a pane (header mousedown, same as a user click) and make sure its xterm textarea has keyboard focus. */
export async function focusPane(page, i) {
  const pane = panes(page).nth(i);
  await pane.locator(".pband").first().click({ position: { x: 20, y: 2 } }).catch(() => {});
  await pane.locator("textarea.xterm-helper-textarea").first().focus({ timeout: 5000 }).catch(() => {});
}

export async function typeInPane(page, i, text, { enter = false, delay = 8 } = {}) {
  await focusPane(page, i);
  if (text) await page.keyboard.type(text, { delay });
  if (enter) await page.keyboard.press("Enter");
}
export async function pressInPane(page, i, key) {
  await focusPane(page, i);
  await page.keyboard.press(key);
}

/** Resolve once the pane's output has been silent for quietMs (after at least minMs), or reject on timeout. */
export async function waitQuiet(page, modelId, { quietMs = 8000, minMs = 15000, timeoutMs = 240000 } = {}) {
  const t0 = Date.now();
  let last = await tailSeq(page, modelId), lastChange = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(500);
    const s = await tailSeq(page, modelId);
    if (s !== last) { last = s; lastChange = Date.now(); }
    if (Date.now() - t0 >= minMs && Date.now() - lastChange >= quietMs) return;
  }
  throw new Error(`pane ${modelId} never went quiet within ${timeoutMs} ms`);
}

/** Wait until the pane's plain-text tail matches `re`; returns the lines. */
export async function waitForText(page, modelId, re, { timeoutMs = 60000, bytes = 65536 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const lines = await tail(page, modelId, bytes);
    if (re.test(lines.join("\n"))) return lines;
    await sleep(700);
  }
  throw new Error(`pane ${modelId}: text ${re} not seen within ${timeoutMs} ms`);
}

export async function shotPane(page, i, file, { zoom = 1 } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  // With webview zoom != 1 the captured surface is in physical pixels (css * zoom) and the element screenshot
  // miscomputes its box, so clip by hand.
  const r = await panes(page).nth(i).evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
  await page.screenshot({ path: file, clip: { x: Math.floor(r.x * zoom), y: Math.floor(r.y * zoom), width: Math.floor(r.width * zoom), height: Math.floor(r.height * zoom) } });
  return file;
}
/** Window screenshot cropped to the real window (the surface is css-sized, content fills only css*zoom). */
export async function shotWindowZ(page, file, zoom = 1) {
  mkdirSync(path.dirname(file), { recursive: true });
  const v = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: Math.floor(v.w * zoom), height: Math.floor(v.h * zoom) } });
  return file;
}
export async function shotWindow(page, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  return file;
}

/** Resize/move the Canary window (SWP_NOACTIVATE, off-screen). The Tauri window API is not granted to the page. */
export function setWindow({ width, height, x = -20000, y = 0 }) {
  return execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "window.ps1"),
    "-ProcessId", String(canaryPid()), "-Mode", "move", "-X", String(x), "-Y", String(y), "-Width", String(width), "-Height", String(height), "-WaitMs", "100"],
  { encoding: "utf8" }).trim();
}
export function foreground() {
  return execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "window.ps1"), "-ProcessId", "0", "-Mode", "foreground"], { encoding: "utf8" }).trim();
}

/** The cloned/previous session offers "Reopen last session?"; decline it so the launcher shows. */
export async function declineRestore(page) {
  const cancel = page.getByRole("button", { name: "Cancel" });
  const reopen = page.getByRole("button", { name: "Reopen session" });
  try { await reopen.waitFor({ timeout: 4000 }); await cancel.click(); await page.waitForTimeout(400); return true; } catch { return false; }
}

export const wrapSpawns = (page) => page.evaluate(SPAWN_LOG);

/** Emulate a taller/wider CSS viewport (CDP) so a long turn fits one screenshot. Pass null to clear. */
export async function setViewport(page, size) {
  const s = await page.context().newCDPSession(page);
  if (!size) await s.send("Emulation.clearDeviceMetricsOverride");
  else await s.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.dsf ?? 1.1, mobile: false });
  await s.detach();
  await page.waitForTimeout(2500);
}
