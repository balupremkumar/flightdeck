// Visual QA rig: screenshots the real frontend (Vite dev server on :1420) so a
// human/agent can inspect actual rendered layout. Tauri invokes fail in a plain
// browser — expected; layout still renders via the fallbacks.
// Run from demo/:  node visual-check.mjs [outDir]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "vshots";
const URL = "http://localhost:1420";
const shot = async (page, name) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(URL, { waitUntil: "networkidle" });

// 1-2: first-run launcher, dark + light
await shot(page, "01-launcher-dark");
await page.evaluate(() => localStorage.setItem("flightdeck-theme-id", "light"));
await page.reload({ waitUntil: "networkidle" });
await shot(page, "02-launcher-light");
await page.evaluate(() => localStorage.setItem("flightdeck-theme-id", "dark"));
await page.reload({ waitUntil: "networkidle" });

// 3: create a workspace (layout renders even though PTY spawn fails in-browser)
await page.fill(".dir .path", "C:\\Windows");
await page.click(".btn-primary");
await shot(page, "03-cockpit-dark");

// 4: add-pane menu (new + button)
const addBtn = page.locator('button[title="Add a pane to this workspace"]');
if (await addBtn.count()) { await addBtn.click(); await shot(page, "04-addpane-menu"); await page.keyboard.press("Escape"); await page.mouse.click(640, 500); }

// 5: command palette
await page.keyboard.press("Control+k");
await shot(page, "05-palette");
await page.keyboard.press("Escape");

// 6: settings modal
await page.click('button[title^="Settings"]');
await shot(page, "06-settings");
await page.mouse.click(30, 400); // scrim click closes

// 7: board view
const board = page.locator(".lp-app", { hasText: "Board" });
if (await board.count()) { await board.first().click(); await shot(page, "07-board"); }

// 8: notifications menu
const bell = page.locator('button[title="Notifications"]');
if (await bell.count()) { await bell.first().click(); await shot(page, "08-notifications"); await page.mouse.click(400, 400); }

// 9: dracula cockpit (back to terminals view first)
const wsRow = page.locator(".lp-ws").first();
if (await wsRow.count()) await wsRow.click();
await page.evaluate(() => localStorage.setItem("flightdeck-theme-id", "dracula"));
await page.reload({ waitUntil: "networkidle" });
await shot(page, "09-cockpit-dracula");

// 10: broadcast overlay
const bc = page.locator('button[title="Broadcast to panes"]');
if (await bc.count()) { await bc.first().click(); await shot(page, "10-broadcast"); }

await page.evaluate(() => localStorage.setItem("flightdeck-theme-id", "dark"));
await browser.close();
console.log("done ->", OUT);
