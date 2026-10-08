// 0.6.0 red team fix 6: the AdoptQueue / main_adopt_done ack path (windows.rs :566-621, :1074-1083,
// :1106-1118; windowBoot.ts handleAdopt / replayPendingAdopts). A fold into main is parked in Rust
// until main acks it, because emit_to is fire and forget and a reloading main loses the event.
//
//   A. Live fold: main adopts and acks; the queue drains (a repeated or unknown ack changes nothing).
//   B. The live win://adopt is lost (main mid-reload): the fold stays queued, main_pending_adopts
//      returns it, and main's replay (listener up) adopts it and acks.
//   C. The ack never arrives (main died before it landed): the fold stays queued and replays again
//      without duplicating the workspace (idempotent by id); once the ack lands the queue drains.
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1446 node multiwindow-adopt-ack.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MultiWindowBus } from "./lib/multiwindow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");localStorage.setItem("flightdeck-multiwindow","1");`;

const URL = process.env.FD_URL ?? "http://localhost:1446";
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) { check(false, `timed out waiting for ${what}`); console.log(`FAILED: ${failures.length} check(s)`); await browser.close().catch(() => {}); process.exit(1); }
    await sleep(100);
  }
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const bus = new MultiWindowBus(context, URL);
await bus.install();
await context.addInitScript(`if (/^https?:/.test(location.protocol)) {\n${boot}\n${mock}\n}`);

const pageErrors = [];
context.on("page", (p) => p.on("pageerror", (e) => pageErrors.push(e.message)));

const page1 = await context.newPage();
bus.register("main", page1);
await page1.goto(URL, { waitUntil: "networkidle" });
await page1.waitForTimeout(2500);
await page1.locator('text="acme-web" >> visible=true').first().click();
await page1.waitForTimeout(2500);

const storeState = (page) => page.evaluate(async () => {
  const { useApp } = await import("/src/store.ts");
  const s = useApp.getState();
  return { activeId: s.activeId, workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, panes: w.panes.map((p) => p.id) })) };
});
const count = async (id) => (await storeState(page1)).workspaces.filter((w) => w.id === id).length;
const invokeMain = (cmd, args) => page1.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
/** main's boot step once its win://adopt listener is up (src/main.tsx). */
const replay = () => page1.evaluate(async () => (await import("/src/windowBoot.ts")).replayPendingAdopts());
const queued = () => bus.mainAdopts.items.map(([id]) => id);

const before = await storeState(page1);
const ws = before.workspaces.find((w) => w.id === before.activeId);
check(!!ws && ws.panes.length >= 1, `active workspace has live panes (ws ${ws?.id} "${ws?.name}")`);

/** Move the active workspace of page 1 to a new window by chord; returns the new label and page. */
async function moveOut() {
  await page1.bringToFront();
  const n = bus.transfers.length;
  await page1.keyboard.press("Control+Shift+N");
  const to = await until(async () => bus.transfers[n]?.to, 10000, "ws_transfer from main");
  const target = await until(async () => bus.pages.get(to), 10000, `${to}'s page`);
  await until(async () => (await storeState(target)).workspaces.length === 1, 15000, `${to} to adopt the workspace`);
  await until(async () => (await storeState(page1)).workspaces.every((w) => w.id !== ws.id), 10000, "main to release the workspace");
  await target.waitForTimeout(800); // let the new window push its own slice (800 ms debounce)
  return to;
}

// ---- A. live fold: adopted, acked, queue drained ------------------------------------------------
const a = await moveOut();
await bus.closeWindow(a);
await until(async () => (await count(ws.id)) === 1, 15000, "A: workspace back in main");
await until(async () => queued().length === 0, 5000, "A: main to ack the fold");
check(bus.mainAcks.length === 1 && bus.mainAcks[0] === 1, `A: main acked transfer 1 once (${JSON.stringify(bus.mainAcks)})`);
check((await invokeMain("main_pending_adopts", {})).length === 0, "A: nothing left for a replay");
await invokeMain("main_adopt_done", { transferId: 1 });
await invokeMain("main_adopt_done", { transferId: 99 });
check(queued().length === 0 && (await count(ws.id)) === 1, "A: a repeated or unknown ack changes nothing");

// ---- B. the live event is lost: queued until the replay -----------------------------------------
const b = await moveOut();
bus.dropAdoptTo = "main"; // main is mid-reload: its listener is not up for this emit
await bus.closeWindow(b);
await sleep(1500);
check((await count(ws.id)) === 0, "B: main never saw the lost win://adopt");
check(queued().length === 1, `B: the fold stays queued in Rust (${JSON.stringify(queued())})`);
const pend = await invokeMain("main_pending_adopts", {});
check(pend.length === 1 && pend[0].workspaceIds.includes(ws.id) && pend[0].transferId === queued()[0], `B: main_pending_adopts returns it with its id (${JSON.stringify(pend.map((p) => [p.from, p.transferId]))})`);
const acksB = bus.mainAcks.length;
await replay();
await until(async () => (await count(ws.id)) === 1, 15000, "B: replay to bring the workspace back");
await until(async () => queued().length === 0, 5000, "B: replay to ack the fold");
check(bus.mainAcks.length === acksB + 1, "B: the replay acked it");
check((await invokeMain("main_pending_adopts", {})).length === 0, "B: a second reload has nothing to replay");

// ---- C. the ack never arrives: replays stay idempotent, a late ack drains it ----------------------
const c = await moveOut();
bus.dropAdoptTo = "main";
bus.holdMainAcks = true;
await bus.closeWindow(c);
const idC = queued()[0];
await replay();
await until(async () => (await count(ws.id)) === 1, 15000, "C: replay to bring the workspace back");
await sleep(500);
check(queued().length === 1 && queued()[0] === idC, `C: no ack applied, the fold stays queued (${JSON.stringify(queued())})`);
await replay();
await replay();
check((await count(ws.id)) === 1, "C: replaying an unacked fold again does not duplicate the workspace");
check(queued().length === 1, "C: still queued after repeated replays");
bus.holdMainAcks = false;
await invokeMain("main_adopt_done", { transferId: 9999 });
check(queued().length === 1, "C: an ack for an unknown id leaves it queued");
await replay();
await until(async () => queued().length === 0, 5000, "C: the late ack to drain the queue");
check((await count(ws.id)) === 1, "C: still one copy of the workspace");
await invokeMain("main_adopt_done", { transferId: idC });
check(queued().length === 0, "C: a repeated ack on an empty queue is harmless");

check(bus.kills.length === 0, `no pty_kill anywhere (saw ${JSON.stringify(bus.kills)})`);
check(await page1.getByText("Something broke in the cockpit UI").count() === 0, "no ErrorBoundary crash screen");
check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors[0] : ""}`);

bus.stop();
await browser.close();
if (failures.length) { console.error(`MULTIWINDOW-ADOPT-ACK FAIL: ${failures.length} check(s)`); process.exit(1); }
console.log("MULTIWINDOW-ADOPT-ACK PASS");
