// Regression test for R1: adding, closing or reordering a pane must not kill
// (and respawn) the PTYs of panes that are already live.
//
// React StrictMode (dev) spawns then kills a NEW pane's PTY before it goes
// live. That is a dev artefact, so we never judge a step by the raw kill log.
// Instead we track the set of PTY ids alive (spawned and not killed) once each
// step settles: every id alive before a step must still be alive after it,
// except the one pane the step deliberately closes.
//
// Run from e2e/ with the Vite dev server on :1420: node reflow-keeps-agents.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const wrap = `(()=>{const T=window.__TAURI_INTERNALS__;const inv=T.invoke;window.__ptylog=[];T.invoke=(c,a)=>{const r=inv(c,a);if(c==="pty_spawn"){Promise.resolve(r).then(id=>window.__ptylog.push("spawn "+id+" "+a.vendor));}if(c==="pty_kill")window.__ptylog.push("kill "+a.paneId);return r;};})();`;

const URL = "http://localhost:1420";
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

// Run a step, let it settle, then require every previously-alive id (minus the
// intentionally closed ones) to still be alive.
async function step(name, action, { expectKilled = [] } = {}) {
  const { set: before, log: logBefore } = await alive();
  await action();
  await page.waitForTimeout(2000);
  const { set: after, log } = await alive();
  const killedEstablished = [...before].filter((id) => !after.has(id) && !expectKilled.includes(id));
  const missedExpected = expectKilled.filter((id) => after.has(id));
  console.log(`${name}: alive before=[${[...before]}] after=[${[...after]}] log+=${JSON.stringify(log.slice(logBefore.length))}`);
  if (killedEstablished.length) {
    failures.push(`${name}: established PTY id(s) ${killedEstablished.join(", ")} were killed by the reflow`);
  }
  if (missedExpected.length) failures.push(`${name}: PTY id(s) ${missedExpected.join(", ")} should have been killed but are still alive`);
}

const addPane = async () => {
  await page.click('button[title="Add a pane to this workspace"]');
  await page.locator(".apm-item").first().click();
};

const startPanes = await page.locator(".pane").count();
console.log(`panes at start: ${startPanes}, alive: [${[...(await alive()).set]}]`);

for (let i = 0; i < 3; i++) {
  const n = startPanes + i;
  await step(`add pane #${i + 1} (${n} -> ${n + 1} .pane elements)`, addPane);
}

// Close the last pane: only its own PTY may die.
{
  const victimId = [...(await alive()).set].at(-1);
  await step("close one pane", async () => {
    await page.locator(".pane").last().locator("button.x").click();
    const confirm = page.getByText("Close & end session");
    if (await confirm.count()) await confirm.first().click();
  }, { expectKilled: [victimId] });
}

// TODO: drag-reorder via the ".phead" grip (title "Drag to reorder"). HTML5
// drag events are flaky under headless Playwright; add once a stable path exists.

if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 3).join(" | "));
await browser.close();
if (failures.length) {
  console.error("REFLOW-KEEPS-AGENTS FAIL:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("REFLOW-KEEPS-AGENTS PASS");
