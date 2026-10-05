// Phase 4 S8b: close semantics.
//
// Same two-"window" harness as multiwindow-move.mjs (lib/multiwindow.mjs ports the Rust
// registry, slices and rings; the real Terminal and store code run in every page).
//   A. Move a workspace to page 2, close page 2 (CloseRequested: flush, merge, destroy):
//      the workspace reappears in page 1 with its output, no pty_kill, no second spawn.
//   B. Same, but page 2 dies with no flush (Destroyed without a merge): re-adopted from
//      the last slice, same guarantees.
//   C. Move the only workspace of a secondary out: Rust retires that window, nothing
//      folds back, nothing is killed.
//   D. With the flag off in Rust, a move is refused and the panes keep streaming.
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1439 node multiwindow-close.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MultiWindowBus } from "./lib/multiwindow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");localStorage.setItem("flightdeck-multiwindow","1");`;

const URL = process.env.FD_URL ?? "http://localhost:1439";
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
await page1.getByText("acme-web", { exact: true }).first().click();
await page1.waitForTimeout(2500);

const termText = (page, id) => page.evaluate(async (id) => {
  const ps = await import("/src/paneSessions.ts");
  const t = ps.get(id)?.term;
  if (!t) return null;
  const b = t.buffer.active;
  let out = "";
  for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? "") + "\n";
  return out;
}, id);
const storeState = (page) => page.evaluate(async () => {
  const { useApp } = await import("/src/store.ts");
  const s = useApp.getState();
  return { activeId: s.activeId, workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, panes: w.panes.map((p) => p.id) })) };
});
const ticks = (text, model) => [...(text ?? "").matchAll(new RegExp(`TICK-${model}-(\\d+)`, "g"))].map((m) => Number(m[1]));
const maxTick = async (page, m) => Math.max(0, ...ticks(await termText(page, m), m));

const before = await storeState(page1);
const ws = before.workspaces.find((w) => w.id === before.activeId);
check(!!ws && ws.panes.length >= 2, `active workspace has live panes (ws ${ws?.id} "${ws?.name}", panes [${ws?.panes}])`);
const panes = ws.panes;
for (const m of panes) await until(async () => ticks(await termText(page1, m), m).length >= 3, 8000, `pane ${m} output in page 1`);

/** Move the active workspace of `page` to a new window by chord; returns the new label. */
async function moveByChord(page, from) {
  await page.bringToFront();
  const n = bus.transfers.length;
  await page.keyboard.press("Control+Shift+N");
  const to = await until(async () => bus.transfers[n]?.to, 10000, `ws_transfer from ${from}`);
  const target = await until(async () => bus.pages.get(to), 10000, `${to}'s page`);
  await until(async () => (await storeState(target)).workspaces.length === 1, 15000, `${to} to adopt the workspace`);
  await until(async () => (await Promise.all(panes.map((m) => termText(target, m)))).every((x, i) => x && x.includes(`BANNER-${panes[i]}`)), 15000, `${to} terminals to show the moved screens`);
  await target.waitForTimeout(800);
  return { to, target };
}

/** The workspace is back in page 1 with its output, streaming, and nothing was killed or respawned. */
async function expectBackInMain(tag) {
  await until(async () => (await storeState(page1)).workspaces.some((w) => w.id === ws.id), 15000, `${tag}: workspace back in page 1`);
  await until(async () => (await Promise.all(panes.map((m) => termText(page1, m)))).every((x, i) => x && x.includes(`BANNER-${panes[i]}`)), 15000, `${tag}: page 1 terminals to show the output`);
  const mid = {};
  for (const m of panes) mid[m] = await maxTick(page1, m);
  await page1.waitForTimeout(1000);
  for (const m of panes) {
    const t = ticks(await termText(page1, m), m);
    check(t.length > 0 && t.every((v, i) => i === 0 || v === t[i - 1] + 1), `${tag}: pane ${m} ticks ${t[0]}..${t.at(-1)} are consecutive (no gap, no duplicate)`);
    check(t.at(-1) > mid[m], `${tag}: pane ${m} still streaming in page 1 (${mid[m]} -> ${t.at(-1)})`);
    check(bus.spawns.filter((s) => s.modelId === m).length === 1, `${tag}: pane ${m} spawned exactly once`);
    check(bus.byModel.get(m)?.attached === "main", `${tag}: pane ${m} is claimed by main`);
  }
  check(bus.kills.length === 0, `${tag}: no pty_kill anywhere (saw ${JSON.stringify(bus.kills)})`);
}

// ---- A. close page 2: flush, merge, destroy -----------------------------------------------
const a = await moveByChord(page1, "main");
check(a.to === "fw-1", `A: moved to ${a.to}`);
await bus.closeWindow(a.to);
check(bus.merges.length === 1 && bus.merges[0].flushed === true, `A: the close asked page 2 for a slice and got it (${JSON.stringify(bus.merges[0])})`);
check(a.target.isClosed(), "A: page 2 is destroyed");
check(!bus.windows.has(a.to), "A: the registry forgot fw-1");
await expectBackInMain("A");
check(await page1.getByText(/Window fw-1 closed/).count() > 0, "A: main toasts that the workspace moved back");
await sleep(1200);
check((bus.slices.get("main")?.workspaces ?? []).some((w) => w.id === ws.id), "A: main's slice holds the workspace again");

// ---- B. page 3 dies with no flush: re-adopted from the last slice ------------------------------
const b = await moveByChord(page1, "main");
check(b.to === "fw-2", `B: moved to ${b.to}`);
await sleep(1500); // let page 3 push its own slice (800 ms debounce)
await bus.crashWindow(b.to);
check(bus.merges.length === 2 && bus.merges[1].flushed === false, `B: no flush on a crash (${JSON.stringify(bus.merges[1])})`);
check(b.target.isClosed(), "B: page 3 is gone");
await expectBackInMain("B");

// ---- C. the last workspace leaves a secondary: Rust closes it ---------------------------------
const c = await moveByChord(page1, "main");
check(c.to === "fw-3", `C: moved to ${c.to}`);
const d = await moveByChord(c.target, c.to);
check(d.to === "fw-4", `C: moved on to ${d.to}`);
await until(async () => c.target.isClosed(), 5000, "the emptied window to close");
check(bus.retired.includes(c.to), `C: Rust retired ${c.to} (${bus.retired})`);
check(!bus.windows.has(c.to), "C: the registry forgot the emptied window");
check(bus.merges.length === 2, "C: an emptied window folds nothing back");
check(bus.kills.length === 0, `C: no pty_kill (saw ${JSON.stringify(bus.kills)})`);
check(bus.windows.get(d.to).workspaceIds.includes(ws.id), `C: ${d.to} owns the workspace`);
check(await d.target.locator(".dir .path").count() === 0, "C: the new window never shows the launcher");
check((await storeState(page1)).workspaces.every((w) => w.id !== ws.id), "C: page 1 does not hold the workspace");

// ---- close fw-4 to return everything to main, then D: flag off refuses a move ------------------------
await bus.closeWindow(d.to);
await expectBackInMain("C-return");
await page1.bringToFront();
await page1.evaluate(() => window.__TAURI_INTERNALS__.invoke("set_multiwindow", { enabled: false }));
const nTransfers = bus.transfers.length;
await page1.keyboard.press("Control+Shift+N");
await sleep(1500);
check(bus.transfers.length === nTransfers, "D: with the flag off in Rust the transfer is refused");
check((await storeState(page1)).workspaces.some((w) => w.id === ws.id), "D: the workspace stays in page 1");
const dm = await maxTick(page1, panes[0]);
await page1.waitForTimeout(800);
check(await maxTick(page1, panes[0]) > dm, "D: the refused move left the panes streaming (pane_resume ran)");

check(await page1.getByText("Something broke in the cockpit UI").count() === 0, "no ErrorBoundary crash screen");
check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors[0] : ""}`);

bus.stop();
await browser.close();
if (failures.length) { console.error(`MULTIWINDOW-CLOSE FAIL: ${failures.length} check(s)`); process.exit(1); }
console.log("MULTIWINDOW-CLOSE PASS");
