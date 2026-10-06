// Checklist: "A pane whose agent exe is missing, then reload: the pane shows the exit, not a stuck 'running'."
// Pane A: a vendor manifest (the documented %APPDATA%\ai.flightdeck.canary\vendors\*.json extension point, CANARY's own dir) whose
//         exe does not exist, so pty_spawn fails.  Pane B: a pwsh pane that exits at once (`exit 7`), a process that ran and died.
// Both are reloaded (+ Reopen session) and compared before and after: status dot, Restart button and its tooltip.
import { writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, armReopen, typeInto, CR, reloadAndWait, sleep, shotPath, paneStates } from "./w1a-lib.mjs";

const VDIR = path.join(process.env.APPDATA, "ai.flightdeck.canary", "vendors");
const MANIFEST = path.join(VDIR, "w1a-missing.json");

const snapshot = (page) => page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => ({
  dot: p.querySelector(".pdot")?.className ?? null,
  band: p.querySelector(".pband")?.className ?? null,
  name: p.querySelector(".pname")?.textContent ?? null,
  restartBtn: !!p.querySelector(".prestart"),
  restartTitle: p.querySelector(".prestart")?.getAttribute("title") ?? null,
  text: (p.innerText || "").replace(/\s+/g, " ").slice(0, 300),
})));

main("missing-exe", async (r) => {
  writeFileSync(MANIFEST, JSON.stringify({
    id: "w1a-missing", label: "W1a Missing Agent", short: "Missing", kind: "agent",
    exe: "C:\\w1a-nope\\missing-agent.exe", args: [], probe: "pwsh",
  }, null, 2));
  r.evidence.manifest = MANIFEST;
  try {
    const c = await boot({ width: 2000, height: 1100 });
    const { page } = c;
    step("launch [w1a-missing, pwsh]");
    const opts = await page.evaluate(() => [...document.querySelectorAll(".launcher .vsel")][0]?.innerText);
    r.check("manifest vendor is offered by the launcher", /Missing/i.test(opts ?? ""), (opts ?? "").slice(0, 200));
    await launchWorkspace(page, { vendors: ["w1a-missing", "pwsh"] });
    await sleep(5000);
    // pane B: make it exit
    const live = await (await import("./w1a-lib.mjs")).liveModels(page);
    r.evidence.liveModelsAfterLaunch = live;
    await typeInto(page, 1, `exit 7${CR}`);
    await sleep(6000);
    const before = await snapshot(page);
    r.evidence.before = before;
    r.shot(await d.shotWindow(page, shotPath("missing-exe-before")));
    r.check("A (missing exe): pane is not shown as running/starting before the reload", before[0] && !/running|starting/.test(before[0].dot ?? ""), before[0]);
    r.check("B (exited pwsh): pane is not shown as running before the reload", before[1] && !/running|starting/.test(before[1].dot ?? ""), before[1]);

    step("arm reopen, reload, Reopen session");
    await armReopen(page, 0, { name: "missing-A", draftChar: "x" });
    await armReopen(page, 1, { name: "exited-B", draftChar: "x" });
    const rl = await reloadAndWait(page, { restore: "reopen", settle: 8000 });
    r.evidence.reload = rl;
    const after = await snapshot(page);
    r.evidence.after = after;
    r.evidence.afterPaneStates = await paneStates(page);
    r.shot(await d.shotWindow(page, shotPath("missing-exe-after")));
    await sleep(8000);
    const later = await snapshot(page);
    r.evidence.after8sLater = later;
    r.check("A (missing exe) after reload: shows the failure with a Restart button, not running/starting", later[0] && later[0].restartBtn && !/running|starting/.test(later[0].dot ?? ""), later[0]);
    r.check("B (exited pwsh) after reload: not stuck on 'starting' (either shows the exit or relaunched cleanly)", later[1] && !/starting/.test(later[1].dot ?? ""), later[1]);
    return c;
  } finally {
    try { if (existsSync(MANIFEST)) rmSync(MANIFEST); } catch { /* leave it, it is only a manifest */ }
  }
});
