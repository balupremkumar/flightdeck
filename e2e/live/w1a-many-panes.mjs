// Checklist: "Reload with 10+ panes with long histories: no visible stall, memory steady."
// 12 pwsh panes (workspace 1: 9, workspace 2: 3; every workspace's panes are mounted), each printing 1..20000 lines.
// Then reload (+ Reopen session) while a side process pings the Canary main window with WM_NULL every 100 ms
// (msgprobe.ps1: a main-thread stall shows as a long SendMessageTimeout) and the page times a cheap invoke (vendors_dir).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, here, OUT, launchWorkspace, waitModels, mapPwsh, write, CR, armReopen, typeInto, jsClick, reloadAndWait, sleep, shotPath, tree, treeBrief, liveModels } from "./w1a-lib.mjs";

const N1 = 9, N2 = 3, LINES = 20000;

async function timeInvokes(page, n = 20) {
  return page.evaluate(async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) { const t = performance.now(); await window.__TAURI_INTERNALS__.invoke("vendors_dir"); out.push(Math.round((performance.now() - t) * 10) / 10); await new Promise((r) => setTimeout(r, 50)); }
    return out;
  }, n);
}
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { n: a.length, min: s[0], median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] }; };

main("many-panes", async (r) => {
  const c = await boot({ width: 2500, height: 1300 });
  const { page } = c;
  step("workspace 1: 9 pwsh");
  await launchWorkspace(page, { vendors: Array(N1).fill("pwsh") });
  await waitModels(page, N1);
  step("workspace 2: 3 pwsh");
  await jsClick(page.locator(".lp-ic.add").first());
  await launchWorkspace(page, { vendors: Array(N2).fill("pwsh") });
  const mids = await waitModels(page, N1 + N2);
  for (const m of mids) await d.waitForText(page, m, /PS [^\n]*>/, { timeoutMs: 45000 });
  const map = await mapPwsh(page, mids);
  r.check(`all ${N1 + N2} panes live and mapped`, mids.length === N1 + N2 && Object.keys(map).length === N1 + N2, { models: mids.length, mapped: Object.keys(map).length });
  r.evidence.treeEmpty = treeBrief(tree());

  step("arm reopen on every pane (rename + draft char)");
  const nPanes = await page.locator(".pane").count();
  for (let i = 0; i < nPanes; i++) await armReopen(page, i, { name: `p${i + 1}`, draftChar: "", settleMs: 0 });
  step("print long histories");
  for (const m of mids) await write(page, m, `1..${LINES} | % { "line $_" }${CR}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    let done = 0;
    for (const m of mids) if ((await d.tail(page, m, 2048)).join("\n").includes(`line ${LINES}`)) done++;
    if (done === mids.length) break;
    await sleep(1000);
  }
  r.evidence.historyPrintedMs = Date.now() - t0;
  // Leave a draft char in each pane at the prompt (the app's draft tracking), then let the debounced save run.
  for (let i = 0; i < nPanes; i++) await typeInto(page, i, "x");
  await sleep(4000);
  const preTails = {};
  for (const m of mids) preTails[m] = (await d.tail(page, m, 4096)).filter((l) => /^line \d+$/.test(l)).slice(-5);
  const treeBefore = tree();
  r.evidence.treeBefore = treeBrief(treeBefore);
  r.shot(await d.shotWindow(page, shotPath("many-panes-before")));

  // WM_NULL probe on the Canary main window across the reload.
  step("reload with the main-thread probe running");
  const probeFile = path.join(OUT, "w1a-many-panes-probe.jsonl");
  const probe = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "msgprobe.ps1"), "-ProcessId", String(d.canaryPid()), "-Out", probeFile, "-Seconds", "60"], { stdio: "ignore" });
  await sleep(1500);
  const tReload = Date.now();
  const rl = await reloadAndWait(page, { restore: "reopen", settle: 0 });
  const tPanes = Date.now();
  const inv = await timeInvokes(page, 30);
  await sleep(8000);
  try { process.kill(probe.pid); } catch { /* finished */ }
  await sleep(300);
  const rows = readFileSync(probeFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const lat = rows.map((x) => x.ms);
  const stalls = rows.filter((x) => x.ms > 250 || !x.ok);
  r.evidence.reload = { ...rl, reloadStartToPanesMs: tPanes - tReload };
  r.evidence.wmNull = { samples: rows.length, ...stats(lat), over250ms: stalls.length, worst: stalls.sort((a, b) => b.ms - a.ms).slice(0, 5) };
  r.evidence.invokeVendorsDirMs = { ...stats(inv), all: inv };
  r.check("main thread never blocked > 1000 ms during/after the reload (WM_NULL round trip, 100 ms cadence)", Math.max(...lat) <= 1000 && rows.every((x) => x.ok), r.evidence.wmNull);
  r.check("cheap invoke (vendors_dir) round trip after the reload stays under 250 ms (max)", Math.max(...inv) < 250, stats(inv));
  await sleep(4000);
  const live = await liveModels(page);
  r.check(`all ${N1 + N2} panes reattached to their live ptys (none respawned: history still there)`, live.length === N1 + N2, { live: live.length });
  let intact = 0;
  const after = {};
  for (const m of mids) { const t = (await d.tail(page, m, 4096)).filter((l) => /^line \d+$/.test(l)).slice(-5); after[m] = t; if (t.join() === preTails[m].join() && t.length) intact++; }
  r.check("each pane's last history lines identical before and after the reload", intact === mids.length, { intact, of: mids.length });
  r.shot(await d.shotWindow(page, shotPath("many-panes-after")));
  const treeAfter = tree();
  r.evidence.treeAfter = treeBrief(treeAfter);
  const dPriv = treeAfter.privMB - treeBefore.privMB, dWs = treeAfter.wsMB - treeBefore.wsMB;
  r.evidence.memoryDelta = { privMB: dPriv, wsMB: dWs, before: { priv: treeBefore.privMB, ws: treeBefore.wsMB }, after: { priv: treeAfter.privMB, ws: treeAfter.wsMB } };
  r.check("memory steady after the reload (private bytes within +15% and +300 MB of before)", dPriv < Math.max(300, 0) && dPriv / treeBefore.privMB < 0.15, r.evidence.memoryDelta);
  await sleep(20000);
  const settled = tree();
  r.evidence.treeSettled20s = treeBrief(settled);
  return c;
});
