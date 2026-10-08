// Phase 5 Home view, end to end against the demo mock backend.
// Step 2: opens by chord, titlebar button and palette; header count equals the
// bell; Escape closes and restores focus; digits do not move pane focus behind Home.
// Step 3: J/K and arrows, 1-5 column jump, Enter opens the pane and focuses its
// terminal, self-close on external focus change, 940 (stacked) and 1440 (columns).
// Step 4: diff and PR rows from the poll store, only while Home is open.
//
// Run from e2e/ with a Vite dev server: FD_URL=http://localhost:1436 node home.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = readFileSync(path.join(here, "..", "demo", "mock-tauri-interactive.js"), "utf8");
const shots = path.join(here, "shots");
mkdirSync(shots, { recursive: true });
const URL = process.env.FD_URL ?? "http://localhost:1420";
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const wrap = `(()=>{
  const T=window.__TAURI_INTERNALS__;const inv=T.invoke;
  window.__pty2model={};window.__model2pty={};window.__calls=[];
  T.invoke=(c,a)=>{
    window.__calls.push({c,a});
    const r=inv(c,a);
    if(c==="pty_spawn")Promise.resolve(r).then((id)=>{window.__pty2model[id]=a.modelId;window.__model2pty[a.modelId]=id;});
    return r;
  };
})();`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
// Populated data for the poll store: a diff on pane 2's cwd, an open PR with
// running checks on acme-api (so its idle panes stay idle), a merged PR on
// acme-web, and a rejecting repo for pane 4 (kimi) to exercise the failure memo.
const overrides = `(()=>{
  window.__homeDelay = 0;
  window.__mockOverrides = {
    git_diff_summary: ({cwd}) => {
      const out = String(cwd).endsWith("billing")
        ? {base:"main",files:[{path:"a.ts"},{path:"b.ts"}],totalAdded:84,totalDeleted:12}
        : {base:"main",files:[],totalAdded:0,totalDeleted:0};
      if (String(cwd).endsWith("web") && String(cwd).includes("acme-api")) return Promise.reject(new Error("not a repo"));
      return window.__homeDelay ? new Promise((r)=>setTimeout(()=>r(out), window.__homeDelay)) : out;
    },
    pr_status: ({cwd}) => {
      const out = cwd === "C:\\\\dev\\\\acme-api" ? {number:12,url:"https://github.com/acme/acme-api/pull/12",state:"OPEN",checks:"running"}
        : cwd === "C:\\\\dev\\\\acme-web" ? {number:41,url:"https://github.com/acme/acme-web/pull/41",state:"MERGED",checks:"passed"} : null;
      return window.__homeDelay ? new Promise((r)=>setTimeout(()=>r(out), window.__homeDelay)) : out;
    },
  };
})();`;
await page.addInitScript(boot + "\n" + mock + "\n" + wrap + "\n" + overrides);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.locator('text="acme-web" >> visible=true').first().click();
await page.waitForTimeout(2500);

// A genuine question on pane 3 (codex, acme-api); pane 6 (codex, acme-web) stays quiet so a merged PR can land it in Merged.
const pty3 = await page.evaluate(() => window.__model2pty[3]);
await page.evaluate((id) => window.__mockPrint(id, "Which package manager should I use?"), pty3);
await page.waitForTimeout(9000);

const bellCount = () => page.evaluate(() =>
  [...document.querySelectorAll(".ntf-badge")].reduce((n, e) => n + (parseInt(e.textContent ?? "0", 10) || 0), 0));
const homeOpen = () => page.locator(".hm-panel").count().then((n) => n > 0);
const focusedPaneIdx = () => page.evaluate(() =>
  [...document.querySelectorAll(".pane")].findIndex((e) => e.classList.contains("focused")));

// --- Step 2: entry -----------------------------------------------------------
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel", { timeout: 5000 });
check(await homeOpen(), "Ctrl+Shift+H opens Home");
await page.keyboard.press("Control+Shift+H");
await page.waitForTimeout(300);
check(!(await homeOpen()), "Ctrl+Shift+H again closes Home");

await page.getByTitle("Home (Ctrl+Shift+H)").click();
await page.waitForSelector(".hm-panel", { timeout: 5000 });
check(await homeOpen(), "titlebar button opens Home");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(!(await homeOpen()), "Escape closes Home");

await page.keyboard.press("Control+k");
await page.getByPlaceholder("Jump to a workspace, pane, or action…").fill("Open Home");
await page.keyboard.press("Enter");
await page.waitForSelector(".hm-panel", { timeout: 5000 });
check(await homeOpen(), "palette 'Open Home' opens Home");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Count equals the bell.
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
const needsCards = await page.locator(".hm-col.needs [data-pane-id]").count();
const bell = await bellCount();
const headerN = await page.locator(".hm-count").innerText();
check(needsCards >= 1, `Needs you has ${needsCards} card(s)`);
check(parseInt(headerN, 10) === bell && needsCards === bell, `header "${headerN}" == bell ${bell} == needs cards ${needsCards}`);
check((await page.locator(".hm-col").count()) === 5, "five columns render");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Escape restores focus to what had it.
await page.locator('button[title^="Settings"]').focus();
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
check(await page.evaluate(() => !!document.activeElement?.closest(".hm-panel")), "focus moves into Home on open");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check(await page.evaluate(() => document.activeElement?.getAttribute("title")?.startsWith("Settings") ?? false), "Escape returns focus to the previous element");

// Digits and pane-focus chords do not move focus behind Home.
const before = await focusedPaneIdx();
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
for (const k of ["2", "Alt+2", "Alt+1", "Control+Alt+ArrowRight", "`"]) await page.keyboard.press(k);
await page.waitForTimeout(200);
check((await focusedPaneIdx()) === before, `pane focus unchanged behind Home (idx ${before})`);
check(await homeOpen(), "Home survives those keys");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// --- Step 3: navigation and layout ------------------------------------------
const activeCard = () => page.evaluate(() => document.activeElement?.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null);
const activeColumn = () => page.evaluate(() => {
  const c = document.activeElement?.closest(".hm-col");
  return c ? [...c.classList].find((x) => x !== "hm-col") : null;
});
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
const first = await activeCard();
check(first !== null, `open lands on a card (${first}, column ${await activeColumn()})`);
await page.keyboard.press("j");
const afterJ = await activeCard();
check(afterJ !== null && afterJ !== first, `J moves to the next card (${first} -> ${afterJ})`);
await page.keyboard.press("k");
check((await activeCard()) === first, "K moves back");
await page.keyboard.press("ArrowDown");
check((await activeCard()) === afterJ, "ArrowDown == J");
await page.keyboard.press("4");
await page.waitForTimeout(100);
check((await activeColumn()) === "idle", "4 jumps to the Idle column");
await page.keyboard.press("1");
await page.waitForTimeout(100);
check((await activeColumn()) === "needs", "1 jumps back to Needs you");
await page.keyboard.press("ArrowRight");
check((await activeColumn()) === "working", "ArrowRight moves to the next non-empty column");
await page.keyboard.press("ArrowLeft");
check((await activeColumn()) === "needs", "ArrowLeft moves back");

// Red team #9: a dialog stacked above Home owns the keyboard; Home's J/K/1-5 do nothing.
// The app's own ui.ts instance (Vite adds ?t= after an HMR update, so a bare import would be a second copy).
const uiUrl = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/src\/ui\.ts/.test(n)) ?? "/src/ui.ts");
const stackedId = await page.evaluate(async (u) => (await import(u)).pushOverlay(() => {}), uiUrl);
const beforeStacked = await activeCard();
await page.keyboard.press("j");
check((await activeCard()) === beforeStacked, `J is ignored while a dialog is stacked above Home (${beforeStacked})`);
await page.keyboard.press("4");
check((await activeColumn()) === "needs", "4 is ignored while a dialog is stacked above Home");
await page.evaluate(async ([u, id]) => (await import(u)).popOverlay(id), [uiUrl, stackedId]);
await page.keyboard.press("j");
check((await activeCard()) !== beforeStacked, "J works again once the dialog is gone");
await page.keyboard.press("k");

// Enter opens the pane: Home closes, workspace switches, terminal has focus.
await page.keyboard.press("4"); // an idle card; pane 1 lives in acme-api, the other workspace
await page.locator('[data-pane-id="1"]').focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
check(!(await homeOpen()), "Enter closes Home");
check((await page.locator(".topbar .ws").innerText()) === "acme-api", "Enter switched to the pane's workspace");
const termFocused = await page.evaluate(() => {
  const a = document.activeElement;
  return !!a?.classList.contains("xterm-helper-textarea") && !!a.closest(".pane.focused");
});
check(termFocused, "focus landed in the opened pane's terminal");

// Self-close: an outside change of workspace closes Home, no jump path edits.
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
await page.locator('text="acme-web" >> visible=true').first().evaluate((el) => el.click());
await page.waitForTimeout(400);
check(!(await homeOpen()), "an external workspace switch closes Home");

// Layout: 1440 columns, 940 stacked sections.
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
const boxes = await page.locator(".hm-col").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
check(new Set(boxes.map(Math.round)).size === 5 && !(await page.locator(".hm-panel.stacked").count()), `1440: five side-by-side columns (${boxes.map(Math.round)})`);
await page.keyboard.press("Escape");

await page.setViewportSize({ width: 940, height: 800 });
await page.waitForTimeout(300);
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel.stacked");
const ys = await page.locator(".hm-col").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
check(ys.every((y, i) => i === 0 || y > ys[i - 1]), `940: sections stack top to bottom (${ys})`);
check((await page.locator(".hm-col.idle [data-pane-id]").count()) === 0, "940: Idle starts folded");
check((await page.locator(".hm-col.merged [data-pane-id]").count()) === 0, "940: Merged starts folded");
check((await page.locator(".hm-col.needs [data-pane-id]").count()) > 0, "940: Needs you stays open");
const noOverflow = await page.evaluate(() => document.querySelector(".hm-body").scrollWidth <= document.querySelector(".hm-body").clientWidth);
check(noOverflow, "940: no horizontal overflow");
await page.keyboard.press("4");
await page.waitForTimeout(200);
check((await page.locator(".hm-col.idle [data-pane-id]").count()) > 0 && (await activeColumn()) === "idle", "940: 4 unfolds Idle and focuses its first card");
await page.waitForTimeout(800); // polls landed, rows populated
await page.screenshot({ path: path.join(shots, "home-940.png") });
await page.keyboard.press("Escape");
await page.setViewportSize({ width: 1440, height: 900 });

// --- Step 4: poll store, diff and PR rows -------------------------------------
const callsFor = (cmd, cwdEnd) => page.evaluate(([c, e]) => window.__calls.filter((x) => x.c === c && String(x.a?.cwd).endsWith(e)).length, [cmd, cwdEnd]);
await page.waitForTimeout(8000); // let the PaneView / chip polls from earlier steps age out of their TTLs
const billingBefore = await callsFor("git_diff_summary", "billing");

// Skeletons hold the place of values still loading (fixed size, no spinner).
await page.evaluate(() => { window.__homeDelay = 900; });
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(".hm-panel");
await page.waitForTimeout(250);
check((await page.locator(".hm-skel").count()) > 0, "skeleton bars show while diff and PR are loading");
const skelBox = await page.locator(".hm-skel").first().boundingBox();
check(skelBox && Math.round(skelBox.width) === 60 && Math.round(skelBox.height) === 12, `skeleton is 60x12 (${skelBox?.width}x${skelBox?.height})`);
check((await page.locator(".hm-card").count()) > 0, "cards render immediately from local state, before any poll lands");
await page.waitForTimeout(1800);
check((await page.locator(".hm-skel").count()) === 0, "no skeleton left once the polls land");

const review = page.locator('.hm-col.review [data-pane-id="2"]');
check((await review.count()) === 1, "pane 2 (diff on its cwd) is in Done");
const reviewText = (await review.innerText()).replace(/\s+/g, " ");
check(/\+84 -12 2 files/.test(reviewText), `diff row reads +84 -12 2 files (${reviewText})`);
check(/PR #12 · checks running/.test(reviewText), "PR chip uses prLabel");
check((await page.locator(".hm-col.merged .hm-pr").first().innerText()) === "PR #41 · merged", "Merged column shows the merged PR chip");
check((await page.locator('[data-pane-id="4"] .hm-diff').count()) === 0 && (await page.locator('[data-pane-id="4"] .hm-skel').count()) === 0, "a repo whose diff rejects shows no diff row and no skeleton");
check((await callsFor("git_diff_summary", "billing")) > billingBefore, "opening Home polled the diff for a pane no PaneView is showing");
await page.screenshot({ path: path.join(shots, "home-1440.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// Stops when closed: no new diff calls for that cwd across a full 15s cycle.
await page.evaluate(() => { window.__homeDelay = 0; });
const closedBefore = await callsFor("git_diff_summary", "billing");
await page.waitForTimeout(16500);
check((await callsFor("git_diff_summary", "billing")) === closedBefore, "no Home polling while closed (diff cycle is 15s)");

// --- Steps 6 and 7: peek, reply, Approve -------------------------------------
// Restart pane 3 first, so its pty id is no longer the one it spawned with: a
// reply that went to the model id (or the old pty) would land on the wrong pane.
await page.locator('text="acme-api" >> visible=true').first().click();
await page.waitForTimeout(1500);
await page.locator(".pane:visible").nth(2).locator("button.pmenubtn").click();
await page.locator(".pmenu-item", { hasText: "Restart" }).first().click();
await page.waitForTimeout(2500);
const newPty3 = await page.evaluate(() => window.__model2pty[3]);
check(newPty3 !== pty3, `pane 3 restarted onto a new pty (${pty3} -> ${newPty3})`);
await page.evaluate((id) => window.__mockPrint(id, "Which test runner should I use?"), newPty3);
await page.waitForTimeout(9000);

const card3 = '.hm-col.needs [data-pane-id="3"]';
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(`${card3} .hm-field`, { timeout: 15000 }).catch(() => {});
check((await page.locator(`${card3} .hm-field`).count()) === 1, "question card shows a reply field");
check((await page.locator(`${card3} .hm-peek`).count()) === 0, "peek starts closed");
await page.locator(card3).focus();
await page.keyboard.press("Space");
await page.waitForSelector(`${card3} .hm-peek pre`, { timeout: 5000 });
check(/Which test runner should I use\?/.test(await page.locator(`${card3} .hm-peek pre`).innerText()), "Space opens a peek with the pane's last output");
check((await page.locator(`${card3} [aria-expanded="true"]`).count()) === 1, "Peek button reports expanded");
check((await page.locator(".hm-panel").count()) === 1, "Space did not close or open anything else");

// Field: Shift+Enter is a newline, Enter would send, drafts survive Escape.
const field = page.locator(`${card3} .hm-field`);
await field.click();
await page.keyboard.type("line one");
await page.keyboard.press("Shift+Enter");
await page.keyboard.type("line two");
check((await field.inputValue()) === "line one\nline two", "Shift+Enter inserts a newline");
const h2 = await field.evaluate((e) => e.getBoundingClientRect().height);
check(h2 > 24, `field auto-grew for two lines (${h2}px)`);
check((await page.evaluate(() => window.__calls.filter((x) => x.c === "pty_write" && String(x.a.data).includes("line one")).length)) === 0, "Shift+Enter sent nothing");
await field.fill("pnpm please");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(!(await homeOpen()), "Escape in the field closes Home");
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(`${card3} .hm-field`);
check((await page.locator(`${card3} .hm-field`).inputValue()) === "pnpm please", "the draft came back after reopening");
await page.locator(`${card3} [aria-expanded]`).click();
await page.waitForSelector(`${card3} .hm-peek pre`);
await page.screenshot({ path: path.join(shots, "home2-1440.png") });
await page.setViewportSize({ width: 940, height: 800 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shots, "home2-940.png") });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);

// Failure: the write rejects, the text stays, the error is plain, Send retries.
await page.evaluate(() => { window.__mockOverrides.pty_write = () => { throw "boom"; }; });
await page.keyboard.press("Escape");
await page.keyboard.press("Control+Shift+H");
await page.waitForSelector(`${card3} .hm-field`);
await page.locator(`${card3} .hm-field`).focus();
await page.keyboard.press("Enter");
await page.waitForSelector(`${card3} .hm-err`, { timeout: 5000 });
check(/Could not send to this pane/.test(await page.locator(`${card3} .hm-err`).innerText()), "a rejected write shows the inline error");
check((await page.locator(`${card3} .hm-field`).inputValue()) === "pnpm please", "failed send keeps the text");
check(await page.evaluate(() => document.activeElement?.classList.contains("hm-field")), "failed send returns the caret to the field");
await page.evaluate(() => { delete window.__mockOverrides.pty_write; });

// Success: lands on the restarted pty and nowhere else.
const REPLY = "pnpm please\r";
const callsBefore = await page.evaluate(() => window.__calls.length); // the rejected attempt is already in __calls
await page.keyboard.press("Enter");
await page.waitForFunction(([d, n]) => window.__calls.slice(n).some((x) => x.c === "pty_write" && x.a.data === d), [REPLY, callsBefore], { timeout: 5000 });
const wrote = await page.evaluate(([d, n]) => window.__calls.slice(n).filter((x) => x.c === "pty_write" && x.a.data === d).map((x) => x.a.paneId), [REPLY, callsBefore]);
await page.waitForFunction((sel) => !document.querySelector(sel), `${card3} .hm-field`, { timeout: 5000 });
await page.waitForTimeout(150);
check(wrote.length === 1 && wrote[0] === newPty3, `reply reached pty ${newPty3} only (writes to: ${wrote})`);
// Either the Sent note holds, or the pane's state already flipped and the card moved on by itself.
check((await page.locator(`${card3} .hm-field`).count()) === 0, "the field is gone after Send (Sent note, or the card moved column)");
check(await page.evaluate(() => !!document.activeElement?.closest("[data-pane-id]")), "focus moved to a card after Send");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Approve: a `1. Yes` menu on pane 5 (claude, acme-web) sends Enter to that pty only.
await page.locator('text="acme-web" >> visible=true').first().click();
await page.waitForTimeout(1000);
const pty5 = await page.evaluate(() => window.__model2pty[5]);
await page.evaluate((id) => window.__mockPrint(id, "Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No, tell Claude what to do differently"), pty5);
await page.waitForTimeout(9000);
await page.keyboard.press("Control+Shift+H");
const approveBtn = page.locator('.hm-col.needs [data-pane-id="5"] button', { hasText: "Approve" });
await approveBtn.waitFor({ timeout: 15000 });
// Approve now mounts at once (disabled while the prompt loads); wait for the prompt itself.
await page.locator('.hm-col.needs [data-pane-id="5"] .hm-req').waitFor({ timeout: 15000 });
// Lead review fixes: identity, activity line, permission question, reserved row.
const names = await page.locator(".hm-name").allInnerTexts();
check(names.length > 0 && names.every((n) => n.toLowerCase() !== "node"), `no card is titled by its process name (${names.join(", ")})`);
const acts = await page.locator(".hm-act").allInnerTexts();
check(acts.every((a) => /[\p{L}\p{N}]/u.test(a)), `no activity line is a bare glyph (${JSON.stringify(acts)})`);
const ask5 = await page.locator('.hm-col.needs [data-pane-id="5"] .hm-act:not(.hm-req)').innerText();
check(ask5 === "Do you want to proceed?", `permission card shows the question, not an option ("${ask5}")`);
const metaH = await page.locator(".hm-meta").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
check(metaH.length > 0 && metaH.every((h) => h >= 14), `row 3 keeps its height on every card (${metaH})`);
// Critique 2 and 3: the command being approved is on the card, and Approve is enabled once it shows.
const req5 = await page.locator('.hm-col.needs [data-pane-id="5"] .hm-req').innerText();
check(/rm -rf build/.test(req5), `permission card shows the command above the question ("${req5}")`);
check(await approveBtn.isEnabled(), "Approve is enabled once the command and key are known");
// Critique 1: the focused card's ring is not clipped by the column.
await page.keyboard.press("j");
await page.keyboard.press("k");
const ringClip = await page.evaluate(() => {
  const card = document.activeElement?.closest("[data-pane-id]");
  const col = card?.closest(".hm-col");
  if (!card || !col) return "no card focused";
  const c = card.getBoundingClientRect(), k = col.getBoundingClientRect();
  return c.left - 3 >= k.left && c.right + 3 <= k.right && c.top - 3 >= k.top ? "ok" : `clipped card=${c.left},${c.top},${c.right} col=${k.left},${k.top},${k.right}`;
});
check(ringClip === "ok", `focus ring fits inside the column (${ringClip})`);
await page.screenshot({ path: path.join(shots, "home3-1440.png") });
await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, "home3-light.png") });
await page.evaluate(() => { delete document.documentElement.dataset.theme; });
await page.setViewportSize({ width: 940, height: 800 });
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector(".hm-col.needs [data-pane-id]")?.focus());
await page.keyboard.press("j");
await page.keyboard.press("k");
await page.screenshot({ path: path.join(shots, "home3-940.png") });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
const writesBefore = await page.evaluate(() => window.__calls.filter((x) => x.c === "pty_write").length);
await approveBtn.click();
await page.waitForFunction((n) => window.__calls.filter((x) => x.c === "pty_write").length > n, writesBefore, { timeout: 5000 });
const newWrites = await page.evaluate((n) => window.__calls.filter((x) => x.c === "pty_write").slice(n), writesBefore);
check(newWrites.length === 1 && newWrites[0].a.paneId === pty5 && newWrites[0].a.data === "\r", `Approve sent Enter to pty ${pty5} only (${JSON.stringify(newWrites.map((w) => [w.a.paneId, w.a.data]))})`);
await page.keyboard.press("Escape");

check(pageErrors.length === 0, `no page errors ${pageErrors.join("|")}`);
await browser.close();
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log("\nhome: all checks passed");
