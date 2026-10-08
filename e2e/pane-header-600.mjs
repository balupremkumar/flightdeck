// Phase 6 design fixes 12 + 13: a 600px pane header in the NEEDS YOU state keeps its branch
// label and a readable title; a running Chat activity line pulses only its glyph (opacity)
// and stops when the step finishes; the topbar workspace chips clip with ellipsis.
// Shots: e2e/shots/pane-header-600.png, chat-running-600.png, topbar-chips-long.png.
// Run from e2e/ against your own Vite server: FD_URL=http://localhost:1440 node pane-header-600.mjs
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
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.error("FAIL: " + msg); } else console.log("ok: " + msg); };

const boot = `localStorage.setItem("flightdeck-startup","reopen");`;
const overrides = `(() => {
  const JSONL = "C:\\\\Users\\\\demo\\\\.claude\\\\projects\\\\acme-api\\\\sess-1.jsonl";
  let n = 0;
  const rec = (kind, extra) => { n += 10; return { index: n, block: 0, uuid: "u" + n, parent_uuid: null, timestamp: "2026-10-04T10:00:00Z",
    kind, sidechain: false, text: null, tool: null, result: null, ...extra }; };
  const tool = (id, name, summary) => rec("tool_use", { tool: { id, name, summary, paths: [], added: 0, removed: 0 } });
  const done = (id) => rec("tool_result", { result: { tool_use_id: id, is_error: false, summary: "ok" } });
  // The last Bash has no result yet: the run is live and "now:" shows.
  const R = [ rec("user", { text: "Run the checks" }), tool("r1", "Read", "src/a.ts"), done("r1"), tool("b1", "Bash", "npm test") ];
  window.__live = true;
  let sent = false;
  window.__mockOverrides = {
    pane_session_info: () => ({ session_id: "sess-1", pinned: true, jsonl_path: JSONL }),
    session_tail: ({ fromOffset }) => {
      if (fromOffset > 0) {
        if (!window.__live && !sent) { sent = true; return { records: [done("b1")], next_offset: fromOffset + 1, truncated: false }; }
        return { records: [], next_offset: fromOffset, truncated: false };
      }
      return { records: R, next_offset: 1000, truncated: false };
    },
    session_subagents: () => [],
    git_status: () => ({ isRepo: true, branch: "feature/phase-6-pane-header-crush-fix", dirty: true, ahead: 2, behind: 0 }),
    workspace_ports: () => [3000, 5173, 8080, 9229].map((p, i) => ({ port: p, pid: 100 + i, processName: "node-dev-server", paneId: 1 })),
    pr_status: () => ({ number: 482, url: "https://example.com/acme/api/pull/482", state: "OPEN", checks: "running" }),
  };
})();`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + overrides);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".pane", { timeout: 30000 });
await page.evaluate(async () => {
  window.__app = (await import("/src/store.ts")).useApp;
  const s = window.__app.getState();
  window.__app.setState({ workspaces: s.workspaces.map((w, i) => i === 0 ? { ...w, name: "acme-api-platform-monorepo-with-a-very-long-workspace-name" } : w) });
});
const paneId = await page.evaluate(() => window.__app.getState().workspaces[0].panes[0].id);
await page.addStyleTag({ content: ".pane { width: 600px !important; flex: none !important; }" });
await page.locator(".pane").first().locator(".pmenubtn").click();
await page.getByRole("menuitemcheckbox", { name: /^(✓ )?Chat view$/ }).click();
await page.evaluate((id) => window.__app.getState().setPaneState(id, "permission"), paneId);
check(await page.locator(".phead .pattn").first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false), "NEEDS YOU pill shows");
await page.waitForSelector(".phead .branch-name", { timeout: 15000 });

// --- 13: header ---------------------------------------------------------------
const w = (sel) => page.locator(sel).first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
const paneW = await w(".pane");
const phead = await page.evaluate(() => { const h = document.querySelector(".phead"); return { sw: h.scrollWidth, cw: h.clientWidth }; });
const bn = await w(".phead .branch-name");
const pn = await w(".phead .pname");
console.log(`   pane ${paneW}px, branch-name ${bn}px, pname ${pn}px, phead ${phead.sw}/${phead.cw}`);
check(Math.abs(paneW - 600) <= 2, `pane is 600px wide (got ${paneW})`);
check(bn >= 30, `branch chip keeps a readable label (${bn}px)`);
check(pn >= 40, `pane title keeps at least 6ch (${pn}px)`);
check(phead.sw <= phead.cw + 1, "pane header does not overflow");
check((await page.locator(".phead .branch").first().getAttribute("title"))?.startsWith("feature/phase-6-pane-header-crush-fix"), "branch chip title carries the full branch name");
check(await page.locator(".phead .branch").first().evaluate((e) => e.getBoundingClientRect().right <= document.querySelector(".phead").getBoundingClientRect().right), "branch chip stays inside the header");
await page.locator(".pane").first().screenshot({ path: path.join(shots, "pane-header-600.png") });

// --- 13: topbar chips ---------------------------------------------------------
await page.waitForSelector(".ws-chips .wsc", { timeout: 20000 });
const tb = await page.evaluate(() => {
  const row = document.querySelector(".ws-chips");
  const c = row.getBoundingClientRect();
  const bar = row.parentElement;
  const btns = [...bar.querySelectorAll(".tb-ic")].map((b) => b.getBoundingClientRect());
  const over = btns.filter((b) => b.width > 0 && b.left < c.right - 0.5 && b.right > c.left && b.top < c.bottom && b.bottom > c.top).length;
  const chips = [...row.querySelectorAll(".wsc")].map((e) => e.getBoundingClientRect());
  return { right: c.right, over, n: chips.length, chipsRight: Math.max(...chips.map((r) => r.right)) };
});
console.log(`   topbar: ${JSON.stringify(tb)}`);
check(tb.over === 0, "workspace chips do not overlap topbar buttons");
check(tb.chipsRight <= tb.right + 1, "chips are clipped inside their row");
await page.screenshot({ path: path.join(shots, "topbar-chips-long.png"), clip: { x: 0, y: 0, width: 1400, height: 60 } });

// --- 12: running line ---------------------------------------------------------
await page.waitForSelector(".chat-activity > .chat-chip[data-running]", { timeout: 15000 });
const anim = () => page.locator(".chat-activity > .chat-chip .chat-glyph").first().evaluate((e) => { const c = getComputedStyle(e); return { name: c.animationName, dur: c.animationDuration }; });
const a1 = await anim();
check(a1.name === "chat-pulse" && a1.dur === "1.4s", `running glyph pulses (${a1.name} ${a1.dur})`);
check(await page.locator(".chat-activity > .chat-chip .chat-now").first().isVisible(), "now: text is shown while running");
check((await page.locator(".chat-activity [data-running]").count()) === 1, "only one line is marked running");
await page.locator(".pane").first().screenshot({ path: path.join(shots, "chat-running-600.png") });
await page.emulateMedia({ reducedMotion: "reduce" });
check((await anim()).name === "none", "reduced motion turns the pulse off");
await page.emulateMedia({ reducedMotion: "no-preference" });
await page.evaluate(() => { window.__live = false; });
check(await page.waitForSelector(".chat-activity > .chat-chip[data-running]", { state: "detached", timeout: 20000 }).then(() => true, () => false), "pulse stops when the step finishes");

check(pageErrors.length === 0, "no page errors" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));
await browser.close();
if (failures.length) { console.error(`\nPANE-HEADER-600 FAIL (${failures.length})`); process.exit(1); }
console.log("\nPANE-HEADER-600 PASS");
