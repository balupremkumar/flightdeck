// B (part 2): per-pane "Quiet terminal" switch after one real Haiku turn: confirm dialog copy, pane restarts, SAME conversation
// (session id via pane_session_info before/after, earlier answer visible), both directions; Ctrl+O shows the full transcript in quiet.
import { main, boot, d, step, launchWorkspace, waitModels, mapClaudeSingle, healthIdsNow, claudeReady, write, say, textOf, idle, sleep, shotPath, teardown, stableSnapshot, quietItem, paneInfo, dialogText, jsClick, claudeCmdlines, health, REPO } from "./w1b-lib.mjs";

const TOKEN = "PURPLE-FALCON-7";
const sid = (info) => info.jsonl_path?.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, "") ?? info.session_id;

main("b2-switch", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 2000, height: 1100, openClaudeIn: "quiet" });
    const { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    step("launch quiet claude pane (haiku)");
    const b0 = await healthIdsNow(page);
    await launchWorkspace(page, { vendors: ["claude"] });
    const [mid] = await waitModels(page, 1);
    let pty = await mapClaudeSingle(page, mid, b0);
    await claudeReady(page, mid, { must: /haiku/i });
    r.check("pane starts in Quiet terminal (menu checkbox checked)", (await quietItem(page, 0)) === true);

    step("one real Haiku turn with a Read tool call");
    await say(page, mid, `Use the Read tool to read package.json in this folder, then reply with exactly the single word ${TOKEN} and nothing else.`);
    await sleep(3000);
    await idle(page, mid);
    r.shot(await d.shotWindow(page, shotPath("b2-quiet-after-turn")));
    const t1 = await textOf(page, mid);
    r.check(`quiet pane shows the final answer ${TOKEN}`, t1.includes(TOKEN), t1.split("\n").slice(-12));
    const info1 = await paneInfo(page, pty);
    r.evidence.sessionBefore = { sid: sid(info1), jsonl: info1.jsonl_path };
    r.check("pane_session_info reports a session transcript before the switch", !!sid(info1), info1);

    async function flip(label, expectQuietAfter) {
      step(label);
      const ids = await healthIdsNow(page);
      await quietItem(page, 0, { click: true });
      await page.waitForSelector(".confirm-modal", { timeout: 5000 });
      const dlg = await dialogText(page);
      r.shot(await d.shotWindow(page, shotPath(`b2-confirm-${expectQuietAfter ? "to-quiet" : "to-full"}`)));
      r.evidence[label + " dialog"] = dlg;
      const wantTitle = expectQuietAfter ? "Switch to Quiet terminal?" : "Switch to the full terminal?";
      const wantBody = "Claude restarts in " + (expectQuietAfter ? "Quiet terminal" : "the full terminal") + " and picks up the same conversation.";
      r.check(`${label}: confirm dialog copy`, !!dlg && dlg.includes(wantTitle) && dlg.includes(wantBody) && /Restart pane/.test(dlg), dlg);
      await page.locator(".confirm-modal .btn-primary").evaluate((el) => el.click());
      await sleep(1500);
      const newPty = await mapClaudeSingle(page, mid, ids);
      const txt = await claudeReady(page, mid, { timeoutMs: 120000 });
      await sleep(4000);
      const info = await paneInfo(page, newPty);
      const after = { sid: sid(info), jsonl: info.jsonl_path, oldPty: pty, newPty };
      r.evidence[label + " after"] = after;
      r.check(`${label}: pane restarted (new pty) and checkbox now ${expectQuietAfter ? "checked" : "unchecked"}`, newPty !== pty && (await quietItem(page, 0)) === expectQuietAfter, { oldPty: pty, newPty });
      r.check(`${label}: SAME session id after the restart (pane_session_info)`, !!after.sid && after.sid === r.evidence.sessionBefore.sid, { before: r.evidence.sessionBefore.sid, after: after.sid });
      const full = await textOf(page, mid);
      r.check(`${label}: earlier conversation visible in the restarted pane`, full.includes(TOKEN) || /package\.json/.test(full), full.split("\n").filter((l) => l.trim()).slice(0, 14));
      r.evidence[label + " model/banner"] = txt.split("\n").filter((l) => /haiku|sonnet|opus|resum/i.test(l)).slice(-4);
      r.shot(await d.shotWindow(page, shotPath(`b2-after-${expectQuietAfter ? "to-quiet" : "to-full"}`)));
      pty = newPty;
    }
    await flip("quiet -> full terminal", false);
    await flip("full terminal -> quiet", true);

    step("Ctrl+O in quiet shows the full transcript");
    const before = await textOf(page, mid, 16384);
    await write(page, mid, String.fromCharCode(15));
    await sleep(2500);
    const after = await textOf(page, mid, 16384);
    r.shot(await d.shotWindow(page, shotPath("b2-quiet-ctrl-o")));
    r.evidence.ctrlO = { toolLineBefore: /Read\(|Read\s+package\.json|Reading/i.test(before), toolLineAfter: /Read\(|Read\s+package\.json|Reading|ctrl\+o to toggle|transcript/i.test(after), tailAfter: after.split("\n").filter((l) => l.trim()).slice(-24) };
    r.check("Ctrl+O in a quiet pane shows the full transcript (tool detail / transcript header appears)", r.evidence.ctrlO.toolLineAfter, r.evidence.ctrlO.tailAfter.slice(-10));
    await write(page, mid, String.fromCharCode(15));
    r.check("no pageerror during the switches", errors.length === 0, errors.slice(0, 3));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
