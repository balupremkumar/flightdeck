// K11 probe 2026-10-08: which raw input scrolls Claude's transcript in Quiet view, and by how much.
import "./bs-prefix.mjs";
import { main, boot, d, step, launchWorkspace, waitModels, mapClaudeSingle, healthIdsNow, claudeReady, say, idle, sleep, shotPath, teardown, stableSnapshot, write, ESC } from "./w1b-lib.mjs";

main("k11-probe", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 1600, height: 1000, openClaudeIn: "quiet" });
    const { page } = c;
    step("launch quiet claude haiku");
    const b0 = await healthIdsNow(page);
    await launchWorkspace(page, { vendors: ["claude"] });
    const [mid] = await waitModels(page, 1);
    await mapClaudeSingle(page, mid, b0);
    await claudeReady(page, mid, { must: /haiku/i });
    await say(page, mid, "Print the integers 1 to 150, one per line, no other text, no code fence.");
    await sleep(3000); await idle(page, mid);
    const bottom = async () => { await write(page, mid, `${ESC}[1;5F`); await sleep(800); };
    await d.shotPane(page, 0, shotPath("k11p-0-bottom"));
    const cands = [
      ["sgr-wheel-up-x3", `${ESC}[<64;20;10M`.repeat(3)],
      ["x10-wheel-up-x3", (`${ESC}[M` + String.fromCharCode(32 + 64, 32 + 20, 32 + 10)).repeat(3)],
      ["shift-up-x3", `${ESC}[1;2A`.repeat(3)],
      ["ctrl-up-x3", `${ESC}[1;5A`.repeat(3)],
      ["ctrl-shift-up-x3", `${ESC}[1;6A`.repeat(3)],
      ["pageup-x1", `${ESC}[5~`],
      ["shift-pageup-x1", `${ESC}[5;2~`],
    ];
    for (const [name, seq] of cands) {
      step(name);
      await bottom();
      await write(page, mid, seq);
      await sleep(1500);
      r.shot(await d.shotPane(page, 0, shotPath(`k11p-${name}`)));
    }
    await bottom();
    r.shot(await d.shotPane(page, 0, shotPath("k11p-z-end")));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
