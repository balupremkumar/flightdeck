import "./w3-prefix.mjs";
// W3 (Balu away): scripted workspace drag-out / drag-back on the Canary (docs/plans/drag-windows-d3.md section 6,
// checklist "0.6.1 drag-out windows > Scripted"). The JS half is the real rail pointer handler fed synthetic pointer
// events; the OS half is drag_debug_script (Canary only), which feeds scripted cursor samples through the same Rust
// state machine, so ghost, hover, drop, transfer and placement all run without the user's mouse. pwsh panes only.
// A drop may raise the window it opens or targets (by design), so the foreground abort is off and samples are evidence.
import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, health, sleep, shotPath, teardown, stableSnapshot, jsClick, here, SCRATCH } from "./w1a-lib.mjs";

const win = (mode, extra = []) => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "window.ps1"), "-ProcessId", String(d.canaryPid()), "-Mode", mode, ...extra], { encoding: "utf8" }).trim();
const listWins = () => JSON.parse(win("list") || "[]");
const DESK = [3800, 300];            // empty desktop on DISPLAY3 (x 2560..5120)
const MAIN_AT = [-20000, 0], W2_AT = [-17500, 0];

const label = (p) => p.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null);
const rect = (p) => p.evaluate(() => ({ x: screenX, y: screenY, w: outerWidth, h: outerHeight }));
const tiles = (p) => p.evaluate(() => [...new Set([...document.querySelectorAll("[data-workspace-id]")].map((e) => Number(e.dataset.workspaceId)))]);
const paneCount = (p) => p.evaluate(() => document.querySelectorAll(".pane").length);
const hasLauncher = (p) => p.evaluate(() => !!document.querySelector(".launcher"));
const hint = (p) => p.evaluate(() => !!document.querySelector(".drag-drop-hint"));
const shim = (p) => p.evaluate(() => {
  // Synthetic pointer ids are not active pointers, so capture calls throw; the harness swallows that, nothing else.
  for (const k of ["setPointerCapture", "releasePointerCapture"]) {
    const o = Element.prototype[k];
    if (o.__fd) continue;
    const f = function (id) { try { return o.call(this, id); } catch { /* synthetic pointer */ } };
    f.__fd = true; Element.prototype[k] = f;
  }
});

/** All app pages by window label (ghost included under "drag-ghost"). */
async function pages(ctx) {
  const out = {};
  for (const p of ctx.pages()) {
    if (/devtools/.test(p.url())) continue;
    try { const l = /ghost/.test(p.url()) ? "drag-ghost" : await label(p); if (l) out[l] = p; } catch { /* closing */ }
  }
  return out;
}
// The ghost is a hidden-then-shown top-level window titled "Flightdeck drag" (dragghost.rs build()).
const GHOST_TITLE = "Flightdeck drag";
const ghostAlive = async (ctx) => !!(await pages(ctx))["drag-ghost"] || listWins().some((w) => w.title === GHOST_TITLE);
const ghostShown = () => listWins().some((w) => w.title === GHOST_TITLE && w.visible);
/** HWND of the app window whose page reports this screen rect (GetWindowRect includes the invisible resize border). */
const hwndAt = (rc) => listWins().find((w) => w.title !== GHOST_TITLE && w.w > 1000 && Math.abs(w.x - rc.x) < 24 && Math.abs(w.y - rc.y) < 48)?.hwnd;

/** Drive one drag: script the OS cursor for the source window, then press + move the tile out with synthetic pointer events. */
async function drag(ctx, src, wsId, points, { release = true, watchGhost = false } = {}) {
  await shim(src);
  await d.invoke(src, "drag_debug_script", { points, release });
  const ok = await src.evaluate((id) => {
    const el = document.querySelector(`[data-workspace-id="${id}"]`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 41, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: r.x + 20, clientY: r.y + 10 }));
    el.dispatchEvent(new PointerEvent("pointermove", { ...base, button: -1, clientX: r.x + 40, clientY: r.y + 10 }));
    el.dispatchEvent(new PointerEvent("pointermove", { ...base, button: -1, clientX: innerWidth + 60, clientY: r.y + 10 }));
    return true;
  }, wsId);
  let ghostSeen = false;
  const t0 = Date.now(), span = points.length * 16 + 600;
  while (Date.now() - t0 < span) { if (watchGhost && !ghostSeen) ghostSeen = ghostShown(); await sleep(60); }
  await sleep(2500);
  // The source may have closed (its only workspace left it): diagnostics are best effort.
  const diag = src.isClosed() ? { sourceClosed: true } : await src.evaluate((id) => ({
    multiwindow: localStorage.getItem("flightdeck-multiwindow"), windowDrag: localStorage.getItem("flightdeck-window-drag"),
    draggable: document.querySelector(`[data-workspace-id="${id}"]`)?.getAttribute("draggable"),
    toasts: [...document.querySelectorAll(".toast, [role=status], [role=alert]")].map((t) => t.textContent.trim()).filter(Boolean).slice(-4),
  }), wsId).catch(() => ({ sourceClosed: true }));
  return { tileFound: ok, ghostSeen, diag };
}
const repeat = (pt, n) => Array.from({ length: n }, () => pt);
const inside = (r) => [r.x + Math.round(r.w / 2), r.y + 300];

/** Start from an empty Canary session: a saved session with secondaries brings them back at launch even when Reopen is
 *  declined (bug found 2026-10-06, fix on qol/fix-restore-cancel), which would scramble every window rect below.
 *  Canary test profile only; the file is moved to the scratch folder, never deleted. */
function clearCanarySession() {
  const f = path.join(process.env.APPDATA, "ai.flightdeck.canary", "session.json");
  if (!existsSync(f)) return null;
  const to = path.join(SCRATCH, `canary-session-${Date.now()}.json`);
  renameSync(f, to);
  return to;
}

main("drag", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  r.evidence.canarySessionMovedTo = clearCanarySession();
  try {
    // Drag flags at their shipped defaults (absent = on); rail sort manual so reorder and HTML5 drag are not suppressed.
    const c = await boot({ width: 2000, height: 1000, beforeSettings: async (p) => {
      r.evidence.profileFlags = await p.evaluate(() => ({ mw: localStorage.getItem("flightdeck-multiwindow"), drag: localStorage.getItem("flightdeck-window-drag"), sort: localStorage.getItem("flightdeck-ws-sort") }));
      await p.evaluate(() => { localStorage.removeItem("flightdeck-multiwindow"); localStorage.removeItem("flightdeck-window-drag"); localStorage.setItem("flightdeck-ws-sort", "0"); });
      await p.reload({ waitUntil: "load" }); await d.wrapSpawns(p);
    } });
    const { ctx, page: mainPage } = c;
    const errors = [];
    const watch = (p) => p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    watch(mainPage);
    r.evidence.monitors = "3 x 2560x1440 at x -2560, 0, 2560 (same DPI on this machine, so the 150% placement check cannot run here)";

    step("two workspaces in main: A (2 pwsh), B (1 pwsh)");
    await launchWorkspace(mainPage, { vendors: ["pwsh", "pwsh"] });
    await waitModels(mainPage, 2);
    await jsClick(mainPage.locator('button.lp-ic.add, button.lp-add').first());
    await launchWorkspace(mainPage, { vendors: ["pwsh"] });
    const models = await waitModels(mainPage, 3);
    await sleep(2500);
    const map = await mapPwsh(mainPage, models);
    const ptys0 = (await health(mainPage)).map((p) => p.paneId).sort();
    const [A, B] = await tiles(mainPage);
    r.evidence.start = { tiles: [A, B], ptys: ptys0, map };
    r.check("setup: main has two workspaces and three live ptys", A && B && ptys0.length === 3, r.evidence.start);
    const mainRect = await rect(mainPage);
    const ptysSame = async (p) => JSON.stringify((await health(p)).map((x) => x.paneId).sort()) === JSON.stringify(ptys0);
    const markers = async (p) => { const out = {}; for (const m of models) out[m] = (await d.tail(p, m, 65536)).join(" ").includes(`FDMAP1N${map[m]}X`); return out; };

    step("S1: tear A to empty desktop");
    const s1 = await drag(ctx, mainPage, A, [inside(mainRect), [mainRect.x + mainRect.w + 12, 300], ...repeat(DESK, 60)], { watchGhost: true });
    let pg = await pages(ctx);
    const w2Label = Object.keys(pg).find((l) => l !== "main" && l !== "drag-ghost");
    const w2 = w2Label ? pg[w2Label] : null;
    if (w2) watch(w2);
    const w2Rect = w2 ? await rect(w2) : null;
    r.evidence.s1 = { ...s1, labels: Object.keys(pg), w2Label, w2Rect, mainTiles: await tiles(mainPage), w2Tiles: w2 ? await tiles(w2) : null, wins: listWins() };
    r.shot(await d.shotWindow(mainPage, shotPath("drag-s1-main")));
    if (w2) r.shot(await d.shotWindow(w2, shotPath("drag-s1-new-window")));
    r.check("S1: the ghost appeared during the tear", s1.ghostSeen, s1);
    r.check("S1: a new window holds A, main keeps only B", !!w2 && JSON.stringify(r.evidence.s1.w2Tiles) === JSON.stringify([A]) && JSON.stringify(r.evidence.s1.mainTiles) === JSON.stringify([B]), r.evidence.s1);
    // place_at: top-left = cursor minus the grab offset (where the drag started inside the source), clamped to the work area.
    r.check("S1: new window opened on the drop monitor, inside its work area (DISPLAY3, title bar on screen)", !!w2Rect && w2Rect.x >= 2550 && w2Rect.x + w2Rect.w <= 5130 && w2Rect.y >= 0 && w2Rect.y + w2Rect.h <= 1400, { w2Rect, drop: DESK, grabOffsetX: 1000 });
    r.check("S1: agents not restarted (same pty ids, history intact) and the new window shows both panes", (await ptysSame(mainPage)) && Object.values(await markers(mainPage)).every(Boolean) && (w2 ? await paneCount(w2) : 0) === 2, { panes: w2 ? await paneCount(w2) : null, markers: await markers(mainPage) });
    r.check("S1: ghost gone after the drop", !(await ghostAlive(ctx)));
    if (!w2) throw new Error("no second window; cannot continue");

    // Park W2 off-screen beside main, NOACTIVATE.
    const w2Hwnd = hwndAt(w2Rect);
    r.evidence.park = win("movehwnd", ["-Hwnd", String(w2Hwnd), "-X", String(W2_AT[0]), "-Y", String(W2_AT[1]), "-Width", "1600", "-Height", "1000"]);
    await sleep(800);
    const w2Park = await rect(w2);

    step("S2: drag B (main's only workspace) onto W2");
    await drag(ctx, mainPage, B, [inside(mainRect), [mainRect.x + mainRect.w + 12, 300], ...repeat(inside(w2Park), 30)]);
    r.evidence.s2 = { mainTiles: await tiles(mainPage), w2Tiles: await tiles(w2), launcher: await hasLauncher(mainPage), labels: Object.keys(await pages(ctx)) };
    r.shot(await d.shotWindow(w2, shotPath("drag-s2-w2")));
    r.shot(await d.shotWindow(mainPage, shotPath("drag-s2-main-launcher")));
    r.check("S2: dropping onto another window moves B in, appended (A then B)", JSON.stringify(r.evidence.s2.w2Tiles) === JSON.stringify([A, B]), r.evidence.s2);
    r.check("S2: main, now empty, shows the launcher", r.evidence.s2.mainTiles.length === 0 && r.evidence.s2.launcher, r.evidence.s2);
    r.check("S2: agents not restarted, W2 shows the active workspace", (await ptysSame(w2)) && Object.values(await markers(w2)).every(Boolean));

    step("S3a: tear A out of W2 and release back over W2 (cancel)");
    await drag(ctx, w2, A, [inside(w2Park), [w2Park.x + w2Park.w + 12, 300], ...repeat(DESK, 10), ...repeat(inside(w2Park), 20)], { watchGhost: true });
    r.evidence.s3a = { w2Tiles: await tiles(w2), mainTiles: await tiles(mainPage), labels: Object.keys(await pages(ctx)), hints: [await hint(w2), await hint(mainPage)] };
    r.check("S3a: release over the source moves nothing", JSON.stringify(r.evidence.s3a.w2Tiles) === JSON.stringify([A, B]) && r.evidence.s3a.mainTiles.length === 0, r.evidence.s3a);
    r.check("S3a: ghost gone, no stuck drop outline in either window", !(await ghostAlive(ctx)) && !r.evidence.s3a.hints.some(Boolean), r.evidence.s3a);

    step("S3b: tear A out to the desktop, hold, Escape");
    const esc = drag(ctx, w2, A, [inside(w2Park), [w2Park.x + w2Park.w + 12, 300], ...repeat(DESK, 10)], { release: false });
    await sleep(900);
    const ghostDuring = ghostShown();
    await w2.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await esc;
    r.evidence.s3b = { ghostDuring, w2Tiles: await tiles(w2), labels: Object.keys(await pages(ctx)), hints: [await hint(w2), await hint(mainPage)] };
    r.check("S3b: Escape cancels: nothing moves, no new window", JSON.stringify(r.evidence.s3b.w2Tiles) === JSON.stringify([A, B]) && r.evidence.s3b.labels.filter((l) => l !== "drag-ghost").length === 2, r.evidence.s3b);
    r.check("S3b: ghost shown while held, gone after Escape, no stuck outline", ghostDuring && !(await ghostAlive(ctx)) && !r.evidence.s3b.hints.some(Boolean), r.evidence.s3b);

    step("S4a: B from W2 back into main");
    await drag(ctx, w2, B, [inside(w2Park), [w2Park.x - 12, 300], ...repeat(inside(mainRect), 30)]);
    r.evidence.s4a = { mainTiles: await tiles(mainPage), w2Tiles: await tiles(w2) };
    r.check("S4a: drag back to main merges B into main", JSON.stringify(r.evidence.s4a.mainTiles) === JSON.stringify([B]) && JSON.stringify(r.evidence.s4a.w2Tiles) === JSON.stringify([A]), r.evidence.s4a);

    step("S4b: W2's only workspace to a new spot moves the window");
    const winsBefore = listWins().length;
    await drag(ctx, w2, A, [inside(w2Park), [w2Park.x + w2Park.w + 12, 300], ...repeat(DESK, 30)]);
    pg = await pages(ctx);
    const w2Moved = pg[w2Label] ? await rect(pg[w2Label]) : null;
    r.evidence.s4b = { labels: Object.keys(pg), w2Moved, winsBefore, winsAfter: listWins().length, w2Tiles: pg[w2Label] ? await tiles(pg[w2Label]) : null };
    r.check("S4b: same window (same label) moved to the drop monitor, not recreated", !!w2Moved && w2Moved.x >= 2560 && JSON.stringify(r.evidence.s4b.w2Tiles) === JSON.stringify([A]) && r.evidence.s4b.labels.filter((l) => l !== "drag-ghost").length === 2, r.evidence.s4b);
    if (w2Moved) {
      const h = hwndAt(w2Moved);
      win("movehwnd", ["-Hwnd", String(h), "-X", String(W2_AT[0]), "-Y", String(W2_AT[1]), "-Width", "1600", "-Height", "1000"]);
      await sleep(800);
    }

    step("S4c: W2's only workspace into main: W2 closes");
    const w2Now = await rect(w2);
    await drag(ctx, w2, A, [inside(w2Now), [w2Now.x - 12, 300], ...repeat(inside(mainRect), 30)]);
    await sleep(1500);
    pg = await pages(ctx);
    r.evidence.s4c = { labels: Object.keys(pg), mainTiles: await tiles(mainPage), wins: listWins().map((w) => w.title) };
    r.check("S4c: A moved into main and the empty secondary closed", JSON.stringify([...r.evidence.s4c.mainTiles].sort()) === JSON.stringify([A, B].sort()) && !pg[w2Label], r.evidence.s4c);
    r.check("S4c: after all moves, same three ptys and history intact", (await ptysSame(mainPage)) && Object.values(await markers(mainPage)).every(Boolean));

    step("S5: sub-flag off: HTML5 tile drag, no drag_arm");
    await mainPage.evaluate(() => { localStorage.setItem("flightdeck-window-drag", "0"); window.dispatchEvent(new Event("flightdeck-window-drag-changed")); });
    await sleep(500);
    const dr = await mainPage.evaluate((id) => document.querySelector(`[data-workspace-id="${id}"]`)?.getAttribute("draggable"), A);
    const off = await drag(ctx, mainPage, A, [inside(mainRect), [mainRect.x + mainRect.w + 12, 300], ...repeat(DESK, 20)], { watchGhost: true });
    r.evidence.s5 = { draggable: dr, ghostSeen: off.ghostSeen, labels: Object.keys(await pages(ctx)), mainTiles: await tiles(mainPage) };
    r.check("S5: flag off: tile uses HTML5 draggable, pointer drag never arms (no ghost, nothing moves)", dr === "true" && !off.ghostSeen && r.evidence.s5.labels.filter((l) => l !== "drag-ghost").length === 1, r.evidence.s5);
    await mainPage.evaluate(() => { localStorage.removeItem("flightdeck-window-drag"); window.dispatchEvent(new Event("flightdeck-window-drag-changed")); });

    r.check("no pageerror in any window", errors.length === 0, errors.slice(0, 5));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
}, { abortOnForeground: false });
