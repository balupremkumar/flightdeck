// Bug sweep 2026-10-07: K11 live repro (Quiet terminal wheel). Run with FD_CANARY_EXE, FD_SWEEP_REPO, FD_RESULTS_DATE=2026-10-07.
import "./bs-prefix.mjs";
import { main, boot, d, step, launchWorkspace, waitModels, mapClaudeSingle, healthIdsNow, claudeReady, say, textOf, idle, sleep, shotPath, teardown, stableSnapshot, quietItem, typeInto, jsClick, write } from "./w1b-lib.mjs";

const logOf = (page) => page.evaluate(() => { const l = window.__fdW || []; window.__fdW = []; return l; });
const view = (page) => page.evaluate(() => {
  const p = document.querySelector(".pane"); const v = p.querySelector(".xterm-viewport");
  return { scrollTop: v?.scrollTop, scrollHeight: v?.scrollHeight, clientHeight: v?.clientHeight, rows: p.querySelectorAll(".xterm-rows > div").length, canvases: p.querySelectorAll(".xterm-screen canvas").length };
});
const showKey = (key, code, extra = {}) => ({ key, code, ...extra });

async function wheel(page, n, deltaY = -120) {
  const box = await page.locator(".pane").first().locator(".xterm-screen").first().boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const s = await page.context().newCDPSession(page);
  for (let i = 0; i < n; i++) { await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY }); await sleep(120); }
  await s.detach();
}
async function key(page, k) {
  await page.locator(".pane").first().locator("textarea.xterm-helper-textarea").first().evaluate((ta, o) => {
    ta.dispatchEvent(new KeyboardEvent("keydown", { ...o, bubbles: true, cancelable: true }));
  }, k);
}
const tailEnd = async (page, mid, n = 14) => (await textOf(page, mid, 4096)).split("\n").filter((l) => l.trim()).slice(-n);

main("k11", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 2000, height: 1100, openClaudeIn: "quiet" });
    const { page } = c;
    await page.evaluate(() => { const T = window.__TAURI_INTERNALS__; if (T.__fdW) return; T.__fdW = 1; const inv = T.invoke.bind(T); window.__fdW = []; T.invoke = (cmd, a, o) => { if (cmd === "pty_write") window.__fdW.push(JSON.stringify(a.data)); return inv(cmd, a, o); }; });
    step("launch quiet claude haiku");
    const b0 = await healthIdsNow(page);
    await launchWorkspace(page, { vendors: ["claude"] });
    const [mid] = await waitModels(page, 1);
    await mapClaudeSingle(page, mid, b0);
    await claudeReady(page, mid, { must: /haiku/i });
    r.check("pane starts Quiet", (await quietItem(page, 0)) === true);
    step("produce output");
    await say(page, mid, "Print the integers 1 to 150, one per line, no other text, no code fence.");
    await sleep(3000); await idle(page, mid);
    r.shot(await d.shotWindow(page, shotPath("k11-1-after-output")));
    r.evidence.afterOutputTail = await tailEnd(page, mid);
    await typeInto(page, 0, "abcdef ghijkl");
    await sleep(1200);
    r.shot(await d.shotWindow(page, shotPath("k11-2-draft-typed")));
    r.evidence.viewBefore = await view(page);
    r.evidence.tailBeforeWheel = await tailEnd(page, mid, 6);
    await logOf(page);
    step("wheel up x6");
    await wheel(page, 6);
    await sleep(1500);
    r.evidence.quietWheelWrites = await logOf(page);
    r.evidence.quietViewAfter = await view(page);
    r.evidence.quietTailAfterWheel = await tailEnd(page, mid, 6);
    r.shot(await d.shotWindow(page, shotPath("k11-3-quiet-after-wheel")));
    const keys = [
      ["PageUp", showKey("PageUp", "PageUp", { keyCode: 33 })],
      ["Shift+PageUp", showKey("PageUp", "PageUp", { keyCode: 33, shiftKey: true })],
      ["Ctrl+Home", showKey("Home", "Home", { keyCode: 36, ctrlKey: true })],
    ];
    r.evidence.keys = {};
    for (const [name, k] of keys) {
      await logOf(page);
      await key(page, k);
      await sleep(1500);
      r.evidence.keys[name] = { writes: await logOf(page), view: await view(page), tail: await tailEnd(page, mid, 5) };
      r.shot(await d.shotWindow(page, shotPath(`k11-4-quiet-${name.replace(/\W/g, "")}`)));
    }
    // Ctrl+O transcript mode then PageUp, a likely Claude-native way to read earlier output.
    await write(page, mid, String.fromCharCode(15)); await sleep(2000);
    await logOf(page); await key(page, keys[0][1]); await sleep(1500);
    r.evidence.keys["Ctrl+O then PageUp"] = { writes: await logOf(page), tail: await tailEnd(page, mid, 5) };
    r.shot(await d.shotWindow(page, shotPath("k11-5-quiet-ctrlO-pageup")));
    await write(page, mid, String.fromCharCode(15)); await sleep(1000);

    step("switch to full terminal");
    const ids = await healthIdsNow(page);
    await quietItem(page, 0, { click: true });
    await page.waitForSelector(".confirm-modal", { timeout: 5000 });
    await page.locator(".confirm-modal .btn-primary").evaluate((el) => el.click());
    await sleep(1500);
    await mapClaudeSingle(page, mid, ids);
    await claudeReady(page, mid, { timeoutMs: 120000 });
    await sleep(5000);
    r.check("pane now full terminal", (await quietItem(page, 0)) === false);
    r.shot(await d.shotWindow(page, shotPath("k11-6-full-after-switch")));
    r.evidence.fullViewBefore = await view(page);
    await logOf(page);
    await wheel(page, 6); await sleep(1500);
    r.evidence.fullWheelWrites = await logOf(page);
    r.evidence.fullViewAfter = await view(page);
    r.shot(await d.shotWindow(page, shotPath("k11-7-full-after-wheel")));
    await wheel(page, 6, 120); await sleep(800);
    r.evidence.fullViewAfterDown = await view(page);
    await logOf(page); await key(page, keys[1][1]); await sleep(1000);
    r.evidence.fullShiftPgUp = { writes: await logOf(page), view: await view(page) };
    r.shot(await d.shotWindow(page, shotPath("k11-8-full-shiftpgup")));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
