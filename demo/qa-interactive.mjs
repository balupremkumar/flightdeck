// qa-interactive.mjs — headless QA loop against the BUILT demo (demo/site-dist,
// served by demo/serve-dist.mjs on :5180 — NOT the :1420 dev server). Screens
// each beat to e2e-shots/demo/ for a design-critique pass.
//
// Run:
//   node demo/serve-dist.mjs 5180 &
//   node demo/qa-interactive.mjs
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, "..", "e2e-shots", "demo");
const URL = "http://localhost:5180/";

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const shot = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name) }); log("screenshot", name); };

function paneByVendorLabel(page, label) {
  // Exact match on the pane's name text (vendorShort, no custom title set).
  return page.locator(".pane").filter({ has: page.locator(".pname", { hasText: new RegExp(`^${label}$`) }) });
}

async function focusPaneAndTerminal(page, paneLocator) {
  await paneLocator.locator(".phead").click({ position: { x: 10, y: 10 } }); // focusPane() on mousedown
  await paneLocator.locator(".pbody").click();
  await page.waitForTimeout(150);
}

async function typeIntoFocusedPane(page, text) {
  await page.keyboard.type(text, { delay: 18 });
  await page.keyboard.press("Enter");
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => { errors.push(String(e)); console.error("[pageerror]", e.message); });
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[fd-demo]")) return;
    if (m.type() === "error") console.log("[console:error]", t);
  });

  log("goto", URL);
  await page.goto(URL, { waitUntil: "load" });

  // --- 1. boot: 4 panes, 4 distinct vendor labels/accents -------------------
  await page.waitForSelector(".pane", { timeout: 10000 });
  await page.waitForTimeout(1800); // let boot banners land
  const labels = await page.locator(".pane .pname").allTextContents();
  log("pane labels:", labels);
  const expected = ["Claude", "Antigravity", "Codex", "Kimi"];
  const ok1 = expected.every((l) => labels.includes(l));
  log("4 distinct vendor labels present:", ok1);
  const accents = await page.locator(".pane .vglyph").evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
  log("vendor accent colours:", [...new Set(accents)]);
  await shot(page, "01-boot-4-panes.png");

  // --- 2. type into Claude pane -> streamed response, diff badge -----------
  const claude = paneByVendorLabel(page, "Claude").first();
  await focusPaneAndTerminal(page, claude);
  await typeIntoFocusedPane(page, "add rate limiting to the upload endpoint");
  await shot(page, "02-claude-typing-response.png");
  // PaneView polls git_diff_summary every 30s (GIT_POLL_MS, real product
  // behaviour, not a mock artefact) — the badge lands on the next tick after
  // the edit, not instantly. Give it a full cycle plus margin.
  await page.waitForSelector(".pane:has(.pname:text-is('Claude')) .pdiff", { timeout: 45000 });
  await shot(page, "03-claude-diff-badge.png");
  log("Claude diff badge appeared");

  // --- 3. suggestion chip targets the focused pane (Codex) ------------------
  const codex = paneByVendorLabel(page, "Codex").first();
  await focusPaneAndTerminal(page, codex);
  await page.click('.fd-chip[data-prompt="Fix the failing checkout test"]');
  await page.waitForTimeout(3500);
  await shot(page, "04-codex-chip-response.png");

  // --- 4. review drawer, split view -----------------------------------------
  await page.locator(".pane:has(.pname:text-is('Claude')) .pdiff").first().click();
  await page.waitForSelector(".rv-drawer", { timeout: 5000 });
  await page.waitForTimeout(400); // let the slide-in transition settle before the shot
  await shot(page, "05-review-drawer.png");
  const splitBtn = page.locator("button", { hasText: /split/i }).first();
  if (await splitBtn.count()) { await splitBtn.click(); await page.waitForTimeout(300); await shot(page, "06-review-split.png"); }
  await page.keyboard.press("Escape");
  await page.waitForSelector(".rv-drawer", { state: "detached", timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);

  // --- 5. board, drag a card (synthetic DragEvent — native DnD hangs headless) ---
  await page.click(".lp-app");
  await page.waitForSelector(".board-columns", { timeout: 5000 });
  await shot(page, "07-board.png");
  const dragged = await page.evaluate(() => {
    const cols = document.querySelectorAll(".col");
    const fromCol = cols[0], toCol = cols[1]; // todo -> in progress
    const card = fromCol?.querySelector(".card[draggable]");
    if (!card || !toCol) return false;
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(card, "dragstart");
    return true;
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const cols = document.querySelectorAll(".col");
    const toCol = cols[1];
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(toCol, "dragenter"); fire(toCol, "dragover");
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const cols = document.querySelectorAll(".col");
    const fromCol = cols[0], toCol = cols[1];
    const card = fromCol?.querySelector(".card[draggable]");
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(toCol, "drop");
    fire(card, "dragend");
  });
  await page.waitForTimeout(400);
  log("card drag dispatched:", dragged);
  await shot(page, "08-board-after-drag.png");

  // --- 6. attention: permission badge + workspace-tile severity -------------
  // The migrate-to-redis pane (workspace "acme-web") auto-runs to a permission
  // prompt ~20s after boot; give it the rest of that budget if we're early.
  const elapsedMs = Date.now() - t0;
  if (elapsedMs < 21000) await page.waitForTimeout(21000 - elapsedMs);
  await page.waitForSelector(".lp-ws.needy-permission .lp-needy-badge", { timeout: 15000 });
  await shot(page, "09-sidebar-severity-badge.png"); // visible without switching workspace
  await page.locator(".lp-ws").nth(1).click(); // second workspace row (acme-web)
  await page.waitForTimeout(300);
  await page.waitForSelector(".pattn.permission", { timeout: 8000 });
  await shot(page, "10-attention-permission.png");

  // --- 7. theme toggle: light then back to dark ------------------------------
  await page.click('button[title="Toggle light / dark"]');
  await page.waitForTimeout(300);
  await shot(page, "11-theme-light.png");
  await page.click('button[title="Toggle light / dark"]');
  await page.waitForTimeout(300);
  await shot(page, "12-theme-dark-again.png");

  // --- 8. Reset demo -----------------------------------------------------
  await page.click("#fd-reset");
  await page.waitForSelector(".pane", { timeout: 10000 });
  await page.waitForTimeout(1500);
  const labelsAfterReset = await page.locator(".pane .pname").allTextContents();
  log("labels after reset:", labelsAfterReset);
  await shot(page, "13-after-reset.png");

  log("page errors observed:", errors.length, errors.slice(0, 5));
  await browser.close();
  log("done");
})();
