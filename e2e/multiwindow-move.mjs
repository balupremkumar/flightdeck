// Phase 4 S8a: move a workspace with live panes to a new window.
//
// Two pages share one browser context and one JS port of the Rust side
// (lib/multiwindow.mjs): registry, slices, pty table and rings. The real Terminal and
// store code run in both pages. Asserted:
//   - the move never kills a pty and never spawns a second agent for a moved pane
//   - the new window takes the hybrid path: serialised screen + a delta attach after
//     the paused seq (not a full ring replay)
//   - output continues in page 2, gapless and without duplicates across the boundary,
//     and the panes are gone from page 1
//   - pane ids minted in the two windows cannot collide
//   - Ctrl+Shift+N (the chord) is what starts the move, and the new window announces
//     itself and puts focus on the active pane
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1437 node multiwindow-move.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MultiWindowBus } from "./lib/multiwindow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");localStorage.setItem("flightdeck-multiwindow","1");`;

const URL = process.env.FD_URL ?? "http://localhost:1437";
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) { check(false, `timed out waiting for ${what}`); return null; }
    await sleep(100);
  }
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const bus = new MultiWindowBus(context, URL);
await bus.install();
// Context-level init scripts also run in a new page's initial about:blank, where
// localStorage is denied: only boot real (http) documents.
await context.addInitScript(`if (/^https?:/.test(location.protocol)) {\n${boot}\n${mock}\n}`);

const pageErrors = [];
context.on("page", (p) => p.on("pageerror", (e) => pageErrors.push(e.message)));

const page1 = await context.newPage();
bus.register("main", page1);
await page1.goto(URL, { waitUntil: "networkidle" });
await page1.waitForTimeout(2500);
await page1.getByText("acme-web", { exact: true }).first().click();
await page1.waitForTimeout(2500);

// Page helpers: read live module state through the same Vite instances the app uses.
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
  const ps = await import("/src/paneSessions.ts");
  const s = useApp.getState();
  return {
    activeId: s.activeId,
    workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, focused: w.focused, panes: w.panes.map((p) => p.id) })),
    sessions: ps.size(),
  };
});
const ticks = (text, model) => [...(text ?? "").matchAll(new RegExp(`TICK-${model}-(\\d+)`, "g"))].map((m) => Number(m[1]));

const before = await storeState(page1);
const ws = before.workspaces.find((w) => w.id === before.activeId);
check(!!ws && ws.panes.length >= 2, `active workspace has live panes (ws ${ws?.id} "${ws?.name}", panes [${ws?.panes}])`);
const moved = ws.panes;
const stayId = before.workspaces.find((w) => w.id !== ws.id).id;

for (const m of moved) {
  await until(async () => ticks(await termText(page1, m), m).length >= 3, 8000, `pane ${m} output in page 1`);
}
check(moved.every((m) => bus.spawns.filter((s) => s.modelId === m).length === 1), "every pane spawned exactly once before the move");

// ---- the move, by chord -------------------------------------------------------
const lastBefore = {};
for (const m of moved) lastBefore[m] = Math.max(...ticks(await termText(page1, m), m));
await page1.keyboard.press("Control+Shift+N");
const label = await until(async () => bus.transfers[0]?.to, 10000, "ws_transfer");
check(label === "fw-1", `ws_transfer minted ${label}`);
// ws_transfer records the transfer before it opens the page; wait for the page itself.
const page2 = await until(async () => bus.pages.get("fw-1"), 10000, "the new window's page");
await until(async () => (await storeState(page2)).workspaces.length === 1, 15000, "page 2 to adopt the workspace");
await until(async () => {
  const t = await Promise.all(moved.map((m) => termText(page2, m)));
  return t.every((x, i) => x && x.includes(`BANNER-${moved[i]}`));
}, 15000, "page 2 terminals to show the moved screens");
await page2.waitForTimeout(1500);

// ---- no kill, no second spawn, hybrid path ---------------------------------------
check(bus.kills.length === 0, `no pty_kill anywhere (saw ${JSON.stringify(bus.kills)})`);
for (const m of moved) {
  check(bus.spawns.filter((s) => s.modelId === m).length === 1, `pane ${m}: still exactly one spawn`);
  const a = bus.attaches.find((x) => x.label === "fw-1" && x.modelId === m);
  check(!!a && a.hit, `pane ${m}: page 2 attached to the live pty`);
  check(!!a && a.delta, `pane ${m}: hybrid path (serialised screen + delta after the paused seq), not a full ring replay`);
  check(bus.ptys.get(bus.byModel.get(m)?.id)?.attached === "fw-1", `pane ${m}: pty is now claimed by fw-1`);
}

// ---- output continues in page 2, gapless, and is gone from page 1 ----------------------
for (const m of moved) {
  const t2 = await termText(page2, m);
  const n = ticks(t2, m);
  const consecutive = n.length > 0 && n.every((v, i) => i === 0 || v === n[i - 1] + 1);
  check(consecutive, `pane ${m}: ticks ${n[0]}..${n.at(-1)} are consecutive across the move (no gap, no duplicate)`);
  check(n.length > 0 && n.at(-1) > lastBefore[m], `pane ${m}: output continued past the move (${lastBefore[m]} -> ${n.at(-1)})`);
}
const lastMid = {};
for (const m of moved) lastMid[m] = Math.max(...ticks(await termText(page2, m), m));
await page2.waitForTimeout(1000);
for (const m of moved) {
  const n = Math.max(...ticks(await termText(page2, m), m));
  check(n > lastMid[m], `pane ${m}: still streaming live in page 2 (${lastMid[m]} -> ${n})`);
}
const after1 = await storeState(page1);
check(after1.workspaces.map((w) => w.id).join() === [stayId].join() || !after1.workspaces.some((w) => w.id === ws.id), "workspace is gone from page 1's store");
check(await page1.evaluate(async (ids) => { const ps = await import("/src/paneSessions.ts"); return ids.every((id) => !ps.get(id)); }, moved), "page 1 holds no terminal for the moved panes");
const staleHidden = await page1.evaluate(async () => (await import("/src/paneSessions.ts")).size());
check(staleHidden === after1.sessions, "page 1 session count matches its remaining panes");

// ---- ids cannot collide -------------------------------------------------------------
const newIds = await page2.evaluate(async (wsId) => {
  const { useApp } = await import("/src/store.ts");
  useApp.getState().addPane(wsId, "pwsh", "C:\\dev\\acme-web");
  return useApp.getState().workspaces.flatMap((w) => w.panes.map((p) => p.id));
}, ws.id);
const ids1 = await page1.evaluate(async (wsId) => {
  const { useApp } = await import("/src/store.ts");
  useApp.getState().addPane(wsId, "pwsh", "C:\\dev\\acme-api");
  return useApp.getState().workspaces.flatMap((w) => w.panes.map((p) => p.id));
}, stayId);
const fresh2 = newIds.find((i) => !moved.includes(i));
check(fresh2 !== undefined && Math.floor(fresh2 / 2 ** 24) === 1, `a pane minted in window 2 is in partition 1 (id ${fresh2})`);
check(ids1.every((i) => Math.floor(i / 2 ** 24) === 0), "panes in window 1 stay in partition 0");
check(new Set([...newIds, ...ids1]).size === newIds.length + ids1.length, "pane ids across both windows are disjoint");

// ---- slices: the new window owns the workspace -----------------------------------------
await sleep(1500);
const s2 = bus.slices.get("fw-1")?.workspaces?.map((w) => w.id) ?? [];
const s1 = bus.slices.get("main")?.workspaces?.map((w) => w.id) ?? [];
check(s2.includes(ws.id), `fw-1 slice holds workspace ${ws.id} (${s2})`);
check(!s1.includes(ws.id), `main slice no longer holds workspace ${ws.id} (${s1})`);

// ---- new window: announcement, focus, title, no launcher ----------------------------------
const live = await page2.locator('.sr-only[role="status"]').allTextContents();
check(live.some((t) => /moved to this window/.test(t)), `new window announced the move in a polite live region (${JSON.stringify(live)})`);
const focusOk = await page2.evaluate(async (wsId) => {
  const ps = await import("/src/paneSessions.ts");
  const { useApp } = await import("/src/store.ts");
  const w = useApp.getState().workspaces.find((x) => x.id === wsId);
  const s = ps.get(w?.focused ?? w?.panes[0]?.id);
  return !!s && s.host.contains(document.activeElement);
}, ws.id);
check(focusOk, "initial focus is on the workspace's active pane");
check(await page2.locator(".dir .path").count() === 0, "new window never shows the launcher");

for (const [name, p] of [["page 1", page1], ["page 2", page2]]) {
  check(await p.getByText("Something broke in the cockpit UI").count() === 0, `${name}: no ErrorBoundary crash screen`);
}
check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors[0] : ""}`);

bus.stop();
await browser.close();
if (failures.length) { console.error(`MULTIWINDOW-MOVE FAIL: ${failures.length} check(s)`); process.exit(1); }
console.log("MULTIWINDOW-MOVE PASS");
