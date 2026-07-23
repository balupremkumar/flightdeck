// theme-candidates.mjs — screenshot cockpit + board in each candidate theme
// for the demo-video colour decision. Headless, throwaway.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "e2e-shots", "themes");
fs.mkdirSync(OUT, { recursive: true });
const mock = fs.readFileSync(path.join(__dirname, "mock-tauri.js"), "utf8");

const THEMES = ["light", "nord", "dracula", "gruvbox"];
const browser = await chromium.launch();

for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(mock);
  await page.addInitScript((t) => localStorage.setItem("flightdeck-theme", t), theme);
  await page.goto("http://localhost:1420", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  // Reach the cockpit: mock flow may need a workspace; reuse whatever state the
  // mock boots into. If the launcher shows, fill dir and launch.
  if (await page.locator(".dir .path").count()) {
    await page.fill(".dir .path", "C:\\dev\\acme-api");
    await page.locator(".btn-primary").first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const modal = page.locator(".confirm-modal .btn-primary");
    if (await modal.count()) await modal.first().click().catch(() => {});
    await page.waitForTimeout(4000);
  }
  await page.screenshot({ path: path.join(OUT, `${theme}-cockpit.png`) });
  await page.locator(".lp-app").first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${theme}-board.png`) });
  await ctx.close();
}
await browser.close();
console.log("done:", OUT);
