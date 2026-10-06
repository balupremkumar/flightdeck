// Checklist: "Restart one pane 20 times quickly: it never shows the old agent." (+ no leaked processes afterwards)
// Phase 1: pwsh pane. Before every restart a unique marker is echoed; after every restart (250 ms later and again once the
//          new prompt shows) the pane must not contain ANY earlier generation's marker.
// Phase 2: Claude pane (haiku, no turns), 20 restarts 350 ms apart through the pane menu (page-JS clicks, no OS input);
//          afterwards exactly one Claude generation is alive and the Canary process tree is back to its baseline size.
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, mapClaudeSingle, healthIdsNow, health, claudeReady, write, typeInto, CR, paneMenu, setPty, sleep, shotPath, tree, treeBrief, pwshCmd } from "./w1a-lib.mjs";

const alive = (pid) => pwshCmd(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`).trim() === "True";
const restart = (page, i) => paneMenu(page, i, /^\s*Restart/);

main("restart-x20", async (r) => {
  const c = await boot({ width: 2200, height: 1100 });
  const { page } = c;
  step("launch [pwsh, claude]");
  await launchWorkspace(page, { vendors: ["pwsh", "claude"] });
  const [pM, cM] = await waitModels(page, 2);
  await d.waitForText(page, pM, /PS [^\n]*>/, { timeoutMs: 30000 });
  const m = await mapPwsh(page, [pM]);
  const claudePty = (await healthIdsNow(page)).find((x) => x !== m[pM]);
  setPty(cM, claudePty);
  await claudeReady(page, cM, { must: /haiku/i });
  await sleep(3000);
  const baseline = tree();
  r.evidence.baseline = treeBrief(baseline);

  // ---- phase 1: pwsh ----
  step("phase 1: 20 pwsh restarts with generation markers");
  const seen = [];
  const bad = [];
  const pids = [];
  for (let g = 1; g <= 20; g++) {
    await typeInto(page, 0, `echo GENMARK-${g}-END${CR}`);
    await sleep(120);
    await restart(page, 0);
    await sleep(250);
    const early = (await d.tail(page, pM).catch(() => [])).join("\n");
    const olds = [...early.matchAll(/GENMARK-(\d+)-END/g)].map((x) => Number(x[1]));
    if (olds.length) bad.push({ gen: g, when: "250ms", olds });
    seen.push(olds.length);
    await sleep(150);
  }
  await d.waitForText(page, pM, /PS [^\n]*>/, { timeoutMs: 30000 });
  await sleep(1500);
  const final1 = (await d.tail(page, pM)).join("\n");
  const olds1 = [...final1.matchAll(/GENMARK-(\d+)-END/g)].map((x) => Number(x[1]));
  r.evidence.phase1 = { staleMarkerSightings: bad, finalTail: final1.split("\n").slice(-3), finalMarkers: olds1 };
  r.check("pwsh: after 20 quick restarts no earlier generation's output is ever shown (250 ms samples and final)", bad.length === 0 && olds1.length === 0, r.evidence.phase1);
  r.shot(await d.shotWindow(page, shotPath("restart-x20-pwsh")));

  // ---- phase 2: Claude ----
  step("phase 2: 20 Claude restarts");
  const hBefore = await health(page);
  const pwshPid = hBefore.find((x) => /^pwsh$/i.test(x.procName ?? ""))?.pid;
  const pwshPtyId = hBefore.find((x) => /^pwsh$/i.test(x.procName ?? ""))?.paneId;
  r.check("pwsh pane identified after phase 1 (live process name pwsh)", !!pwshPtyId, hBefore.map((x) => ({ id: x.paneId, proc: x.procName })));
  const gens = new Set(hBefore.map((x) => x.pid));
  let maxPtys = hBefore.length;
  for (let g = 1; g <= 20; g++) {
    await restart(page, 1);
    await sleep(350);
    const h = await health(page);
    maxPtys = Math.max(maxPtys, h.length);
    for (const x of h) gens.add(x.pid);
  }
  await sleep(2000);
  // The restarted pane's pty id changed; find the Claude pane's new pty as the id that is not the pwsh pane's.
  const hNow = await health(page);
  const claudeNow = hNow.filter((x) => x.paneId !== pwshPtyId);
  r.evidence.phase2 = { ptysAfter: hNow.map((x) => ({ id: x.paneId, pid: x.pid, proc: x.procName })), maxConcurrentPtys: maxPtys, distinctRootPids: gens.size };
  r.check("exactly 2 live ptys after the 20 Claude restarts (pwsh pane + one Claude)", hNow.length === 2 && claudeNow.length === 1, r.evidence.phase2);
  setPty(cM, claudeNow[0].paneId);
  const tail = await claudeReady(page, cM, { must: /haiku/i, timeoutMs: 120000 });
  r.check("Claude pane shows a fresh banner (Claude Code, Haiku) after the last restart", /Claude\s*Code/i.test(tail) && /haiku/i.test(tail), tail.split("\n").slice(-6));
  r.shot(await d.shotWindow(page, shotPath("restart-x20-claude")));
  await sleep(6000);
  const after = tree();
  r.evidence.after = treeBrief(after);
  const stale = [...gens].filter((p) => p !== claudeNow[0].pid && p !== pwshPid && alive(p));
  r.evidence.stalePidsStillAlive = stale;
  r.check("no superseded Claude/pwsh root processes still alive", stale.length === 0, { stale, generationsSeen: gens.size });
  r.check("Canary process tree is back to its baseline size (no leaked processes)", after.count === baseline.count, { baseline: treeBrief(baseline), after: treeBrief(after) });
  return c;
});
