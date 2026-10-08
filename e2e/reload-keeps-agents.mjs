// Regression test for Phase 4 S3: a webview reload (Ctrl+R, dev HMR full reload,
// a renderer crash recovered by reload) must reattach to the live agents instead of
// spawning new ones.
//
// The mock backend dies with the page, so the "Rust side" is faked the way the real
// one behaves: before the reload we publish, through sessionStorage (which survives
// page.reload()), a pty_attach answer for every pane that was spawned. Then:
//   - zero pty_spawn after the reload, for panes that already existed
//   - every pane asked pty_attach and the terminal shows the snapshot text
//   - an output event inside the snapshot (seq == next_seq) is NOT written again
//   - an output event past it (seq > next_seq) IS written (gapless)
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1436 node reload-keeps-agents.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
// Logs spawn/attach per page load, and answers pty_attach from sessionStorage.
const wrap = `(()=>{
  const T=window.__TAURI_INTERNALS__;const inv=T.invoke;
  window.__spawns=[];window.__attaches=[];
  window.__fdMockAttach=(modelId)=>{const live=JSON.parse(sessionStorage.getItem("fdLive")||"{}");window.__attaches.push({modelId,hit:!!live[modelId]});return live[modelId]??null;};
  T.invoke=(c,a)=>{if(c==="pty_spawn")window.__spawns.push({modelId:a.modelId,gen:a.gen,vendor:a.vendor});return inv(c,a);};
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
await page.locator('text="acme-web" >> visible=true').first().click();
await page.waitForTimeout(2000);

const first = await page.evaluate(() => window.__spawns.slice());
check(first.length > 0, `first load spawned ${first.length} pane(s) with modelId+gen`);
check(first.every((s) => Number.isInteger(s.modelId) && /^\d+\|/.test(s.gen)), "every pty_spawn carries modelId and an epoch|vendor|cwd gen");

// Publish what Rust would answer: the ring for each live pty.
const NEXT = 1000;
const live = {};
first.forEach((s, i) => {
  const text = `SNAPSHOT-${s.modelId}\r\n`;
  live[s.modelId] = {
    pty_id: 500 + i,
    snapshot: { head: "", body: Buffer.from(text).toString("base64"), start_seq: 0, next_seq: NEXT },
    cols: 100, rows: 30, proc_name: "node",
  };
});
await page.evaluate((l) => sessionStorage.setItem("fdLive", JSON.stringify(l)), live);

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(3500);

const spawnsAfter = await page.evaluate(() => window.__spawns.slice());
const attaches = await page.evaluate(() => window.__attaches.slice());
check(spawnsAfter.length === 0, `zero pty_spawn after reload (saw ${spawnsAfter.length}: ${JSON.stringify(spawnsAfter)})`);
const attachedModels = new Set(attaches.filter((a) => a.hit).map((a) => a.modelId));
const firstModels = new Set(first.map((s) => s.modelId));
check(attachedModels.size === firstModels.size && [...firstModels].every((m) => attachedModels.has(m)),
  `every existing pane reattached (spawned [${[...firstModels]}], attached [${[...attachedModels]}])`);

// Terminal text: read each pane's xterm buffer through the live paneSessions module
// (same Vite module instance the app uses). The renderer may be WebGL, so the DOM has no rows.
const termText = () => page.evaluate(async (ids) => {
  const ps = await import("/src/paneSessions.ts");
  return ids.map((id) => {
    const t = ps.get(id)?.term;
    if (!t) return "";
    const b = t.buffer.active;
    let out = "";
    for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? "") + "\n";
    return out;
  });
}, [...firstModels]);
let texts = await termText();
for (const m of firstModels) {
  check(texts[[...firstModels].indexOf(m)].includes(`SNAPSHOT-${m}`), `terminal for pane ${m} shows its snapshot text`);
}

// Dedupe + gapless against the first pane's pty id (500).
await page.evaluate((next) => {
  const b = (s) => btoa(s);
  window.__mockEmit("pty://output", { pane_id: 500, b64: b("DUPLICATE-IN-SNAPSHOT\r\n"), seq: next });
  window.__mockEmit("pty://output", { pane_id: 500, b64: b("LIVE-AFTER-SNAPSHOT\r\n"), seq: next + 23 });
}, NEXT);
await page.waitForTimeout(600);
texts = await termText();
check(!texts[0].includes("DUPLICATE-IN-SNAPSHOT"), "event with seq <= next_seq is dropped (no duplicate)");
check(texts[0].includes("LIVE-AFTER-SNAPSHOT"), "event with seq > next_seq is written (no gap)");

const crashed = await page.getByText("Something broke in the cockpit UI").count();
check(crashed === 0, "no ErrorBoundary crash screen");
check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors[0] : ""}`);

await browser.close();
if (failures.length) { console.error(`RELOAD-KEEPS-AGENTS FAIL: ${failures.length} check(s)`); process.exit(1); }
console.log("RELOAD-KEEPS-AGENTS PASS");
