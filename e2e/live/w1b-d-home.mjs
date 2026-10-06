import "./w1b-prefix.mjs";
// W1b-D: the Home board on the real Canary. Two Claude panes on Haiku (one sitting on a Bash permission prompt, one
// idle after a one-word answer) and one pwsh pane. Opens Home from the titlebar button and the palette, compares its
// count with the bell, checks card columns, peek, Approve (answers the prompt), Open-only on the pwsh card, Escape,
// and the stacked layout at 940 px. All input is page JS (no CDP input); nothing touches ~/.claude.
import { main, boot, d, step, launchWorkspace, waitModels, liveModels, mapClaudeSingle, mapPwsh, healthIdsNow, claudeReady, say, write, textOf, idle, sleep, shotPath, teardown, stableSnapshot, jsClick, jsFill, addPaneJs, REPO, FLAGS, CR } from "./w1b-lib.mjs";

const PROMPT = /Do\s*you\s*want\s*to\s*proceed|Esc\s*to\s*cancel/i;
const homeOpen = (page) => page.locator(".hm-panel").count().then((n) => n > 0);
const esc = (page) => page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
const card = (page, id) => page.locator(`.hm-panel [data-pane-id="${id}"]`).first();
const colOf = (page, id) => card(page, id).evaluate((el) => el.closest(".hm-col")?.className.replace("hm-col", "").trim() ?? null).catch(() => null);

main("d-home", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 2200, height: 1200, openClaudeIn: "terminal" });
    const { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    step("Claude pane 1 (permission), Claude pane 2 (idle), pwsh pane");
    const b0 = await healthIdsNow(page);
    await launchWorkspace(page, { vendors: ["claude"] });
    const [c1] = await waitModels(page, 1);
    await mapClaudeSingle(page, c1, b0);
    await claudeReady(page, c1, { must: /haiku/i });
    const add = async (label) => {
      const before = await liveModels(page), ids = await healthIdsNow(page);
      if (/claude/i.test(label)) await d.invoke(page, "stage_launch_args", { vendor: "claude", cwd: REPO, args: FLAGS });
      await addPaneJs(page, label);
      let m = null;
      for (let i = 0; i < 40 && !m; i++) { m = (await liveModels(page)).find((x) => !before.includes(x)) ?? null; if (!m) await sleep(300); }
      return { m, ids };
    };
    const a2 = await add("Claude");
    const c2 = a2.m;
    await mapClaudeSingle(page, c2, a2.ids);
    await claudeReady(page, c2, { must: /haiku/i });
    const a3 = await add(/PowerShell|pwsh/i);
    const p3 = a3.m;
    await sleep(2500);
    // An unfamiliar prompt (home.ts:205: shell panes join Home only through the needs-you queue).
    // Its pty is the one new health id (mapPwsh would clear the Claude mappings).
    let p3pty = null;
    for (let i = 0; i < 40 && !p3pty; i++) { p3pty = (await healthIdsNow(page)).find((x) => !a3.ids.includes(x)) ?? null; if (!p3pty) await sleep(250); }
    if (p3pty) await d.invoke(page, "pty_write", { paneId: p3pty, data: "Read-Host 'Proceed with the deploy? (y/n)'" + CR });

    await say(page, c2, "Reply with exactly the single word TEAL and nothing else.");
    await say(page, c1, "Use the Bash tool to run exactly this command: node -e \"console.log(4100+142)\" . Do not use any other tool.");
    await sleep(3000);
    for (let i = 0; i < 90 && !PROMPT.test(await textOf(page, c1)); i++) await sleep(1000);
    await idle(page, c2);
    await sleep(5000); // let the attention model classify both panes
    r.check("setup: pane 1 sits on a permission prompt", PROMPT.test(await textOf(page, c1)));

    step("open Home: titlebar button, then palette");
    await jsClick(page.locator('button[title="Home (Ctrl+Shift+H)"]'));
    await page.waitForSelector(".hm-panel", { timeout: 5000 }).catch(() => {});
    r.check("titlebar button opens Home", await homeOpen(page));
    await esc(page); await sleep(400);
    r.check("Escape closes Home", !(await homeOpen(page)));
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
    await sleep(500);
    const pal = page.getByPlaceholder("Jump to a workspace, pane, or action…");
    if (await pal.count()) {
      await jsFill(pal, "Open Home");
      await sleep(300);
      await pal.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    }
    await page.waitForSelector(".hm-panel", { timeout: 5000 }).catch(() => {});
    r.check("palette 'Open Home' opens Home", await homeOpen(page));
    await sleep(1500);

    step("count, columns, peek");
    const homeN = Number((await page.locator(".hm-count").innerText().catch(() => "")).replace(/\D/g, "")) || 0;
    const bellN = await page.evaluate(() => [...document.querySelectorAll(".ntf-bell .ntf-badge")].reduce((n, b) => n + (Number(b.textContent) || 0), 0));
    const cols = { c1: await colOf(page, c1), c2: await colOf(page, c2), p3: await colOf(page, p3) };
    r.evidence.home = { homeN, bellN, cols };
    r.shot(await d.shotWindow(page, shotPath("d-home-open")));
    r.check("Home needs-you count matches the bell", homeN === bellN && homeN >= 2, r.evidence.home);
    r.check("permission pane and the pwsh y/n prompt in Needs you; the idle Claude pane in another column", /needs/.test(cols.c1 ?? "") && /needs/.test(cols.p3 ?? "") && !!cols.c2 && !/needs/.test(cols.c2), cols);
    const peekBtn = card(page, c2).locator(".hm-peekbtn");
    if (await peekBtn.count()) await jsClick(peekBtn);
    await sleep(2000);
    const peek = await card(page, c2).locator(".hm-peek").innerText().catch(() => "");
    r.check("peek on the idle Claude card shows its last lines (TEAL)", /TEAL/.test(peek), peek.split("\n").slice(-4));

    step("Open-only on the pwsh card, Approve on the permission card");
    const pwshBtns = await card(page, p3).locator(".hm-actions button").evaluateAll((bs) => bs.map((b) => b.textContent.trim()));
    r.check("the unfamiliar (pwsh y/n) prompt card offers only Open", JSON.stringify(pwshBtns) === JSON.stringify(["Open"]), pwshBtns);
    const approve = card(page, c1).locator('button[aria-label^="Approve"]');
    const approveState = await approve.evaluate((b) => ({ disabled: b.disabled, title: b.title })).catch(() => null);
    r.evidence.approveState = approveState;
    if (approveState && !approveState.disabled) await jsClick(approve);
    let ran = false;
    for (let i = 0; i < 40 && !ran; i++) { await sleep(1000); ran = /4242/.test(await textOf(page, c1)); }
    r.shot(await d.shotWindow(page, shotPath("d-home-after-approve")));
    r.check("Approve answers the Claude permission prompt (the command ran)", !!approveState && !approveState.disabled && ran, { approveState, tail: (await textOf(page, c1)).split("\n").filter((l) => l.trim()).slice(-6) });

    step("940 px: stacked, nothing clipped");
    d.setWindow({ width: 940, height: 1000 });
    await sleep(1500);
    const stacked = await page.locator(".hm-panel.stacked").count();
    const clipped = await page.evaluate(() => [...document.querySelectorAll(".hm-panel .hm-card")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1); }).length);
    r.shot(await d.shotWindow(page, shotPath("d-home-940")));
    r.check("at 940 px the columns stack and no card is clipped", stacked > 0 && clipped === 0, { stacked, clipped });
    d.setWindow({ width: 2200, height: 1200 });
    await esc(page);
    r.check("no pageerror", errors.length === 0, errors.slice(0, 3));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    r.check("~/.claude.json briefTranscript and ~/.claude/settings.json unchanged by the run", r.evidence.safetyAfter.briefTranscript === r.evidence.safetyBefore.briefTranscript && r.evidence.safetyAfter.settingsSha === r.evidence.safetyBefore.settingsSha, { before: r.evidence.safetyBefore, after: r.evidence.safetyAfter });
    await teardown();
  }
});
