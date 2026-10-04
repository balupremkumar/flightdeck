// Phase 2 viewers, end to end on the real frontend with the mock backend.
// Opens one fixture per viewer through the app's own openPreview (the same
// store action a terminal link click calls) and asserts each renders.
//
// Run from e2e/ with the Vite dev server on :1420: node viewers.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const shots = path.join(here, "shots");
mkdirSync(shots, { recursive: true });
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const URL = process.env.FD_URL ?? "http://localhost:1420";
const VFX = "D:\\Dev\\ai\\vfx\\";
const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.error("FAIL: " + msg); } else console.log("ok: " + msg); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

// Same module instance the app uses: Vite serves /src/ui.ts at one URL.
await page.evaluate(async () => { window.__ui = (await import("/src/ui.ts")).useUI; });
const open = async (file) => {
  await page.evaluate((p) => { window.__ui.getState().closeAllPreviews(); window.__ui.getState().openPreview(p); }, file);
  await page.waitForTimeout(1200);
};
const shot = (name) => page.screenshot({ path: path.join(shots, `viewer-${name}.png`) });
// Cold dev server: Vite compiles each lazy chunk on first request, so waits
// are condition-based with generous ceilings, never fixed sleeps.
const has = (sel, timeout = 15000) => page.waitForSelector(sel, { timeout, state: "visible" }).then(() => true, () => false);

// JSON tree
await open(VFX + "data.json");
check(await has(".jt-row"), "JSON: tree rows render");
check((await page.locator(".jt-tog:not(.jt-tog-none)").count()) > 0, "JSON: expandable nodes present");
const before = await page.locator(".jt-row").count();
await page.locator('button:has-text("Expand all")').click();
await page.waitForTimeout(300);
const after = await page.locator(".jt-row").count();
check(after > before, `JSON: Expand all reveals more rows (${before} -> ${after})`);
await shot("json");

// Ctrl+F in the JSON view
await page.locator(".prv-drawer").focus();
await page.keyboard.press("Control+f");
await page.waitForTimeout(300);
// Fill, not type: in dev, StrictMode re-runs useOverlayEsc and its deferred focus
// restore steals focus from the freshly opened find box (production is unaffected).
await page.locator(".prv-find-in").fill("deep");
await page.waitForTimeout(500);
const count = await page.locator(".prv-find-count").textContent().catch(() => "");
check(/\d+ of \d+/.test(count ?? ""), `JSON: Ctrl+F shows a match count (${JSON.stringify(count)})`);
await shot("json-find");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// View menu: JSON -> text -> JSON tree
await page.locator('button:has-text("View:")').click();
await page.locator('[role="menuitemradio"]', { hasText: "Text" }).click();
await page.waitForTimeout(500);
check(await has(".prv-code-view"), "View menu: JSON switches to the text view");
await page.locator('button:has-text("View:")').click();
await page.locator('[role="menuitemradio"]', { hasText: "JSON tree" }).click();
await page.waitForTimeout(500);
check(await has(".jt-row"), "View menu: switches back to the JSON tree");

// JSONL
await open(VFX + "session.jsonl");
check(await has(".jl-row"), "JSONL: rows render");
const chips = (await page.locator(".jl-chip").allTextContents()).map((s) => s.trim());
check(chips.includes("user") && chips.includes("assistant"), `JSONL: type chips (${JSON.stringify(chips)})`);
await shot("jsonl");

// CSV
await open(VFX + "table.csv");
check(await has(".csv-th-wrap"), "CSV: header cells render");
check(await page.waitForFunction(() => document.querySelectorAll(".csv-th-wrap").length >= 3, null, { timeout: 15000 }).then(() => true, () => false), "CSV: three header cells");
const priceTh = page.locator(".csv-th-wrap", { hasText: "price" });
await priceTh.locator(".csv-th").click();
await page.waitForTimeout(300);
const sort1 = await priceTh.getAttribute("aria-sort");
const ind1 = await priceTh.locator(".csv-th-sort").textContent().catch(() => "");
await priceTh.locator(".csv-th").click();
await page.waitForTimeout(300);
const sort2 = await priceTh.getAttribute("aria-sort");
const ind2 = await priceTh.locator(".csv-th-sort").textContent().catch(() => "");
check(sort1 === "ascending" && ind1 === "▲" && sort2 === "descending" && ind2 === "▼", `CSV: sort toggles indicator (${sort1} ${ind1} -> ${sort2} ${ind2})`);
await shot("csv");

// Markdown + TOC + mermaid
await open(VFX + "doc.md");
check(await has(".prv-toc"), "Markdown: Contents/TOC renders");
check(/contents/i.test((await page.locator(".prv-toc").textContent()) ?? ""), "Markdown: TOC is labelled Contents");
check(await has(".mermaid-svg svg", 45000), "Markdown: mermaid fence renders an <svg>");
await shot("markdown-mermaid");

// Code view
await open(VFX + "code.ts");
check(await has(".cm-editor", 10000), "Code: .cm-editor present for .ts");
check((await page.locator(".cm-lineNumbers .cm-gutterElement").count()) > 1, "Code: line numbers shown");
await shot("code");

// Log
await open(VFX + "app.log");
check(await has(".lg-row"), "Log: rows render");
const lvl = await page.evaluate(() => [...document.querySelectorAll(".lg-row")].flatMap((e) => [...e.classList].filter((c) => /^lg-(info|warn|error|debug)/.test(c))));
check(["lg-info", "lg-warn", "lg-error"].every((c) => lvl.includes(c)), `Log: coloured level classes (${JSON.stringify([...new Set(lvl)])})`);
await shot("log");

// Outside scope
await open("C:\\secret\\outside.txt");
await page.waitForTimeout(2500); // boot-window retry
check(await has("text=This file is outside your workspaces"), "Outside scope: panel shown");
await shot("outside-scope");

// Media: image and pdf never go through fs_read_text_file and skip the binary panel
await page.evaluate(() => {
  const T = window.__TAURI_INTERNALS__, inv = T.invoke;
  window.__reads = [];
  T.invoke = (c, a) => { if (c === "fs_read_text_file") window.__reads.push(a.path); return inv(c, a); };
});
for (const f of ["pic.png", "doc.pdf"]) {
  await open(VFX + f);
  const reads = await page.evaluate(() => window.__reads.slice());
  check(!reads.some((r) => r.endsWith(f)), `Media: ${f} is not read as text`);
  check(!(await page.locator("text=opens outside Flightdeck").count()), `Media: ${f} skips the binary panel`);
  check((await page.locator(".prv-body-wrap").count()) === 1 && (await page.locator(".prv-content .prv-state:has-text('Empty file')").count()) === 0, `Media: ${f} body mounted`);
  await shot(f.endsWith("png") ? "image" : "pdf");
}

if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 3).join(" | "));
await browser.close();
if (failures.length) {
  console.error("VIEWERS FAIL:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("VIEWERS PASS");
