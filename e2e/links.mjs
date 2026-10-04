// Phase 1 terminal links, end to end on the real frontend with the mock backend.
// Prints a block of path/URL lines into one pane, then drives hover, click and
// right-click at computed cell coordinates (the terminal is WebGL, so there is
// no text in the DOM to target).
//
// Run from e2e/ with the Vite dev server on :1420: node links.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const shots = path.join(here, "shots");
mkdirSync(shots, { recursive: true });
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const wrap = `(()=>{const T=window.__TAURI_INTERNALS__;const inv=T.invoke;window.__spawned=[];window.__size={};window.__writes=[];window.__pathsExist=[];T.invoke=(c,a)=>{if(c==="paths_exist")window.__pathsExist.push(JSON.stringify(a));if(c==="pty_resize")window.__size[a.paneId]={cols:a.cols,rows:a.rows};if(c==="pty_write")window.__writes.push({id:a.paneId,data:a.data});const r=inv(c,a);if(c==="pty_spawn"){Promise.resolve(r).then(id=>{window.__spawned.push(id);window.__size[id]={cols:a.cols,rows:a.rows};});}return r;};})();`;

const URL = "http://localhost:1420";
const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.error("FAIL: " + msg); } else console.log("ok: " + msg); };

const SPACED = "D:\\Dev\\ai\\projects\\active\\Kove Clients\\STATE.md";
// [label prefix, text]; row index = position in this list.
const LINES = [
  ["spaced: ", SPACED],
  ["rel: `", "src/app.ts:12`"],
  ["home: ", "~/.claude/agents/frontend.md"],
  ["wiki: ", "[[projects/active/flightdeck/STATE|Flightdeck]]"],
  ["dir: ", "D:\\Dev\\ai\\research\\"],
  ["url: (see ", "https://example.com/x)"],
  ["unc: ", "\\\\server\\share\\a.txt"],
  ["mixed: ", '"/\\localhost/c$/Windows/win.ini"'],
  ["bslash: `", "\\/server/share/x.txt`"],
];
const ROW = Object.fromEntries(["spaced", "rel", "home", "wiki", "dir", "url", "unc", "mixed", "bslash"].map((k, i) => [k, i]));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + wrap);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(3500); // let the scripted banners finish

const spawned = await page.evaluate(() => window.__spawned.slice());
const paneCount = await page.locator(".pane:visible").count();
console.log(`spawned ids: [${spawned}], visible panes: ${paneCount}`);
if (!spawned.length || !paneCount) { console.error("LINKS FAIL: no panes spawned"); await browser.close(); process.exit(1); }

const id = spawned[0];
const pane = page.locator(".pane:visible").first();
const size = await page.evaluate((i) => window.__size[i], id);
console.log(`pane ${id} size ${size.cols}x${size.rows}`);

// Clear the screen, home the cursor, and print one line per row.
const text = "\x1b[2J\x1b[H" + LINES.map(([a, b]) => a + b).join("\n");
await page.evaluate(([i, t]) => window.__mockPrint(i, t), [id, text]);
await page.waitForTimeout(500);

const screen = pane.locator(".xterm-screen");
// Pixel centre of the cell `off` characters into the text of row `key`.
// Re-measured every call: opening Explorer reflows the pane.
const at = async (key, off) => {
  const box = await screen.boundingBox();
  const sz = await page.evaluate((i) => window.__size[i], id);
  const [prefix] = LINES[ROW[key]];
  return { x: box.x + (prefix.length + off + 0.5) * (box.width / sz.cols), y: box.y + (ROW[key] + 0.5) * (box.height / sz.rows) };
};
const hover = async (key, off = 4) => {
  const p = await at(key, off);
  await page.mouse.move(p.x - 30, p.y - 30);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(500);
  return p;
};
const pointer = () => pane.locator(".xterm.xterm-cursor-pointer, .xterm-screen.xterm-cursor-pointer, .xterm-cursor-pointer").count().then((n) => n > 0);
const tabs = () => page.locator(".prv-tab-name").allTextContents();
const clearOverlays = async () => { await page.mouse.move(2, 2); await page.keyboard.press("Escape"); await page.waitForTimeout(300); };

// (a) hover spaced path -> pointer cursor
{
  await hover("spaced", 30); // inside "Kove Clients"
  check(await pointer(), "(a) hovering the spaced path shows a pointer cursor");
  await page.screenshot({ path: path.join(shots, "link-hover.png") });
  const tip = await pane.locator(".xterm-hover").first().textContent().catch(() => "");
  console.log(`tooltip: ${JSON.stringify(tip)}`);
}

// (e) UNC: no pointer. Done early while nothing is open.
{
  await hover("unc", 6);
  check(!(await pointer()), "(e) hovering the UNC path shows no pointer");
  await hover("mixed", 6);
  check(!(await pointer()), "(e2) hovering the mixed-slash UNC path shows no pointer");
  await hover("bslash", 6);
  check(!(await pointer()), "(e3) hovering the backslash-slash UNC path shows no pointer");
  const probed = await page.evaluate(() => window.__pathsExist.join("\n"));
  console.log("paths_exist log:", probed.slice(0, 1500));
  check(!/localhost|server|srv/i.test(probed), "(e4) no paths_exist call received a UNC-shaped path");
}

// (b) click spaced path -> Preview with STATE.md
{
  const p = await hover("spaced", 30);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(900);
  const dlg = page.locator('[role="dialog"]:has(.prv-tabs)');
  check(await dlg.isVisible().catch(() => false), "(b) Preview drawer is visible after clicking the spaced path");
  const names = await tabs();
  check(names.includes("STATE.md"), `(b) Preview tab is STATE.md (tabs: ${JSON.stringify(names)})`);
  await page.screenshot({ path: path.join(shots, "link-preview.png") });
  void p;
  await clearOverlays();
}

// (c) click src/app.ts:12 -> Preview at line 12
{
  await hover("rel", 5);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(900);
  const names = await tabs();
  check(names.includes("app.ts"), `(c) Preview tab is app.ts (tabs: ${JSON.stringify(names)})`);
  await page.waitForSelector(".prv-line-hit, .cv-hit", { timeout: 8000 }).catch(() => null); // CodeMirror view marks it cv-hit
  const hit = await page.locator(".prv-line-hit, .cv-hit").first().textContent().catch(() => null);
  check(hit != null && /line12\b/.test(hit), `(c) highlighted preview line is line 12 (got ${JSON.stringify(hit)})`);
  await clearOverlays();
}

// (d) click folder -> Explorer opens, no Preview tab added
{
  const before = (await tabs()).length;
  await hover("dir", 10);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(900);
  check(await page.locator(".explorer").first().isVisible().catch(() => false), "(d) Explorer panel is open after clicking the folder");
  const after = (await tabs()).length;
  check(after === before, `(d) no Preview tab added for the folder (${before} -> ${after})`);
  await clearOverlays();
}

// (f) right-click a path -> LinkMenu; Escape closes it
const items = ["Open in preview", "Open in editor", "Reveal in Explorer", "Copy path", "Send path to agent"];
{
  const p = await hover("spaced", 30);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.waitForTimeout(500);
  const menu = page.locator(".lm-menu");
  // Menu items arrive after the link target resolves (async): wait for them
  // instead of a fixed sleep (flaked on a cold dev server).
  await page.waitForFunction(() => document.querySelectorAll(".lm-menu .lm-item").length >= 5, null, { timeout: 15000 }).catch(() => {});
  check(await menu.isVisible().catch(() => false), "(f) LinkMenu is visible after right-click");
  const got = (await menu.locator(".lm-item").allTextContents()).map((s) => s.trim());
  check(items.every((n) => got.some((g) => g.startsWith(n))), `(f) LinkMenu has all five items (got ${JSON.stringify(got)})`);
  await page.screenshot({ path: path.join(shots, "link-menu.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(!(await menu.isVisible().catch(() => false)), "(f) Escape closes the LinkMenu");
}

// (g) Send path to agent -> pty_write "@<path> " with no CR
{
  await page.evaluate(() => { window.__writes.length = 0; });
  const p = await hover("spaced", 30);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.waitForTimeout(500);
  await page.locator(".lm-item", { hasText: "Send path to agent" }).click();
  await page.waitForTimeout(400);
  const writes = await page.evaluate(() => window.__writes.slice());
  const want = "@" + SPACED + " ";
  const w = writes.find((x) => x.data.startsWith("@"));
  console.log(`pty_write log: ${JSON.stringify(writes)}`);
  check(!!w && w.data === want, `(g) pty_write is ${JSON.stringify(want)}`);
  check(!writes.some((x) => /[\r\n]/.test(x.data)), "(g) no carriage return was written");
}

if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 3).join(" | "));
await browser.close();
if (failures.length) {
  console.error("LINKS FAIL:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("LINKS PASS");
