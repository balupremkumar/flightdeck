// Design-pass QA rig (agent C: board + icons + left-panel workspace tiles).
// Drives the real frontend against the mock Tauri bridge, seeds state by
// dynamic-importing the live store modules (same singleton the mounted app
// already uses, since Vite dev-serves each module URL once and caches it),
// and screenshots the surfaces under test. Read-only against the app code —
// this file is scratch tooling, not part of the shipped product.
//
// Run from demo/:  node design-pass-c.mjs [outDir] [stage]
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? "../e2e-shots";
const STAGE = process.argv[3] ?? "after"; // "before" | "after" — just a filename tag
const URL = "http://localhost:1420";

const shot = async (page, name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(__dirname, OUT, `${STAGE}-${name}.png`) });
  console.log("shot:", `${STAGE}-${name}`);
};

const setZoom = async (page, z) => {
  await page.evaluate((zz) => { document.documentElement.style.zoom = String(zz); }, z);
  await page.waitForTimeout(120);
};

const setTheme = async (page, id) => {
  await page.evaluate((t) => localStorage.setItem("flightdeck-theme-id", t), id);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript({ path: path.join(__dirname, "mock-tauri.js") });

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

// ---- Seed via the live store modules (same singleton the app rendered) ----
await page.evaluate(async () => {
  const store = await import("/src/store.ts");
  const board = await import("/src/board/boardStore.ts");
  window.__store = store;
  window.__board = board;

  const { useApp } = store;

  // 1) "ai" — short-named, exactly like the bug report: several panes so the
  //    meta row (mini grid + state chips + token count + timestamp) is
  //    guaranteed to outgrow one line and wrap.
  useApp.getState().createWorkspace("C:\\dev\\acme-api", [
    { vendor: "claude", cwd: "C:\\dev\\acme-api" },
    { vendor: "pwsh", cwd: "C:\\dev\\acme-api" },
    { vendor: "agy", cwd: "C:\\dev\\acme-api" },
    { vendor: "pwsh", cwd: "C:\\dev\\acme-api" },
  ]);
  const aiWs = useApp.getState().workspaces[0];
  useApp.getState().renameWorkspace(aiWs.id, "ai");
  window.__aiWsId = aiWs.id;

  // 2) An errored workspace, mid-length name.
  useApp.getState().createWorkspace("C:\\dev\\acme-web", [
    { vendor: "claude", cwd: "C:\\dev\\acme-web" },
    { vendor: "pwsh", cwd: "C:\\dev\\acme-web" },
  ]);
  window.__webWsId = useApp.getState().workspaces[1].id;

  // 3) Long name + many panes, to stress-test wrapping at every zoom.
  useApp.getState().createWorkspace("C:\\dev\\scratch", [
    { vendor: "pwsh", cwd: "C:\\dev\\scratch" },
    { vendor: "agy", cwd: "C:\\dev\\scratch" },
    { vendor: "pwsh", cwd: "C:\\dev\\scratch" },
  ]);
  const longWs = useApp.getState().workspaces[2];
  useApp.getState().renameWorkspace(longWs.id, "acme-platform-infrastructure-monorepo");
  window.__longWsId = longWs.id;

  useApp.getState().switchWorkspace(aiWs.id);
});

// Let the mock's own spawn->running flip land first, or our forced overrides
// below get stomped by that later event.
await page.waitForTimeout(800);

await page.evaluate(() => {
  const { useApp } = window.__store;
  const byId = (id) => useApp.getState().workspaces.find((w) => w.id === id);

  // Workspace 1 ("ai"): all four state categories at once, the documented
  // worst case for the meta row (see the "~110px ... four simultaneous state
  // counts plus a timestamp genuinely don't fit on one line" comment above
  // .lp-meta in App.css) — this is exactly the wrap condition the bug needs.
  const ai = byId(window.__aiWsId);
  useApp.getState().setPaneState(ai.panes[0].id, "waiting");
  useApp.getState().setPaneState(ai.panes[1].id, "running");
  useApp.getState().setPaneState(ai.panes[2].id, "starting");
  useApp.getState().setPaneState(ai.panes[3].id, "error");

  // Workspace 2: an error pane.
  const web = byId(window.__webWsId);
  useApp.getState().setPaneState(web.panes[1].id, "error");

  // Workspace 3 (long name): error + running + starting, all at once.
  const longWs = byId(window.__longWsId);
  useApp.getState().setPaneState(longWs.panes[2].id, "error");
  useApp.getState().setPaneState(longWs.panes[0].id, "running");
});

await page.waitForTimeout(1200);

// Populate "last active" (the "Xs ago" text) for real, the same way a user
// would — by opening each tile — instead of faking the localStorage key,
// since the real click path is what the original bug report exercised.
for (const name of ["ai", "acme-web", "acme-platform"]) {
  const row = page.locator(".lp-ws", { hasText: name }).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(150); }
}
await page.evaluate(() => { window.__store.useApp.getState().switchWorkspace(window.__aiWsId); });
await page.waitForTimeout(300);

console.log("workspaces:", await page.evaluate(() => window.__store.useApp.getState().workspaces.map((w) => ({ name: w.name, states: w.panes.map((p) => p.state) }))));

// ============================================================
// A) Left panel — expanded, mixed states, dark, zoom 1 / 1.15 / 1.25
// ============================================================
for (const z of [1, 1.15, 1.25]) {
  await setZoom(page, z);
  await shot(page, `leftpanel-dark-z${z}`);
}
await setZoom(page, 1);

// Tight-viewport crop on the "ai" tile specifically (top of list) to inspect
// the dot/timestamp relationship close-up — this is the exact reported tile.
await page.locator(".lp-ws", { hasText: "ai" }).first().screenshot({ path: path.join(__dirname, OUT, `${STAGE}-tile-closeup-dark.png`) }).catch(() => {});

// ---- Collapsed rail ----
const toggle = page.locator(".tb-toggle").first();
if (await toggle.count()) { await toggle.click(); await page.waitForTimeout(200); }
await shot(page, "rail-dark-z1");
await setZoom(page, 1.25);
await shot(page, "rail-dark-z125");
await setZoom(page, 1);
if (await toggle.count()) { await toggle.click(); await page.waitForTimeout(200); }

// Link a card to a live pane so the card face's "linked-pane live status"
// chip (chip-live) has something real to render, and add a couple of extra
// labels to one card so the metadata row is under genuine pressure.
await page.evaluate(() => {
  const { useBoardStore } = window.__board;
  const { useApp } = window.__store;
  const ws = useApp.getState().workspaces.find((w) => w.name === "ai");
  const pane = ws?.panes?.[0];
  const cards = useBoardStore.getState().cards;
  const target = cards.todo[1]; // "Click a card to open its detail view" (has a checklist)
  if (pane && target) {
    useBoardStore.getState().linkPane(target.id, ws.id, pane.id);
    useBoardStore.getState().updateCard(target.id, { agent: "claude" });
    useBoardStore.getState().addLabel(target.id, { id: "lbl-x1", name: "backend", colorVar: "--aqua" });
    useBoardStore.getState().addLabel(target.id, { id: "lbl-x2", name: "urgent", colorVar: "--red" });
  }
});
await page.waitForTimeout(600);

// ============================================================
// B) Board — populated, dark
// ============================================================
const boardNav = page.locator(".lp-app", { hasText: "Board" });
if (await boardNav.count()) { await boardNav.first().click(); await page.waitForTimeout(300); }
await shot(page, "board-populated-dark-z1");
await setZoom(page, 1.25);
await shot(page, "board-populated-dark-z125");
await setZoom(page, 1);

// Card detail modal (first card)
const firstCard = page.locator(".card .card-title").first();
if (await firstCard.count()) { await firstCard.click(); await page.waitForTimeout(250); await shot(page, "board-card-detail-dark"); await page.keyboard.press("Escape"); }

// Empty board state
await page.evaluate(async () => {
  const { useBoardStore } = window.__board;
  useBoardStore.getState().setCards({ todo: [], inprogress: [], review: [], complete: [] });
});
await page.waitForTimeout(200);
await shot(page, "board-empty-dark");

// Restore seed cards for the light-mode pass
await page.evaluate(async () => { window.__board.useBoardStore.getState().reset(); });
await page.waitForTimeout(200);

// ============================================================
// C) Light mode — board + left panel
// ============================================================
await setTheme(page, "light");
// re-seed after reload (store resets on full reload)
await page.evaluate(async () => {
  const store = await import("/src/store.ts");
  const board = await import("/src/board/boardStore.ts");
  window.__store = store; window.__board = board;
  const { useApp } = store;
  useApp.getState().createWorkspace("C:\\dev\\acme-api", [
    { vendor: "claude", cwd: "C:\\dev\\acme-api" },
    { vendor: "pwsh", cwd: "C:\\dev\\acme-api" },
  ]);
  useApp.getState().renameWorkspace(useApp.getState().workspaces[0].id, "ai");
  useApp.getState().createWorkspace("C:\\dev\\acme-web", [
    { vendor: "claude", cwd: "C:\\dev\\acme-web" },
    { vendor: "pwsh", cwd: "C:\\dev\\acme-web" },
  ]);
  useApp.getState().switchWorkspace(useApp.getState().workspaces[0].id);
});
await page.waitForTimeout(900);
await page.evaluate(() => {
  const { useApp } = window.__store;
  const ai = useApp.getState().workspaces[0];
  useApp.getState().setPaneState(ai.panes[0].id, "waiting");
  const web = useApp.getState().workspaces[1];
  useApp.getState().setPaneState(web.panes[1].id, "error");
});
await page.waitForTimeout(600);
for (const name of ["ai", "acme-web"]) {
  const row = page.locator(".lp-ws", { hasText: name }).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(150); }
}
await shot(page, "leftpanel-light-z1");
await setZoom(page, 1.25);
await shot(page, "leftpanel-light-z125");
await setZoom(page, 1);

const boardNav2 = page.locator(".lp-app", { hasText: "Board" });
if (await boardNav2.count()) { await boardNav2.first().click(); await page.waitForTimeout(300); }
await shot(page, "board-populated-light-z1");

// Collapsed rail, light.
const toggle2 = page.locator(".tb-toggle").first();
if (await toggle2.count()) { await toggle2.click(); await page.waitForTimeout(200); }
await shot(page, "rail-light-z1");
await setZoom(page, 1.25);
await shot(page, "rail-light-z125");
await setZoom(page, 1);
if (await toggle2.count()) { await toggle2.click(); await page.waitForTimeout(200); }

await setTheme(page, "dark");

await browser.close();
console.log("done ->", OUT);
