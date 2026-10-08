// H3 Settings search, end to end on the real frontend with the mock backend.
// Run from e2e/ with a Vite dev server up: FD_URL=http://localhost:1432 node settings-search.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const shots = path.join(here, "shots");
mkdirSync(shots, { recursive: true });
const URL = process.env.FD_URL ?? "http://localhost:1420";
const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.error("FAIL: " + msg); } else console.log("ok: " + msg); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(`localStorage.setItem("flightdeck-startup","reopen");\n` + mock);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const box = page.locator('input[aria-label="Search settings"]');
const modal = page.locator(".set-modal");
const hits = page.locator(".set-hit");

await page.keyboard.press("Control+,");
await modal.waitFor();
check(await modal.isVisible(), "Settings opens with Ctrl+,");

// Panel and section list: src/Settings.tsx (.set-content, .set-nav, .set-section).
const panel = await modal.boundingBox();
check(Math.abs(panel.width - 920) <= 2 && Math.abs(panel.height - 828) <= 2, "Settings uses the larger panel dimensions");
const nav = page.getByRole("navigation", { name: "Settings sections" });
const sectionLabels = await modal.locator(".set-section .set-label").allTextContents();
check(await nav.getByRole("button").count() === sectionLabels.length, "one navigation button per section");
await nav.getByRole("button", { name: "Terminal", exact: true }).click();
await page.waitForTimeout(600);
check(await nav.getByRole("button", { name: "Terminal", exact: true }).getAttribute("aria-current") === "location", "section navigation scrolls and highlights Terminal");
await modal.locator(".set-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(200);
check(await nav.getByRole("button", { name: "About", exact: true }).getAttribute("aria-current") === "location", "manual scrolling updates the current section");
check(await modal.locator("details.set-advanced[open]").count() === 0, "Advanced disclosures start collapsed");
check(await modal.locator('input[placeholder="extra CLI flags"], input[placeholder="binary path override"]').count() === 0, "unwired agent inputs are hidden");

// Every rendered row name is reachable: the index is read from the render.
const rowNames = await page.locator(".set-modal .set-row-name").allInnerTexts();
check(rowNames.length > 20, `rendered ${rowNames.length} named settings`);
const missing = [];
for (const name of rowNames) {
  await box.fill(name.trim());
  const labels = (await page.locator(".set-hit-name").allInnerTexts()).map((t) => t.trim());
  if (!labels.includes(name.trim())) missing.push(name.trim());
}
check(missing.length === 0, `every rendered setting label is searchable${missing.length ? " (missing: " + missing.join(", ") + ")" : ""}`);
await box.fill("");

// Ctrl+F focuses the box.
await page.locator(".set-head h2").click();
await page.keyboard.press("Control+f");
check(await box.evaluate((el) => el === document.activeElement), "Ctrl+F focuses the search box");

// Typing filters across sections, case-insensitively, with the section shown and a mark.
await box.fill("SCROLLBACK");
check((await hits.count()) >= 1, "query matches (case-insensitive)");
check((await hits.first().locator(".set-hit-name").innerText()).trim() === "Scrollback", "label hit ranks first");
check((await hits.first().locator(".set-hit-sec").innerText()).trim().toLowerCase() === "terminal", "result shows its section");
check((await hits.first().locator("mark.set-mark").count()) >= 1, "matches are highlighted");
// Section-name match returns that section's rows.
await box.fill("startup");
check((await hits.count()) >= 1, "section name matches");
// Description match.
await box.fill("lines kept");
check((await hits.first().locator(".set-hit-name").innerText()).trim() === "Scrollback", "description matches");

// Empty state.
await box.fill("zzzqqq");
check((await page.locator(".set-noresults").innerText()).trim() === 'No settings match "zzzqqq"', "empty state text");
await box.fill("scroll");
await page.screenshot({ path: path.join(shots, "settings-search.png") });

// Escape in the box clears it and leaves Settings open; a second Escape closes it.
await box.focus();
await page.keyboard.press("Escape");
check((await box.inputValue()) === "" && (await modal.isVisible()), "Escape clears the box and keeps Settings open");
check((await page.locator(".set-section:visible").count()) > 3, "sections are back after clearing");
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check(!(await modal.isVisible().catch(() => false)), "second Escape closes Settings");

// Enter jumps to the row.
await page.keyboard.press("Control+,");
await modal.waitFor();
await box.fill("scrollback");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
check((await box.inputValue()) === "", "Enter clears the query");
const flashed = page.locator(".set-flash");
check((await flashed.count()) === 1 && /Scrollback/.test(await flashed.innerText()), "Enter jumps to and flashes the Scrollback row");
check(await flashed.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), "the row is scrolled into view");
// Click jumps too (after the first flash has faded).
await page.waitForTimeout(1800);
await box.fill("reduced motion");
await hits.first().click();
await page.waitForTimeout(200);
check(/Reduced motion/.test(await page.locator(".set-flash").innerText()), "click jumps to the row");

// Collapsed rows remain indexed and their disclosure opens before the jump.
// src/Settings.tsx: .set-advanced, Preview text size, pendingJump effect.
await page.waitForTimeout(1800);
await box.fill("preview text size");
check(!(await nav.isVisible()), "section list hides while searching");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const advancedRow = modal.locator(".set-flash");
check(/Preview text size/.test(await advancedRow.innerText()), "search jumps to the Advanced row");
check(await advancedRow.evaluate((el) => el.closest("details.set-advanced")?.open === true), "search opens the containing Advanced disclosure");
check(await advancedRow.isVisible(), "Advanced search target is visible");
check(await nav.getByRole("button", { name: "Appearance", exact: true }).getAttribute("aria-current") === "location", "Advanced search jump updates section navigation");

check(pageErrors.length === 0, "no page errors" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));
await browser.close();
if (failures.length) { console.error(`SETTINGS-SEARCH FAIL (${failures.length})`); process.exit(1); }
console.log("SETTINGS-SEARCH OK");
