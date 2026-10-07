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

main("sweep", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  try {
    const c = await boot({ width: 2000, height: 1100, openClaudeIn: "terminal" });
    const { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror " + String(e).slice(0, 300)));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console.error " + m.text().slice(0, 300)); });
    const S = async (name, fn) => { step(name); try { await fn(); } catch (e) { r.check(`${name}: no exception`, false, String(e?.message ?? e).slice(0, 400)); } };
    const shot = async (n) => r.shot(await d.shotWindow(page, shotPath("sw-" + n)));

    await S("launch 2 pwsh", async () => {
      await launchWorkspace(page, { vendors: ["pwsh", "pwsh"] });
      await waitModels(page, 2, 60000); await sleep(2500);
      await shot("01-two-panes");
      note("topbar buttons", await page.evaluate(() => [...document.querySelectorAll(".tb-ic, .tb-toggle")].map((b) => b.title || b.getAttribute("aria-label"))));
    });
    await S("add pane + rename", async () => {
      await addPaneJs(page, /PowerShell|pwsh/i); await waitModels(page, 3, 30000);
      r.check("3 panes after add", (await page.locator(".pane").count()) === 3);
      await renamePaneJs(page, 0, "Alpha pane");
      const names = await page.locator(".pane .pname").allInnerTexts();
      r.check("rename applied", names[0] === "Alpha pane", names);
      await shot("02-added-renamed");
    });
    await S("pane menu", async () => {
      const pane = page.locator(".pane").nth(1);
      await pane.locator(".pmenubtn").evaluate((el) => el.click()); await sleep(400);
      const items = await page.locator(".pmenu .pmenu-item").allInnerTexts();
      note("pane menu items (pwsh)", items);
      const geo = await page.locator(".pmenu").evaluate((m) => { const b = m.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vh: innerHeight, scrollable: m.scrollHeight > m.clientHeight }; });
      r.check("pane menu fits in the window", geo.bottom <= geo.vh && geo.top >= 0, geo);
      await shot("03-pane-menu");
      await pane.locator(".pmenubtn").evaluate((el) => el.click()); await sleep(300);
    });
    await S("pane header controls", async () => {
      note("pane header", await page.locator(".pane").first().evaluate((p) => [...p.querySelectorAll("button")].filter((b) => !b.closest(".pmenu")).map((b) => ({ t: b.title, a: b.getAttribute("aria-label"), cls: b.className.slice(0, 30), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }))));
      await page.locator(".pane").first().locator(".pmaxbtn").evaluate((el) => el.click()); await sleep(600);
      await shot("04-maximised");
      await page.locator(".pane").first().locator(".pmaxbtn").evaluate((el) => el.click()); await sleep(500);
    });
    await S("close a pane", async () => {
      const before = await page.locator(".pane").count();
      const closeBtn = page.locator(".pane").nth(2).locator('button[title*="Close" i], button[aria-label*="Close" i]').first();
      note("close btn count", await closeBtn.count());
      await closeBtn.evaluate((el) => el.click()); await sleep(800);
      const dlg = await page.evaluate(() => { const m = document.querySelector(".confirm-modal"); return m ? m.innerText.replace(/\s+/g, " ") : null; });
      note("close confirm", dlg);
      if (dlg) { await page.locator(".confirm-modal .btn-primary, .confirm-modal .btn-danger").first().evaluate((el) => el.click()); await sleep(800); }
      r.check("pane count dropped by one", (await page.locator(".pane").count()) === before - 1, { before, after: await page.locator(".pane").count() });
      await shot("05-closed");
    });
    await S("second workspace", async () => {
      await page.locator(".ws-add, button[title*='New workspace' i], button[aria-label*='New workspace' i], .left-panel button[title*='New' i]").first().evaluate((el) => el.click());
      await sleep(900); await shot("06-new-ws-launcher");
      r.check("launcher shows", (await page.locator(".launcher").count()) > 0);
      await launchWorkspace(page, { vendors: ["pwsh"] }); await sleep(2500);
      note("workspaces", await page.evaluate(() => document.querySelectorAll(".ws-item, .wsrow, [class*=wsitem]").length));
      await shot("07-two-workspaces");
    });
    await S("command palette", async () => {
      await kd(page, "k", { ctrlKey: true }); await sleep(600);
      await shot("08-palette");
      const inp = page.locator(".cp-input, input[placeholder^='Jump to']").first();
      r.check("palette opens", (await inp.count()) > 0);
      if (await inp.count()) { await jsFill(inp, "settings"); await sleep(500); await shot("09-palette-search"); note("palette rows", await page.locator("[role=option], .cp-row").allInnerTexts().then((a) => a.slice(0, 6))); }
      await esc(page); await sleep(400);
      r.check("Esc closed the palette", (await page.locator("input[placeholder^='Jump to']").count()) === 0);
    });
    await S("quick open", async () => {
      await kd(page, "p", { ctrlKey: true }); await sleep(900);
      await shot("10-quickopen");
      note("quick open present", await page.evaluate(() => !!document.querySelector("[class*=qo], [aria-label*='Go to file' i], input[placeholder*='file' i]")));
      await esc(page); await sleep(400);
    });
    await S("settings", async () => {
      await page.locator('button[title^="Settings"]').first().evaluate((el) => el.click()); await sleep(900);
      const labels = await page.locator(".set-modal .set-label").allInnerTexts();
      note("settings sections", labels);
      r.check("settings opens with sections", labels.length >= 5, labels);
      await shot("11-settings-top");
      for (let i = 0; i < labels.length; i++) {
        await page.locator(".set-modal .set-label").nth(i).evaluate((el) => el.scrollIntoView({ block: "start" })); await sleep(150);
        if (i % 3 === 0) await shot(`12-settings-sec${String(i).padStart(2, "0")}`);
      }
      const q = page.locator(".set-modal input.set-search").first();
      await jsFill(q, "quiet"); await sleep(600); await shot("13-settings-search");
      const hits = await page.locator(".set-hit").count();
      r.check("settings search 'quiet' returns hits", hits > 0, hits);
      await jsFill(q, "zzzqqq"); await sleep(500); await shot("14-settings-search-empty");
      note("empty search text", await page.locator(".set-modal .set-body").first().innerText().then((t) => t.slice(0, 200)));
      await jsFill(q, "");
      // UI size
      const w0 = await page.evaluate(() => getComputedStyle(document.documentElement).zoom + "|" + document.body.style.zoom);
      await kd(page, "=", { ctrlKey: true }); await sleep(400); await kd(page, "=", { ctrlKey: true }); await sleep(600); await shot("15-zoom-up");
      const w1 = await page.evaluate(() => getComputedStyle(document.documentElement).zoom + "|" + document.body.style.zoom + "|" + innerWidth);
      await kd(page, "-", { ctrlKey: true }); await sleep(300); await kd(page, "-", { ctrlKey: true }); await kd(page, "-", { ctrlKey: true }); await sleep(600); await shot("16-zoom-down");
      const w2 = await page.evaluate(() => getComputedStyle(document.documentElement).zoom + "|" + document.body.style.zoom);
      await kd(page, "0", { ctrlKey: true }); await sleep(500);
      const w3 = await page.evaluate(() => getComputedStyle(document.documentElement).zoom + "|" + document.body.style.zoom);
      note("zoom values", { w0, w1, w2, w3 });
      r.check("Ctrl+0 returns zoom to initial", w3 === w0, { w0, w3 });
      await esc(page); await sleep(400);
      r.check("Esc closed settings", (await page.locator(".set-modal").count()) === 0);
    });
    await S("escape stack", async () => {
      await page.locator('button[title^="Settings"]').first().evaluate((el) => el.click()); await sleep(600);
      await kd(page, "k", { ctrlKey: true }); await sleep(600);
      const both = { settings: await page.locator(".set-modal").count(), palette: await page.locator("input[placeholder^='Jump to']").count() };
      await shot("17-two-overlays");
      await esc(page); await sleep(400);
      const one = { settings: await page.locator(".set-modal").count(), palette: await page.locator("input[placeholder^='Jump to']").count() };
      await esc(page); await sleep(400);
      const none = { settings: await page.locator(".set-modal").count(), palette: await page.locator("input[placeholder^='Jump to']").count() };
      note("escape stack", { both, one, none });
      r.check("Esc closes only the top overlay", both.settings === 1 && both.palette === 1 && one.palette === 0 && one.settings === 1 && none.settings === 0, { both, one, none });
    });
    await S("explorer", async () => {
      await page.locator(".tb-ic[title*='xplorer' i], .tb-ic[title*='files' i]").first().evaluate((el) => el.click()); await sleep(1200);
      await shot("18-explorer");
      note("explorer rows", await page.locator(".ex-row").count());
      const rows = await page.locator(".ex-row").allInnerTexts(); note("explorer text", rows.slice(0, 8));
      await page.locator(".tb-ic[title*='xplorer' i], .tb-ic[title*='files' i]").first().evaluate((el) => el.click()); await sleep(400);
    });
    await S("review drawer", async () => {
      writeFileSync(path.join(REPO, "newfile.txt"), "hello\nworld\n"); appendFileSync(path.join(REPO, "README.md"), "\nedit\n");
      await sleep(3000);
      const pane = page.locator(".pane").first();
      await pane.locator(".pmenubtn").evaluate((el) => el.click()); await sleep(300);
      const it = page.locator(".pmenu .pmenu-item").filter({ hasText: /Review/ }).first();
      note("review item", await it.count());
      if (await it.count()) { await it.evaluate((el) => el.click()); await sleep(2000); await shot("19-review"); r.check("review drawer opens", (await page.locator('[class*=review], [aria-label*=Review i]').count()) > 0); await esc(page); await sleep(500); }
      else { await pane.locator(".pmenubtn").evaluate((el) => el.click()); r.check("Review item present for a repo with changes", false); }
    });
    await S("home board", async () => {
      await page.locator('[aria-label="Home"]').first().evaluate((el) => el.click()); await sleep(1200);
      await shot("20-home");
      note("home text", await page.evaluate(() => (document.querySelector('[role=dialog], .home-ov, [class*=home]')?.innerText || "").replace(/\s+/g, " ").slice(0, 300)));
      await esc(page); await sleep(500);
    });
    await S("notifications + quota", async () => {
      const bell = page.locator('.tb-ic[title*="otif" i], button[title*="otif" i], button[aria-label*="otif" i]').first();
      note("bell count", await bell.count());
      if (await bell.count()) { await bell.evaluate((el) => el.click()); await sleep(900); await shot("21-notifications"); await esc(page); await sleep(400); }
      note("quota text", await page.locator(".qg, [class*=qg]").first().evaluate((e) => e.parentElement.innerText.replace(/\s+/g, " ")).catch(() => null));
      note("quota title", await page.locator(".qg, [class*=qg-]").first().evaluate((e) => (e.closest("[title]") || e).getAttribute("title")).catch(() => null));
    });
    await S("resize narrow/wide", async () => {
      for (const [w, h, n] of [[900, 700, "narrow"], [2560, 1300, "wide"], [1300, 800, "mid"]]) {
        d.setWindow({ width: w, height: h }); await sleep(1800);
        await shot(`22-${n}`);
        const p = await problems(page); note(`layout ${n}`, p);
        r.evidence["layout-" + n] = p;
      }
      d.setWindow({ width: 900, height: 700 }); await sleep(1500);
      await page.locator('button[title^="Settings"]').first().evaluate((el) => el.click()); await sleep(800); await shot("23-narrow-settings"); await esc(page); await sleep(300);
      await page.locator('[aria-label="Home"]').first().evaluate((el) => el.click()); await sleep(800); await shot("24-narrow-home"); await esc(page); await sleep(300);
      await page.locator(".pane").first().locator(".pmenubtn").evaluate((el) => el.click()); await sleep(300); await shot("25-narrow-panemenu");
      await page.locator(".pane").first().locator(".pmenubtn").evaluate((el) => el.click());
      d.setWindow({ width: 2000, height: 1100 }); await sleep(1500);
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
