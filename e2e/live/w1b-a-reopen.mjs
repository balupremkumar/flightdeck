// A. Reopen fix regression (fc43472): Claude pane with NO rename and NO draft, reload, Reopen session: pane comes back,
// no pageerror. Also a pane whose spawn failed (vendor manifest with an exe that never existed).
import { writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, mapClaudeSingle, healthIdsNow, claudeReady, reloadAndWait, sleep, shotPath, teardown, stableSnapshot } from "./w1b-lib.mjs";

const MANIFEST = path.join(process.env.APPDATA, "ai.flightdeck.canary", "vendors", "w1b-missing.json");
const manifest = (exe) => writeFileSync(MANIFEST, JSON.stringify({ id: "w1b-missing", label: "W1b Missing Agent", short: "Missing", kind: "agent", exe, args: [], probe: "pwsh" }, null, 2));
const snap = (page) => page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => ({ dot: p.querySelector(".pdot")?.className ?? null, name: p.querySelector(".pname")?.textContent ?? null, restartBtn: !!p.querySelector(".prestart"), text: (p.innerText || "").replace(/\s+/g, " ").slice(0, 160) })));

main("a-reopen", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    // ---- part 1: live Claude pane, nothing renamed, nothing typed ----
    let c = await boot({ width: 2000, height: 1100, openClaudeIn: "quiet" });
    let { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.stack ?? e).split("\n").slice(0, 3).join(" | ")));
    step("part 1: launch one claude pane (haiku), no rename, no draft");
    const before = await healthIdsNow(page);
    await launchWorkspace(page, { vendors: ["claude"] });
    const [mid] = await waitModels(page, 1);
    await mapClaudeSingle(page, mid, before);
    await claudeReady(page, mid, { must: /haiku/i });
    const title0 = await page.locator(".pane .pname").first().innerText();
    r.evidence.paneNameBefore = title0;
    await sleep(3500);
    errors.length = 0;
    step("part 1: reload and Reopen session");
    await reloadAndWait(page, { restore: "reopen", settle: 3000 });
    const a = await snap(page);
    r.evidence.part1 = { panes: a, pageerrors: errors.slice(0, 3), live: (await d.invoke(page, "pane_health", {})).length };
    r.shot(await d.shotWindow(page, shotPath("a-reopen-claude")));
    r.check("Claude pane (no rename, no draft) comes back after reload + Reopen session", a.length === 1, r.evidence.part1);
    r.check("no pageerror during that reload/reopen", errors.length === 0, errors.slice(0, 3));

    // ---- part 2: spawn-failed pane ----
    manifest("C:\w1b-nope\missing-agent.exe");
    c = await boot({ width: 2000, height: 1100 });
    page = c.page;
    const errors2 = [];
    page.on("pageerror", (e) => errors2.push(String(e.stack ?? e).split("\n").slice(0, 3).join(" | ")));
    step("part 2: pane whose spawn fails");
    await launchWorkspace(page, { vendors: ["w1b-missing"] });
    await sleep(6000);
    const f0 = await snap(page);
    r.evidence.part2before = f0;
    r.check("spawn-failed pane shows error + Restart before the reload", f0.length === 1 && f0[0].restartBtn && /error/.test(f0[0].dot ?? ""), f0);
    await sleep(3000);
    errors2.length = 0;
    await reloadAndWait(page, { restore: "reopen", settle: 3000 }).catch((e) => { r.evidence.part2reopenError = String(e).slice(0, 200); });
    const f1 = await snap(page);
    r.evidence.part2 = { panes: f1, pageerrors: errors2.slice(0, 3) };
    r.shot(await d.shotWindow(page, shotPath("a-reopen-failed")));
    r.check("spawn-failed pane comes back after reload + Reopen session", f1.length === 1, r.evidence.part2);
    r.check("no pageerror during the spawn-failed reload/reopen", errors2.length === 0, errors2.slice(0, 3));
    return c;
  } finally {
    try { if (existsSync(MANIFEST)) rmSync(MANIFEST); } catch { /* harmless */ }
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
