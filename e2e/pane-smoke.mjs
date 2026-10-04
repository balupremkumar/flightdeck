// Release-gate smoke: boot the real frontend, create a workspace, and require
// a real xterm terminal to mount without tripping the ErrorBoundary.
//
// Exists because of the 0.5.3 boot loop: the Unicode11 addon needed
// allowProposedApi and every pane mount threw, but nothing in the gate ever
// mounted a pane — vitest mocks xterm, and the boot gate stalls on the restore
// prompt before Cockpit mounts. This runs the exact code path a user hits.
//
// Run from demo/ with the Vite dev server on :1420 (tools/release.ps1 manages
// the server itself): node pane-smoke.mjs
import { chromium } from "playwright";

const URL = "http://localhost:1420";
const fail = (msg) => { console.error("PANE-SMOKE FAIL:", msg); process.exitCode = 1; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: "networkidle" });

// Fresh browser context -> always the first-run launcher. Create a workspace,
// which mounts panes and constructs their terminals.
await page.fill(".dir .path", "C:\\Windows");
await page.click(".btn-primary");
await page.waitForTimeout(1500);

const crashed = await page.getByText("Something broke in the cockpit UI").count();
if (crashed) {
  const detail = pageErrors.at(-1) ?? "(no page error captured)";
  fail(`ErrorBoundary crash screen after pane mount — last page error: ${detail}`);
}

// Positive assertion: term.open() ran, so at least one .xterm element exists.
// Guards against a blank page passing the crash check above.
const xterms = await page.locator(".xterm").count();
if (!crashed && xterms === 0) fail("no .xterm element rendered — terminal never mounted");

if (process.exitCode !== 1) console.log(`PANE-SMOKE PASS: ${xterms} terminal(s) mounted, no crash screen`);
await browser.close();
