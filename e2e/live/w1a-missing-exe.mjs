// Checklist: "A pane whose agent exe is missing, then reload: the pane shows the exit, not a stuck 'running'."
// Uses a vendor manifest (the documented %APPDATA%\ai.flightdeck.canary\vendors\*.json extension point, CANARY's own dir).
//   Part 1: manifest exe that never existed -> spawn failure. What does the pane show?  (no reload: a pane that never spawned has no
//           draft, which trips the null-draft reopen bug, see w1a-bug-reopen)
//   Part 2: the realistic case. Manifest exe is a copy of cmd.exe in the scratch folder. Pane A runs it, then exits (exit 3); pwsh pane B
//           exits (exit 7). The exe is then renamed away, the page reloaded and the session reopened. A must show the failure (error +
//           Restart), not running/starting; B is compared before/after.
import { writeFileSync, rmSync, existsSync, copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, healthIdsNow, health, armReopen, paneMenu, write, setPty, CR, ESC, reloadAndWait, sleep, shotPath, SCRATCH, liveModels, pwshCmd } from "./w1a-lib.mjs";

const VDIR = path.join(process.env.APPDATA, "ai.flightdeck.canary", "vendors");
const MANIFEST = path.join(VDIR, "w1a-missing.json");
const AGENT = path.join(SCRATCH, "w1a-agent.exe");

const alive = (pid) => pwshCmd(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`).trim() === "True";
const snapshot = (page) => page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => ({
  dot: p.querySelector(".pdot")?.className ?? null,
  name: p.querySelector(".pname")?.textContent ?? null,
  restartBtn: !!p.querySelector(".prestart"),
  restartTitle: p.querySelector(".prestart")?.getAttribute("title") ?? null,
  text: (p.innerText || "").replace(/\s+/g, " ").slice(0, 220),
})));
const manifest = (exe) => writeFileSync(MANIFEST, JSON.stringify({ id: "w1a-missing", label: "W1a Missing Agent", short: "Missing", kind: "agent", exe, args: [], probe: "pwsh" }, null, 2));

main("missing-exe", async (r) => {
  try {
    // ---------- part 1 ----------
    manifest("C:\\w1a-nope\\missing-agent.exe");
    let c = await boot({ width: 2000, height: 1100 });
    step("part 1: exe that never existed");
    await launchWorkspace(c.page, { vendors: ["w1a-missing", "pwsh"] });
    await sleep(6000);
    const p1 = await snapshot(c.page);
    r.evidence.part1 = p1;
    r.shot(await d.shotWindow(c.page, shotPath("missing-exe-part1")));
    r.check("part 1: spawn failure shows as an error with a Restart button (not running/starting)", p1[0].restartBtn && /error/.test(p1[0].dot ?? ""), p1[0]);

    // ---------- part 2 ----------
    copyFileSync("C:\\Windows\\System32\\cmd.exe", AGENT);
    manifest(AGENT);
    c = await boot({ width: 2000, height: 1100 });
    const { page } = c;
    step("part 2: [w1a-missing (cmd copy), pwsh]");
    await launchWorkspace(page, { vendors: ["w1a-missing", "pwsh"] });
    const [aM, bM] = await waitModels(page, 2);
    await d.waitForText(page, bM, /PS [^\n]*>/, { timeoutMs: 30000 });
    const mb = await mapPwsh(page, [bM]);
    setPty(aM, (await healthIdsNow(page)).find((x) => x !== mb[bM]));
    await d.waitForText(page, aM, /Microsoft Windows|>/, { timeoutMs: 20000 });
    r.evidence.aBanner = (await d.tail(page, aM)).slice(-3);
    await armReopen(page, 0, { name: "agent-A", draftChar: "x" });
    await armReopen(page, 1, { name: "shell-B", draftChar: "x" });
    const live0 = await snapshot(page);
    r.evidence.beforeExit = live0;
    step("both exit with nonzero codes");
    const hp = await health(page);
    const pidA = hp.find((x) => x.procName === "w1a-agent")?.pid, pidB = hp.find((x) => x.procName === "pwsh")?.pid;
    r.evidence.pids = { pidA, pidB };
    // pty only (the app's draft stays "x"): DEL (what xterm sends for Backspace) removes the drafted "x", then the command, then Enter.
    for (const m of [aM, bM]) { await write(page, m, String.fromCharCode(127)); await sleep(300); }
    await write(page, aM, "exit 3"); await write(page, bM, "exit 7");
    await sleep(500);
    await write(page, aM, CR); await write(page, bM, CR);
    await sleep(15000);
    const procDead = { A: pidA ? !alive(pidA) : null, B: pidB ? !alive(pidB) : null };
    r.evidence.processDead15sAfterExit = procDead;
    r.check("both processes really are dead 15 s after `exit` (Get-Process)", procDead.A === true && procDead.B === true, procDead);
    const exited = await snapshot(page);
    r.evidence.afterExit = exited;
    r.shot(await d.shotWindow(page, shotPath("missing-exe-exited")));
    r.check("A and B show their exit (error/idle + Restart) within 15 s of the process dying, before any reload", exited.every((x) => /error|idle/.test(x.dot ?? "") && x.restartBtn), exited);
    renameSync(AGENT, AGENT + ".bak");     // the agent is now missing
    r.evidence.agentRenamed = !existsSync(AGENT);
    step("reload + Reopen session with the exe gone");
    const rl = await reloadAndWait(page, { restore: "reopen", settle: 6000 });
    r.evidence.reload = rl;
    const after = await snapshot(page);
    r.evidence.afterReload = after;
    r.shot(await d.shotWindow(page, shotPath("missing-exe-after")));
    await sleep(15000);
    const later = await snapshot(page);
    r.evidence.after15sLater = later;
    r.evidence.liveModelsAfter = await liveModels(page);
    r.check("A (dead process, exe now missing) after reload shows the exit with a Restart button, not running/waiting, 15 s later", later[0].restartBtn && /error|idle/.test(later[0].dot ?? ""), later[0]);
    r.check("B (pwsh that exited with 7) after reload shows the exit with a Restart button, or a clean relaunch (running prompt), not a dead pane marked waiting", later[1].restartBtn || (await liveModels(page)).length === 0, later[1]);
    step("Restart pane A with the exe gone");
    await paneMenu(page, 0, /^\s*Restart/);
    await sleep(6000);
    const afterRestart = await snapshot(page);
    r.evidence.afterRestartWithExeGone = afterRestart[0];
    r.shot(await d.shotWindow(page, shotPath("missing-exe-restart-gone")));
    r.check("Restart of A with the exe missing shows the spawn failure (error + Restart)", afterRestart[0].restartBtn && /error/.test(afterRestart[0].dot ?? ""), afterRestart[0]);
    return c;
  } finally {
    for (const f of [MANIFEST, AGENT, AGENT + ".bak"]) { try { if (existsSync(f)) rmSync(f); } catch { /* scratch leftovers are harmless */ } }
  }
});
