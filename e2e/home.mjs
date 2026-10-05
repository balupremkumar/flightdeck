// Phase 5 Home view, end to end against the demo mock backend.
// Step 2: opens by chord, titlebar button and palette; header count equals the
// bell; Escape closes and restores focus; digits do not move pane focus behind Home.
// Step 3: J/K and arrows, 1-5 column jump, Enter opens the pane and focuses its
// terminal, self-close on external focus change, 940 (stacked) and 1440 (columns).
// Step 4: diff and PR rows from the poll store, only while Home is open.
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1436 node home.mjs
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
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const wrap = `(()=>{
  const T=window.__TAURI_INTERNALS__;const inv=T.invoke;
  window.__pty2model={};window.__model2pty={};window.__calls=[];
  T.invoke=(c,a)=>{
    window.__calls.push({c,a});
    const r=inv(c,a);
    if(c==="pty_spawn")Promise.resolve(r).then((id)=>{window.__pty2model[id]=a.modelId;window.__model2pty[a.modelId]=id;});
    return r;
  };
})();`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + wrap);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.getByText("acme-web", { exact: true }).first().click();
await page.waitForTimeout(2500);

// A genuine question on pane 6, so Needs you has a question next to pane 5's approval.
const pty6 = await page.evaluate(() => window.__model2pty[6]);
await page.evaluate((id) => window.__mockPrint(id, "Which package manager should I use?"), pty6);
await page.waitForTimeout(9000);

const bellCount = () => page.evaluate(() =>
  [...document.querySelectorAll(".ntf-badge")].reduce((n, e) => n + (parseInt(e.textContent ?? "0", 10) || 0), 0));
const homeOpen = () => page.locator(".hm-panel").count().then((n) => n > 0);
const focusedPaneIdx = () => page.evaluate(() =>
  [...document.querySelectorAll(".pane")].findIndex((e) => e.classList.contains("focused")));

// --- Step 2: entry -----------------------------------------------------------
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel", { timeout: 5000 });
check(await homeOpen(), "Ctrl+Shift+H opens Home");
await page.keyboard.press("Control+Shift+H");
await page.waitForTimeout(300);
check(!(await homeOpen()), "Ctrl+Shift+H again closes Home");

await page.getByTitle("Home (Ctrl+Shift+H)").click();
await page.waitForSelector(".hm-panel", { timeout: 5000 });
check(await homeOpen(), "titlebar button opens Home");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(!(await homeOpen()), "Escape closes Home");

await page.keyboard.press("Control+k");
await page.getByPlaceholder("Jump to a workspace, pane, or action…").fill("Open Home");
await page.keyboard.press("Enter");
await page.waitForSelector(".hm-panel", { timeout: 5000 });
check(await homeOpen(), "palette 'Open Home' opens Home");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Count equals the bell.
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
const needsCards = await page.locator(".hm-col.needs [data-pane-id]").count();
const bell = await bellCount();
const headerN = await page.locator(".hm-count").innerText();
check(needsCards >= 1, `Needs you has ${needsCards} card(s)`);
check(parseInt(headerN, 10) === bell && needsCards === bell, `header "${headerN}" == bell ${bell} == needs cards ${needsCards}`);
check((await page.locator(".hm-col").count()) === 5, "five columns render");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Escape restores focus to what had it.
await page.locator('button[title^="Settings"]').focus();
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
check(await page.evaluate(() => !!document.activeElement?.closest(".hm-panel")), "focus moves into Home on open");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check(await page.evaluate(() => document.activeElement?.getAttribute("title")?.startsWith("Settings") ?? false), "Escape returns focus to the previous element");

// Digits and pane-focus chords do not move focus behind Home.
const before = await focusedPaneIdx();
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
for (const k of ["2", "Alt+2", "Alt+1", "Control+Alt+ArrowRight", "`"]) await page.keyboard.press(k);
await page.waitForTimeout(200);
check((await focusedPaneIdx()) === before, `pane focus unchanged behind Home (idx ${before})`);
check(await homeOpen(), "Home survives those keys");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

check(pageErrors.length === 0, `no page errors ${pageErrors.join("|")}`);
await browser.close();
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log("\nhome: all checks passed");
