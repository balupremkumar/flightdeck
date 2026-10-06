import "./w3-prefix.mjs";
// W3: launch restore of secondary windows honours the "Reopen last session?" answer (qol/fix-restore-cancel).
// Build a real two-window session (tear a workspace out with drag_debug_script), kill the Canary, then relaunch:
// decline -> no secondary appears while the prompt is open or after Cancel, and the next launch does not bring it back;
// accept -> main hydrates and the secondary comes back with its workspace. pwsh panes only.
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { main, boot, d, step, here, launchWorkspace, waitModels, sleep, shotPath, teardown, stableSnapshot, jsClick, SCRATCH } from "./w1a-lib.mjs";

const SESSION = path.join(process.env.APPDATA, "ai.flightdeck.canary", "session.json");
const label = (p) => p.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null);
async function labels(ctx) {
  const out = [];
  for (const p of ctx.pages()) { if (/devtools|ghost/.test(p.url())) continue; try { const l = await label(p); if (l) out.push(l); } catch { /* closing */ } }
  return out.sort();
}
const savedWindows = () => { try { return JSON.parse(readFileSync(SESSION, "utf8")).windows ?? null; } catch { return null; } };
const savedWorkspaces = () => { try { return JSON.parse(readFileSync(SESSION, "utf8")).workspaces.map((w) => w.id); } catch { return null; } };
const shim = (p) => p.evaluate(() => {
  for (const k of ["setPointerCapture", "releasePointerCapture"]) {
    const o = Element.prototype[k]; if (o.__fd) continue;
    const f = function (id) { try { return o.call(this, id); } catch { /* synthetic pointer */ } }; f.__fd = true; Element.prototype[k] = f;
  }
});
const flags = async (p) => { await p.evaluate(() => { localStorage.removeItem("flightdeck-multiwindow"); localStorage.removeItem("flightdeck-window-drag"); localStorage.setItem("flightdeck-ws-sort", "0"); }); await p.reload({ waitUntil: "load" }); await d.wrapSpawns(p); };

/** Fresh session with main {B} and fw-1 {A}, then kill the Canary so session.json keeps both windows. */
async function makeTwoWindowSession(r, tag) {
  if (existsSync(SESSION)) renameSync(SESSION, path.join(SCRATCH, `canary-session-${Date.now()}.json`));
  const c = await boot({ width: 2000, height: 1000, beforeSettings: flags });
  const { ctx, page } = c;
  await launchWorkspace(page, { vendors: ["pwsh"] });
  await waitModels(page, 1);
  await jsClick(page.locator("button.lp-ic.add, button.lp-add").first());
  await launchWorkspace(page, { vendors: ["pwsh"] });
  await waitModels(page, 2);
  await sleep(2000);
  const [A] = await page.evaluate(() => [...new Set([...document.querySelectorAll("[data-workspace-id]")].map((e) => Number(e.dataset.workspaceId)))]);
  await shim(page);
  const pts = [[-19000, 300], [-17988, 300], ...Array.from({ length: 40 }, () => [3800, 300])];
  await d.invoke(page, "drag_debug_script", { points: pts, release: true });
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-workspace-id="${id}"]`); const rc = el.getBoundingClientRect();
    const b = { bubbles: true, cancelable: true, pointerId: 41, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...b, clientX: rc.x + 20, clientY: rc.y + 10 }));
    el.dispatchEvent(new PointerEvent("pointermove", { ...b, button: -1, clientX: rc.x + 40, clientY: rc.y + 10 }));
    el.dispatchEvent(new PointerEvent("pointermove", { ...b, button: -1, clientX: innerWidth + 60, clientY: rc.y + 10 }));
  }, A);
  await sleep(4000);
  const ls = await labels(ctx);
  await sleep(4000); // autosave
  await teardown();
  await sleep(1000);
  const w = savedWindows();
  r.evidence[`${tag}: built`] = { labels: ls, saved: w, workspaces: savedWorkspaces() };
  return r.check(`${tag}: setup saved a session with main and fw-1 holding a workspace (both workspaces in the doc)`, ls.includes("fw-1") && !!w?.some((x) => x.label === "fw-1" && x.workspaceIds.length > 0) && savedWorkspaces()?.length === 2, r.evidence[`${tag}: built`]);
}

/** Relaunch on the saved session and answer the prompt. */
/** Launch on the saved session WITHOUT the harness settings reload (boot() reloads the page, which would land while the
 *  prompt is open; that case is its own scenario below). Test settings persist in the Canary profile from earlier runs. */
async function launchNoReload() {
  console.log("[launch]", execFileSync("node", [path.join(here, "launch.mjs")], { encoding: "utf8" }).trim().split(/\r?\n/).join(" | "));
  const c = await d.connect();
  d.setWindow({ width: 2000, height: 1000 });
  return c;
}
async function relaunch(r, tag, answer, { reloadWhileOpen = false } = {}) {
  const c = await launchNoReload();
  if (reloadWhileOpen) {
    await c.page.getByRole("button", { name: "Reopen session" }).waitFor({ timeout: 30000 });
    await sleep(3000);
    r.evidence[`${tag}: doc before reload`] = savedWorkspaces();
    await c.page.reload({ waitUntil: "load" });
    await sleep(3000);
    r.evidence[`${tag}: doc after reload`] = savedWorkspaces();
  }
  const { ctx, page } = c;
  const reopen = page.getByRole("button", { name: "Reopen session" });
  await reopen.waitFor({ timeout: 30000 });
  const body = await page.evaluate(() => document.querySelector('[role="dialog"], [role="alertdialog"], .confirm-modal')?.innerText.replace(/\s+/g, " ") ?? null);
  await sleep(3000);
  const whileOpen = await labels(ctx);
  r.shot(await d.shotWindow(page, shotPath(`restore-${tag}-prompt`)));
  r.check(`${tag}: prompt offered and names the other window`, /other window/.test(body ?? ""), body);
  r.check(`${tag}: no secondary created while the prompt is open`, JSON.stringify(whileOpen) === JSON.stringify(["main"]), whileOpen);
  if (answer === "cancel") await jsClick(page.getByRole("button", { name: "Cancel" }));
  else await jsClick(reopen);
  await sleep(6000);
  const after = await labels(ctx);
  r.evidence[`${tag}: after`] = { labels: after, saved: savedWindows(), workspaces: savedWorkspaces(), mainTiles: await page.evaluate(() => [...new Set([...document.querySelectorAll("[data-workspace-id]")].map((e) => Number(e.dataset.workspaceId)))]) };
  console.log(`[${tag}] after`, JSON.stringify(r.evidence[`${tag}: after`]));
  return { c, after };
}

main("restore", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    step("decline: build two-window session");
    if (!(await makeTwoWindowSession(r, "decline"))) throw new Error("setup failed");
    step("decline: relaunch and Cancel");
    const dc = await relaunch(r, "decline", "cancel");
    r.check("decline: after Cancel only main exists", JSON.stringify(dc.after) === JSON.stringify(["main"]), dc.after);
    const sw = savedWindows();
    r.check("decline: session.json no longer carries fw-1 with workspaces", !sw?.some((x) => x.label === "fw-1" && x.workspaceIds.length > 0), sw);
    await teardown(); await sleep(1000);
    step("decline: next launch brings nothing back");
    const c2 = await boot({ width: 2000, height: 1000, keepSession: true });
    await sleep(6000);
    const l2 = await labels(c2.ctx);
    const prompt2 = await c2.page.getByRole("button", { name: "Reopen session" }).count();
    r.check("decline: the following launch shows no secondary", JSON.stringify(l2) === JSON.stringify(["main"]), { labels: l2, prompt: prompt2 });
    await teardown(); await sleep(1000);

    step("accept: build two-window session");
    if (!(await makeTwoWindowSession(r, "accept"))) throw new Error("setup failed");
    step("accept: relaunch and Reopen");
    const ac = await relaunch(r, "accept", "reopen");
    r.check("accept: fw-1 restored after Reopen", JSON.stringify(ac.after) === JSON.stringify(["fw-1", "main"]), ac.after);
    const fw = ac.c.ctx.pages().find((p) => !/devtools|ghost/.test(p.url()) && p !== ac.c.page);
    let fwPanes = 0;
    for (const p of ac.c.ctx.pages()) { try { if ((await label(p)) === "fw-1") fwPanes = await p.evaluate(() => document.querySelectorAll(".pane").length); } catch { /* */ } }
    const mainPanes = await ac.c.page.evaluate(() => document.querySelectorAll(".pane").length);
    r.check("accept: main and fw-1 each show their workspace's pane", fwPanes === 1 && mainPanes === 1, { fwPanes, mainPanes, fw: !!fw });
    await teardown(); await sleep(1000);

    step("reload while the prompt is open, then Reopen");
    if (!(await makeTwoWindowSession(r, "reload"))) throw new Error("setup failed");
    const rl = await relaunch(r, "reload", "reopen", { reloadWhileOpen: true });
    const mainPanes2 = await rl.c.page.evaluate(() => document.querySelectorAll(".pane").length);
    r.check("reload: a reload while the prompt is open does not erase main's saved workspace", mainPanes2 === 1 && (r.evidence["reload: doc after reload"] ?? []).length === 2, { mainPanes2, before: r.evidence["reload: doc before reload"], afterReload: r.evidence["reload: doc after reload"], after: r.evidence["reload: after"] });
    return rl.c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
}, { abortOnForeground: false });
