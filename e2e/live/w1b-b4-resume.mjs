// B (part 4): the Quiet terminal switch after the red team H1/M1 fix (b8cf0db). Live, Haiku, one quiet pane.
// 1. resume_id is the pane's own pinned session id. 2. After a real /clear, record how Claude marks the rotation in the
// pane's own transcript (the fix follows `new_conversation_id`; its shape was never seen on disk) and check that the
// switch resumes the post-clear conversation. 3. M1: switching a pane whose Claude has exited still resumes it.
// No /focus. Only the pane's own test transcript (sweep repo) is read, and only record types and keys are kept.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, mapClaudeSingle, healthIdsNow, claudeReady, write, say, textOf, idle, sleep, shotPath, teardown, stableSnapshot, quietItem, paneInfo, dialogText } from "./w1b-lib.mjs";

const T1 = "AMBER-OTTER-3", T2 = "COBALT-HERON-9";
const lines = (t, n = 14) => t.split("\n").filter((l) => l.trim()).slice(-n);
/** Record shapes (type/subtype/keys) in a transcript that mention a reset or another conversation id. No content. */
function resetShapes(file) {
  if (!file || !existsSync(file)) return { file, exists: false };
  const out = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!/clear|reset|new_conversation|conversation_id/i.test(l)) continue;
    try {
      const v = JSON.parse(l);
      const keys = (o, pre = "") => Object.entries(o ?? {}).flatMap(([k, x]) => x && typeof x === "object" && !Array.isArray(x) ? keys(x, `${pre}${k}.`) : [`${pre}${k}`]);
      out.push({ type: v.type, subtype: v.subtype, keys: keys(v).filter((k) => !/content|text|message\.content/i.test(k)).slice(0, 30), hasNewConversationId: /new_conversation_id/.test(l) });
    } catch { /* partial line */ }
  }
  return { file: path.basename(file), exists: true, records: out.slice(-6) };
}

main("b4-resume", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 2200, height: 1100, openClaudeIn: "quiet" });
    const { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    step("quiet pane, one turn");
    const b0 = await healthIdsNow(page);
    await launchWorkspace(page, { vendors: ["claude"] });
    const [mid] = await waitModels(page, 1);
    let pty = await mapClaudeSingle(page, mid, b0);
    await claudeReady(page, mid, { must: /haiku/i });
    await say(page, mid, `Reply with exactly the single word ${T1} and nothing else.`);
    await sleep(3000); await idle(page, mid);
    const i1 = await paneInfo(page, pty);
    r.evidence.info1 = { session_id: i1.session_id, pinned: i1.pinned, resume_id: i1.resume_id, jsonl: i1.jsonl_path && path.basename(i1.jsonl_path) };
    r.check("resume_id is the pane's own pinned session id", i1.pinned && !!i1.resume_id && i1.resume_id === i1.session_id, r.evidence.info1);

    step("/clear, then a second turn");
    await say(page, mid, "/clear");
    await sleep(4000);
    await say(page, mid, `Reply with exactly the single word ${T2} and nothing else.`);
    await sleep(3000); await idle(page, mid);
    const i2 = await paneInfo(page, pty);
    r.evidence.info2 = { session_id: i2.session_id, resume_id: i2.resume_id, rotated: i2.rotated, jsonl: i2.jsonl_path && path.basename(i2.jsonl_path) };
    r.evidence.resetRecordInPreClearTranscript = resetShapes(i1.jsonl_path);
    const followed = !!i2.resume_id && i2.resume_id !== i1.resume_id;
    r.check("after /clear, resume_id follows the pane's own reset record to the new conversation", followed, { info2: r.evidence.info2, shapes: r.evidence.resetRecordInPreClearTranscript });

    step("switch to the full terminal");
    const ids = await healthIdsNow(page);
    await quietItem(page, 0, { click: true });
    await page.waitForSelector(".confirm-modal", { timeout: 5000 });
    await page.locator(".confirm-modal .btn-primary").evaluate((el) => el.click());
    await sleep(1500);
    pty = await mapClaudeSingle(page, mid, ids);
    await claudeReady(page, mid, { timeoutMs: 120000 });
    await sleep(4000);
    const i3 = await paneInfo(page, pty);
    const t3 = await textOf(page, mid);
    r.evidence.info3 = { session_id: i3.session_id, resume_id: i3.resume_id };
    r.shot(await d.shotWindow(page, shotPath("b4-after-switch")));
    r.check("switch resumes the post-clear conversation (its answer is in the restarted pane)", t3.includes(T2), lines(t3));
    r.check("switch did not resurrect the pre-clear conversation", !t3.includes(T1), lines(t3));

    step("M1: Claude exits, then switch back to Quiet");
    await say(page, mid, "/exit");
    let exited = false;
    for (let i = 0; i < 40 && !exited; i++) { await sleep(500); exited = await page.locator(".pane").first().locator(".prestart").count() > 0; }
    r.check("pane shows exited (Restart) after /exit", exited);
    const ids2 = await healthIdsNow(page);
    await quietItem(page, 0, { click: true });
    await page.waitForSelector(".confirm-modal", { timeout: 5000 });
    const dlg = await dialogText(page);
    await page.locator(".confirm-modal .btn-primary").evaluate((el) => el.click());
    await sleep(1500);
    pty = await mapClaudeSingle(page, mid, ids2);
    await claudeReady(page, mid, { timeoutMs: 120000 });
    await sleep(4000);
    const t4 = await textOf(page, mid);
    const i4 = await paneInfo(page, pty);
    r.evidence.m1 = { dialog: dlg, info4: { session_id: i4.session_id, resume_id: i4.resume_id } };
    r.shot(await d.shotWindow(page, shotPath("b4-exited-switch")));
    r.check("M1: switching an exited pane resumes its conversation (same session, answer visible)", t4.includes(T2) && i4.resume_id === i3.resume_id, { tail: lines(t4), m1: r.evidence.m1 });
    r.check("no pageerror", errors.length === 0, errors.slice(0, 3));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    r.check("~/.claude.json briefTranscript and ~/.claude/settings.json unchanged by the run", r.evidence.safetyAfter.briefTranscript === r.evidence.safetyBefore.briefTranscript && r.evidence.safetyAfter.settingsSha === r.evidence.safetyBefore.settingsSha, { before: r.evidence.safetyBefore, after: r.evidence.safetyAfter });
    await teardown();
  }
});
