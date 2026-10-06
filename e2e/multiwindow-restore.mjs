// Phase 4 D2: restore secondary windows on launch.
//
// Same harness as multiwindow-close.mjs (lib/multiwindow.mjs ports the Rust registry,
// slices and rings; the real store and Terminal run in every page). The bus holds a v2
// session document on "disk" with main plus fw-1.
//   A. Flag on: main boots and hydrates only its own workspace; restore_windows then
//      recreates fw-1 under its persisted label; that page boots with its workspace and
//      its panes print output. Nothing is focused (no bringToFront), and the next label
//      minted is fw-2.
//   B. Flag off with the same v2 doc: no second page, every workspace lives in main.
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1443 node multiwindow-restore.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MultiWindowBus } from "./lib/multiwindow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");

const URL = process.env.FD_URL ?? "http://localhost:1443";
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

const FW_WS = (1 << 24) + 1;
const FW_PANE = (1 << 24) + 1;
const doc = {
  version: 2,
  savedAt: Date.now(),
  activeWorkspaceId: 1,
  workspaces: [
    { id: 1, name: "acme-api", root: "C:\\dev\\acme-api", setupCmd: "npm ci", panes: [{ id: 1, vendor: "claude", cwd: "C:\\dev\\acme-api" }] },
    { id: FW_WS, name: "far-away", root: "C:\\dev\\scratch", setupCmd: "", panes: [{ id: FW_PANE, vendor: "claude", cwd: "C:\\dev\\scratch" }] },
  ],
  uiPrefs: {},
  windows: [
    { label: "main", workspaceIds: [1], activeWorkspaceId: 1 },
    { label: "fw-1", workspaceIds: [FW_WS], activeWorkspaceId: FW_WS },
  ],
};

const browser = await chromium.launch();
const pageErrors = [];

// RT-H1 fixture: a moved workspace keeps its partition-0 ids (main minted them), so fw-1 holds pane 2.
const MOVED = 2;
const docMoved = {
  ...doc,
  workspaces: [
    { id: 1, name: "acme-api", root: "C:\\dev\\acme-api", setupCmd: "npm ci", panes: [{ id: 1, vendor: "claude", cwd: "C:\\dev\\acme-api" }] },
    { id: MOVED, name: "far-away", root: "C:\\dev\\scratch", setupCmd: "", panes: [{ id: MOVED, vendor: "claude", cwd: "C:\\dev\\scratch" }] },
  ],
  windows: [
    { label: "main", workspaceIds: [1], activeWorkspaceId: 1 },
    { label: "fw-1", workspaceIds: [MOVED], activeWorkspaceId: MOVED },
  ],
};

async function launch(multiwindow, seed = doc, startup = "reopen") {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const bus = new MultiWindowBus(context, URL);
  await bus.install();
  bus.seedDoc(seed);
  const boot = `localStorage.setItem("flightdeck-startup","${startup}");localStorage.setItem("flightdeck-multiwindow","${multiwindow ? 1 : 0}");`;
  await context.addInitScript(`if (/^https?:/.test(location.protocol)) {\n${boot}\n${mock}\n}`);
  context.on("page", (p) => p.on("pageerror", (e) => pageErrors.push(e.message)));
  const main = await context.newPage();
  bus.register("main", main);
  await main.goto(URL, { waitUntil: "networkidle" });
  return { context, bus, main };
}

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

// ---- A. flag on ----
{
  const { context, bus, main } = await launch(true);
  await until(async () => bus.restores.includes("fw-1"), 10000, "restore_windows to create fw-1");
  const fw = bus.pages.get("fw-1");
  check(!!fw, "a page exists for the persisted label fw-1");
  if (fw) {
    await fw.waitForLoadState("networkidle").catch(() => {});
    await until(async () => (await storeState(fw)).workspaces.some((w) => w.id === FW_WS), 10000, "fw-1 to hold its workspace");
    const st = await storeState(fw);
    check(st.workspaces.length === 1 && st.workspaces[0].name === "far-away", `fw-1 holds exactly its workspace (${JSON.stringify(st.workspaces)})`);
    check(!!(await until(async () => /TICK-\d+-\d+/.test((await termText(fw, FW_PANE)) ?? ""), 8000, "fw-1 pane output")), "fw-1 pane prints output");
    check(bus.windows.get("fw-1")?.booted === true, "fw-1 booted through window_boot");
  }
  const m = await storeState(main);
  check(m.workspaces.length === 1 && m.workspaces[0].id === 1, `main hydrated only its own workspace (${JSON.stringify(m.workspaces.map((w) => w.id))})`);
  check(bus.focuses.length === 0, "launch restore focused nothing");
  check(bus.nextOrdinal === 2, `next label allocation skips restored labels (nextOrdinal ${bus.nextOrdinal})`);
  check(bus.restores.length === 1, `exactly one window restored (${bus.restores})`);
  await context.close();
}

// ---- B. flag off ----
{
  const { context, bus, main } = await launch(false);
  await sleep(3500);
  const m = await storeState(main);
  check(m.workspaces.length === 2, `flag off: main holds every workspace (${JSON.stringify(m.workspaces.map((w) => w.id))})`);
  check(bus.restores.length === 0 && context.pages().length === 1, `flag off: no secondary page (${context.pages().length} page(s))`);
  await main.evaluate(async (id) => {
    const { useApp } = await import("/src/store.ts");
    useApp.setState({ activeId: id });
  }, FW_WS);
  check(!!(await until(async () => /TICK-\d+-\d+/.test((await termText(main, FW_PANE)) ?? ""), 8000, "the merged pane's output in main")), "flag off: the merged workspace's pane prints output in main");
  await context.close();
}

// ---- C. RT-H1: main must not mint an id a secondary's moved workspace still holds ----
{
  const { context, bus, main } = await launch(true, docMoved);
  await until(async () => bus.restores.includes("fw-1"), 10000, "restore_windows to create fw-1");
  const fw = bus.pages.get("fw-1");
  if (fw) await fw.waitForLoadState("networkidle").catch(() => {});
  check(!!(await until(async () => fw && /TICK-\d+-\d+/.test((await termText(fw, MOVED)) ?? ""), 8000, "fw-1 pane output")), "fw-1 pane 2 is live");
  await main.evaluate(async () => {
    const { useApp } = await import("/src/store.ts");
    useApp.getState().addPane(1, "claude", "C:\\dev\\acme-api");
  });
  await sleep(1500);
  const m = await storeState(main);
  const ids = m.workspaces.flatMap((w) => w.panes);
  check(ids.length === 2 && !ids.includes(MOVED), `main minted a fresh pane id, not fw-1's (${JSON.stringify(ids)})`);
  check(bus.kills.length === 0, `adding a pane in main killed nothing (${JSON.stringify(bus.kills)})`);
  await context.close();
}

// ---- D. "Reopen last session?" shown, Cancel: no secondary, no spawn for its workspace ----
{
  const { context, bus, main } = await launch(true, doc, "launcher");
  await until(async () => main.getByRole("alertdialog", { name: "Reopen last session?" }).isVisible(), 10000, "the reopen prompt");
  await sleep(1500);
  check(bus.restores.length === 0 && context.pages().length === 1, "prompt open: no secondary is created before the answer");
  await main.getByRole("button", { name: "Cancel" }).click();
  await sleep(3000);
  check(bus.restores.length === 0 && context.pages().length === 1, `Cancel: no secondary page (${context.pages().length} page(s), restores ${bus.restores})`);
  check(bus.discards.includes("fw-1"), `Cancel: Rust discarded fw-1's pending restore (${bus.discards})`);
  check(!bus.windows.has("fw-1") && !(bus.doc.windows ?? []).some((w) => w.label === "fw-1"), "Cancel: fw-1 is gone from the registry and the document");
  check(!bus.spawns.some((s) => s.modelId === FW_PANE), `Cancel: no agent spawned for the secondary's workspace (${JSON.stringify(bus.spawns.map((s) => s.modelId))})`);
  check((await storeState(main)).workspaces.length === 0, "Cancel: nothing reopened in main");
  await context.close();
}

// ---- E. prompt shown, Reopen session: main hydrates, then the secondary is restored ----
{
  const { context, bus, main } = await launch(true, doc, "launcher");
  await until(async () => main.getByRole("alertdialog", { name: "Reopen last session?" }).isVisible(), 10000, "the reopen prompt");
  await sleep(1500);
  check(bus.restores.length === 0, "prompt open: still no secondary");
  await main.getByRole("button", { name: "Reopen session" }).click();
  await until(async () => bus.restores.includes("fw-1"), 10000, "restore_windows to create fw-1 after Reopen");
  const m = await storeState(main);
  check(m.workspaces.length === 1 && m.workspaces[0].id === 1, `Reopen: main hydrated its own workspace (${JSON.stringify(m.workspaces.map((w) => w.id))})`);
  const fw = bus.pages.get("fw-1");
  if (fw) await fw.waitForLoadState("networkidle").catch(() => {});
  check(!!(await until(async () => fw && /TICK-\d+-\d+/.test((await termText(fw, FW_PANE)) ?? ""), 8000, "fw-1 pane output")), "Reopen: fw-1 pane prints output");
  check(bus.discards.length === 0, "Reopen: nothing discarded");
  await context.close();
}

// ---- F. main holds nothing but a secondary does: the prompt still appears, Cancel keeps it closed ----
{
  const docSecondaryOnly = { ...doc, windows: [{ label: "main", workspaceIds: [] }, { label: "fw-1", workspaceIds: [FW_WS], activeWorkspaceId: FW_WS }], workspaces: [doc.workspaces[1]], activeWorkspaceId: FW_WS };
  const { context, bus, main } = await launch(true, docSecondaryOnly, "launcher");
  await until(async () => main.getByRole("alertdialog", { name: "Reopen last session?" }).isVisible(), 10000, "the reopen prompt with an empty main");
  await sleep(1500);
  check(bus.restores.length === 0, "empty main, prompt open: no secondary yet");
  await main.getByRole("button", { name: "Cancel" }).click();
  await sleep(3000);
  check(bus.restores.length === 0 && context.pages().length === 1, "empty main, Cancel: no secondary page");
  check(!bus.spawns.some((s) => s.modelId === FW_PANE), "empty main, Cancel: no agent spawned for the secondary's workspace");
  await context.close();
}

check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ""}`);
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
