// Phase 4 S10: attention across windows (bell footer, global badge, summon target).
//
// Same two-"window" harness as multiwindow-s9.mjs (lib/multiwindow.mjs ports the Rust
// registry and, for S10, attention_report: per-window reports summed into bus.badge, the
// count Rust puts on every window's taskbar overlay).
//   A. A question in page 2 raises the global badge to 1 and adds "1 needs you in Window 2"
//      to page 1's bell as a footer row, with page 1's own rows unchanged ("nothing needs you").
//   B. Identical reports are not re-sent while nothing changes.
//   C. Clicking the footer row calls window_focus_pane(fw-1, ws, pane) and page 2 selects it.
//   D. The question clears: badge back to 0 and the footer row goes.
//   E. A summon payload picks the pane in page 2; a null payload does nothing.
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1442 node multiwindow-attention.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MultiWindowBus } from "./lib/multiwindow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const boot = `localStorage.setItem("flightdeck-startup","reopen");localStorage.setItem("flightdeck-multiwindow","1");`;

const URL = process.env.FD_URL ?? "http://localhost:1442";
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

const storeState = (page) => page.evaluate(async () => {
  const { useApp } = await import("/src/store.ts");
  const s = useApp.getState();
  return { activeId: s.activeId, workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, focused: w.focused, panes: w.panes.map((p) => p.id) })) };
});
const hasPty = (page, ids) => page.evaluate(async (ids) => {
  const ps = await import("/src/paneSessions.ts");
  return ids.every((i) => !!ps.get(i)?.ptyId);
}, ids);

// Both seeded workspaces live: ws 1 (acme-api, panes 1-4) and ws 2 (acme-web, panes 5-6).
await page1.locator('text="acme-api" >> visible=true').first().click();
await until(() => hasPty(page1, [1, 2, 3, 4]), 15000, "acme-api panes to start");
await page1.locator('text="acme-web" >> visible=true').first().click();
await until(() => hasPty(page1, [5, 6]), 15000, "acme-web panes to start");
await page1.waitForTimeout(1500);

// Move acme-web (active) to its own window, then come back to acme-api in page 1.
await page1.bringToFront();
await page1.keyboard.press("Control+Shift+N");
const to = await until(async () => bus.transfers[0]?.to, 10000, "ws_transfer");
const page2 = await until(async () => bus.pages.get(to), 10000, `${to}'s page`);
await until(async () => (await storeState(page2)).workspaces.length === 1, 15000, `${to} to adopt acme-web`);
await until(() => hasPty(page2, [5, 6]), 15000, `${to} panes attached`);
await page1.evaluate(async () => (await import("/src/store.ts")).useApp.getState().switchWorkspace(1));
await page2.waitForTimeout(1500);
check(to === "fw-1", `setup: acme-web lives in ${to}`);
check(bus.badge === 0, `setup: nothing needs anyone, badge ${bus.badge}`);

// ---- A. a question in page 2 ------------------------------------------------------------------
const p5 = bus.byModel.get(5);
clearInterval(p5.timer); // pane 5 goes quiet; the last line is a question
bus.push(p5, "Which package manager should I use?\r\n");
await until(async () => bus.reports.get("fw-1")?.count === 1, 15000, "fw-1's attention_report with count 1");
const rep = bus.reports.get("fw-1");
check(rep?.count === 1 && rep.top?.wsId === 2 && rep.top?.paneId === 5 && rep.top?.kindRank === 2, `A: fw-1 reports its question as the top item (${JSON.stringify(rep)})`);
check(bus.badge === 1, `A: the global badge is 1 (${bus.badge})`);

await page1.bringToFront();
await page1.locator(".ntf-bell").click();
const footer = page1.locator(".ntf-item", { hasText: "1 needs you in Window 2" });
await until(async () => (await footer.count()) === 1, 8000, "A: the footer row in page 1's bell");
check((await footer.count()) === 1, "A: page 1's bell lists '1 needs you in Window 2'");
check((await page1.getByText("Nothing needs you right now").count()) === 1, "A: page 1's own rows are unchanged (nothing needs you here)");
check((await page1.locator(".ntf-badge").count()) === 0, "A: the bell's own badge still counts local panes only");

// ---- B. identical reports are dropped ---------------------------------------------------------
const nBadges = bus.badges.length;
await sleep(3500);
check(bus.badges.length === nBadges, `B: no re-report while nothing changed (${bus.badges.length - nBadges} extra)`);

// ---- C. clicking the row routes window_focus_pane to page 2 -----------------------------------
const nF = bus.focuses.length;
await footer.click();
await until(async () => bus.focuses.length > nF, 5000, "C: window_focus_pane");
const f = bus.focuses[nF];
check(f?.from === "main" && f?.label === "fw-1" && f?.wsId === 2 && f?.paneId === 5, `C: focus routed to fw-1 / ws 2 / pane 5 (${JSON.stringify(f)})`);
await until(async () => (await storeState(page2)).workspaces.find((w) => w.id === 2)?.focused === 5, 5000, "C: page 2 to focus pane 5");
check((await storeState(page2)).workspaces.find((w) => w.id === 2)?.focused === 5, "C: page 2 has pane 5 focused");
check((await page1.locator(".ntf-menu").count()) === 0, "C: the bell closed after the jump");

// ---- D. the question clears -------------------------------------------------------------------
p5.timer = setInterval(() => bus.push(p5, `TICK-5-${++p5.n}\r\n`), 120);
await until(async () => bus.reports.get("fw-1")?.count === 0, 15000, "D: fw-1 to report 0");
check(bus.badge === 0, `D: the badge clears (${bus.badge})`);
await page1.bringToFront();
await page1.locator(".ntf-bell").click();
await sleep(3200);
check((await page1.locator(".ntf-item", { hasText: "need you in Window 2" }).count()) === 0 && (await page1.locator(".ntf-item", { hasText: "needs you in Window 2" }).count()) === 0, "D: the footer row is gone");
await page1.keyboard.press("Escape");

// ---- E. summon payload picks the pane ---------------------------------------------------------
await page2.evaluate(async () => (await import("/src/store.ts")).useApp.getState().focusPane(2, 5));
await bus.emitTo("fw-1", "app://summon", { wsId: 2, paneId: 6 });
await until(async () => (await storeState(page2)).workspaces.find((w) => w.id === 2)?.focused === 6, 5000, "E: page 2 to focus pane 6 from the summon payload");
check((await storeState(page2)).workspaces.find((w) => w.id === 2)?.focused === 6, "E: summon lands on the payload's pane");
await bus.emitTo("fw-1", "app://summon", { wsId: null, paneId: null });
await sleep(400);
check((await storeState(page2)).workspaces.find((w) => w.id === 2)?.focused === 6, "E: a null payload leaves focus alone");

check(await page1.getByText("Something broke in the cockpit UI").count() === 0, "no ErrorBoundary crash screen");
check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors.slice(0, 3).join(" | ") : ""}`);

bus.stop();
await browser.close();
if (failures.length) { console.error(`MULTIWINDOW-ATTENTION FAIL: ${failures.length} check(s)`); process.exit(1); }
console.log("MULTIWINDOW-ATTENTION PASS");
