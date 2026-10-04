// Phase 3 C1: Review drawer de-cluttering, end to end with the mock backend.
// Asserts auto-collapse of a huge file, Collapse all / Expand all, folded
// unchanged regions, Viewed (persisting across a refresh and unticking when the
// patch hash moves), and that Hide whitespace re-requests the diff with -w.
//
// Run from e2e/ with the Vite dev server on :1420: node review-collapse.mjs
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

const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
// Installed after the mock: replaces the git commands for the acme-api panes
// and logs every git_file_diff call so the -w flag can be asserted.
const overrides = `(() => {
  window.__diffCalls = [];
  window.__patchVersion = 1;
  const hunk = (name, olds, news, ctxBefore, ctxAfter) => {
    const head = ["diff --git a/" + name + " b/" + name, "index 1111111..2222222 100644", "--- a/" + name, "+++ b/" + name,
      "@@ -1," + (ctxBefore + olds + ctxAfter) + " +1," + (ctxBefore + news + ctxAfter) + " @@"];
    const body = [];
    for (let i = 0; i < ctxBefore; i++) body.push(" const keep" + (i + 1) + " = " + (i + 1) + ";");
    for (let i = 0; i < olds; i++) body.push("-const old" + (i + 1) + " = " + (window.__patchVersion === 2 ? "'v2'" : "1") + ";");
    for (let i = 0; i < news; i++) body.push("+const next" + (i + 1) + " = " + (i + 1) + ";");
    for (let i = 0; i < ctxAfter; i++) body.push(" const tail" + (i + 1) + " = " + (i + 1) + ";");
    return head.concat(body).join("\\n") + "\\n";
  };
  const FILES = [
    { path: "src/big.ts", added: 250, deleted: 100, binary: false },
    { path: "src/folded.ts", added: 1, deleted: 1, binary: false },
    { path: "src/small.ts", added: 3, deleted: 1, binary: false },
  ];
  const patchFor = (f) => f === "src/big.ts" ? hunk(f, 100, 250, 3, 3)
    : f === "src/folded.ts" ? hunk(f, 1, 1, 15, 20) : hunk(f, 1, 3, 2, 2);
  window.__mockOverrides = {
    git_diff_summary: ({ cwd }) => /acme-api/.test(String(cwd))
      ? { base: "a1b2c3d", files: FILES, totalAdded: 254, totalDeleted: 102 }
      : { base: "a1b2c3d", files: [], totalAdded: 0, totalDeleted: 0 },
    git_file_diff: (a) => { window.__diffCalls.push({ file: a.file, ignoreWhitespace: a.ignoreWhitespace }); return patchFor(a.file); },
  };
})();`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + overrides);

const has = (sel, timeout = 15000) => page.waitForSelector(sel, { timeout, state: "visible" }).then(() => true, () => false);
const cond = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const shot = (name) => page.screenshot({ path: path.join(shots, `review-${name}.png`) });
const chev = (file) => page.locator(`.rv-file-chev[aria-label$="${file}"]`);
const expandedOf = (file) => chev(file).getAttribute("aria-expanded");

async function boot_() {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".pane", { timeout: 30000 });
  await page.evaluate(async () => { window.__ui = (await import("/src/ui.ts")).useUI; });
  await page.evaluate(() => window.__ui.getState().setReviewPane(1));
  return has(".rv-drawer .rv-file-row", 30000);
}

check(await boot_(), "Review drawer opens with the file list");
check(await cond(() => document.querySelectorAll(".rv-file-row").length === 3), "three changed files listed");

// Auto-collapse: only the 350-line file starts collapsed.
check((await expandedOf("src/big.ts")) === "false", "file over 300 changed lines is auto-collapsed");
check((await expandedOf("src/folded.ts")) === "true" && (await expandedOf("src/small.ts")) === "true", "small files start expanded");
await page.locator(".rv-file", { hasText: "src/big.ts" }).click();
check(await has(".rv-collapsed"), "collapsed file shows the collapsed placeholder");
const reason = (await page.locator(".rv-collapsed-t").textContent()) ?? "";
check(/Large diff \(350 changed lines\)/.test(reason), `placeholder explains why (${JSON.stringify(reason.trim())})`);
await shot("autocollapse");

// Collapse all / Expand all.
await page.locator('.rv-tb:has-text("Collapse all")').click();
check(await cond(() => [...document.querySelectorAll(".rv-file-chev")].every((b) => b.getAttribute("aria-expanded") === "false")), "Collapse all collapses every file");
await page.locator('.rv-tb:has-text("Expand all")').click();
check(await cond(() => [...document.querySelectorAll(".rv-file-chev")].every((b) => b.getAttribute("aria-expanded") === "true")), "Expand all expands every file");
await shot("expand-all");

// Folded unchanged region.
await page.locator(".rv-file", { hasText: "src/folded.ts" }).click();
check(await has(".rv-fold"), "folded.ts shows a fold row");
const foldText = ((await page.locator(".rv-fold").first().textContent()) ?? "").trim();
check(/^Show \d+ hidden lines?$/.test(foldText), `fold row reads "Show N hidden lines" (${JSON.stringify(foldText)})`);
const foldsBefore = await page.locator(".rv-fold").count();
await shot("folded");
await page.locator(".rv-fold").first().click();
check(await cond((n) => document.querySelectorAll(".rv-fold").length < n, foldsBefore), "clicking the fold row reveals the hidden lines");
const keepRows = await page.locator(".rv-lc", { hasText: "keep8" }).count().catch(() => 0);
check(keepRows > 0 || (await page.locator("pre, .rv-split").first().textContent())?.includes("keep8"), "a previously hidden line (keep8) is now in the DOM");

// Viewed: collapses, persists across a refresh.
await page.locator(".rv-viewed input").click();
check(await cond(() => document.querySelector('.rv-file-chev[aria-label$="src/folded.ts"]')?.getAttribute("aria-expanded") === "false"), "ticking Viewed collapses the file");
check((await page.locator(".rv-file-row", { hasText: "src/folded.ts" }).locator(".rv-file-reviewed.on").count()) === 1, "Viewed mark shown on the file row");
await page.reload({ waitUntil: "networkidle" });
check(await boot_(), "drawer reopens after a page refresh");
check(await cond(() => document.querySelector('.rv-file-row .rv-file-reviewed.on') !== null), "Viewed mark survives the refresh");
check((await expandedOf("src/folded.ts")) === "false", "viewed file is still collapsed after the refresh");

// Patch hash moves: the mark clears with a "changed since viewed" marker.
await page.evaluate(() => { window.__patchVersion = 2; });
await page.locator('.rv-ic[title="Refresh diff"]').click();
check(await has(".rv-file-changed"), "changed patch unticks Viewed and flags the file row");
check((await page.locator(".rv-file-row .rv-file-reviewed.on").count()) === 0, "Viewed mark cleared when the patch hash changed");
check((await expandedOf("src/folded.ts")) === "true", "changed file reopens expanded");
await page.locator(".rv-file", { hasText: "src/folded.ts" }).click();
check(await has(".rv-changed-note"), "patch bar shows the changed since viewed note");
check(/changed since viewed/.test((await page.locator(".rv-changed-note").textContent()) ?? ""), "note text reads changed since viewed");
await shot("changed-since-viewed");

// Hide whitespace re-requests with -w.
await page.evaluate(() => { window.__diffCalls.length = 0; });
await page.locator('.rv-tb:has-text("Hide whitespace")').click();
check(await cond(() => window.__diffCalls.some((c) => c.file === "src/folded.ts" && c.ignoreWhitespace === true)), "Hide whitespace requests git_file_diff with ignoreWhitespace: true");
const ws = await page.evaluate(() => window.__diffCalls.filter((c) => c.ignoreWhitespace === true));
console.log("   -w calls: " + JSON.stringify(ws));
check((await page.locator('.rv-tb:has-text("Hide whitespace")').getAttribute("aria-pressed")) === "true", "Hide whitespace toggle is pressed");
await shot("hide-whitespace");

check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors.join(" | ") : ""}`);
await browser.close();
if (failures.length) { console.error(`REVIEW-COLLAPSE FAIL (${failures.length})`); process.exit(1); }
console.log("REVIEW-COLLAPSE PASS");
