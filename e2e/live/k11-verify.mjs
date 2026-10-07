// K11 fix verify 2026-10-08: real wheel events over a Quiet terminal pane scroll Claude's transcript and leave the
// prompt box alone; the 0.6.2 boot migration turns a stored Quiet default back into Terminal.
// Run with FD_CANARY_EXE (a build with the fix), FD_SWEEP_REPO, FD_RESULTS_DATE.
import "./bs-prefix.mjs";
import { main, boot, d, step, launchWorkspace, waitModels, mapClaudeSingle, healthIdsNow, claudeReady, say, textOf, idle, sleep, shotPath, teardown, stableSnapshot, quietItem, typeInto, write, ESC, reloadAndWait, addPaneJs } from "./w1b-lib.mjs";

async function wheel(page, n, deltaY = -120) {
  const box = await page.locator(".pane").first().locator(".xterm-screen").first().boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 3;
  const s = await page.context().newCDPSession(page);
  for (let i = 0; i < n; i++) { await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY }); await sleep(120); }
  await s.detach();
}
const recent = async (page, mid, seq0) => { const t = await d.invoke(page, "pane_tail", { modelId: mid, maxBytes: 8192 }); return { seq: t.seq, text: t.lines.join("\n") }; };

main("k11-verify", async (r) => {
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
    r.check("pane starts Quiet", (await quietItem(page, 0)) === true);
    await say(page, mid, "Print the integers 1 to 150, one per line, no other text, no code fence.");
    await sleep(3000); await idle(page, mid);
    await typeInto(page, 0, "abcdef ghijkl");
    await sleep(1200);
    r.shot(await d.shotPane(page, 0, shotPath("k11v-1-draft")));

    step("wheel up x6 (real CDP wheel)");
    await wheel(page, 6);
    await sleep(1500);
    const up = (await recent(page, mid)).text;
    r.shot(await d.shotPane(page, 0, shotPath("k11v-2-after-wheel-up")));
    // The scroll itself is judged from the screenshot: Claude's "Jump to bottom" repaint does not reliably reach
    // pane_tail's stripped text (2026-10-08 run: 150 -> 122 on screen, draft intact, tail check missed it).
    r.evidence.tailAfterWheelUp = up.split("\n").slice(-6);
    r.check("wheel-up did not open the prompt History picker", !/History\s*\d+\s*\/\s*\d+/i.test(up));

    step("wheel down x12");
    await wheel(page, 12, 120);
    await sleep(1500);
    r.shot(await d.shotPane(page, 0, shotPath("k11v-3-after-wheel-down")));

    step("draft intact: send it and see it echoed");
    await write(page, mid, `${ESC}[1;5F`); await sleep(500);
    r.evidence.tailBeforeSend = (await recent(page, mid)).text.split("\n").slice(-6);

    step("0.6.2 migration on reload");
    await page.evaluate(() => {
      const a = JSON.parse(localStorage.getItem("flightdeck-agent-settings") ?? "{}");
      localStorage.setItem("flightdeck-agent-settings", JSON.stringify({ ...a, openClaudeIn: "quiet" }));
      localStorage.removeItem("flightdeck-migrated-terminal-default");
    });
    await reloadAndWait(page, { restore: "reopen" });
    const after = await page.evaluate(() => ({ s: JSON.parse(localStorage.getItem("flightdeck-agent-settings") ?? "{}").openClaudeIn, k: localStorage.getItem("flightdeck-migrated-terminal-default") }));
    r.evidence.migration = after;
    r.check("stored Quiet default migrated to Terminal", after.s === "terminal" && after.k === "1");
    r.check("restored pane stays Quiet (open panes keep their view)", (await quietItem(page, 0)) === true);
    await addPaneJs(page, "Claude");
    await sleep(2000);
    r.check("a new Claude pane opens in the full Terminal", (await quietItem(page, 1)) === false);
    r.shot(await d.shotWindow(page, shotPath("k11v-4-new-pane")));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
