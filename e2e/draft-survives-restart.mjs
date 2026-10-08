// Regression test for the setPaneDraft id bug: Terminal used to pass the Rust
// pty id to setPaneDraft, but the store matches PaneModel.id, so the unsent
// input line was saved to the wrong pane (or none) and a Restart lost it.
//
// Types an unsent line into the SECOND pane, restarts that pane, and requires
// the line to be re-typed into the fresh terminal.
//
// Run from e2e/ with the Vite dev server on :1420: node draft-survives-restart.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
// Records every pty_write payload. Output is drawn by the WebGL renderer (no
// DOM text to read), so the re-typed draft is observed where it leaves the
// frontend: as one whole-string pty_write into the fresh PTY.
const wrap = `(()=>{const T=window.__TAURI_INTERNALS__;const inv=T.invoke;window.__writes=[];T.invoke=(c,a)=>{if(c==="pty_write")window.__writes.push(String(a.data));return inv(c,a);};})();`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(boot + "\n" + mock + "\n" + wrap);
await page.goto(process.env.FD_URL ?? "http://localhost:1420", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.locator('text="acme-web" >> visible=true').first().click();
await page.waitForTimeout(1500);

const marker = "unsentdraft42";
const pane = page.locator(".pane:visible").nth(1);
await pane.locator(".xterm").click();
await page.keyboard.type(marker);
await page.waitForTimeout(900); // draft save is debounced 400ms
await pane.locator("button.pmenubtn").click();
await page.locator(".pmenu-item", { hasText: "Restart" }).first().click();
await page.waitForTimeout(2500);

const writes = await page.evaluate(() => window.__writes.slice());
await browser.close();
if (!writes.includes(marker)) {
  console.error("DRAFT-SURVIVES-RESTART FAIL: unsent line not re-typed after restart");
  process.exit(1);
}
console.log("DRAFT-SURVIVES-RESTART PASS");
