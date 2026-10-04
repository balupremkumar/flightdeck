// Regression test for R1: adding, closing or reordering a pane must not kill
// (and respawn) the PTYs of panes that are already live.
//
// The registry makes StrictMode a no-op (one spawn, zero kills per pane), so the
// raw kill log is exact: add and drag steps must log no pty_kill at all, and the
// close step exactly one, of the closed pane. We also track the set of PTY ids
// alive (spawned and not killed): every id alive before a step must still be
// alive after it, except the one pane the step deliberately closes.
//
// Sizes: every pty_spawn and pty_resize must carry cols >= 20 and rows >= 5. A
// tiny size reaches a live agent (Claude Code re-renders at 2 columns and the
// re-wrapped lines stay in scrollback).
//
// Run from e2e/ with the Vite dev server on :1420: node reflow-keeps-agents.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const wrap = `(()=>{const T=window.__TAURI_INTERNALS__;const inv=T.invoke;window.__ptylog=[];window.__sizes=[];T.invoke=(c,a)=>{if(c==="pty_spawn"||c==="pty_resize")window.__sizes.push({op:c,id:a.paneId,cols:a.cols,rows:a.rows});const r=inv(c,a);if(c==="pty_spawn"){Promise.resolve(r).then(id=>window.__ptylog.push("spawn "+id+" "+a.vendor));}if(c==="pty_kill")window.__ptylog.push("kill "+a.paneId);return r;};})();`;

const URL = process.env.FD_URL ?? "http://localhost:1420";
const failures = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + wrap);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

await page.getByText("acme-web", { exact: true }).first().click();
await page.waitForTimeout(1500);

// Replay the log into the set of currently alive PTY ids.
async function alive() {
  const log = await page.evaluate(() => window.__ptylog.slice());
  const set = new Set();
  for (const line of log) {
    const [op, id] = line.split(" ");
    if (op === "spawn") set.add(id);
    else set.delete(id);
  }
  return { set, log };
}

// The terminal DOM node itself must survive a reflow, not just the PTY: tag each
// visible pane's .xterm element, then require the same element (by tag) to still
// be in the document after the step.
async function tagNodes() {
  return page.evaluate(() => {
    const tags = [];
    document.querySelectorAll(".pane").forEach((p, i) => {
      const x = p.querySelector(".xterm");
      if (!x) return;
      if (!x.__fdTag) x.__fdTag = "t" + Math.random().toString(36).slice(2);
      tags.push(x.__fdTag);
    });
    return tags;
  });
}
async function liveTags() {
  return new Set(await page.evaluate(() => [...document.querySelectorAll(".pane .xterm")].map((x) => x.__fdTag).filter(Boolean)));
}

// Run a step, let it settle, then require every previously-alive id (minus the
// intentionally closed ones) to still be alive.
async function step(name, action, { expectKilled = [] } = {}) {
  const { set: before, log: logBefore } = await alive();
  const tagsBefore = await tagNodes();
  await action();
  await page.waitForTimeout(2000);
  const { set: after, log } = await alive();
  const killedEstablished = [...before].filter((id) => !after.has(id) && !expectKilled.includes(id));
  const missedExpected = expectKilled.filter((id) => after.has(id));
  const kills = log.slice(logBefore.length).filter((l) => l.startsWith("kill "));
  if (expectKilled.length === 0 && kills.length) failures.push(`${name}: expected zero pty_kill, saw ${kills.join(", ")}`);
  if (expectKilled.length && (kills.length !== expectKilled.length || kills.some((k) => !expectKilled.includes(k.split(" ")[1])))) {
    failures.push(`${name}: expected exactly kill of [${expectKilled}], saw [${kills}]`);
  }
  console.log(`${name}: alive before=[${[...before]}] after=[${[...after]}] log+=${JSON.stringify(log.slice(logBefore.length))}`);
  if (killedEstablished.length) {
    failures.push(`${name}: established PTY id(s) ${killedEstablished.join(", ")} were killed by the reflow`);
  }
  const tagsAfter = await liveTags();
  const lostNodes = tagsBefore.filter((t) => !tagsAfter.has(t)).length;
  // Closing a pane legitimately removes exactly its own node.
  if (lostNodes > expectKilled.length) {
    failures.push(`${name}: ${lostNodes - expectKilled.length} terminal DOM node(s) of established panes were replaced by the reflow`);
  }
  if (missedExpected.length) failures.push(`${name}: PTY id(s) ${missedExpected.join(", ")} should have been killed but are still alive`);
}

const addPane = async () => {
  await page.click('button[title="Add a pane to this workspace"]');
  await page.locator(".apm-item").first().click();
};

const startPanes = await page.locator(".pane:visible").count();
console.log(`panes at start: ${startPanes}, alive: [${[...(await alive()).set]}]`);

for (let i = 0; i < 3; i++) {
  const n = startPanes + i;
  await step(`add pane #${i + 1} (${n} -> ${n + 1} .pane elements)`, addPane);
}

// Close the last pane: only its own PTY may die.
{
  const victimId = [...(await alive()).set].at(-1);
  await step("close one pane", async () => {
    await page.locator(".pane:visible").last().locator("button.x").click();
    const confirm = page.getByText("Close & end session");
    if (await confirm.count()) await confirm.first().click();
  }, { expectKilled: [victimId] });
}

// Cross-row drag-reorder: pane index 1 dropped on index 2 swaps rows, so both
// panes change parent. Neither PTY may die and neither node may be replaced.
await step("drag pane 1 onto pane 2 (cross-row)", async () => {
  const from = page.locator(".pane:visible").nth(1).locator(".pgrip");
  const to = page.locator(".pane:visible").nth(2);
  await from.dragTo(to);
});

{
  const sizes = await page.evaluate(() => window.__sizes.slice());
  console.log(`pty size calls: ${sizes.length}`);
  for (const z of sizes) {
    if (!(z.cols >= 20 && z.rows >= 5)) failures.push(`degenerate ${z.op} ${z.id ?? ""} ${z.cols}x${z.rows}`);
  }
}

if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 3).join(" | "));
await browser.close();
if (failures.length) {
  console.error("REFLOW-KEEPS-AGENTS FAIL:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("REFLOW-KEEPS-AGENTS PASS");
