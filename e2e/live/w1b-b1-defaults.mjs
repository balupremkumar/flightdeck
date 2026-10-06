// B (part 1): Quiet terminal as the default for new Claude panes, the stored setting + one-off migration flag, the Settings three-way
// switch deciding what new panes open in, and the claude child command line (--settings <app-data>\claude-view\claude-view-focus.json).
import { main, boot, d, step, launchWorkspace, waitModels, sleep, shotPath, teardown, stableSnapshot, jsDeclineRestore, openSettingsJs, settingsSeg, clickSeg, closeSettingsJs, addPaneJs, quietItem, claudeCmdlines, storage, viewOf, REPO, FLAGS } from "./w1b-lib.mjs";

const stage = (page) => d.invoke(page, "stage_launch_args", { vendor: "claude", cwd: REPO, args: FLAGS });

main("b1-defaults", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    let stored0 = null;
    const c = await boot({ width: 2200, height: 1100, openClaudeIn: "quiet", beforeSettings: async (p) => { stored0 = await storage(p); } });
    const { page } = c;
    r.evidence.canaryProfileBeforeHarness = stored0;

    step("migration: stored chat + no flag -> quiet, flag set");
    await page.evaluate(() => { localStorage.setItem("flightdeck-agent-settings", JSON.stringify({ defaultVendor: "claude", openClaudeIn: "chat", flags: {} })); localStorage.removeItem("flightdeck-migrated-quiet-default"); });
    await page.reload({ waitUntil: "load" }); await d.wrapSpawns(page); await jsDeclineRestore(page);
    const m = await storage(page);
    r.evidence.migration = m;
    r.check("one-off migration turns a stored Chat default into Quiet terminal and sets flightdeck-migrated-quiet-default", /"openClaudeIn":"quiet"/.test(m.agent ?? "") && !!m.migrated, m);

    step("fresh profile: no stored agent settings -> Settings shows Quiet terminal selected");
    await page.evaluate(() => { localStorage.removeItem("flightdeck-agent-settings"); localStorage.removeItem("flightdeck-migrated-quiet-default"); });
    await page.reload({ waitUntil: "load" }); await d.wrapSpawns(page); await jsDeclineRestore(page);
    await page.waitForSelector(".launcher, .cockpit-root", { timeout: 20000 });
    await openSettingsJs(page);
    const seg0 = await settingsSeg(page);
    r.evidence.freshSettingsSeg = seg0;
    r.shot(await d.shotWindow(page, shotPath("b1-settings-fresh")));
    r.check("fresh profile: Settings > Open Claude panes in shows Quiet terminal selected", seg0.length === 3 && seg0.find((x) => x.on)?.t === "Quiet terminal", seg0);

    step("three-way switch: Terminal");
    await clickSeg(page, "Terminal");
    const sTerm = await page.evaluate(() => localStorage.getItem("flightdeck-agent-settings"));
    r.check("Settings: clicking Terminal persists openClaudeIn=terminal", /"openClaudeIn":"terminal"/.test(sTerm), sTerm);
    await closeSettingsJs(page);
    await launchWorkspace(page, { vendors: ["claude"], stageClaude: true });
    await waitModels(page, 1);
    const q0 = await quietItem(page, 0);
    r.check("pane opened under Terminal: Quiet terminal unchecked, terminal view", q0 === false, { quietChecked: q0, view: await viewOf(page, 0) });

    step("three-way switch: Quiet terminal");
    await openSettingsJs(page); await clickSeg(page, "Quiet terminal"); await closeSettingsJs(page);
    await stage(page);
    await addPaneJs(page, "Claude");
    await sleep(2500);
    const q1 = await quietItem(page, 1);
    r.check("pane opened under Quiet terminal: Quiet terminal checked", q1 === true, { quietChecked: q1, view: await viewOf(page, 1) });

    step("three-way switch: Chat");
    await openSettingsJs(page); await clickSeg(page, "Chat"); await closeSettingsJs(page);
    await stage(page);
    await addPaneJs(page, "Claude");
    await sleep(2500);
    const v2 = await viewOf(page, 2);
    r.check("pane opened under Chat: chat view on (view toggle shows Chat pressed)", v2.toggle[1] === "true", v2);
    r.shot(await d.shotWindow(page, shotPath("b1-three-panes")));

    step("claude command lines");
    await sleep(3000);
    const cl = claudeCmdlines();
    r.evidence.cmdlines = cl.map((x) => ({ pid: x.pid, name: x.name, cmd: x.cmd }));
    const real = cl.filter((x) => /claude(\.exe)?["']?\s+--/.test(x.cmd) || /claude\.exe/.test(x.cmd));
    const withFocus = real.filter((x) => /claude-view-focus\.json/.test(x.cmd));
    const withDefault = real.filter((x) => /claude-view-default\.json/.test(x.cmd));
    r.evidence.counts = { claudeProcs: real.length, focus: withFocus.length, default: withDefault.length };
    r.check("Quiet pane's claude child carries --settings <app-data>\\claude-view\\claude-view-focus.json", withFocus.length >= 1 && /--settings/.test(withFocus[0].cmd) && /ai\.flightdeck\.canary\\claude-view\\claude-view-focus\.json/i.test(withFocus[0].cmd), withFocus.map((x) => x.cmd));
    await openSettingsJs(page); await clickSeg(page, "Quiet terminal"); await closeSettingsJs(page);
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
