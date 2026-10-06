// Checklist: "Reload (Ctrl+R) with a Claude pane mid-stream: last 20 lines identical before and after, nothing doubled or missing."
// Two real Haiku turns in one pane, each reloaded while Claude is working:
//   A. reload ~8 s into the turn (status line "esc to interrupt", spinner churning). The xterm scrollback (read through the
//      app's own "View transcript" overlay) is snapshotted first; after the turn finishes, everything that was above the live
//      zone must be identical and contiguous, and every "Line NN:" must appear exactly once and in order.
//   B. reload the instant the first "Row NN:" line shows in the Rust ring (the burst is still being written), then the same
//      exactly-once / in-order check for Row 01..60 plus Line 01..60 still intact.
import { main, boot, d, step, launchWorkspace, waitModels, mapClaudeSingle, healthIdsNow, claudeReady, armReopen, write, CR, reloadAndWait, paneMenu, jsClick, sleep, shotPath, tree, treeBrief } from "./w1a-lib.mjs";

const prompt = (word, lo, hi) => `Reply with exactly 60 lines and nothing else, no tools. Each line starts with '${word} NN: ' (NN from 01 to 60) followed by a different sentence of 20 to 25 words about ${word === "Line" ? "the sea" : "mountains"}.`;
const WORKING = /esc\s*to\s*interrupt/i;

async function transcript(page) {
  await paneMenu(page, 0, /View transcript/);
  await page.waitForSelector(".transcript-line", { timeout: 8000 }).catch(() => {});
  const lines = await page.locator(".transcript-line").allInnerTexts();
  await jsClick(page.locator(".transcript-x"));
  await sleep(200);
  return lines;
}
const nums = (word, lines) => lines.map((l) => new RegExp(`${word}\\s*(\\d\\d):`).exec(l)).filter(Boolean).map((m) => Number(m[1]));
const squash = (l) => l.replace(/\s+/g, "");
function exactlyOnce(word, lines) {
  const seq = nums(word, lines);
  const counts = new Map();
  for (const n of seq) counts.set(n, (counts.get(n) ?? 0) + 1);
  const missing = Array.from({ length: 60 }, (_, i) => i + 1).filter((n) => !counts.has(n));
  const doubled = [...counts].filter(([, k]) => k > 1).map(([n, k]) => `${n}x${k}`);
  const inOrder = seq.every((n, i) => i === 0 || n >= seq[i - 1]);
  return { ok: missing.length === 0 && doubled.length === 0 && inOrder, missing, doubled, inOrder, count: seq.length };
}
async function waitTurnDone(page, mid, word, timeoutMs = 300000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if (Math.max(0, ...nums(word, await d.tail(page, mid))) >= 60) break;
    await sleep(500);
  }
  await d.waitQuiet(page, mid, { quietMs: 5000, minMs: 5000, timeoutMs: 120000 });
  return Date.now() - t;
}

main("claude-reload", async (r) => {
  const c = await boot({ width: 2000, height: 1100 });
  const { page } = c;
  step("launch claude haiku pane");
  const before = await healthIdsNow(page);
  await launchWorkspace(page, { vendors: ["claude"] });
  const [mid] = await waitModels(page, 1);
  await mapClaudeSingle(page, mid, before);
  step("wait for Claude prompt (trust prompt handled)");
  const banner = await claudeReady(page, mid, { must: /haiku/i });
  r.evidence.banner = banner.split("\n").slice(-8);
  r.check("Claude pane is on Haiku", /haiku/i.test(banner), r.evidence.banner);

  // ---- A ----
  // Workaround for the null title/draft reopen bug (w1a-bug-reopen): rename the pane and leave a draft char in the app's
  // tracking, then take the char back out of Claude's input via the pty only (the app's draft stays "x").
  step("A: arm reopen, send prompt");
  await armReopen(page, 0, { name: "claude-1", draftChar: "x" });
  await write(page, mid, String.fromCharCode(127));
  await sleep(300);
  const tA = Date.now();
  await write(page, mid, prompt("Line"));
  await sleep(300);
  await write(page, mid, CR);
  let working = null;
  while (Date.now() - tA < 180000) {
    const txt = (await d.tail(page, mid)).join("\n");
    if (WORKING.test(txt)) { working = true; break; }
    await sleep(60);
  }
  await sleep(8000);
  const snap = await transcript(page);
  const inFlightBefore = snap.some((l) => WORKING.test(l));
  const highestBefore = Math.max(0, ...nums("Line", snap));
  r.evidence.A = { statusLines: snap.filter((l) => /interrupt|thinking|tokens/i.test(l)).slice(-3), highestBefore };
  r.check("A: Claude was mid-turn (status line 'esc to interrupt' in the xterm buffer, Line 60 not yet written) when reloaded", inFlightBefore && highestBefore < 60, r.evidence.A);
  const stableBefore = snap.filter((l) => l.trim()).slice(0, -6);   // banner + echoed prompt, above the spinner/input/footer
  step("A: reload now");
  r.evidence.A.reload = await reloadAndWait(page, { restore: "reopen", settle: 1500 });
  r.evidence.A.finishedAfterReloadMs = await waitTurnDone(page, mid, "Line");
  const afterA = await transcript(page);
  r.shot(await d.shotWindow(page, shotPath("claude-reload-A-after")));
  const eoA = exactlyOnce("Line", afterA);
  r.check("A: every Line 01..60 present exactly once and in order after the reload", eoA.ok, eoA);
  const flatA = afterA.filter((l) => l.trim());
  const idxA = flatA.findIndex((l) => l === stableBefore[0]);
  const sameA = stableBefore.length > 0 && idxA >= 0 && stableBefore.every((l, i) => flatA[idxA + i] === l);
  r.evidence.A.stableBefore = stableBefore;
  r.check("A: banner and echoed prompt (everything above the live zone before the reload) identical and contiguous after it", sameA, { n: stableBefore.length, idxA });
  const ring = (await d.tail(page, mid)).map(squash).filter(Boolean).slice(-20);
  const xt = flatA.map(squash).slice(-40);
  r.evidence.A.last20Xterm = flatA.slice(-20);
  r.evidence.A.ringLinesAlsoInXterm = ring.filter((l) => xt.some((x) => x.includes(l.slice(0, 30)))).length + "/" + ring.length;

  // ---- B ----
  step("B: second prompt, reload the instant the first Row line appears");
  const tB = Date.now();
  await write(page, mid, prompt("Row"));
  await sleep(300);
  await write(page, mid, CR);
  let firstRow = null;
  while (Date.now() - tB < 300000) {
    const n = nums("Row", await d.tail(page, mid));
    if (n.length) { firstRow = { highest: Math.max(...n), ms: Date.now() - tB }; break; }
    await sleep(15);
  }
  r.evidence.B = { firstRowSeen: firstRow };
  r.check("B: first Row line seen in the ring before the reload was triggered", !!firstRow, firstRow);
  r.evidence.B.reload = await reloadAndWait(page, { restore: "reopen", settle: 1500 });
  r.evidence.B.highestRowAfterReload = Math.max(0, ...nums("Row", await d.tail(page, mid)));
  r.evidence.B.finishedAfterReloadMs = await waitTurnDone(page, mid, "Row");
  const afterB = await transcript(page);
  r.shot(await d.shotWindow(page, shotPath("claude-reload-B-after")));
  const eoB = exactlyOnce("Row", afterB);
  const eoBL = exactlyOnce("Line", afterB);
  r.check("B: every Row 01..60 present exactly once and in order after the reload", eoB.ok, eoB);
  r.check("B: the earlier Line 01..60 answer is still intact (once, in order)", eoBL.ok, eoBL);
  r.evidence.B.last20Xterm = afterB.filter((l) => l.trim()).slice(-20);
  r.evidence.tree = treeBrief(tree());
  return c;
});
