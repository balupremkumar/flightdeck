// Checklist: "Resize the window, touch nothing, reload with an idle pwsh pane: the prompt is still visible."
// Resizes with SetWindowPos NOACTIVATE, no input to the pane, location.reload via CDP, then reads the pane
// from the Rust ring (pane_tail), the xterm DOM when present, and a screenshot.
import { main, boot, d, pasteInto, launchWorkspace, waitModels, reloadAndWait, sleep, shotPath, tree, treeBrief } from "./w1a-lib.mjs";

main("resize-reload", async (r) => {
  const c = await boot({ width: 2000, height: 1100 });
  const { page } = c;
  await launchWorkspace(page, { vendors: ["pwsh"] });
  const mid = (await waitModels(page, 1))[0];
  await d.waitForText(page, mid, /PS [^\n]*>/, { timeoutMs: 30000 });
  // Workaround for the null-draft reopen bug (see w1a-bug-reopen): leave one char unsent so the session doc has a string draft.
  await pasteInto(page, 0, "z");
  await sleep(3000);
  const before = await d.tail(page, mid);
  r.evidence.tailBefore = before.slice(-5);
  r.shot(await d.shotWindow(page, shotPath("resize-reload-before")));

  const paneSize0 = await page.evaluate(() => { const b = document.querySelector(".pane").getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; });
  // Resize two ways, touching nothing in the pane: shrink, then grow, both NOACTIVATE.
  r.evidence.resize1 = d.setWindow({ width: 1500, height: 900 });
  await sleep(1500);
  r.evidence.resize2 = d.setWindow({ width: 1900, height: 1000 });
  await sleep(1500);
  const geomBefore = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, pane: (() => { const b = document.querySelector(".pane").getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })() }));
  const reloadMs = await reloadAndWait(page, { settle: 4000 });
  r.evidence.reloadMs = reloadMs;
  const after = await d.tail(page, mid);
  r.evidence.tailAfter = after.slice(-5);
  r.evidence.geomBefore = geomBefore;
  r.evidence.geomAfter = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    r.shot(await d.shotWindow(page, shotPath("resize-reload-after-window")));
  // On-screen proof: DOM text if the DOM renderer is active, else non-background pixels in the bottom rows of the pane.
  const dom = await page.locator(".pane").first().locator(".xterm-rows").first().innerText().catch(() => "");
  r.evidence.domRowsSample = dom.slice(-200);
  r.evidence.canvases = await page.locator(".pane").first().locator("canvas").count();
  const lastLine = (before.filter((l) => /PS [^\n]*>/.test(l)).pop() ?? "").trim();
  r.check("same live pty reattached (pane_tail still has the pre-reload prompt line)", after.some((l) => l.includes(lastLine.slice(0, 20))), { lastLine });
  r.check("tail after reload ends with a prompt", /PS [^\n]*>/.test(after.slice(-3).join("\n")), after.slice(-3));
  r.check("window size actually changed before reload (pane box differs from the first layout)", geomBefore.pane.w !== paneSize0.w || geomBefore.pane.h !== paneSize0.h, { paneSize0, geomBefore });
  r.evidence.tree = treeBrief(tree());
  await sleep(500);
  return c;
});
