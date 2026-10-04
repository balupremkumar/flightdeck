// H2: copy-on-select and right-click paste, end to end on the mock backend.
// Run with the Vite dev server up: FD_URL=http://localhost:1436 node copy-paste.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const wrap = `(()=>{const T=window.__TAURI_INTERNALS__;const inv=T.invoke;window.__spawned=[];window.__size={};window.__writes=[];T.invoke=(c,a)=>{if(c==="pty_resize")window.__size[a.paneId]={cols:a.cols,rows:a.rows};if(c==="pty_write")window.__writes.push({id:a.paneId,data:a.data});const r=inv(c,a);if(c==="pty_spawn"){Promise.resolve(r).then(id=>{window.__spawned.push(id);window.__size[id]={cols:a.cols,rows:a.rows};});}return r;};})();`;

const URL = process.env.FD_URL ?? "http://localhost:1420";
const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.error("FAIL: " + msg); } else console.log("ok: " + msg); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + wrap);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

const spawned = await page.evaluate(() => window.__spawned.slice());
if (!spawned.length) { console.error("COPY-PASTE FAIL: no panes spawned"); await browser.close(); process.exit(1); }
const id = spawned[0];
const pane = page.locator(".pane:visible").first();
const screen = pane.locator(".xterm-screen");

const WORD = "copyme-token-42";
const LINK = "src/app.ts:12";
await page.evaluate(([i, t]) => window.__mockPrint(i, t), [id, `\x1b[2J\x1b[H${WORD}\nlink: ${LINK}\n`]);
await page.waitForTimeout(500);

const cell = async (row, col) => {
  const box = await screen.boundingBox();
  const sz = await page.evaluate((i) => window.__size[i], id);
  return { x: box.x + (col + 0.5) * (box.width / sz.cols), y: box.y + (row + 0.5) * (box.height / sz.rows) };
};
const clip = () => page.evaluate(() => navigator.clipboard.readText());
const writes = () => page.evaluate(() => window.__writes.slice());
const setTerm = (patch) => page.evaluate((p) => {
  const k = "flightdeck-terminal-settings";
  const cur = JSON.parse(localStorage.getItem(k) || "{}");
  localStorage.setItem(k, JSON.stringify({ ...cur, ...p }));
}, patch);

// (a) drag across the word -> clipboard has it, selection stays
{
  await page.evaluate(() => navigator.clipboard.writeText("seed"));
  const a = await cell(0, 0), b = await cell(0, WORD.length - 1);
  await page.mouse.move(a.x - 1, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 3, b.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check((await clip()) === WORD, `(a) selecting text copies it (clipboard ${JSON.stringify(await clip())})`);
  await page.screenshot({ path: path.join(here, "shots", "copy-select.png") }).catch(() => {});
}

// (b) right-click with a selection copies and clears, nothing is pasted
{
  await page.evaluate(() => { window.__writes.length = 0; });
  const p = await cell(0, 3);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.waitForTimeout(300);
  check((await writes()).length === 0, "(b) right-click with a selection writes nothing to the pty");
  check((await clip()) === WORD, "(b) clipboard still holds the selection");
  check(!(await page.locator(".pctx").first().isVisible().catch(() => false)), "(b) no context menu opens");
}

// (c) right-click with no selection pastes the clipboard through pty_write
{
  await page.evaluate(() => navigator.clipboard.writeText("pasted-line-1"));
  await page.evaluate(() => { window.__writes.length = 0; });
  const p = await cell(5, 10);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.waitForTimeout(400);
  const w = await writes();
  check(w.some((x) => x.data === "pasted-line-1"), `(c) right-click pastes via pty_write (${JSON.stringify(w)})`);
}

// (d) a plain click (no drag) must not overwrite the clipboard
{
  await page.evaluate(() => navigator.clipboard.writeText("keep-me"));
  const p = await cell(6, 4);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
  check((await clip()) === "keep-me", "(d) plain click does not copy");
}

// (e) right-click on a link still opens LinkMenu
{
  const p = await cell(1, "link: ".length + 4);
  await page.mouse.move(p.x - 30, p.y - 30);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.waitForFunction(() => document.querySelectorAll(".lm-menu .lm-item").length >= 1, null, { timeout: 15000 }).catch(() => {});
  check(await page.locator(".lm-menu").isVisible().catch(() => false), "(e) right-click on a link opens LinkMenu");
  check((await writes()).length === 0, "(e) ...and pastes nothing");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

// (f) Shift+right-click opens the pane context menu
{
  const p = await cell(5, 10);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.keyboard.up("Shift");
  await page.waitForTimeout(300);
  check(await page.locator(".pctx").first().isVisible().catch(() => false), "(f) Shift+right-click opens the pane menu");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

// (f2) SF2: a permission pane must not take a bare right-click paste
{
  await page.evaluate(([i]) => window.__mockEmit("pty://state", { pane_id: i, state: "permission" }), [id]);
  await page.waitForTimeout(300);
  await page.evaluate(() => navigator.clipboard.writeText("1"));
  await page.evaluate(() => { window.__writes.length = 0; });
  const p = await cell(5, 10);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.waitForTimeout(400);
  check(await page.locator(".confirm-modal").isVisible().catch(() => false), "(f2) permission pane: right-click paste shows the confirm");
  check((await writes()).length === 0, "(f2) ...and nothing is written until confirmed");
  await page.locator(".confirm-modal .btn-primary").click();
  await page.waitForTimeout(300);
  check((await writes()).some((x) => x.data === "1"), "(f2) confirming writes the paste");
  await page.evaluate(([i]) => window.__mockEmit("pty://state", { pane_id: i, state: "running" }), [id]);
  await page.waitForTimeout(200);
}

// (g) settings off: copy on select disabled, right-click behaves as Menu
{
  await setTerm({ copyOnSelect: false, rightClick: "menu" });
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  const a = await cell(0, 0), b = await cell(0, 6);
  await page.mouse.move(a.x - 1, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 3, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check((await clip()) === "untouched", "(g) copy on select off: clipboard untouched");
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.mouse.click(b.x, b.y, { button: "right" });
  await page.waitForTimeout(300);
  check(await page.locator(".pctx").first().isVisible().catch(() => false), "(g) Right-click: Menu opens the pane menu");
  check((await writes()).length === 0, "(g) ...and pastes nothing");
}

if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 3).join(" | "));
await browser.close();
if (failures.length) { console.error("COPY-PASTE FAIL:\n  " + failures.join("\n  ")); process.exit(1); }
console.log("COPY-PASTE PASS");
