import "./w1c-prefix.mjs";
// Natural pane exit (ptyexit.rs, qol/fix-exit): a pwsh pane that runs `exit 7` must show as exited with a Restart
// button that names the failure; `exit 0` shows Restart without the error wording; the other pane stays live; Restart
// brings the pane back on a new pty. pwsh panes only: nothing here starts Claude or touches ~/.claude.
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, write, health, sleep, shotPath, teardown, stableSnapshot, jsClick, CR } from "./w1a-lib.mjs";

const exitedPanes = (page) => page.evaluate(() => [...document.querySelectorAll(".pane")].map((p, i) => {
  const b = p.querySelector(".prestart");
  return { i, restart: !!b, title: b?.getAttribute("title") ?? null };
}).filter((x) => x.restart));

async function waitExited(page, n, timeoutMs = 15000) {
  const t0 = Date.now();
  let ex = [];
  while (Date.now() - t0 < timeoutMs) { ex = await exitedPanes(page); if (ex.length >= n) return { ex, ms: Date.now() - t0 }; await sleep(200); }
  return { ex, ms: null };
}

main("exit", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 2000, height: 1000 });
    const { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    step("three pwsh panes");
    await launchWorkspace(page, { vendors: ["pwsh", "pwsh", "pwsh"] });
    const models = await waitModels(page, 3);
    await sleep(3000);
    const map = await mapPwsh(page, models);
    r.check("all three pwsh ptys mapped", Object.keys(map).length === 3, map);
    const [m7, m0, mLive] = models;
    const ptyLive = map[mLive];

    step("exit 7");
    await write(page, m7, "exit 7" + CR);
    const w1 = await waitExited(page, 1);
    r.evidence.afterExit7 = w1;
    r.shot(await d.shotWindow(page, shotPath("exit-7")));
    r.check("exit 7: exactly one pane shows Restart within 15 s", w1.ex.length === 1 && w1.ms !== null, w1);
    r.check("exit 7: Restart tooltip says it exited unexpectedly with a non-zero code", /exited unexpectedly/.test(w1.ex[0]?.title ?? ""), w1.ex[0]?.title);

    step("exit 0");
    await write(page, m0, "exit 0" + CR);
    const w2 = await waitExited(page, 2);
    r.evidence.afterExit0 = w2;
    const clean = w2.ex.find((x) => x.i !== w1.ex[0]?.i);
    r.check("exit 0: second pane shows Restart", w2.ex.length === 2 && w2.ms !== null, w2);
    r.check("exit 0: tooltip is the plain restart wording, not an error", clean?.title === "Restart this pane in the same folder", clean?.title);

    step("third pane still live");
    const live = (await health(page)).map((p) => p.paneId);
    r.check("untouched pane's pty is still live", live.includes(ptyLive), { live, ptyLive });
    await write(page, mLive, "#still-here" + CR);

    step("Restart the exit 7 pane");
    const before = new Set(live);
    await jsClick(page.locator(".pane").nth(w1.ex[0].i).locator(".prestart"));
    let fresh = [];
    for (let i = 0; i < 50 && !fresh.length; i++) { await sleep(200); fresh = (await health(page)).map((p) => p.paneId).filter((x) => !before.has(x)); }
    await sleep(1500);
    const after = await exitedPanes(page);
    r.evidence.afterRestart = { fresh, exited: after };
    r.shot(await d.shotWindow(page, shotPath("exit-after-restart")));
    r.check("Restart spawns a new pty and that pane no longer shows Restart", fresh.length === 1 && !after.some((x) => x.i === w1.ex[0].i), r.evidence.afterRestart);
    r.check("no pageerror", errors.length === 0, errors.slice(0, 3));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
