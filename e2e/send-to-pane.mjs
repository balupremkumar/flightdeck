// Regression: Broadcast / Review "send to agent" / palette "New task" must write
// to the pane's real PTY id (what pty_spawn returned), not its store model id.
// The mock hands out pty ids offset from model ids, so a model-id write targets
// a pty that does not exist (or another pane's).
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1435 node send-to-pane.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const wrap = `(()=>{
  const T=window.__TAURI_INTERNALS__;const inv=T.invoke;
  window.__pty2model={};window.__writes=[];
  T.invoke=(c,a)=>{
    if(c==="pty_write")window.__writes.push({paneId:a.paneId,data:a.data});
    const r=inv(c,a);
    if(c==="pty_spawn")Promise.resolve(r).then((id)=>{window.__pty2model[id]=a.modelId;});
    return r;
  };
})();`;

const URL = process.env.FD_URL ?? "http://localhost:1420";
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + wrap);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.getByText("acme-web", { exact: true }).first().click();
await page.waitForTimeout(2500);

const map = await page.evaluate(() => window.__pty2model);
const ptys = Object.keys(map).map(Number);
check(ptys.length > 1, `spawned ${ptys.length} panes`);
check(ptys.every((p) => map[p] !== p), "mock pty ids differ from model ids");

await page.getByTitle("Broadcast to panes").click();
const MSG = "ping-e2e-" + Date.now();
await page.locator(".bc-bar textarea").fill(MSG);
await page.locator(".bc-send").click();
await page.waitForTimeout(800);

const writes = await page.evaluate((m) => window.__writes.filter((w) => String(w.data).startsWith(m)), MSG);
const hitPtys = new Set(writes.map((w) => w.paneId));
check(writes.length > 0, `broadcast wrote ${writes.length} time(s)`);
check([...hitPtys].every((p) => p in map), `every broadcast write addressed a real pty id (got [${[...hitPtys]}], live [${ptys}])`);
check(hitPtys.size === writes.length, "each target written exactly once");

check(pageErrors.length === 0, `no page errors ${pageErrors.join("|")}`);
await browser.close();
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log("\nsend-to-pane: all checks passed");
