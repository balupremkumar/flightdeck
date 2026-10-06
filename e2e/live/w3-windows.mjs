import "./w3-prefix.mjs";
// W3 (Balu away): multi-window behaviour on the Canary, checklist "Phase 4 multi-window" items that a script can drive.
// Storage sync between windows, closing a secondary while its pane prints, a crashed secondary renderer (heartbeat),
// multiwindow off + restart, closing main quits everything. pwsh panes only; nothing touches ~/.claude or stable.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, write, health, sleep, shotPath, teardown, stableSnapshot, jsClick, here, CR } from "./w1a-lib.mjs";
import { DESK, pagesByLabel, tiles, dragTo, park, clearCanarySession, dragFlags, savedDoc, closeLikeUser, launchNoReload } from "./w3-lib.mjs";

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

main("windows", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  r.evidence.canarySessionMovedTo = clearCanarySession();
  try {
    const c = await boot({ width: 2000, height: 1000, beforeSettings: dragFlags });
    const { ctx, page } = c;
    const errors = [];
    const watch = (p, l) => p.on("pageerror", (e) => errors.push(`${l}: ${String(e).slice(0, 200)}`));
    watch(page, "main");

    step("setup: A (pwsh) and B (pwsh) in main, A torn out to fw-1");
    await launchWorkspace(page, { vendors: ["pwsh"] });
    await waitModels(page, 1);
    await jsClick(page.locator("button.lp-ic.add, button.lp-add").first());
    await launchWorkspace(page, { vendors: ["pwsh"] });
    const models = await waitModels(page, 2);
    await sleep(2500);
    const map = await mapPwsh(page, models);
    const ptys0 = (await health(page)).map((p) => p.paneId).sort();
    const [A, B] = await tiles(page);
    await dragTo(page, A, DESK);
    let pg = await pagesByLabel(ctx);
    const fw1 = pg["fw-1"];
    r.check("setup: fw-1 holds A", !!fw1 && JSON.stringify(await tiles(fw1)) === JSON.stringify([A]), Object.keys(pg));
    if (!fw1) throw new Error("no fw-1");
    watch(fw1, "fw-1");
    await park(fw1);

    step("storage sync: accent changed in main shows in fw-1 without a reload");
    const accent = (p) => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    const before = await accent(fw1);
    const prevKey = await page.evaluate(() => localStorage.getItem("flightdeck-accent"));
    // Any valid change will do; the value format is the app's, so just flip to a different stored accent.
    await page.evaluate(() => localStorage.setItem("flightdeck-accent", localStorage.getItem("flightdeck-accent") === "blue" ? "violet" : "blue"));
    await sleep(1200);
    const after = await accent(fw1);
    r.check("storage sync: fw-1 picks up main's accent change live (no reload)", after.toLowerCase() !== before.toLowerCase(), { before, after });
    await page.evaluate((v) => { if (v == null) localStorage.removeItem("flightdeck-accent"); else localStorage.setItem("flightdeck-accent", v); }, prevKey);

    step("close fw-1 while its pane prints");
    const aModel = models[0];
    await write(page, aModel, "1..300 | % { \"FDLINE $_\"; Start-Sleep -Milliseconds 25 }" + CR);
    await sleep(1500);
    r.evidence.closeFw1 = await closeLikeUser(fw1);
    await sleep(1500);
    await fw1.locator(".confirm-modal .btn-primary").evaluate((el) => el.click()).catch(() => {});
    await sleep(6000);
    pg = await pagesByLabel(ctx);
    const mainTiles = await tiles(page);
    const ptys1 = (await health(page)).map((p) => p.paneId).sort();
    const ring = (await d.tail(page, aModel, 65536)).join(" ");
    r.evidence.closeWhilePrinting = { labels: Object.keys(pg), mainTiles, ptys1, lastLine: (ring.match(/FDLINE \d+/g) ?? []).slice(-1)[0] };
    r.shot(await d.shotWindow(page, shotPath("windows-after-close-fw1")));
    r.check("close secondary: fw-1 gone, A merged back into main", !pg["fw-1"] && mainTiles.includes(A) && mainTiles.includes(B), r.evidence.closeWhilePrinting);
    r.check("close secondary: agent kept running through the close (same ptys, output reached the end)", JSON.stringify(ptys1) === JSON.stringify(ptys0) && /FDLINE 300/.test(ring), r.evidence.closeWhilePrinting);

    step("heartbeat: crash fw-2's renderer");
    await dragTo(page, A, DESK);
    pg = await pagesByLabel(ctx);
    const fw2Label = Object.keys(pg).find((l) => l !== "main");
    const fw2 = pg[fw2Label];
    r.check("heartbeat setup: A in a new secondary", !!fw2, Object.keys(pg));
    if (fw2) {
      await park(fw2);
      const cdp = await ctx.newCDPSession(fw2);
      void cdp.send("Page.crash").catch(() => {});
      const t0 = Date.now();
      let back = false;
      while (Date.now() - t0 < 30000) { await sleep(1000); try { if ((await tiles(page)).includes(A)) { back = true; break; } } catch { break; } }
      const mainAlive = await page.evaluate(() => 1).then(() => true, () => false);
      const ptys2 = mainAlive ? (await health(page)).map((p) => p.paneId).sort() : null;
      r.evidence.heartbeat = { back, secs: back ? Math.round((Date.now() - t0) / 1000) : null, mainAlive, ptys2 };
      r.check("heartbeat: main survives a crashed secondary renderer", mainAlive, r.evidence.heartbeat);
      r.check("heartbeat: A back in main within 30 s with its agent alive", back && JSON.stringify(ptys2) === JSON.stringify(ptys0), r.evidence.heartbeat);
    }

    step("multiwindow off + restart: everything opens in main");
    await dragTo(page, A, DESK);
    await sleep(4000);
    r.evidence.beforeFlagOff = { labels: Object.keys(await pagesByLabel(ctx)), doc: savedDoc()?.windows };
    await page.evaluate(() => { localStorage.setItem("flightdeck-multiwindow", "0"); return window.__TAURI_INTERNALS__.invoke("set_multiwindow", { enabled: false }); }).catch((e) => r.evidence.setFlagErr = String(e));
    await sleep(3000);
    await teardown(); await sleep(1500);
    const c2 = await launchNoReload();
    const reopen = c2.page.getByRole("button", { name: "Reopen session" });
    if (await reopen.waitFor({ timeout: 15000 }).then(() => true, () => false)) await jsClick(reopen);
    await sleep(6000);
    const pg2 = await pagesByLabel(c2.ctx);
    const t2 = await tiles(c2.page);
    r.evidence.flagOff = { labels: Object.keys(pg2), mainTiles: t2 };
    r.check("flag off + restart: one window, both workspaces in main", JSON.stringify(Object.keys(pg2)) === JSON.stringify(["main"]) && t2.includes(A) && t2.includes(B), r.evidence.flagOff);
    await c2.page.evaluate(() => { localStorage.removeItem("flightdeck-multiwindow"); return window.__TAURI_INTERNALS__.invoke("set_multiwindow", { enabled: true }); }).catch(() => {});
    await teardown(); await sleep(1500);

    step("close main: the whole app quits, secondaries included");
    const c3 = await boot({ width: 2000, height: 1000, beforeSettings: dragFlags });
    await launchWorkspace(c3.page, { vendors: ["pwsh"] });
    await waitModels(c3.page, 1);
    await jsClick(c3.page.locator("button.lp-ic.add, button.lp-add").first());
    await launchWorkspace(c3.page, { vendors: ["pwsh"] });
    await waitModels(c3.page, 2);
    await sleep(2000);
    const [A3] = await tiles(c3.page);
    await dragTo(c3.page, A3, DESK);
    const l3 = Object.keys(await pagesByLabel(c3.ctx));
    const pid = d.canaryPid();
    r.evidence.closeMainPosted = await closeLikeUser(c3.page);
    await sleep(2500);
    // A quit confirm may ask first: accept it (page JS click, no input events).
    await c3.page.locator(".confirm-modal .btn-danger, .confirm-modal .btn-primary").first().evaluate((el) => el.click()).catch(() => {});
    const t0 = Date.now();
    while (pidAlive(pid) && Date.now() - t0 < 20000) await sleep(500);
    r.evidence.closeMain = { labelsBefore: l3, exited: !pidAlive(pid), secs: Math.round((Date.now() - t0) / 1000) };
    r.check("close main: Canary process exits with its secondary", l3.length === 2 && !pidAlive(pid), r.evidence.closeMain);
    r.check("no pageerror in any window", errors.length === 0, errors.slice(0, 5));
    return null;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
}, { abortOnForeground: false });
