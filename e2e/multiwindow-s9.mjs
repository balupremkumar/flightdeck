// Phase 4 S9: Move to an existing window, Merge all windows, palette Go to workspace,
// live settings across windows, and the created-in-a-secondary fix.
//
// Same two-"window" harness as multiwindow-move.mjs (lib/multiwindow.mjs ports the Rust
// registry, slices and rings; the real Terminal, store, palette and storage-sync code run
// in every page; two pages of one context share localStorage and get real storage events).
//   A. A workspace created in page 2 is assigned to it (no ownership rejection) and merges
//      back into page 1 when page 2 closes.
//   B. Palette "Move workspace to window..." moves a live workspace into an existing page:
//      no kill, no second spawn, gapless output.
//   C. Palette "Go to workspace" in page 1 lists page 2's workspaces and reaches page 2.
//   D. A theme change and a terminal setting changed in page 1 apply live in page 2.
//   E. Palette "Merge all windows" folds every secondary into page 1, agents intact.
//   F. Turning the flag off at runtime merges, and the palette entries are hidden.
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1440 node multiwindow-s9.mjs
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
await page1.locator('text="acme-api" >> visible=true').first().click();
await until(() => hasPty(page1, [1, 2, 3, 4]), 15000, "acme-api panes to start");
await page1.locator('text="acme-web" >> visible=true').first().click();
await until(() => hasPty(page1, [5, 6]), 15000, "acme-web panes to start");
await page1.waitForTimeout(1500);
const W1 = [1, 2, 3, 4];
const W2 = [5, 6];
for (const m of [...W1, ...W2]) await until(async () => ticks(await termText(page1, m), m).length >= 3, 8000, `pane ${m} output`);
check((await storeState(page1)).activeId === 2, "setup: acme-web is active in page 1");

// ---- A. a workspace created in page 2 is assigned to it and merges back ----------------------
const a = await moveByChord(page1, "main", W2);
check(a.to === "fw-1", `A: acme-web moved to ${a.to}`);
const made = await a.target.evaluate(async () => {
  const { useApp } = await import("/src/store.ts");
  useApp.getState().createWorkspace("C:\\dev\\newone", [{ vendor: "pwsh", cwd: "C:\\dev\\newone" }]);
  const s = useApp.getState();
  const w = s.workspaces.find((x) => x.name === "newone");
  return { id: w.id, pane: w.panes[0].id };
});
check(made.id >> 24 === 1 && made.pane >> 24 === 1, `A: ids minted in page 2 sit in its partition (ws ${made.id}, pane ${made.pane})`);
await until(async () => bus.windows.get("fw-1")?.workspaceIds.includes(made.id), 6000, "the registry to assign the new workspace to fw-1");
check(!bus.rejected.some((r) => r.id === made.id), `A: no ownership rejection for the new workspace (${JSON.stringify(bus.rejected)})`);
check((bus.slices.get("fw-1")?.workspaces ?? []).some((w) => w.id === made.id), "A: fw-1's accepted slice holds the new workspace");
await until(() => hasPty(a.target, [made.pane]), 10000, "the new pane to start in page 2");
await bus.closeWindow(a.to);
check(a.target.isClosed(), "A: page 2 is destroyed");
await until(async () => (await storeState(page1)).workspaces.some((w) => w.id === made.id), 15000, "A: the new workspace to appear in page 1");
const afterA = await storeState(page1);
check(afterA.workspaces.some((w) => w.id === 2) && afterA.workspaces.some((w) => w.name === "newone"), `A: page 1 holds acme-web and newone (${afterA.workspaces.map((w) => w.name)})`);
check(bus.spawns.filter((s) => s.modelId === made.pane).length === 1, "A: the new pane was spawned once (page 1 attached to it)");
await expectIntact(page1, "page 1", W2, "A");

// ---- B. Move workspace to window... (existing page) ------------------------------------------
await setActive(page1, 2);
const b = await moveByChord(page1, "main", W2);
check(b.to === "fw-2", `B: acme-web is in ${b.to}`);
await setActive(page1, 1);
await until(() => hasPty(page1, W1), 15000, "B: acme-api panes live in page 1");
await openPalette(page1);
await page1.getByPlaceholder(/Jump to/).fill("move workspace");
await page1.locator(".cmdp-item", { hasText: "Move workspace to window…" }).click();
const targetRow = await until(async () => (await page1.locator(".cmdp-item", { hasText: "Window 3" }).count()) > 0, 8000, "B: the other window listed by title");
check(!!targetRow, "B: the palette lists fw-2 by its title, Window 3");
const nB = bus.transfers.length;
await page1.locator(".cmdp-item", { hasText: "Window 3" }).first().click();
await until(async () => bus.transfers.length > nB, 10000, "B: the move to fw-2");
check(bus.transfers[nB]?.to === "fw-2" && bus.transfers[nB]?.from === "main" && bus.transfers[nB]?.workspaceId === 1, `B: ws 1 moved main -> fw-2 (${JSON.stringify(bus.transfers[nB])})`);
await until(async () => (await storeState(b.target)).workspaces.some((w) => w.id === 1), 15000, "B: fw-2 to adopt acme-api");
const bState = await storeState(b.target);
check(bState.workspaces.map((w) => w.id).sort().join() === "1,2", `B: page 3 holds both workspaces (${bState.workspaces.map((w) => w.name)})`);
check(!(await storeState(page1)).workspaces.some((w) => w.id === 1), "B: page 1 no longer holds acme-api");
check(bus.windows.get("fw-2").workspaceIds.includes(1) && bus.windows.get("main").workspaceIds.every((i) => i !== 1), "B: the registry assigns ws 1 to fw-2 only");
await expectIntact(b.target, "page 3", W1, "B");

// ---- C. Go to workspace in page 1 reaches page 2 ---------------------------------------------
await sleep(1800); // let fw-2's slice (with both workspaces) land
await setActive(b.target, 1);
await openPalette(page1);
await page1.getByPlaceholder(/Jump to/).fill("acme-web");
const row = page1.locator(".cmdp-item", { hasText: "Window 3" }).filter({ hasText: "acme-web" });
await until(async () => (await row.count()) > 0, 8000, "C: acme-web (in Window 3) listed in page 1's palette");
check((await row.count()) === 1, "C: the remote workspace row names its window");
const nF = bus.focuses.length;
await row.first().click();
await until(async () => bus.focuses.length > nF, 5000, "C: window_focus_pane");
check(bus.focuses[nF]?.label === "fw-2" && bus.focuses[nF]?.wsId === 2, `C: focus request targets fw-2 / ws 2 (${JSON.stringify(bus.focuses[nF])})`);
await until(async () => (await storeState(b.target)).activeId === 2, 5000, "C: page 3 to switch to acme-web");
const cState = await storeState(b.target);
check(cState.activeId === 2 && cState.workspaces.find((w) => w.id === 2)?.focused === 5, `C: page 3 shows acme-web with its first pane focused (active ${cState.activeId}, focused ${cState.workspaces.find((w) => w.id === 2)?.focused})`);

// ---- D. live settings across windows ----------------------------------------------------------
const themeOf = (page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
await page1.bringToFront();
await b.target.evaluate(() => {
  window.__seen = [];
  window.addEventListener("flightdeck-terminal-settings-changed", (e) => window.__seen.push(e.detail?.fontSize));
});
const t0 = await themeOf(b.target);
await page1.evaluate(async () => { const m = await import("/src/themes.ts"); m.applyTheme(m.rememberedThemeId("light")); });
await until(async () => (await themeOf(b.target)) !== t0, 5000, "D: page 3 to take the light theme");
const lightP1 = await themeOf(page1);
check(!!lightP1 && (await themeOf(b.target)) === lightP1, `D: theme set in page 1 applies live in page 3 (${lightP1})`);
await page1.evaluate(async () => { const m = await import("/src/themes.ts"); m.applyTheme(m.rememberedThemeId("dark")); });
await until(async () => (await themeOf(b.target)) === (await themeOf(page1)), 5000, "D: page 3 to return to dark");
check((await themeOf(b.target)) === (await themeOf(page1)), "D: and back");
await page1.evaluate(async () => { (await import("/src/settingsStore.ts")).saveTerminalSettings({ fontSize: 17 }); });
await until(async () => (await b.target.evaluate(() => window.__seen)).includes(17), 5000, "D: the terminal settings event in page 3");
check((await b.target.evaluate(() => window.__seen)).includes(17), "D: a terminal setting changed in page 1 reaches page 3 as the same-context event");
await page1.evaluate(async () => { (await import("/src/settingsStore.ts")).saveTerminalSettings({ fontSize: 13 }); });

// ---- E. Merge all windows ---------------------------------------------------------------------
await setActive(b.target, 1);
const e3 = await moveByChord(b.target, "fw-2", W1);
check(e3.to === "fw-3", `E: acme-api moved on to ${e3.to}, so three windows exist`);
await sleep(1200);
await openPalette(page1);
await page1.getByPlaceholder(/Jump to/).fill("merge all");
const nM = bus.merges.length;
await page1.locator(".cmdp-item", { hasText: "Merge all windows" }).first().click();
await until(async () => bus.merges.length >= nM + 2, 10000, "E: both secondaries to merge");
check(bus.merges.slice(nM).map((m) => m.label).sort().join() === "fw-2,fw-3", `E: fw-2 and fw-3 merged (${bus.merges.slice(nM).map((m) => m.label)})`);
check(bus.merges.slice(nM).every((m) => m.flushed), "E: each was asked for a final slice first");
await until(async () => b.target.isClosed() && e3.target.isClosed(), 5000, "E: both secondary pages to be destroyed");
check(b.target.isClosed() && e3.target.isClosed(), "E: both secondary pages are destroyed");
await until(async () => (await storeState(page1)).workspaces.length === 3, 15000, "E: page 1 to hold all three workspaces");
const eState = await storeState(page1);
check(["acme-api", "acme-web", "newone"].every((n) => eState.workspaces.some((w) => w.name === n)), `E: page 1 holds ${eState.workspaces.map((w) => w.name)}`);
await setActive(page1, 1);
await expectIntact(page1, "page 1", W1, "E");
await setActive(page1, 2);
await expectIntact(page1, "page 1", W2, "E");
check([...bus.windows.keys()].join() === "main", `E: the registry is back to main only (${[...bus.windows.keys()]})`);

// ---- F. flag off at runtime merges; entries are hidden ----------------------------------------
await setActive(page1, 2);
const f = await moveByChord(page1, "main", W2);
check(f.to === "fw-4", `F: acme-web moved to ${f.to}`);
const nF2 = bus.merges.length;
await page1.bringToFront();
await page1.evaluate(async () => { (await import("/src/settingsStore.ts")).saveMultiwindow(false); (await import("/src/windowBoot.ts")).pushMultiwindow(false); });
await until(async () => bus.merges.length > nF2, 10000, "F: turning the flag off to merge fw-4");
await until(async () => f.target.isClosed(), 5000, "F: the secondary to be destroyed");
check(f.target.isClosed(), "F: the secondary is gone");
await until(async () => (await storeState(page1)).workspaces.some((w) => w.id === 2), 15000, "F: acme-web back in page 1");
await expectIntact(page1, "page 1", W2, "F");
await openPalette(page1);
await page1.getByPlaceholder(/Jump to/).fill("merge all windows");
await sleep(300);
check((await page1.locator(".cmdp-item", { hasText: "Merge all windows" }).count()) === 0, "F: with the flag off the palette has no Merge all windows");
await page1.getByPlaceholder(/Jump to/).fill("move workspace to");
await sleep(300);
check((await page1.locator(".cmdp-item", { hasText: /Move workspace to (new )?window/ }).count()) === 0, "F: nor the move entries");
await closePalette(page1);

check(await page1.getByText("Something broke in the cockpit UI").count() === 0, "no ErrorBoundary crash screen");
check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors.slice(0, 3).join(" | ") : ""}`);

bus.stop();
await browser.close();
if (failures.length) { console.error(`MULTIWINDOW-S9 FAIL: ${failures.length} check(s)`); process.exit(1); }
console.log("MULTIWINDOW-S9 PASS");
