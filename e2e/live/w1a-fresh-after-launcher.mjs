// Checklist: "Reload, pick the launcher, wait 10 s, open the same folder with the same agent: it starts fresh, not last session's agent."
// Workspace of [pwsh, claude(haiku)] on the sweep repo, each carrying a marker (pwsh: echoed text and an env var; Claude: a one-line
// reply). Reload, answer the restore prompt with Cancel (the launcher), wait 10 s, open the same folder with the same two agents.
// The new panes must be different processes with none of the old content.
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, mapClaudeSingle, healthIdsNow, health, claudeReady, armReopen, write, CR, reloadAndWait, setPty, pwshCmd, sleep, shotPath, liveModels, REPO } from "./w1a-lib.mjs";

const alive = (pid) => pwshCmd(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`).trim() === "True";

main("fresh-after-launcher", async (r) => {
  const c = await boot({ width: 2200, height: 1100 });
  const { page } = c;
  step("launch [pwsh, claude]");
  await launchWorkspace(page, { vendors: ["pwsh", "claude"] });
  const mids = await waitModels(page, 2);
  const [pM, cM] = mids;
  await d.waitForText(page, pM, /PS [^\n]*>/, { timeoutMs: 30000 });
  // pane order is pwsh first, claude second
  const ids = (await healthIdsNow(page));
  const m = await mapPwsh(page, [pM]);
  const claudePty = ids.find((x) => x !== m[pM]);
  setPty(cM, claudePty);
  await claudeReady(page, cM, { must: /haiku/i });
  const h0 = await health(page);
  const old = { pwshPid: h0.find((x) => x.paneId === m[pM]).pid, claudePid: h0.find((x) => x.paneId === claudePty).pid };
  r.evidence.old = old;

  step("leave markers");
  await write(page, pM, `$env:FD_OLD='yes'; echo OLDMARK-PWSH-7731${CR}`);
  await write(page, cM, `Reply with exactly the word OLDMARK-CLAUDE-5519 and nothing else, no tools.`);
  await sleep(300);
  await write(page, cM, CR);
  await d.waitForText(page, pM, /OLDMARK-PWSH-7731/, { timeoutMs: 20000 });
  const tw = Date.now();
  while (Date.now() - tw < 180000) { if (((await d.tail(page, cM)).join(" ").match(/OLDMARK-CLAUDE-5519/g) ?? []).length >= 2) break; await sleep(1000); }
  await d.waitQuiet(page, cM, { quietMs: 4000, minMs: 4000, timeoutMs: 60000 });
  r.evidence.oldTailClaude = (await d.tail(page, cM)).slice(-8);
  r.check("old Claude pane has its marker answer", (await d.tail(page, cM)).join(" ").includes("OLDMARK-CLAUDE-5519"), r.evidence.oldTailClaude);

  step("arm reopen, reload, Cancel (launcher)");
  await armReopen(page, 0, { name: "old-pwsh", draftChar: "x" });
  await armReopen(page, 1, { name: "old-claude", draftChar: "x" });
  const rl = await reloadAndWait(page, { restore: "cancel", settle: 0 });
  r.evidence.reload = rl;
  r.check("launcher is showing (no panes) after Cancel", (await page.locator(".pane").count()) === 0 && (await page.locator(".launcher").count()) > 0);
  step("wait 10 s");
  await sleep(10000);
  const hMid = await health(page);
  r.evidence.afterWait10s = { ptys: hMid.map((x) => ({ id: x.paneId, pid: x.pid, proc: x.procName })), liveModels: await liveModels(page) };

  step("open the same folder with the same agents");
  const hb = (await healthIdsNow(page));
  await launchWorkspace(page, { root: REPO, vendors: ["pwsh", "claude"] });
  const mids2 = await waitModels(page, 2);
  const [pM2, cM2] = mids2;
  await d.waitForText(page, pM2, /PS [^\n]*>/, { timeoutMs: 30000 });
  const m2 = await mapPwsh(page, [pM2]);
  const claudePty2 = (await healthIdsNow(page)).find((x) => x !== m2[pM2]);
  setPty(cM2, claudePty2);
  await claudeReady(page, cM2, { must: /haiku/i });
  const h1 = await health(page);
  const nw = { pwshPid: h1.find((x) => x.paneId === m2[pM2]).pid, claudePid: h1.find((x) => x.paneId === claudePty2).pid };
  r.evidence.new = nw;
  const tailP = (await d.tail(page, pM2)).join("\n");
  const tailC = (await d.tail(page, cM2)).join("\n");
  r.shot(await d.shotWindow(page, shotPath("fresh-after-launcher")));
  r.check("new pwsh pane is a different process from the old one", nw.pwshPid !== old.pwshPid, { old: old.pwshPid, new: nw.pwshPid });
  r.check("new Claude pane is a different process from the old one", nw.claudePid !== old.claudePid, { old: old.claudePid, new: nw.claudePid });
  r.check("old processes are gone", !alive(old.pwshPid) && !alive(old.claudePid), { pwshAlive: alive(old.pwshPid), claudeAlive: alive(old.claudePid) });
  r.check("new pwsh pane has none of the old content (no OLDMARK)", !/OLDMARK/.test(tailP), tailP.split("\n").slice(-3));
  r.check("new Claude pane is a fresh session (banner, no OLDMARK)", !/OLDMARK/.test(tailC) && /Claude\s*Code/i.test(tailC), tailC.split("\n").slice(-6));
  await write(page, pM2, `"FD_OLD=[$env:FD_OLD]"${CR}`);
  await sleep(1200);
  const envLine = (await d.tail(page, pM2)).join("\n");
  r.check("new pwsh pane does not have the old env var", /FD_OLD=\[\]/.test(envLine), envLine.split("\n").slice(-3));
  return c;
});
