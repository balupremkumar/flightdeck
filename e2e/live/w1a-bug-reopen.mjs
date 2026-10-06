// App bug repro: after a reload, "Reopen session" restores nothing (launcher, no panes) because
// src/session.ts:51 redactOpt() only guards `undefined` and the Rust session doc stores an absent draft as `null`
// (src-tauri/src/persist.rs:65), so hi(null).split() throws in the save/summary path while the store is hydrated.
// Also proves the CDP-input workaround the rest of the sweep uses: leave one character in the pane's input line
// (a non-null `draft`) so the doc carries a string.
import { main, boot, d, pasteInto, launchWorkspace, liveModels, waitModels, reloadAndWait, sleep, shotPath } from "./w1a-lib.mjs";

main("bug-reopen", async (r) => {
  const c = await boot({ width: 1900, height: 1000 });
  const { page } = c;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack ?? e).split("\n").slice(0, 3).join(" | ")));
  await launchWorkspace(page, { vendors: ["pwsh"] });
  const [mid] = await waitModels(page, 1);
  await d.waitForText(page, mid, /PS [^\n]*>/, { timeoutMs: 30000 });
  await sleep(2500); // let the session slice save

  // A: plain pane, nothing typed (the normal case).
  await reloadAndWait(page, { restore: "reopen", settle: 1500 }).catch((e) => { r.evidence.reopenAError = String(e).slice(0, 200); });
  const a = await page.evaluate(() => ({ panes: document.querySelectorAll(".pane").length, launcher: !!document.querySelector(".launcher") }));
  r.evidence.A = { ...a, liveModelsAfter: await liveModels(page), pageerrors: errors.slice(0, 3), pageerrorCount: errors.length };
  r.shot(await d.shotWindow(page, shotPath("bug-reopen-A")));
  r.check("BUG: Reopen session after reload restores the pane (no draft typed)", a.panes === 1, r.evidence.A);

  // B: workaround. Fresh workspace, leave one character unsent in the input line, wait for the save, reload, reopen.
  // The failed hydrate leaves the store half-built (a new workspace cannot be created either), so relaunch Canary clean.
  r.evidence.afterBugNewWorkspaceBroken = !(await launchWorkspace(page, { vendors: ["pwsh"] }).then(() => true, () => false));
  const c2 = await boot({ width: 1900, height: 1000 });
  const page2 = c2.page;
  page2.on("pageerror", (e) => errors.push(String(e.stack ?? e).split("\n").slice(0, 3).join(" | ")));
  await launchWorkspace(page2, { vendors: ["pwsh"] });
  const [mid2] = await waitModels(page2, 1);
  await d.waitForText(page2, mid2, /PS [^\n]*>/, { timeoutMs: 30000 });
  await pasteInto(page2, 0, "z");
  await sleep(3000);
  errors.length = 0;
  await reloadAndWait(page2, { restore: "reopen", settle: 3000 });
  const b = await page2.evaluate(() => ({ panes: document.querySelectorAll(".pane").length }));
  const lines = await d.tail(page2, mid2);
  r.evidence.B = { ...b, pageerrorCount: errors.length, tailEnd: lines.slice(-3) };
  r.shot(await d.shotWindow(page2, shotPath("bug-reopen-B")));
  r.check("workaround: with an unsent draft char the pane is restored after reload+Reopen", b.panes === 1 && errors.length === 0, r.evidence.B);
  return c2;
});
