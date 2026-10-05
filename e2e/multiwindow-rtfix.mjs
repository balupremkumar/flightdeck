// Phase 4+5 red team fixes, cross-window races (docs/plans/phase4-5-redteam.md).
//   #2: a move into an existing window whose win://adopt listener is not up yet. The target
//       never acks, so the source keeps the workspace and resumes its panes (no kill, output
//       still flowing); a later move to the same window still works.
//   #3: a pane added to the workspace during the snapshot drain aborts the move (3a); a pane
//       added during the ws_transfer await (RT-060 M1) stays alive in the source (3b).
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1444 node multiwindow-rtfix.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MultiWindowBus } from "./lib/multiwindow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");localStorage.setItem("flightdeck-multiwindow","1");`;

const URL = process.env.FD_URL ?? "http://localhost:1440";
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
  return { activeId: s.activeId, workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, focused: w.focused, panes: w.panes.map((p) => p.id) })) };
});
const setActive = (page, id) => page.evaluate(async (id) => (await import("/src/store.ts")).useApp.getState().switchWorkspace(id), id);
const hasPty = (page, ids) => page.evaluate(async (ids) => {
  const ps = await import("/src/paneSessions.ts");
  return ids.every((i) => !!ps.get(i)?.ptyId);
}, ids);
const ticks = (text, model) => [...(text ?? "").matchAll(new RegExp(`TICK-${model}-(\\d+)`, "g"))].map((m) => Number(m[1]));
const maxTick = async (page, m) => Math.max(0, ...ticks(await termText(page, m), m));

/** Every pane shows its banner, ticks are consecutive and still advancing, nothing killed or respawned. */
async function expectIntact(page, label, models, tag) {
  await until(async () => (await Promise.all(models.map((m) => termText(page, m)))).every((x, i) => x && x.includes(`BANNER-${models[i]}`)), 15000, `${tag}: ${label} terminals to show their output`);
  const mid = {};
  for (const m of models) mid[m] = await maxTick(page, m);
  await page.waitForTimeout(1000);
  for (const m of models) {
    const t = ticks(await termText(page, m), m);
    check(t.length > 0 && t.every((v, i) => i === 0 || v === t[i - 1] + 1), `${tag}: pane ${m} ticks ${t[0]}..${t.at(-1)} are consecutive in ${label}`);
    check(t.at(-1) > mid[m], `${tag}: pane ${m} still streaming in ${label} (${mid[m]} -> ${t.at(-1)})`);
    check(bus.spawns.filter((s) => s.modelId === m).length === 1, `${tag}: pane ${m} spawned exactly once`);
  }
  check(bus.kills.length === 0, `${tag}: no pty_kill anywhere (saw ${JSON.stringify(bus.kills)})`);
}

/** Move the active workspace of `page` to a new window by chord. */
async function moveByChord(page, from, models) {
  await page.bringToFront();
  const n = bus.transfers.length;
  await page.keyboard.press("Control+Shift+N");
  const to = await until(async () => bus.transfers[n]?.to, 10000, `ws_transfer from ${from}`);
  const target = await until(async () => bus.pages.get(to), 10000, `${to}'s page`);
  await until(async () => (await storeState(target)).workspaces.length === 1, 15000, `${to} to adopt the workspace`);
  await until(async () => (await Promise.all(models.map((m) => termText(target, m)))).every((x, i) => x && x.includes(`BANNER-${models[i]}`)), 15000, `${to} terminals to show the moved screens`);
  await target.waitForTimeout(800);
  return { to, target };
}

async function openPalette(page) {
  await page.bringToFront();
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Jump to|Move to which/).waitFor({ timeout: 5000 });
}
const closePalette = async (page) => { await page.keyboard.press("Escape"); await sleep(150); };

// Both seeded workspaces live: ws 1 (acme-api, panes 1-4) and ws 2 (acme-web, panes 5-6).
await page1.getByText("acme-api", { exact: true }).first().click();
await until(() => hasPty(page1, [1, 2, 3, 4]), 15000, "acme-api panes to start");
await page1.getByText("acme-web", { exact: true }).first().click();
await until(() => hasPty(page1, [5, 6]), 15000, "acme-web panes to start");
await page1.waitForTimeout(1500);
const W1 = [1, 2, 3, 4];
const W2 = [5, 6];
for (const m of [...W1, ...W2]) await until(async () => ticks(await termText(page1, m), m).length >= 3, 8000, `pane ${m} output`);
check((await storeState(page1)).activeId === 2, "setup: acme-web is active in page 1");


// ---- #2. adopt lost before the target listens ------------------------------------------------
await setActive(page1, 2);
const mv = await moveByChord(page1, "main", W2);
check(mv.to === "fw-1", `setup: acme-web is in ${mv.to}`);
await setActive(page1, 1);
await until(() => hasPty(page1, W1), 15000, "acme-api panes live in page 1");
bus.adoptAckMs = 700;
bus.dropAdoptTo = "fw-1";
const lost = await page1.evaluate(async () => (await import("/src/windowMove.ts")).moveWorkspaceToWindow(1, "fw-1"));
check(lost.ok === false, `#2: the move is reported as failed (${JSON.stringify(lost)})`);
const st2 = await storeState(page1);
check(st2.workspaces.some((w) => w.id === 1), "#2: page 1 still holds acme-api");
check(bus.windows.get("main").workspaceIds.includes(1) || !bus.windows.get("fw-1").workspaceIds.includes(1), "#2: the registry gave ws 1 back to main");
await expectIntact(page1, "page 1", W1, "#2");
check(![...bus.ptys.values()].some((p) => p.paused), "#2: no pane left paused");

// The same move, with the target listening, goes through.
const n2 = bus.transfers.length;
const ok = await page1.evaluate(async () => (await import("/src/windowMove.ts")).moveWorkspaceToWindow(1, "fw-1"));
check(ok.ok === true, `#2: a retry with a live target succeeds (${JSON.stringify(ok)})`);
await until(async () => (await storeState(mv.target)).workspaces.some((w) => w.id === 1), 15000, "fw-1 to adopt acme-api");
check(bus.transfers.length > n2, "#2: the retry reached the bus");
await expectIntact(mv.target, "page 2", W1, "#2 retry");

// ---- #3. a pane added while the move is in flight -------------------------------------------
// Both workspaces now live in fw-1 (mv.target). Drive the moves from there.
const fw1 = mv.target;
const addPaneIn = (page, wsId) => page.evaluate(async (wsId) => {
  const { useApp } = await import("/src/store.ts");
  const before = new Set(useApp.getState().workspaces.flatMap((w) => w.panes.map((p) => p.id)));
  useApp.getState().addPane(wsId, "pwsh", "C:\\");
  return useApp.getState().workspaces.flatMap((w) => w.panes.map((p) => p.id)).find((id) => !before.has(id)) ?? null;
}, wsId);
const moveFrom = (page, wsId) => page.evaluate(async (wsId) => (await import("/src/windowMove.ts")).moveWorkspaceToNewWindow(wsId), wsId);
const paneWs = async (page, id) => (await storeState(page)).workspaces.find((w) => w.panes.includes(id))?.id ?? null;

// #3a: added during the snapshot drain: the move aborts, everything resumes, nothing is killed.
await fw1.bringToFront();
await setActive(fw1, 1);
await until(() => hasPty(fw1, W1), 15000, "#3a: acme-api panes live in fw-1");
await fw1.evaluate(async () => {
  const ps = await import("/src/paneSessions.ts");
  const { useApp } = await import("/src/store.ts");
  const s = ps.get(4);
  const orig = s.api.snapshot;
  s.api.snapshot = async (seq) => {
    s.api.snapshot = orig;
    useApp.getState().addPane(1, "pwsh", "C:\\");
    return orig(seq);
  };
});
const nA = bus.transfers.length;
const rA = await moveFrom(fw1, 1);
check(rA.ok === false, `#3a: a pane added during the drain aborts the move (${JSON.stringify(rA)})`);
check(bus.transfers.length === nA, "#3a: ws_transfer never reached the bus");
check((await storeState(fw1)).workspaces.find((w) => w.id === 1)?.panes.length === 5, "#3a: fw-1 still holds acme-api with its new pane");
check(![...bus.ptys.values()].some((p) => p.paused), "#3a: no pane left paused");
await expectIntact(fw1, "fw-1", W1, "#3a");

// #3b (M1): added during the ws_transfer await. The pane is not in the transfer, so it must
// stay alive in the source (moved to another workspace there), never be released and killed.
await setActive(fw1, 2);
await until(() => hasPty(fw1, W2), 15000, "#3b: acme-web panes live in fw-1");
await fw1.evaluate(async () => {
  const { useApp } = await import("/src/store.ts");
  const orig = window.__fdBus;
  window.__fdBus = (m) => {
    if (m.cmd === "ws_transfer") {
      window.__fdBus = orig;
      const ids = () => useApp.getState().workspaces.flatMap((w) => w.panes.map((p) => p.id));
      const before = new Set(ids());
      useApp.getState().addPane(2, "pwsh", "C:\\");
      window.__extraPane = ids().find((id) => !before.has(id));
    }
    return orig(m);
  };
});
const nB = bus.transfers.length;
const rB = await moveFrom(fw1, 2);
check(rB.ok === true, `#3b: the move itself succeeds (${JSON.stringify(rB)})`);
check(bus.transfers.length === nB + 1, "#3b: ws_transfer reached the bus");
const stB = await storeState(fw1);
const extra = await fw1.evaluate(() => window.__extraPane);
check(!stB.workspaces.some((w) => w.id === 2), "#3b: acme-web left fw-1");
check(extra !== undefined && (await paneWs(fw1, extra)) === 1, `#3b: the pane added mid-move stayed in fw-1, in acme-web's sibling workspace (pane ${extra})`);
await until(async () => bus.spawns.some((s) => s.modelId === extra), 8000, "#3b: the extra pane to spawn");
await fw1.waitForTimeout(800);
check(bus.kills.length === 0, `#3b: no pty_kill anywhere (saw ${JSON.stringify(bus.kills)})`);
check(await fw1.evaluate(async (id) => { const s = (await import("/src/paneSessions.ts")).get(id); return !!s && !s.disposed; }, extra), "#3b: the extra pane's session is live, not disposed");
await until(() => bus.pages.get("fw-2"), 10000, "fw-2's page");
await expectIntact(bus.pages.get("fw-2"), "fw-2", W2, "#3b");

check(await page1.getByText("Something broke in the cockpit UI").count() === 0, "no ErrorBoundary crash screen");
check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors.slice(0, 3).join(" | ") : ""}`);

bus.stop();
await browser.close();
if (failures.length) { console.error(`MULTIWINDOW-RTFIX FAIL: ${failures.length} check(s)`); process.exit(1); }
console.log("MULTIWINDOW-RTFIX PASS");
