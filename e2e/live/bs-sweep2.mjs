// Bug sweep 2026-10-07: daily-driver flows, pwsh panes only, all input synthetic (no OS focus).
import "./bs-prefix.mjs";
import { writeFileSync, appendFileSync } from "node:fs";
import { main, boot, d, step, launchWorkspace, waitModels, sleep, shotPath, teardown, stableSnapshot, jsClick, jsFill, addPaneJs, renamePaneJs, health, OUT, REPO } from "./w1b-lib.mjs";
import path from "node:path";

const kd = (page, key, o = {}) => page.evaluate(([k, o]) => { (document.activeElement && document.activeElement !== document.body ? document.body : document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })); }, [key, o]);
const esc = (page) => page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
const overlays = (page) => page.evaluate(() => ({
  settings: !!document.querySelector(".set-modal"), palette: !!document.querySelector(".cp-modal, .palette, [aria-label*='ommand']"),
  dialogs: [...document.querySelectorAll('[role="dialog"]')].map((e) => e.getAttribute("aria-label") || e.className),
}));
const problems = (page) => page.evaluate(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    if (el.closest(".xterm, canvas")) continue;
    const txt = (el.textContent || "").trim().slice(0, 30);
    if (r.right > vw + 2 && !el.closest(".ov-scrim")) out.push({ k: "beyond-right", cls: String(el.className).slice(0, 40), txt, right: Math.round(r.right) });
    if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflow !== "visible" && cs.textOverflow !== "ellipsis" && el.clientWidth > 0) out.push({ k: "clipped-no-ellipsis", cls: String(el.className).slice(0, 40), txt, sw: el.scrollWidth, cw: el.clientWidth });
  }
  const hdr = [...document.querySelectorAll(".pane .pband, .pane header, .pane .phead")].map((h) => { const kids = [...h.children].map((c) => c.getBoundingClientRect()); let overlap = 0; for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) { const a = kids[i], b = kids[j]; if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlap++; } return { w: Math.round(h.getBoundingClientRect().width), overlap }; });
  return { vw, vh, out: out.slice(0, 15), hdr };
});
const log = [];
const note = (k, v) => { log.push([k, v]); console.log("[note]", k, JSON.stringify(v).slice(0, 400)); };

main("sweep2", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 2000, height: 1100, openClaudeIn: "terminal" });
    const { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror " + String(e).slice(0, 300)));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console.error " + m.text().slice(0, 300)); });
    const S = async (name, fn) => { step(name); try { await fn(); } catch (e) { r.check(`${name}: no exception`, false, String(e?.message ?? e).slice(0, 400)); } };
    const shot = async (n) => r.shot(await d.shotWindow(page, shotPath("s2-" + n)));

    await S("launch 2 pwsh", async () => {
      await launchWorkspace(page, { vendors: ["pwsh", "pwsh"] });
      await waitModels(page, 2, 60000); await sleep(2500);
      await shot("01-two-panes");
      note("topbar buttons", await page.evaluate(() => [...document.querySelectorAll(".tb-ic, .tb-toggle")].map((b) => b.title || b.getAttribute("aria-label"))));
    });
    await S("resize narrow/wide", async () => {
      for (const [w, h, n] of [[900, 700, "narrow"], [2560, 1300, "wide"], [1300, 800, "mid"]]) {
        await d.setViewport(page, { width: w, height: h, dsf: 1 });
        await shot(`22-${n}`);
        const p = await problems(page); note(`layout ${n}`, p);
        r.evidence["layout-" + n] = p;
      }
      await d.setViewport(page, { width: 900, height: 700, dsf: 1 });
      await page.locator('button[title^="Settings"]').first().evaluate((el) => el.click()); await sleep(800); await shot("23-narrow-settings"); await esc(page); await sleep(300);
      await page.locator('[aria-label="Home"]').first().evaluate((el) => el.click()); await sleep(800); await shot("24-narrow-home"); await esc(page); await sleep(300);
      await page.locator(".pane").first().locator(".pmenubtn").evaluate((el) => el.click()); await sleep(300); await shot("25-narrow-panemenu");
      await page.locator(".pane").first().locator(".pmenubtn").evaluate((el) => el.click());
      await d.setViewport(page, null);
    });
    await S("light theme", async () => {
      const before = await page.evaluate(() => document.documentElement.dataset.theme || document.documentElement.className);
      await page.locator('.tb-ic[title="Toggle light / dark"]').evaluate((el) => el.click()); await sleep(900);
      const after = await page.evaluate(() => document.documentElement.dataset.theme || document.documentElement.className);
      note("theme attr", { before, after });
      await shot("26-light");
      const p = await problems(page); note("light layout", p);
      await page.locator('button[title^="Settings"]').first().evaluate((el) => el.click()); await sleep(800); await shot("27-light-settings"); await esc(page); await sleep(300);
      await page.locator('[aria-label="Home"]').first().evaluate((el) => el.click()); await sleep(800); await shot("28-light-home"); await esc(page); await sleep(300);
      await page.locator('.tb-ic[title="Toggle light / dark"]').evaluate((el) => el.click()); await sleep(600);
    });
    r.evidence.errors = errors; r.evidence.notes = log;
    r.check("no page errors / console errors", errors.length === 0, errors.slice(0, 5));
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
