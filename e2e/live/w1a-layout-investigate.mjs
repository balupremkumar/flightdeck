// Investigations (no fixes):
//  (a) pane header buttons pushed off-screen at ~960 px pane width: measure .phead overflow and every child's box at a range of
//      window widths with a real Claude pane (token/model chips after one tiny turn, branch pill, diff chip).
//  (b) right-edge clipping of long lines in a classic Claude pane at zoom 1.0: compare a pane created at the final size and never
//      resized (workspace 2) with a pane created at another size then resized while the window is off-screen (workspace 1):
//      pty columns (asked of pwsh), xterm screen box vs its host box, canvas pixel vs css size, devicePixelRatio.
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, mapClaudeSingle, healthIdsNow, health, claudeReady, write, CR, setPty, jsClick, sleep, shotPath, liveModels } from "./w1a-lib.mjs";

const dprOf = (page) => page.evaluate(() => ({ dpr: window.devicePixelRatio, inner: [innerWidth, innerHeight], vv: window.visualViewport?.scale }));

async function headMetrics(page, i = 0) {
  return page.locator(".pane").nth(i).evaluate((pane) => {
    const head = pane.querySelector(".phead");
    const hb = head.getBoundingClientRect();
    const kids = [...head.children].map((el) => {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { cls: (el.className || el.tagName).toString().slice(0, 40), w: Math.round(b.width), left: Math.round(b.left - hb.left), right: Math.round(b.right - hb.left), disp: cs.display, flex: cs.flex.replace(/\s+/g, " "), pos: cs.position, shown: cs.display !== "none" && b.width > 0 };
    });
    const names = ["pmenubtn", "pmaxbtn", "pfindbtn", "prestart", "pview-toggle"];
    const btn = Object.fromEntries(names.map((n) => { const el = head.querySelector("." + n); if (!el) return [n, null]; const b = el.getBoundingClientRect(); return [n, { right: Math.round(b.right - hb.left), visibleInHead: b.right <= hb.right + 0.5 && b.left >= hb.left }]; }));
    const paneB = pane.getBoundingClientRect();
    return { paneW: Math.round(paneB.width), headClient: head.clientWidth, headScroll: head.scrollWidth, overflowPx: head.scrollWidth - head.clientWidth, headOverflowStyle: getComputedStyle(head).overflowX, paneOverflow: getComputedStyle(pane).overflowX, btn, kids: kids.filter((k) => k.shown), hiddenKids: kids.filter((k) => !k.shown).map((k) => k.cls) };
  });
}

async function termMetrics(page, i) {
  return page.locator(".pane").nth(i).evaluate((pane) => {
    const x = pane.querySelector(".xterm");
    const sc = pane.querySelector(".xterm-screen");
    const host = x?.parentElement;
    const cvs = [...pane.querySelectorAll(".xterm-screen canvas")].map((c) => ({ w: c.width, h: c.height, cssW: parseFloat(c.style.width) || null, clientW: c.clientWidth, cls: c.className }));
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1) }; };
    const vp = pane.querySelector(".xterm-viewport");
    return { host: r(host), xterm: r(x), screen: r(sc), viewport: r(vp), viewportClientW: vp?.clientWidth, viewportOffsetW: vp?.offsetWidth, scrollbarW: vp ? vp.offsetWidth - vp.clientWidth : null, canvases: cvs, hostPad: host ? getComputedStyle(host).padding : null, paneRight: +pane.getBoundingClientRect().right.toFixed(1), dpr: window.devicePixelRatio };
  });
}

async function ptyCols(page, mid) {
  await write(page, mid, `"COLS=$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)"${CR}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const m = /COLS=(\d+)x(\d+)/.exec((await d.tail(page, mid)).join(" ").replace(/\s+/g, "").replace(/"COLS=\$.*?\)"/, ""));
    if (m) return { cols: Number(m[1]), rows: Number(m[2]) };
    await sleep(300);
  }
  return null;
}

main("layout-investigate", async (r) => {
  const c = await boot({ width: 2400, height: 1200 });
  const { page } = c;

  // ================= (a) header =================
  step("(a) claude pane with chips");
  const before = await healthIdsNow(page);
  await launchWorkspace(page, { vendors: ["claude"] });
  const [mid] = await waitModels(page, 1);
  await mapClaudeSingle(page, mid, before);
  await claudeReady(page, mid, { must: /haiku/i });
  await write(page, mid, "Reply with exactly the word OK and nothing else, no tools.");
  await sleep(300); await write(page, mid, CR);
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) { if (((await d.tail(page, mid)).join(" ").match(/\bOK\b/g) ?? []).length >= 2) break; await sleep(1000); }
  await d.waitQuiet(page, mid, { quietMs: 4000, minMs: 4000, timeoutMs: 60000 });
  await sleep(18000);   // token chip polls every 15 s
  const widths = [2400, 2100, 1900, 1750, 1650, 1550, 1450, 1350, 1250, 1100, 1000];
  const table = [];
  for (const w of widths) {
    d.setWindow({ width: w, height: 1100 });
    await sleep(1800);
    const m = await headMetrics(page, 0);
    table.push({ windowPx: w, ...m, kids: undefined, summary: { paneW: m.paneW, headClient: m.headClient, headScroll: m.headScroll, overflowPx: m.overflowPx, pmenubtnRight: m.btn.pmenubtn?.right, pmenuVisible: m.btn.pmenubtn?.visibleInHead, fixedKids: m.kids.map((k) => `${k.cls.split(" ")[0]}:${k.w}`).join(" "), hidden: m.hiddenKids.join(",") } });
    if (m.paneW >= 900 && m.paneW <= 1020) {
      await d.shotWindow(page, shotPath(`layout-header-${m.paneW}`));
      r.shot(shotPath(`layout-header-${m.paneW}`));
      r.evidence[`kids_${m.paneW}`] = m.kids;
    }
  }
  r.evidence.headerTable = table.map((t) => t.summary && { windowPx: t.windowPx, ...t.summary });
  const overflowing = table.filter((t) => t.overflowPx > 0 || t.btn.pmenubtn?.visibleInHead === false);
  r.evidence.headerOverflowAtPaneWidths = overflowing.map((t) => t.paneW);
  r.check("INVESTIGATION (a): header overflow reproduced at some pane width (buttons outside the header box)", overflowing.length > 0, r.evidence.headerOverflowAtPaneWidths);
  r.evidence.headerCss = await page.locator(".pane").first().evaluate((pane) => { const h = pane.querySelector(".phead"); const cs = getComputedStyle(h); return { display: cs.display, flexWrap: cs.flexWrap, overflow: cs.overflow, containerType: cs.containerType }; });

  // ================= (b) clipping =================
  step("(b) workspace 1 (pwsh x2) built while the window is big");
  d.setWindow({ width: 2400, height: 1200 });
  await sleep(1500);
  await jsClick(page.locator(".lp-ic.add").first());
  await launchWorkspace(page, { vendors: ["pwsh", "pwsh"], stageClaude: false });
  let mids = await waitModels(page, 2);
  const ws1 = mids.filter((m) => m !== mid);
  for (const m of ws1) await d.waitForText(page, m, /PS [^\n]*>/, { timeoutMs: 30000 });
  step("(b) resize the window while it is off-screen");
  d.setWindow({ width: 1800, height: 1000 });
  await sleep(3000);
  r.evidence.dprAfterResize = await dprOf(page);
  step("(b) workspace 2 (pwsh x2) built at the final size, never resized");
  await jsClick(page.locator(".lp-ic.add").first());
  await launchWorkspace(page, { vendors: ["pwsh", "pwsh"], stageClaude: false });
  mids = await waitModels(page, 5);
  const ws2 = mids.filter((m) => !ws1.includes(m) && m !== mid);
  for (const m of ws2) await d.waitForText(page, m, /PS [^\n]*>/, { timeoutMs: 30000 });
  await mapPwsh(page, [...ws1, ...ws2]);
  const activeGrid = () => page.evaluate(() => [...document.querySelectorAll(".wsgrid")].findIndex((x) => getComputedStyle(x).display !== "none"));
  const paneIdxOfGrid = (k) => page.evaluate((k) => { let n = 0; const gs = [...document.querySelectorAll(".wsgrid")]; for (let i = 0; i < k; i++) n += gs[i].querySelectorAll(".pane").length; return n; }, k);
  const out = {};
  for (const [label, grp, rowIdx] of [["never-resized(ws2)", ws2, 2], ["resized(ws1)", ws1, 1]]) {
    await jsClick(page.locator(".lp-ws").nth(rowIdx));
    await sleep(1500);
    const g = await activeGrid();
    const base = await paneIdxOfGrid(g);
    const cols = [];
    for (const m of grp) cols.push(await ptyCols(page, m));
    // a long ruler line in the first pane of the group, to look at the right edge
    await write(page, grp[0], "1..40 | % { Write-Host -NoNewline ('{0:D3}|' -f ($_*5)) }; ''" + CR);
    await sleep(1200);
    out[label] = { activeGrid: g, models: grp, ptyCols: cols, term: [await termMetrics(page, base), await termMetrics(page, base + 1)] };
    r.shot(await d.shotWindow(page, shotPath(`layout-clip-${label.split("(")[0]}`)));
  }
  r.evidence.clip = out;
  r.evidence.dpr = await dprOf(page);
  const clipOf = (t) => (t.screen && t.host ? +(t.screen.r - t.host.r).toFixed(1) : null);
  r.evidence.clipPx = { never: out["never-resized(ws2)"].term.map(clipOf), resized: out["resized(ws1)"].term.map(clipOf) };
  r.check("INVESTIGATION (b): measured xterm screen vs host box (clipPx: positive = xterm screen wider than its host)", true, r.evidence.clipPx);
  return c;
});
