// Repro rig for the workspace-rename bug. Drives the real frontend, seeds a
// workspace via the live store module, then exercises both rename entry
// points (context-menu "Rename" and double-click the name) and reports what
// actually happened in the DOM.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? "../e2e-shots";
const TAG = process.argv[3] ?? "before";
const URL = "http://localhost:1420";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript({ path: path.join(__dirname, "mock-tauri.js") });
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

await page.evaluate(async () => {
  const store = await import("/src/store.ts");
  window.__store = store;
  store.useApp.getState().createWorkspace("C:\\dev\\acme-api", [{ vendor: "pwsh", cwd: "C:\\dev\\acme-api" }]);
});
await page.waitForTimeout(400);

const row = page.locator(".lp-ws").first();
await row.waitFor({ state: "visible" });

console.log(`\n== [${TAG}] Route 1: right-click -> context menu -> "Rename" ==`);
await row.click({ button: "right" });
await page.waitForTimeout(150);
const menuVisible = await page.locator(".lp-menu").isVisible().catch(() => false);
console.log("  context menu opened:", menuVisible);
if (menuVisible) {
  await page.screenshot({ path: path.join(__dirname, OUT, `${TAG}-rename-01-menu-open.png`) });
  await page.locator(".lp-menu button", { hasText: "Rename" }).click();
  await page.waitForTimeout(200);
  const inputVisible = await page.locator(".lp-rename-input").isVisible().catch(() => false);
  console.log("  rename input appeared after clicking Rename:", inputVisible);
  await page.screenshot({ path: path.join(__dirname, OUT, `${TAG}-rename-02-after-click.png`) });
  if (inputVisible) {
    await page.locator(".lp-rename-input").fill("flightdeck");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const name = await page.locator(".lp-ws .lp-name").first().textContent();
    console.log("  name after commit:", name);
    await page.screenshot({ path: path.join(__dirname, OUT, `${TAG}-rename-03-committed.png`) });
  }
} else {
  await page.screenshot({ path: path.join(__dirname, OUT, `${TAG}-rename-01-menu-FAILED.png`) });
}

// Reset name for a clean route-2 test.
await page.evaluate(() => {
  const { useApp } = window.__store;
  const w = useApp.getState().workspaces[0];
  useApp.getState().renameWorkspace(w.id, "acme-api");
});
await page.waitForTimeout(150);

console.log(`\n== [${TAG}] Route 2: double-click the name ==`);
await page.locator(".lp-ws .lp-name").first().dblclick();
await page.waitForTimeout(200);
const inputVisible2 = await page.locator(".lp-rename-input").isVisible().catch(() => false);
console.log("  rename input appeared after double-click:", inputVisible2);
await page.screenshot({ path: path.join(__dirname, OUT, `${TAG}-rename-04-dblclick.png`) });
if (inputVisible2) {
  await page.locator(".lp-rename-input").fill("flightdeck-dbl");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const name2 = await page.locator(".lp-ws .lp-name").first().textContent();
  console.log("  name after commit:", name2);
}

await browser.close();
