// Checklist regression: "After restoring a session (or restarting a pane), Broadcast, Review 'send to agent' and palette 'New task'
// all reach the right pane."  Four pwsh panes echo what they receive. Panes 2 and 4 are restarted and the whole session is reloaded +
// reopened so pty ids no longer equal pane (model) ids; each route then targets ONE pane and the marker must land there and nowhere else.
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, armReopen, typeInto, paneMenu, reloadAndWait, claudeReady, setPty, healthIdsNow, health, jsClick, jsFill, sleep, shotPath, REPO, liveModels } from "./w1a-lib.mjs";

const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const hasMark = async (page, m, mark) => (await d.tail(page, m, 16384)).join("\n").replace(/\s+/g, "").includes(mark.replace(/\s+/g, ""));

async function whoGot(page, mids, mark) {
  const got = [];
  for (const m of mids) if (await hasMark(page, m, mark)) got.push(m);
  return got;
}

main("regress-paneid", async (r) => {
  // scratch diff for the Review route: notes9.txt committed, then edited with harmless comment lines
  const f = path.join(REPO, "notes9.txt");
  writeFileSync(f, ["# notes9", "# base line 1", "# base line 2", ""].join("\n"));
  git("add", "notes9.txt"); try { git("-c", "user.name=w1a", "-c", "user.email=w1a@example.invalid", "commit", "-q", "-m", "w1a notes9 base"); } catch { /* already committed */ }
  appendFileSync(f, ["# RVMARK-ALPHA first changed line", "# RVMARK-BETA second changed line", ""].join("\n"));
  r.evidence.repoStatus = git("status", "--short");

  const c = await boot({ width: 2400, height: 1200 });
  const { page } = c;
  step("4 pwsh panes");
  await launchWorkspace(page, { vendors: ["pwsh", "pwsh", "pwsh", "pwsh"] });
  let mids = await waitModels(page, 4);
  for (const m of mids) await d.waitForText(page, m, /PS [^\n]*>/, { timeoutMs: 30000 });
  const map0 = await mapPwsh(page, mids);
  r.evidence.mapBefore = map0;

  step("restart panes 2 and 4, then reload + Reopen");
  await paneMenu(page, 1, /^\s*Restart/); await sleep(1500);
  await paneMenu(page, 3, /^\s*Restart/); await sleep(2500);
  for (let i = 0; i < 4; i++) await armReopen(page, i, { name: `rp-${i + 1}`, draftChar: "", settleMs: 0 });
    for (let i = 0; i < 4; i++) await typeInto(page, i, "x");
  await sleep(3500);
  await reloadAndWait(page, { restore: "reopen", settle: 4000 });
  mids = await waitModels(page, 4);
  for (const m of mids) await d.waitForText(page, m, /PS [^\n]*>/, { timeoutMs: 30000 });
  const map1 = await mapPwsh(page, mids);
  r.evidence.mapAfter = map1;
  const mismatched = mids.filter((m) => map1[m] !== m);
  r.check("precondition: after restart + restore, pty ids differ from pane ids for at least one pane", mismatched.length > 0, { map1, mismatched });
  r.shot(await d.shotWindow(page, shotPath("regress-paneid-start")));
  // clear the 'x' drafts typed at the prompts so they do not pollute the echo, and the mapping comments
  for (const m of mids) await d.invoke(page, "pty_write", { paneId: map1[m], data: String.fromCharCode(21) });   // Ctrl+U in PSReadLine

  // ---- Broadcast ----
  step("Broadcast to a single pane at a time");
  const bc = [];
  for (const target of [1, 3, 2]) {   // pane indexes: restarted, restarted, plain
    await jsClick(page.locator('button[title="Broadcast to panes"]'));
    await page.waitForSelector(".bc-chip", { timeout: 8000 });
    const chips = page.locator(".bc-chip");
    const n = await chips.count();
    const states = await chips.evaluateAll((els) => els.map((e) => ({ cls: e.className, dis: e.disabled })));
    for (let i = 0; i < n; i++) if (i !== target) await jsClick(chips.nth(i));
    const mark = `BCMARK-${target + 1}-${Date.now() % 100000}`;
    await jsFill(page.locator(".bc-input"), `echo ${mark}`);
    await sleep(200);
    await jsClick(page.locator(".bc-send"));
    await sleep(2500);
    const got = await whoGot(page, mids, mark);
    bc.push({ targetIndex: target, targetModel: mids[target], mark, got, chipStates: states });
    // restore chip selection for the next round
    if (await page.locator(".bc-chip").count()) { const ch = page.locator(".bc-chip"); for (let i = 0; i < n; i++) { const cls = await ch.nth(i).getAttribute("class"); if (/\boff\b/.test(cls ?? "")) await jsClick(ch.nth(i)); } }
    if (await page.locator(".bc-bar").count()) await jsClick(page.locator(".bc-x"));
    await sleep(300);
  }
  r.evidence.broadcast = bc;
  for (const b of bc) r.check(`Broadcast to pane ${b.targetIndex + 1} (model ${b.targetModel}, pty ${map1[b.targetModel]}) reached exactly that pane`, b.got.length === 1 && b.got[0] === b.targetModel, b);

  // ---- Review: send selected diff lines to the pane ----
  step("Review 'send to agent' on a restarted pane");
  const rv = [];
  for (const target of [1, 2]) {
    await paneMenu(page, target, /Review changes/);
    await page.waitForSelector(".rv-patch [data-line]", { timeout: 15000 });
    // pick the notes9.txt file if the drawer lists files
    const item = page.locator("button.rv-file").filter({ hasText: /notes9/ }).first();
    if (await item.count()) { await jsClick(item); await sleep(1500); }
    const lines = await page.locator(".rv-patch [data-line]").evaluateAll((els) => els.map((e) => ({ i: e.getAttribute("data-line"), t: e.textContent })));
    const a = lines.find((l) => /RVMARK-ALPHA/.test(l.t ?? ""));
    const b = lines.find((l) => /RVMARK-BETA/.test(l.t ?? ""));
    const ok = !!(a && b);
    const countMarks = async (m) => ((await d.tail(page, m, 16384)).join("\n").match(/RVMARK-(ALPHA|BETA)/g) ?? []).length;
    const countsBefore = {};
    for (const m of mids) countsBefore[m] = await countMarks(m);
    if (ok) {
      await page.evaluate(([ai, bi]) => {
        const sa = document.querySelector(`.rv-patch [data-line="${ai}"]`), sb = document.querySelector(`.rv-patch [data-line="${bi}"]`);
        const s = window.getSelection(); s.removeAllRanges();
        s.setBaseAndExtent(sa, 0, sb, sb.childNodes.length);
      }, [a.i, b.i]);
      await jsClick(page.locator('button[title^="Select diff lines above"]'));
      await sleep(2500);
    }
    // the prompt carries the diff lines; the unique tokens are RVMARK-ALPHA / RVMARK-BETA, so count which panes show them
    const got = [];
    const countsAfter = {};
    for (const m of mids) { countsAfter[m] = await countMarks(m); if (countsAfter[m] > countsBefore[m]) got.push(m); }
    rv.push({ targetIndex: target, targetModel: mids[target], selectedOk: ok, linesSeen: lines.length, got, countsBefore, countsAfter });
    r.shot(await d.shotWindow(page, shotPath(`regress-paneid-review-${target + 1}`)));
    // close drawer
    const closeBtn = page.locator('.rv-head button[title^="Close"]').first();
    if (await closeBtn.count()) await jsClick(closeBtn);
    await sleep(500);
    // wipe the typed prompt so the next round starts clean: Ctrl+U then clear screen
    for (const m of mids) await d.invoke(page, "pty_write", { paneId: map1[m], data: String.fromCharCode(21) + "Clear-Host\r" });
    await sleep(1200);
  }
  r.evidence.review = rv;
  for (const x of rv) r.check(`Review 'send to agent' on pane ${x.targetIndex + 1} (model ${x.targetModel}) reached exactly that pane`, x.selectedOk && x.got.length === 1 && x.got[0] === x.targetModel, x);

  // ---- palette New task ----
  step("palette New task");
  await d.invoke(page, "stage_launch_args", { vendor: "claude", cwd: REPO, args: ["--model", "haiku", "--permission-mode", "acceptEdits"] });
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
  const input = page.locator('input[placeholder^="Jump to"]');
  await input.waitFor({ timeout: 8000 });
  await jsFill(input, "New task");
  await sleep(500);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  const tin = page.locator('input[aria-label="New task description"]');
  await tin.waitFor({ timeout: 8000 });
  const TASK = "Reply with exactly the word NEWTASK-4417 and nothing else, no tools.";
  await jsFill(tin, TASK);
  await sleep(300);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  step("wait for the new pane");
  let all = mids;
  const tNew = Date.now();
  while (Date.now() - tNew < 60000) { all = await liveModels(page); if (all.length >= 5) break; await sleep(500); }
  const newM = all.filter((m) => !mids.includes(m))[0];
  r.check("task started a 5th pane", !!newM, { all });
  if (newM) {
    // wait for the task text to show in that pane (typed once Claude is ready), up to 90 s
    let seen = false;
    const tt = Date.now();
    while (Date.now() - tt < 120000) { if (await hasMark(page, newM, "NEWTASK-4417")) { seen = true; break; } await sleep(1000); }
    await sleep(1500);
    const got = await whoGot(page, [...mids, newM], "NEWTASK-4417");
    r.evidence.newTask = { newModel: newM, got, seen, tail: (await d.tail(page, newM)).slice(-8) };
    r.shot(await d.shotWindow(page, shotPath("regress-paneid-newtask")));
    r.check("New task text reached the new pane and no other pane", seen && got.length === 1 && got[0] === newM, r.evidence.newTask);
  }
  return c;
});
