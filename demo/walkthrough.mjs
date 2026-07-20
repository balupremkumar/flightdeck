// walkthrough.mjs — records a full product walkthrough of the REAL Flightdeck
// UI to demo/out/flightdeck-walkthrough.webm.
//
// This replaces the hand-drawn reel. Everything on camera is the actual app:
// real components, real CSS, real state machine. Only the backend is simulated
// (see mock-tauri.js), so the recording cannot drift from the product.
//
// Usage:
//   1. npm run dev            (from the project root — serves the real frontend)
//   2. node walkthrough.mjs   (from demo/)
//
// Add ?slow to stretch every beat if you want a calmer cut.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const W = 1440;
const H = 900;
const URL = "http://localhost:1420";
const mock = fs.readFileSync(path.join(__dirname, "mock-tauri.js"), "utf8");

// A syntax error in the mock doesn't fail loudly — the bridge just never
// installs, every invoke rejects, and you get a 90-second recording of an app
// with no agents in it. Check before spending the take.
try {
  new Function(mock);
} catch (e) {
  console.error("mock-tauri.js has a syntax error, refusing to record:", e.message);
  process.exit(1);
}

const browser = await chromium.launch({ args: ["--force-device-scale-factor=1"] });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await context.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

// --- Caption overlay -------------------------------------------------------
// Injected rather than edited in afterwards, so the video is finished on export
// and re-recordable in one command.
async function installCaptions() {
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "fd-cap";
    el.style.cssText = `
      position:fixed; left:0; right:0; bottom:0; z-index:99999;
      padding:22px 34px 26px; pointer-events:none;
      font-family:"Schibsted Grotesk","Segoe UI",system-ui,sans-serif;
      background:linear-gradient(to top, rgba(3,5,10,.94) 55%, rgba(3,5,10,0));
      opacity:0; transition:opacity .45s ease;`;
    el.innerHTML = `<div id="fd-cap-t" style="font-size:23px;font-weight:700;color:#EAF1F8;letter-spacing:-.01em"></div>
      <div id="fd-cap-s" style="font-size:15px;color:#94A6BC;margin-top:5px;line-height:1.45"></div>`;
    document.body.appendChild(el);
  });
}

const say = async (title, sub = "", where = "bottom") => {
  await page.evaluate(([t, s, w]) => {
    const cap = document.getElementById("fd-cap");
    document.getElementById("fd-cap-t").textContent = t;
    document.getElementById("fd-cap-s").textContent = s;
    // The review drawer's actions live at the BOTTOM of the screen, so a
    // bottom caption hides what it's describing. Flip it up for those scenes.
    const top = w === "top";
    cap.style.top = top ? "0" : "";
    cap.style.bottom = top ? "auto" : "0";
    cap.style.background = top
      ? "linear-gradient(to bottom, rgba(3,5,10,.94) 55%, rgba(3,5,10,0))"
      : "linear-gradient(to top, rgba(3,5,10,.94) 55%, rgba(3,5,10,0))";
    cap.style.padding = top ? "26px 34px 34px" : "22px 34px 26px";
    cap.style.opacity = "1";
  }, [title, sub, where]);
};
const hideCaption = () =>
  page.evaluate(() => { document.getElementById("fd-cap").style.opacity = "0"; });

const SLOW = process.argv.includes("--slow") ? 1.5 : 1;
const beat = (ms) => page.waitForTimeout(Math.round(ms * SLOW));

// A visible cursor, so clicks read as deliberate actions rather than jump cuts.
async function installCursor() {
  await page.evaluate(() => {
    const c = document.createElement("div");
    c.id = "fd-cursor";
    c.style.cssText = `position:fixed;width:18px;height:18px;border-radius:50%;
      background:rgba(154,233,255,.32);border:2px solid #9AE9FF;z-index:99998;
      pointer-events:none;transform:translate(-50%,-50%);left:50%;top:50%;
      transition:left .5s cubic-bezier(.4,0,.15,1),top .5s cubic-bezier(.4,0,.15,1),
      transform .12s ease;opacity:0;`;
    document.body.appendChild(c);
  });
}
async function moveTo(selector, nth = 0) {
  const box = await page.locator(selector).nth(nth)
    .boundingBox({ timeout: 4000 })
    .catch(() => null);
  if (!box) { console.warn("[walkthrough] not on screen, skipping:", selector); return null; }
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(([x, y]) => {
    const c = document.getElementById("fd-cursor");
    c.style.opacity = "1";
    c.style.left = x + "px";
    c.style.top = y + "px";
  }, [x, y]);
  await beat(560);
  return { x, y };
}
async function clickAt(selector, nth = 0) {
  const p = await moveTo(selector, nth);
  if (!p) return false;
  await page.evaluate(() => {
    const c = document.getElementById("fd-cursor");
    c.style.transform = "translate(-50%,-50%) scale(.7)";
    setTimeout(() => (c.style.transform = "translate(-50%,-50%)"), 130);
  });
  await page.locator(selector).nth(nth).click({ force: true, timeout: 4000 }).catch(() => {});
  await beat(420);
  return true;
}

// --- Record ----------------------------------------------------------------
await page.addInitScript(mock);
await page.goto(URL, { waitUntil: "networkidle" });
await beat(900);
await installCaptions();
await installCursor();

// 1. What it is
await say("Flightdeck", "A cockpit for running several AI coding agents at once — on Windows, local-first, no account.");
await beat(3600);

// 2. Setting up a workspace
await say("Start with a folder", "Pick a project, choose how many panes, and which agent goes in each.");
await page.fill(".dir .path", "C:\\dev\\acme-api");
await beat(1500);
await hideCaption();
await beat(600);

await say("Isolation is the default", "Each agent gets its own git worktree and branch, so parallel agents can't overwrite each other.");
await moveTo(".isolate-row");
await beat(3200);

await say("Setup runs first", "A fresh worktree has no node_modules — Flightdeck runs your setup command before the agent starts.");
await moveTo(".setup-input");
await beat(3000);
await hideCaption();

await clickAt(".btn-primary");
await beat(900);

// 3. Trust prompt — a real consent moment, worth showing
if (await page.locator(".confirm-modal").count()) {
  await say("Consent, once per repo", "Antigravity needs folder trust. Flightdeck asks once, rather than answering for you.");
  await beat(3400);
  await hideCaption();
  await clickAt(".confirm-modal .btn-primary");
}
await beat(2600);

// 4. The grid, live
await say("Four agents, working", "Every pane is a real terminal. Status, branch, diff and token use are live in each header.");
await beat(5200);

await say("You can see what changed", "The +/− badge is that agent's diff against its base branch, updating as it works.");
await moveTo(".pdiff");
await beat(3200);
await hideCaption();
await beat(3000);

// 5. Attention — the core value
await page.waitForFunction(
  () => document.querySelectorAll(".pattn.permission").length > 0,
  null, { timeout: 20000 }
).catch(() => console.warn("[walkthrough] no approval state reached — caption suppressed"));
const blocked = await page.locator(".pattn.permission").count();
if (blocked > 0) {
  await say("One agent needs you", "Approval prompts are detected and ranked first, so a blocked agent can't sit unnoticed.");
  await moveTo(".pattn.permission");
  await beat(3400);
}
await hideCaption();
await page.keyboard.press("Control+Shift+A");
await beat(1400);
if (await page.locator(".aq-panel").isVisible().catch(() => false)) {
  await say("The attention queue", "Everything waiting on you, across every workspace — approvals first, longest-waiting first.");
  await beat(4400);
  await hideCaption();
  await page.keyboard.press("Escape");
} else {
  console.warn("[walkthrough] attention queue did not open — scene skipped");
}
await beat(1200);

// 6. Review + merge
await say("Review before you merge", "Open any agent's work as a diff — no switching to a terminal or an editor.", "top");
await beat(1200);
await clickAt(".pdiff");
await beat(2600);
await say("Side by side, word by word", "Split view and intra-line highlighting show exactly what changed.", "top");
const splitBtn = page.locator('.rv-patch-bar .rv-ic[aria-pressed]');
if (await splitBtn.count()) {
  await splitBtn.first().click({ timeout: 4000 }).catch(() => {});
  const isSplit = await page.locator(".rv-split").count();
  if (!isSplit) console.warn("[walkthrough] split view did not engage");
}
await beat(4200);

await say("Land it, or hand it off", "Merge back locally, or push the branch and open a pull request.", "top");
await moveTo(".rv-foot");
await beat(4000);
await hideCaption();
await page.keyboard.press("Escape");
await beat(1400);

// 7. Board
await say("Dispatch work from a board", "Drop a card into In Progress and an agent picks it up — on a branch named after the task.");
await clickAt(".lp-board-i, .board-ic");
await beat(4200);
await hideCaption();
await beat(800);

// 8. Diagnostics
await say("Nothing hidden", "Per-pane CPU and memory, stray-process cleanup, worktree disk use, and a redacted support bundle.");
await page.keyboard.press("Control+,");
await beat(1600);
await page.evaluate(() => {
  const secs = [...document.querySelectorAll(".set-section")];
  const diag = secs.find((s) => s.querySelector(".set-label")?.textContent?.trim() === "Diagnostics");
  diag?.scrollIntoView({ block: "start", behavior: "smooth" });
});
await beat(4200);
await hideCaption();
await page.keyboard.press("Escape");
await beat(1200);

// 9. Close
await say("Flightdeck", "Runs on your machine. Your repos, your agents, your keys — nothing leaves the box.");
await beat(4200);
await hideCaption();
await beat(1400);

await context.close();
await browser.close();

const raw = await page.video().path();
const final = path.join(OUT, "flightdeck-walkthrough.webm");
if (fs.existsSync(final)) fs.rmSync(final);
fs.renameSync(raw, final);
const mb = (fs.statSync(final).size / 1_048_576).toFixed(1);
console.log(`Saved: ${final} (${mb} MB)`);
