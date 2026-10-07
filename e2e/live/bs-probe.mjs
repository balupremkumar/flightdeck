import "./bs-prefix.mjs";
import { main, boot, d, step, launchWorkspace, waitModels, sleep, teardown, stableSnapshot } from "./w1b-lib.mjs";
main("probe", async (r) => {
  try {
    const c = await boot({ width: 2000, height: 1100, openClaudeIn: "terminal" });
    const { page } = c;
    await launchWorkspace(page, { vendors: ["pwsh", "pwsh"] }); await waitModels(page, 2, 60000); await sleep(2500);
    for (const i of [0, 1]) {
      const rect = await page.locator(".pane").nth(i).locator(".pmenubtn").evaluate((b) => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, vis: getComputedStyle(b).visibility, wrapR: b.parentElement.getBoundingClientRect().right }; });
      await page.locator(".pane").nth(i).locator(".pmenubtn").evaluate((el) => el.click()); await sleep(400);
      const m = await page.locator(".pmenu").evaluate((m) => { const r = m.getBoundingClientRect(); return { l: r.left, t: r.top, style: m.getAttribute("style") }; });
      r.check(`pane ${i} menu near its button`, Math.abs(m.l - (rect.r - 220)) < 40, { rect, m });
      await page.locator(".pane").nth(i).locator(".pmenubtn").evaluate((el) => el.click()); await sleep(300);
    }
    // synthetic full mouse sequence at the button
    const out = await page.locator(".pane").first().locator(".pmenubtn").evaluate((b) => { const r = b.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, view: window }; for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) b.dispatchEvent(new MouseEvent(t, o)); return null; });
    await sleep(400);
    r.evidence.afterMouseSeq = await page.locator(".pmenu").evaluate((m) => { const r = m.getBoundingClientRect(); return { l: r.left, t: r.top }; }).catch((e) => String(e));
    return c;
  } finally { await teardown(); }
});
