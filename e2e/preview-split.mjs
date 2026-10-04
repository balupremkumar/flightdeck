// QL-708: pinning the Preview as a split must not restart running panes, must
// not close on Escape, and must collapse when the last tab closes.
//
// Run from e2e/ with the Vite dev server up: FD_URL=http://localhost:1432 node preview-split.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const wrap = `(()=>{const T=window.__TAURI_INTERNALS__;const inv=T.invoke;window.__spawned=[];window.__size={};window.__ptylog=[];T.invoke=(c,a)=>{if(c==="pty_resize")window.__size[a.paneId]={cols:a.cols,rows:a.rows};if(c==="pty_kill")window.__ptylog.push("kill "+a.paneId);const r=inv(c,a);if(c==="pty_spawn"){Promise.resolve(r).then(id=>{window.__spawned.push(id);window.__size[id]={cols:a.cols,rows:a.rows};window.__ptylog.push("spawn "+id);});}return r;};})();`;

const URL = process.env.FD_URL ?? "http://localhost:1420";
const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.error("FAIL: " + msg); } else console.log("ok: " + msg); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + wrap);
await page.goto(URL, { waitUntil: "networkidle" });
// Wait for the panes to actually spawn (a cold Vite can take longer than any
// fixed sleep to serve the lazy chunks), then let layout settle.
await page.waitForFunction(() => (window.__spawned ?? []).length > 0, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1000);

const spawned = await page.evaluate(() => window.__spawned.slice());
console.log(`spawned: [${spawned}]`);
if (!spawned.length) { console.error("PREVIEW-SPLIT FAIL: no panes"); await browser.close(); process.exit(1); }

// Tag terminals so we can prove the same DOM nodes survive.
await page.evaluate(() => document.querySelectorAll(".pane .xterm").forEach((x, i) => { x.__fdTag = "t" + i; }));
const tagCount = await page.evaluate(() => [...document.querySelectorAll(".pane .xterm")].filter((x) => x.__fdTag).length);
const kills = () => page.evaluate(() => window.__ptylog.filter((l) => l.startsWith("kill")));
const survivors = () => page.evaluate(() => [...document.querySelectorAll(".pane .xterm")].filter((x) => x.__fdTag).length);

// Open a preview the same way a user does: via the palette-less route, the
// Explorer is heavy, so use the app store through a terminal link click.
const id = spawned[0];
const pane = page.locator(".pane:visible").first();
const SPACED = "D:\\Dev\\ai\\projects\\active\\Kove Clients\\STATE.md";
await page.evaluate(([i, t]) => window.__mockPrint(i, t), [id, "\x1b[2J\x1b[Hspaced: " + SPACED]);
await page.waitForTimeout(500);
const screen = pane.locator(".xterm-screen");
const box = await screen.boundingBox();
const sz = await page.evaluate((i) => window.__size[i], id);
const px = box.x + (8 + 30 + 0.5) * (box.width / sz.cols);
const py = box.y + 0.5 * (box.height / sz.rows);
await page.mouse.move(px - 30, py - 30);
await page.mouse.move(px, py, { steps: 4 });
await page.waitForTimeout(500);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(900);

check(await page.locator(".prv-scrim .prv-drawer").isVisible().catch(() => false), "drawer mode: preview open inside the scrim");

// Pin.
await page.locator(".prv-pin").click();
await page.waitForTimeout(800);
check((await page.locator(".prv-scrim").count()) === 0, "pinned: no scrim");
check(await page.locator(".prv-drawer.prv-split").isVisible(), "pinned: split preview visible");
{
  const g = await page.locator(".split-main").boundingBox();
  const p = await page.locator(".split-preview").boundingBox();
  const total = g.width + p.width;
  console.log(`grid ${g.width.toFixed(0)} preview ${p.width.toFixed(0)} (${((p.width / total) * 100).toFixed(1)}%)`);
  check(p.x > g.x && p.width / total > 0.19 && g.width / total > 0.29, "pinned: preview on the right, min sizes respected");
}
check((await kills()).length === 0, `pin: zero pty_kill (saw ${JSON.stringify(await kills())})`);
check((await survivors()) === tagCount, `pin: all ${tagCount} terminal DOM nodes survived (${await survivors()})`);

// Escape must NOT close a pinned preview.
await page.mouse.move(2, 2);
await page.locator(".prv-tab").first().focus();
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(await page.locator(".prv-drawer.prv-split").isVisible(), "pinned: Escape does not close the preview");

// Closing the last tab collapses the split.
await page.locator(".prv-tab-close").first().click();
await page.waitForTimeout(600);
check((await page.locator(".split-preview").count()) === 0, "closing the last tab collapses the split");
check((await kills()).length === 0, "collapse: zero pty_kill");
check((await survivors()) === tagCount, "collapse: terminal DOM nodes survived");

// Unpin path: reopen (pin remembered), then unpin back to the drawer.
await page.evaluate(([i, t]) => window.__mockPrint(i, t), [id, "\x1b[2J\x1b[Hspaced: " + SPACED]);
await page.waitForTimeout(500);
{
  const b2 = await screen.boundingBox();
  const s2 = await page.evaluate((i) => window.__size[i], id);
  const x2 = b2.x + (8 + 30 + 0.5) * (b2.width / s2.cols);
  const y2 = b2.y + 0.5 * (b2.height / s2.rows);
  await page.mouse.move(x2 - 30, y2 - 30);
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.waitForTimeout(500);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(900);
}
check(await page.locator(".prv-drawer.prv-split").isVisible().catch(() => false), "pin is remembered: reopening lands in the split");
await page.locator(".prv-pin").click();
await page.waitForTimeout(800);
check(await page.locator(".prv-scrim .prv-drawer").isVisible().catch(() => false), "unpin: back to the drawer");
check((await kills()).length === 0, `unpin: zero pty_kill (saw ${JSON.stringify(await kills())})`);
check((await survivors()) === tagCount, "unpin: terminal DOM nodes survived");

// Drawer Escape still closes.
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check((await page.locator(".prv-drawer").count()) === 0, "drawer mode: Escape still closes");

if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 3).join(" | "));
await browser.close();
if (failures.length) { console.error("PREVIEW-SPLIT FAIL:\n  " + failures.join("\n  ")); process.exit(1); }
console.log("PREVIEW-SPLIT PASS");
