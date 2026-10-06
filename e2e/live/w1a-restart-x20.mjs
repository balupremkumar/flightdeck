// Checklist: "Restart one pane 20 times quickly: it never shows the old agent." (+ no leaked processes afterwards)
// Restart keeps the pane's terminal history on screen by design (same xterm, new pty), so "old agent" is judged by PROCESS identity:
//   Phase 1 (pwsh, 10 restarts, each verified): after every restart the pane's root process is a never-seen pid, `$PID` typed into
//            the pane equals that pid, and the previous pid dies.
//   Phase 2 (pwsh, 20 restarts 250 ms apart): afterwards exactly one pty for the pane, its pid is new, `$PID` matches, all earlier
//            generations are dead.
//   Phase 3 (Claude haiku, 20 restarts 350 ms apart, launch args re-staged for each): one Claude generation alive, fresh banner on
//            Haiku, the Canary tree has the same process mix as before (no leaked processes).
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, healthIdsNow, health, claudeReady, typeInto, CR, paneMenu, setPty, sleep, shotPath, tree, treeBrief, pwshCmd, REPO, FLAGS } from "./w1a-lib.mjs";

const alive = (pid) => pwshCmd(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`).trim() === "True";
const restart = (page, i) => paneMenu(page, i, /^\s*Restart/);
const pwshRoots = async (page) => (await health(page)).filter((x) => /^pwsh$/i.test(x.procName ?? ""));
const mix = (t) => Object.fromEntries(Object.entries(treeBrief(t).byName).filter(([k]) => !/conhost|msedgewebview2|cmd/i.test(k)));

main("restart-x20", async (r) => {
  const c = await boot({ width: 2200, height: 1100 });
  const { page } = c;
  step("launch [pwsh, claude]");
  await launchWorkspace(page, { vendors: ["pwsh", "claude"] });
  const [pM, cM] = await waitModels(page, 2);
  await d.waitForText(page, pM, /PS [^\n]*>/, { timeoutMs: 30000 });
  const m0 = await mapPwsh(page, [pM]);
  setPty(cM, (await healthIdsNow(page)).find((x) => x !== m0[pM]));
  await claudeReady(page, cM, { must: /haiku/i });
  await sleep(4000);
  const baseline = tree();
  r.evidence.baseline = treeBrief(baseline);

  // ---- phase 1 ----
  step("phase 1: 10 verified pwsh restarts");
  const seen = new Set();
  const p1 = [];
  let prev = (await pwshRoots(page)).find((x) => x.paneId === m0[pM])?.pid;
  seen.add(prev);
  for (let g = 1; g <= 10; g++) {
    await restart(page, 0);
    let np = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const cand = (await pwshRoots(page)).find((x) => !seen.has(x.pid));
      if (cand) { np = cand.pid; break; }
      await sleep(100);
    }
    if (np) seen.add(np);
    await sleep(2500);   // let the new PSReadLine prompt come up
    await typeInto(page, 0, `"GENPID=$PID;"${CR}`);
    await sleep(1200);
    const txt = (await d.tail(page, pM, 8192)).join("\n").replace(/\s+/g, "");
    const all = [...txt.matchAll(/GENPID=(\d+);/g)].map((x) => Number(x[1]));
    const last = all[all.length - 1];
    p1.push({ g, newRootPid: np, typedPid: last, match: !!np && last === np, prevAlive: prev ? alive(prev) : null });
    prev = np;
  }
  r.evidence.phase1 = p1;
  r.check("phase 1: every restart produced a never-seen root pid and `$PID` typed into the pane equals it (never an old process)", p1.every((x) => x.match), p1.filter((x) => !x.match));
  r.check("phase 1: each superseded pwsh was dead by the next restart", p1.slice(1).every((x) => x.prevAlive === false), p1.map((x) => x.prevAlive));
  r.shot(await d.shotWindow(page, shotPath("restart-x20-phase1")));

  // ---- phase 2 ----
  step("phase 2: 20 rapid pwsh restarts");
  const before2 = new Set(seen);
  for (let g = 1; g <= 20; g++) { await restart(page, 0); await sleep(250); }
  await sleep(6000);
  const roots = await pwshRoots(page);
  const h2 = await health(page);
  r.evidence.phase2 = { ptys: h2.map((x) => ({ id: x.paneId, pid: x.pid, proc: x.procName })) };
  const cur = roots[0];
  r.check("phase 2: exactly one pwsh pty for the pane after 20 rapid restarts, with a never-seen pid", roots.length === 1 && !before2.has(cur?.pid), { roots: roots.map((x) => x.pid), h2: r.evidence.phase2 });
  await typeInto(page, 0, `"GENPID=$PID;"${CR}`);
  await sleep(1500);
  const txt2 = (await d.tail(page, pM, 8192)).join("\n").replace(/\s+/g, "");
  const last2 = Number([...txt2.matchAll(/GENPID=(\d+);/g)].pop()?.[1]);
  r.check("phase 2: `$PID` typed into the pane equals the pane's live root pid", last2 === cur?.pid, { last2, live: cur?.pid });
  const stale2 = [...before2].filter((p) => p !== cur?.pid && alive(p));
  r.check("phase 2: no earlier pwsh generation still alive", stale2.length === 0, stale2);
  r.shot(await d.shotWindow(page, shotPath("restart-x20-phase2")));

  // ---- phase 3 ----
  step("phase 3: 20 Claude restarts (args re-staged each time)");
  const claudeGens = new Set();
  const snap0 = await health(page);
  for (const x of snap0) claudeGens.add(x.pid);
  for (let g = 1; g <= 20; g++) {
    await page.evaluate(([cwd, args]) => window.__TAURI_INTERNALS__.invoke("stage_launch_args", { vendor: "claude", cwd, args }), [REPO, FLAGS]);
    await restart(page, 1);
    await sleep(350);
    for (const x of await health(page)) claudeGens.add(x.pid);
  }
  await sleep(2500);
  const h3 = await health(page);
  const pwshNowId = (await pwshRoots(page))[0]?.paneId;
  const claudePane = h3.find((x) => x.paneId !== pwshNowId);
  r.evidence.phase3 = { ptys: h3.map((x) => ({ id: x.paneId, pid: x.pid, proc: x.procName })), generationsSeen: claudeGens.size };
  r.check("phase 3: exactly 2 live ptys (pwsh pane + one Claude)", h3.length === 2 && !!claudePane, r.evidence.phase3);
  setPty(cM, claudePane.paneId);
  const tail = await claudeReady(page, cM, { must: /haiku/i, timeoutMs: 120000 });
  r.check("phase 3: Claude pane shows a fresh banner on Haiku after the last restart", /Claude\s*Code/i.test(tail) && /haiku/i.test(tail), tail.split("\n").slice(-6));
  r.shot(await d.shotWindow(page, shotPath("restart-x20-phase3")));
  await sleep(8000);
  const after = tree();
  r.evidence.after = treeBrief(after);
  r.evidence.mixBaseline = mix(baseline);
  r.evidence.mixAfter = mix(after);
  const stale3 = [...claudeGens].filter((p) => p !== claudePane.pid && p !== cur?.pid && alive(p));
  r.check("phase 3: no superseded root process still alive", stale3.length === 0, { stale3, generationsSeen: claudeGens.size });
  const diff = Object.keys({ ...mix(baseline), ...mix(after) }).filter((k) => (mix(baseline)[k] ?? 0) !== (mix(after)[k] ?? 0));
  r.check("phase 3: Canary process tree has the same process mix as the baseline (no leaked agents, MCP servers or shells)", diff.length === 0, { baseline: mix(baseline), after: mix(after), diff });
  return c;
});
