import "./w1b-prefix.mjs";
// W1b-E: 0.6.0 Fable red team fixes and the restore pane-id regression, live on the Canary, pwsh panes only.
// M2/M3: a fake key printed in one pane and typed (unsent) into another never reaches session.json or a snapshot.
// L2: the app refuses to read ~/.claude/.credentials.json (readscope.rs SECRET_NAMES) while a normal repo file reads.
// H1: a pane added in main after a relaunch never collides with the second window's restored pane.
// Pane id after restore: Broadcast reaches exactly the panes of its workspace.
// The fake key is assembled at run time; the credentials read records only ok/err, never content.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, write, health, sleep, shotPath, teardown, stableSnapshot, jsClick, typeInto, REPO, CR } from "./w1a-lib.mjs";
import { DESK, pagesByLabel, tiles, dragTo, park, clearCanarySession, dragFlags, closeLikeUser, launchNoReload } from "./w3-lib.mjs";

const DATA = path.join(process.env.APPDATA, "ai.flightdeck.canary");
const KEY_A = "sk-ant-api03-" + "QwErTyUiOpAsDfGhJkLzXcVbNmQwEr".split("").reverse().join("");
const KEY_B = "sk-ant-api03-" + "ZyXwVuTsRqPoNmLkJiHgFeDcBaZyXw".toLowerCase();
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const newestSnapshot = () => {
  const dir = path.join(DATA, "snapshots");
  const f = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => path.join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return f ? { file: path.basename(f), text: readFileSync(f, "utf8") } : null;
};
/** Quit like the title-bar X on main and accept the quit confirm (Cockpit.tsx:342 requestConfirm, button .btn-danger). */
async function quitApp(page) {
  const pid = d.canaryPid();
  await closeLikeUser(page);
  await sleep(2500);
  await page.locator(".confirm-modal .btn-danger, .confirm-modal .btn-primary").first().evaluate((el) => el.click()).catch(() => {});
  for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(500);
  await teardown(); // clears .canary.pid so the next launch is allowed
  return !pidAlive(pid);
}

main("e-redteam", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  r.evidence.canarySessionMovedTo = clearCanarySession();
  try {
    const c = await boot({ width: 2000, height: 1000, beforeSettings: dragFlags });
    const { ctx, page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    step("setup: A (2 pwsh), B (1 pwsh)");
    await launchWorkspace(page, { vendors: ["pwsh", "pwsh"] });
    await waitModels(page, 2);
    await jsClick(page.locator("button.lp-ic.add, button.lp-add").first());
    await launchWorkspace(page, { vendors: ["pwsh"] });
    const models = await waitModels(page, 3);
    await sleep(2500);
    const map = await mapPwsh(page, models);
    const [A, B] = await tiles(page);

    step("L2: credentials refused, repo file allowed");
    const cred = path.join(process.env.USERPROFILE, ".claude", ".credentials.json");
    const credRead = await d.invoke(page, "fs_read_text_file", { path: cred }).then(() => "ok", (e) => "err:" + String(e).slice(0, 120));
    const repoRead = await d.invoke(page, "fs_read_text_file", { path: path.join(REPO, "package.json") }).then((t) => "ok:" + t.length, (e) => "err:" + String(e).slice(0, 120));
    r.evidence.l2 = { credRead, repoRead };
    r.check("L2: the app refuses ~/.claude/.credentials.json while a repo file reads", credRead.startsWith("err") && repoRead.startsWith("ok"), r.evidence.l2);

    step("M2/M3: key printed in B's pane, key typed unsent into A's second pane");
    // B is the active workspace (created last), so its pane is in the DOM; A's panes are not mounted. Print in B,
    // then switch to A and type the draft into A's second pane.
    const mB = models[2];
    await write(page, mB, `$k='sk-ant-api03-'+'${KEY_A.slice(13)}'; Write-Host $k` + CR);
    await sleep(1500);
    await jsClick(page.locator(`[data-workspace-id="${A}"]`).first());
    await sleep(1500);
    await typeInto(page, 1, KEY_B);
    await sleep(3000);
    r.evidence.keyVisibleInRing = (await d.tail(page, mB, 65536)).join("\n").includes(KEY_A);

    step("H1 setup: tear B into a second window, marker in its pane");
    await write(page, mB, "#FD-H1-MARK" + CR);
    await sleep(800);
    await dragTo(page, B, DESK);
    let pg = await pagesByLabel(ctx);
    const fwLabel = Object.keys(pg).find((l) => l !== "main");
    if (fwLabel) await park(pg[fwLabel]);
    r.check("H1 setup: B moved to a second window", !!fwLabel && (await tiles(pg[fwLabel])).includes(B), Object.keys(pg));
    await sleep(3000);

    step("quit cleanly (flush + snapshot)");
    const quit = await quitApp(page);
    r.check("quit: Canary exited after the quit confirm", quit);
    await sleep(1000);
    const sess = readFileSync(path.join(DATA, "session.json"), "utf8");
    const snap = newestSnapshot();
    r.evidence.m2m3 = {
      keyVisibleInRing: r.evidence.keyVisibleInRing,
      sessionHasKeyA: sess.includes(KEY_A), sessionHasKeyB: sess.includes(KEY_B), sessionRedacted: sess.includes("[REDACTED]"),
      snapshot: snap?.file, snapshotHasKeyA: !!snap?.text.includes(KEY_A), snapshotHasKeyB: !!snap?.text.includes(KEY_B), snapshotRedacted: !!snap?.text.includes("[REDACTED]"),
    };
    r.check("M2/M3: neither key is in session.json or the newest snapshot", !r.evidence.m2m3.sessionHasKeyA && !r.evidence.m2m3.sessionHasKeyB && !r.evidence.m2m3.snapshotHasKeyA && !r.evidence.m2m3.snapshotHasKeyB, r.evidence.m2m3);
    r.check("M2/M3: the redaction marker is present where a key was saved", r.evidence.m2m3.sessionRedacted || r.evidence.m2m3.snapshotRedacted, r.evidence.m2m3);

    step("relaunch, Reopen, add a pane in main");
    const c2 = await launchNoReload();
    const reopen = c2.page.getByRole("button", { name: "Reopen session" });
    await reopen.waitFor({ timeout: 30000 });
    await jsClick(reopen);
    await sleep(8000);
    pg = await pagesByLabel(c2.ctx);
    const fw2 = pg[fwLabel];
    if (fw2) await park(fw2);
    const before = (await health(c2.page)).map((p) => p.paneId).sort();
    await c2.page.locator(".addpane-wrap > button").evaluate((el) => el.click());
    await sleep(300);
    await c2.page.locator(".apm-item").filter({ hasText: "PowerShell" }).first().evaluate((el) => el.click()).catch(async () => {
      await c2.page.locator(".apm-item").first().evaluate((el) => el.click());
    });
    await sleep(4000);
    const after = (await health(c2.page)).map((p) => p.paneId).sort();
    const fwPanes = fw2 ? await fw2.evaluate(() => document.querySelectorAll(".pane").length) : 0;
    r.evidence.h1 = { labels: Object.keys(pg), before, after, fwPanes };
    r.check("H1: after Reopen and a new pane in main, every earlier pty is still live and the second window still shows its pane", !!fw2 && before.every((x) => after.includes(x)) && after.length === before.length + 1 && fwPanes === 1, r.evidence.h1);

    step("pane id after restore: Broadcast to workspace A reaches A's two panes only");
    const models2 = (await c2.page.evaluate(async () => {
      const out = [];
      await Promise.all(Array.from({ length: 64 }, (_, i) => i + 1).map(async (id) => { try { await window.__TAURI_INTERNALS__.invoke("pane_tail", { modelId: id, maxBytes: 256 }); out.push(id); } catch { /* none */ } }));
      return out.sort((a, b) => a - b);
    }));
    await jsClick(c2.page.locator(`[data-workspace-id="${A}"]`).first());
    await sleep(1500);
    await jsClick(c2.page.locator('button[title="Broadcast to panes"]'));
    await sleep(1200);
    const ta = c2.page.locator(".bc-bar textarea").first();
    await ta.evaluate((el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, "#FD-BC-MARK");
    await sleep(300);
    await jsClick(c2.page.locator(".bc-bar .bc-send").last());
    await sleep(3000);
    const hits = {};
    for (const m of models2) hits[m] = (await d.tail(c2.page, m, 65536)).join(" ").includes("FD-BC-MARK");
    const aModelsNow = await c2.page.evaluate(() => [...document.querySelectorAll(".pane")].length);
    r.evidence.broadcast = { models: models2, hits, panesInA: aModelsNow };
    r.shot(await d.shotWindow(c2.page, shotPath("e-broadcast")));
    // A holds its two panes plus the one added in main above, so every pane in A and none in B (the second window).
    r.check("Broadcast after restore: the marker reached exactly the panes of workspace A, none in B", Object.values(hits).filter(Boolean).length === aModelsNow && hits[models[2]] === false, r.evidence.broadcast);
    r.check("no pageerror", errors.length === 0, errors.slice(0, 3));
    return c2;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
}, { abortOnForeground: false }); // tearing B out opens a window, which may take foreground by design
