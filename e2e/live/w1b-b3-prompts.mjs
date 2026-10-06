// B (part 3): Quiet terminal still shows the things a human must answer (a Bash permission prompt, an AskUserQuestion
// dialog), and /focus in one pane leaves a classic pane's full output alone. Every prompt is declined with Esc (nothing
// runs). The ~/.claude.json briefTranscript guard is read before and after; /focus is toggled back before the end.
import { main, boot, d, step, launchWorkspace, waitModels, liveModels, mapClaudeSingle, healthIdsNow, claudeReady, write, say, textOf, idle, sleep, shotPath, teardown, stableSnapshot, quietItem, openSettingsJs, clickSeg, closeSettingsJs, addPaneJs, ESC, REPO, FLAGS } from "./w1b-lib.mjs";

// xterm's tail collapses some spaces ("Yes,anddon'taskagain"), so match space-insensitively.
const PROMPT = /Do\s*you\s*want\s*to\s*proceed|Esc\s*to\s*cancel/i;
// /focus that turns focus view ON persists briefTranscript:true in the user's real ~/.claude.json (seen 2026-10-06), which
// reaches every Claude session on the machine. Off by default; set FD_FOCUS_TOGGLE=1 only on a machine where that is fine.
const FOCUS_TOGGLE = process.env.FD_FOCUS_TOGGLE === "1";
const lines = (t, n = 18) => t.split("\n").filter((l) => l.trim()).slice(-n);

main("b3-prompts", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 2200, height: 1100, openClaudeIn: "quiet" });
    const { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    step("quiet claude pane A (haiku)");
    const b0 = await healthIdsNow(page);
    await launchWorkspace(page, { vendors: ["claude"] });
    const [a] = await waitModels(page, 1);
    await mapClaudeSingle(page, a, b0);
    await claudeReady(page, a, { must: /haiku/i });
    r.check("pane A starts in Quiet terminal", (await quietItem(page, 0)) === true);

    step("permission prompt in quiet");
    await say(page, a, "Use the Bash tool to run exactly this command: node -e \"console.log('FDPERM'+'-'+(40+2))\" . Do not use any other tool.");
    let t = "";
    try { t = (await d.waitForText(page, a, PROMPT, { timeoutMs: 120000 })).join?.("\n") ?? ""; } catch { /* checked below */ }
    t = await textOf(page, a);
    r.shot(await d.shotWindow(page, shotPath("b3-quiet-permission")));
    r.check("quiet pane shows the Bash permission prompt with its options", PROMPT.test(t) && /node -e/.test(t), lines(t));
    await write(page, a, ESC);
    await sleep(1500);
    await idle(page, a);
    const t2 = await textOf(page, a);
    r.check("Esc declined it (command never ran: no bare FDPERM-42 output line)", !t2.split("\n").some((l) => l.trim() === "FDPERM-42"), lines(t2, 8));

    step("AskUserQuestion in quiet");
    await say(page, a, "Call the AskUserQuestion tool exactly once with the question 'Which colour for FDASK?' and the two options 'Crimson' and 'Teal'. Do not do anything else.");
    // The dialog's option rows ("1. Crimson"), never the user's own prompt line, which also names both options.
    const DIALOG = /^\W*1\.\s*Crimson/m, DIALOG2 = /^\W*2\.\s*Teal/m;
    const dlgText = async () => (await textOf(page, a)).split("\n").filter((l) => !/AskUserQuestion/.test(l)).join("\n");
    for (let i = 0; i < 120 && !DIALOG.test(await dlgText()); i++) await sleep(1000);
    await sleep(1000);
    const tq = await dlgText();
    r.shot(await d.shotWindow(page, shotPath("b3-quiet-askuserquestion")));
    r.check("quiet pane shows the AskUserQuestion dialog (question and both options)", /FDASK/.test(tq) && DIALOG.test(tq) && DIALOG2.test(tq), lines(tq));
    await write(page, a, ESC);
    await sleep(1500);
    await idle(page, a);

    step("classic pane B (Settings > Terminal)");
    await openSettingsJs(page); await clickSeg(page, "Terminal"); await closeSettingsJs(page);
    await d.invoke(page, "stage_launch_args", { vendor: "claude", cwd: REPO, args: FLAGS });
    const before = await liveModels(page);
    const b1 = await healthIdsNow(page);
    await addPaneJs(page, "Claude");
    let b = null;
    for (let i = 0; i < 40 && !b; i++) { b = (await liveModels(page)).find((x) => !before.includes(x)) ?? null; if (!b) await sleep(300); }
    await mapClaudeSingle(page, b, b1);
    await claudeReady(page, b, { must: /haiku/i });
    r.check("pane B is a classic pane (Quiet terminal unchecked)", (await quietItem(page, 1)) === false);

    step("/focus in pane A");
    const sFocus0 = stableSnapshot();
    if (FOCUS_TOGGLE) await say(page, a, "/focus");
    await sleep(3000);
    const tf = await textOf(page, a, 8192);
    r.evidence.focusToggleA = lines(tf, 10);
    r.evidence.briefTranscriptAfterFocus = stableSnapshot().briefTranscript;

    step("pane B: one turn with a tool call, full output expected");
    await say(page, b, "Use the Read tool to read package.json, then reply with only the word FDCLASSIC.");
    await sleep(3000);
    await idle(page, b);
    const tb = await textOf(page, b);
    r.shot(await d.shotWindow(page, shotPath("b3-classic-after-focus")));
    r.check("classic pane B still shows the tool call line after /focus in pane A", /Read\(|Read\s+package\.json|Read \d+ lines|package\.json/.test(tb) && /FDCLASSIC/.test(tb), lines(tb, 14));

    step("/focus back in pane A");
    if (FOCUS_TOGGLE) await say(page, a, "/focus");
    await sleep(3000);
    r.evidence.focusToggleA2 = lines(await textOf(page, a, 8192), 10);
    r.check("no pageerror", errors.length === 0, errors.slice(0, 3));
    r.evidence.briefTranscriptBeforeFocus = sFocus0.briefTranscript;
    await openSettingsJs(page); await clickSeg(page, "Quiet terminal"); await closeSettingsJs(page);
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    r.check("~/.claude.json has no briefTranscript and ~/.claude/settings.json unchanged after the run", r.evidence.safetyAfter.briefTranscript === false && r.evidence.safetyAfter.settingsSha === r.evidence.safetyBefore.settingsSha, { before: r.evidence.safetyBefore, after: r.evidence.safetyAfter });
    await teardown();
  }
});
