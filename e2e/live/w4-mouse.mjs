import "./w3-prefix.mjs";
// W4 (Balu hands off the mouse): the drag checks that need the REAL OS cursor (drag-windows-d3.md section 6). Canary is
// shown on the primary monitor; mouse.ps1 presses, glides and releases with the real cursor. Escape mid-drag is sent
// from page JS (the harness window is NOACTIVATE, so OS keys would not reach it). pwsh panes only.
// Decides whether "Drag workspaces between windows" ships on (section 4). The foreground guard is off: real clicks
// and drops legitimately raise Canary windows.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, health, sleep, shotPath, teardown, stableSnapshot, jsClick, here } from "./w1a-lib.mjs";
import { DESK, pagesByLabel, tiles, clearCanarySession, dragFlags, rect } from "./w3-lib.mjs";

const mouse = (pts, { down = false, up = false, stepMs = 8 } = {}) =>
  execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "mouse.ps1"), "-Points", pts.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(";"), ...(down ? ["-Down"] : []), ...(up ? ["-Up"] : []), "-StepMs", String(stepMs)], { encoding: "utf8" }).trim();
/** Screen point of an element's centre (offset) in a page, from the window's screen rect and its client inset. */
async function screenPt(page, selector, { dx = 0, dy = 0 } = {}) {
  return page.locator(selector).first().evaluate((el, o) => {
    const r = el.getBoundingClientRect();
    const border = (outerWidth - innerWidth) / 2;
    const top = outerHeight - innerHeight - border;
    return [screenX + border + r.left + r.width / 2 + o.dx, screenY + top + r.top + r.height / 2 + o.dy];
  }, { dx, dy });
}
const ghostSeen = () => { try { return JSON.parse(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "window.ps1"), "-ProcessId", String(d.canaryPid()), "-Mode", "list"], { encoding: "utf8" })).some((w) => w.title === "Flightdeck drag" && w.visible); } catch { return false; } };
const order = (p) => p.evaluate(() => [...document.querySelectorAll(".lp [data-workspace-id], [data-workspace-id]")].map((e) => Number(e.dataset.workspaceId)).filter((v, i, a) => a.indexOf(v) === i));

main("mouse", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  r.evidence.canarySessionMovedTo = clearCanarySession();
  try {
    const c = await boot({ width: 2000, height: 1000, beforeSettings: dragFlags });
    const { ctx, page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    step("setup: A (2 pwsh), B (1 pwsh), C (1 pwsh)");
    await launchWorkspace(page, { vendors: ["pwsh", "pwsh"] });
    await waitModels(page, 2);
    for (const _ of [0]) { await jsClick(page.locator("button.lp-ic.add, button.lp-add").first()); await launchWorkspace(page, { vendors: ["pwsh"] }); }
    await waitModels(page, 3);
    await sleep(2500);
    d.setWindow({ width: 1800, height: 1000, x: 300, y: 150 }); // set up off-screen, then onto the primary monitor
    await sleep(1500);
    const ptys0 = (await health(page)).map((p) => p.paneId).sort();
    const [A, B] = await tiles(page);
    const tileSel = (id) => `[data-workspace-id="${id}"]`;

    step("plain click opens the workspace; a sub-4 px wiggle is still a click");
    let p = await screenPt(page, tileSel(A));
    mouse([p, [p[0] + 2, p[1] + 1]], { down: true, up: true });
    await sleep(1200);
    const panesA = await page.evaluate(() => document.querySelectorAll(".pane").length);
    r.check("click with a 2 px wiggle on tile A opens A (2 panes shown)", panesA === 2, { panesA });

    step("rail reorder inside the window: B onto A's slot");
    const before = await order(page);
    const pc = await screenPt(page, tileSel(B)), pa = await screenPt(page, tileSel(A));
    mouse([pc, [pc[0], pc[1] - 10], [pa[0], pa[1] - 4]], { down: true, up: true, stepMs: 12 });
    await sleep(1200);
    const afterOrder = await order(page);
    r.evidence.reorder = { before, after: afterOrder };
    r.check("rail reorder with the real mouse changes the order", JSON.stringify(before) !== JSON.stringify(afterOrder), r.evidence.reorder);

    step("tear A out across the window edge to the desktop");
    const mr = await rect(page);
    p = await screenPt(page, tileSel(A));
    let ghost = false;
    const job = new Promise((res) => setTimeout(() => res(mouse([p, [p[0] + 20, p[1]], [mr.x + mr.w + 40, p[1]], DESK], { down: true, up: true, stepMs: 6 })), 0));
    for (let i = 0; i < 40 && !ghost; i++) { await sleep(150); ghost = ghostSeen(); }
    await job;
    await sleep(3500);
    let pg = await pagesByLabel(ctx);
    const fw = Object.keys(pg).find((l) => l !== "main");
    const fwRect = fw ? await rect(pg[fw]) : null;
    r.evidence.tear = { ghost, labels: Object.keys(pg), fwRect, fwTiles: fw ? await tiles(pg[fw]) : null };
    if (fw) r.shot(await d.shotWindow(pg[fw], shotPath("mouse-tear-new-window")));
    r.check("real drag across the edge opens a new window under the cursor holding A", !!fw && JSON.stringify(r.evidence.tear.fwTiles) === JSON.stringify([A]) && fwRect.x > 2560, r.evidence.tear);
    r.check("ghost followed the real cursor during the tear", ghost, ghost);
    r.check("agents not restarted by the tear", JSON.stringify((await health(page)).map((x) => x.paneId).sort()) === JSON.stringify(ptys0));

    step("Escape mid-drag with the real mouse: nothing moves");
    if (fw) {
      const src = pg[fw];
      const sp = await screenPt(src, tileSel(A));
      const sr = await rect(src);
      mouse([sp, [sp[0] + 20, sp[1]], [sr.x - 60, sp[1]]], { down: true, stepMs: 6 });
      await sleep(700);
      const gDuring = ghostSeen();
      await src.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      await sleep(500);
      mouse([[sr.x - 60, sp[1]], [sr.x - 80, sp[1]]], { up: true });
      await sleep(2500);
      pg = await pagesByLabel(ctx);
      r.evidence.escape = { gDuring, fwTiles: await tiles(pg[fw]), mainTiles: await tiles(page), ghostAfter: ghostSeen() };
      r.check("Escape mid-drag cancels: A stays in its window, ghost gone", JSON.stringify(r.evidence.escape.fwTiles) === JSON.stringify([A]) && !r.evidence.escape.ghostAfter, r.evidence.escape);

      step("drag A back from the new window into main");
      const sp2 = await screenPt(src, tileSel(A));
      const mainBody = [mr.x + mr.w / 2, mr.y + mr.h / 2];
      mouse([sp2, [sp2[0] + 20, sp2[1]], [sr.x - 60, sp2[1]], mainBody], { down: true, up: true, stepMs: 6 });
      await sleep(4000);
      pg = await pagesByLabel(ctx);
      const mt = await tiles(page);
      r.evidence.back = { labels: Object.keys(pg), mainTiles: mt };
      r.shot(await d.shotWindow(page, shotPath("mouse-back-in-main")));
      r.check("drag back into main: A rejoins main and the empty window closes", mt.includes(A) && !pg[fw], r.evidence.back);
    }

    step("pane header HTML5 drag (record only: suspected dead with dragDropEnabled on)");
    await jsClick(page.locator(tileSel(A)));
    await sleep(1200);
    const hdr = async (i) => page.locator(".pane").nth(i).locator(".pname").evaluate((el) => {
      const r = el.getBoundingClientRect(); const border = (outerWidth - innerWidth) / 2; const top = outerHeight - innerHeight - border;
      return [screenX + border + r.left + r.width / 2, screenY + top + r.top + r.height / 2];
    });
    const names0 = await page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => p.getAttribute("data-pane-id") ?? p.querySelector(".pname")?.textContent));
    const h0 = await hdr(0), h1 = await hdr(1);
    mouse([h0, [h0[0] + 15, h0[1]], [h1[0], h1[1] + 40]], { down: true, up: true, stepMs: 12 });
    await sleep(1500);
    const names1 = await page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => p.getAttribute("data-pane-id") ?? p.querySelector(".pname")?.textContent));
    r.evidence.paneHeaderDrag = { before: names0, after: names1, moved: JSON.stringify(names0) !== JSON.stringify(names1) };
    r.check("RECORD: pane-header drag reorders panes (expected dead; informational)", true, r.evidence.paneHeaderDrag);

    r.check("no pageerror", errors.length === 0, errors.slice(0, 3));
    return c;
  } finally {
    try { execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "mouse.ps1"), "-Points", "1280,1300", "-Up"], { encoding: "utf8" }); } catch { /* best effort: never leave the button down */ }
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
}, { abortOnForeground: false });
