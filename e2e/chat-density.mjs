// TN2/TN3/TN4/TN6: Chat Normal vs Verbose density, end to end with the mock backend.
// One realistic multi-file edit turn (prompt, prose, 6 Edits over 4 files, 3 Bash,
// 8 Reads, 2 Grep, one subagent, closing prose) is served through session_tail,
// plus a session_subagents link (and one unlinked subagent) whose own transcript is
// served by path. Asserts: Normal fits the turn in at most 5 rows below the prompt,
// the activity line expands to chips, a chip expands to its diff, the subagent is one
// line that tails its transcript only once expanded, the change row opens Review,
// Find opens the activity line holding a hit, and Verbose is today's rendering.
// Screenshots go to e2e/shots/chat-density-{normal,verbose,...}.png.
//
// Run from e2e/ against your own Vite server: FD_URL=http://localhost:1431 node chat-density.mjs
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
  const T = window.__TAURI_INTERNALS__;
  const inv = T.invoke;
  window.__calls = [];
  T.invoke = (c, a) => { window.__calls.push({ c, a }); return inv(c, a); };

  const CWD = "C:\\\\dev\\\\acme-api";
  const P = (rel) => CWD + "\\\\" + rel.replace(/\\//g, "\\\\");
  const JSONL = "C:\\\\Users\\\\demo\\\\.claude\\\\projects\\\\acme-api\\\\sess-1.jsonl";
  const SUBJ = "C:\\\\Users\\\\demo\\\\.claude\\\\projects\\\\acme-api\\\\sess-1\\\\subagents\\\\agent-a64b.jsonl";
  let n = 0;
  const rec = (kind, extra) => { n += 10; return { index: n, block: 0, uuid: "u" + n, parent_uuid: null, timestamp: "2026-10-04T10:00:00Z",
    kind, sidechain: false, text: null, tool: null, result: null, ...extra }; };
  const RAW = {};
  const call = (id, name, summary, paths, added, removed, input, extra) => {
    const r = rec("tool_use", { tool: { id, name, summary, paths, added, removed }, ...extra });
    RAW[r.index] = { message: { content: [{ type: "tool_use", id, name, input: input ?? {} }] } };
    return [r, rec("tool_result", { result: { tool_use_id: id, is_error: false, summary: "ok" }, sidechain: !!extra?.sidechain })];
  };
  const edit = (id, rel, added, removed) =>
    call(id, "Edit", rel, [P(rel)], added, removed, { file_path: P(rel), old_string: "keep\\nold-" + id, new_string: "keep\\nnew-" + id + "-a\\nnew-" + id + "-b" });

  const R = [
    rec("user", { text: "Wire the uploader through the new limiter and tidy the tests" }),
    rec("assistant_text", { text: "I will read the existing modules, change four files, then run the checks." }),
    ...Array.from({ length: 8 }, (_, i) => call("r" + i, "Read", "src/m" + i + ".ts", [P("src/m" + i + ".ts")], 0, 0)).flat(),
    ...edit("e1", "src/a.ts", 10, 2),
    ...call("b1", "Bash", "npm run build", [], 0, 0),
    ...edit("e2", "src/b.ts", 20, 5),
    rec("assistant_text", { text: "Now I'll update the tests." }),
    ...edit("e3", "src/b.ts", 4, 1),
    ...edit("e4", "src/c.ts", 30, 3),
    ...edit("e5", "src/d.ts", 8, 0),
    ...edit("e6", "src/d.ts", 2, 2),
    rec("assistant_text", { text: "Running the checks." }),
    ...call("b2", "Bash", "npm test", [], 0, 0),
    ...call("b3", "Bash", "npm run lint", [], 0, 0),
    ...call("g1", "Grep", "limiter", [], 0, 0),
    ...call("g2", "Grep", "TODO", [], 0, 0),
    rec("assistant_text", { text: "Handing the last piece to a subagent." }),
    ...call("ag1", "Agent", "Build element 11", [], 0, 0),
    rec("assistant_text", { text: "All four files are updated and the checks pass." }),
  ];

  // The subagent's own transcript: every line is a sidechain line, as on disk.
  const S = [
    rec("user", { sidechain: true, text: "Build element 11 Selected work" }),
    rec("assistant_text", { sidechain: true, text: "Reading the layout first." }),
    ...call("s1", "Read", "src/sel.ts", [P("src/sel.ts")], 0, 0, {}, { sidechain: true }),
    ...call("s2", "Edit", "src/sel.ts", [P("src/sel.ts")], 4, 0, {}, { sidechain: true }),
    ...call("s3", "Bash", "npm test", [], 0, 0, {}, { sidechain: true }),
    ...call("s4", "Bash", "npm run build", [], 0, 0, {}, { sidechain: true }),
    rec("assistant_text", { sidechain: true, text: "Element 11 is in." }),
  ];

  const LINKS = [
    { id: "a64b", toolUseId: "ag1", agentType: "fork", description: "Build element 11 Selected work", jsonlPath: SUBJ,
      edits: 4, commands: 25, reads: 8, searches: 0, other: 1, finished: true, lastActivityMs: Date.now() - 60000 },
    { id: "ffff", toolUseId: "toolu_not_loaded", agentType: "fork", description: "Orphan check", jsonlPath: SUBJ.replace("a64b", "ffff"),
      edits: 0, commands: 2, reads: 0, searches: 0, other: 0, finished: false, lastActivityMs: Date.now() - 600000 },
  ];

  window.__mockOverrides = {
    pane_session_info: () => ({ session_id: "sess-1", pinned: true, jsonl_path: JSONL }),
    session_tail: ({ jsonlPath, fromOffset }) => {
      if (fromOffset > 0) return { records: [], next_offset: fromOffset, truncated: false };
      return { records: jsonlPath === JSONL ? R : S, next_offset: 99999, truncated: false };
    },
    session_record: ({ index }) => RAW[index] ?? { message: { content: [] } },
    session_subagents: () => LINKS,
    git_diff_summary: ({ cwd }) => /acme-api/.test(String(cwd))
      ? { base: "a1b2c3d", files: ["a", "b", "c", "d"].map((f) => ({ path: "src/" + f + ".ts", added: 1, deleted: 0, binary: false })), totalAdded: 4, totalDeleted: 0 }
      : { base: "a1b2c3d", files: [], totalAdded: 0, totalDeleted: 0 },
  };
})();`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.addInitScript(boot + "\n" + mock + "\n" + overrides);

const has = (sel, timeout = 15000) => page.waitForSelector(sel, { timeout, state: "visible" }).then(() => true, () => false);
const gone = (sel, timeout = 15000) => page.waitForSelector(sel, { timeout, state: "detached" }).then(() => true, () => false);
const cond = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const shot = (name) => page.screenshot({ path: path.join(shots, `chat-density-${name}.png`) });
const rowsBelowPrompt = () => page.evaluate(() => document.querySelectorAll(".chat-turn")[0].querySelectorAll(":scope > :not(.chat-user)").length);
const subTailCalls = () => page.evaluate(() => window.__calls.filter((x) => x.c === "session_tail" && /subagents/.test(String(x.a?.jsonlPath))).length);

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".pane", { timeout: 30000 });
await page.evaluate(async () => {
  window.__ui = (await import("/src/ui.ts")).useUI;
  window.__app = (await import("/src/store.ts")).useApp;
});
const paneId = await page.evaluate(() => window.__app.getState().workspaces[0].panes[0].id);
const pane = page.locator(".pane").first();
check(await cond(() => window.__calls.some((x) => x.c === "pty_spawn")), "pane PTY spawned");
// Terminal is the default since 0.6.1 (and the mock restores its panes), so switch to Chat explicitly.
await pane.locator(".pmenubtn").click();
await page.getByRole("menuitemcheckbox", { name: /^(✓ )?Chat view$/ }).click();
check(await has(".chat-activity"), "Chat opens with the turn folded into an activity line");

// --- Normal -----------------------------------------------------------------
check(await page.locator('.chat-seg button.on').textContent() === "Normal", "Normal is the default detail level");
const normalRows = await rowsBelowPrompt();
check(normalRows <= 5, `Normal renders the whole turn in at most 5 rows below the prompt (got ${normalRows})`);
check((await page.locator(".chat-diff").count()) === 0, "no diff is inline in Normal");
const label = (await page.locator(".chat-activity > .chat-chip .chat-chip-text").first().textContent())?.trim();
check(label === "Edited 4 files, ran 3 commands, read 8 files +3 other", `activity label is verb first, fixed order, capped at 3 segments (got "${label}")`);
check((await page.locator(".chat-activity > .chat-chip").first().getAttribute("aria-expanded")) === "false", "activity line is a collapsed button (aria-expanded=false)");
const changeRow = (await page.locator(".chat-files-main").first().textContent())?.trim();
check(changeRow === "Changed 4 files +74 -13", `change row sums +/- over the turn's edits (got "${changeRow}")`);
check((await subTailCalls()) === 0, "no subagent transcript is read while collapsed");
check((await page.locator(".chat-turn > .chat-text").count()) === 1, "only the closing reply stays visible as prose; narration is folded into the line");
const lastNarr = await page.locator(".chat-activity .chat-narr-last").first().getAttribute("title");
check(lastNarr === "Handing the last piece to a subagent.", `the line shows the latest narration sentence, title holds it in full (got "${lastNarr}")`);
await shot("normal");

// --- Activity line -> chips -> diff ------------------------------------------
await page.locator(".chat-activity > .chat-chip").first().click();
check(await has(".chat-activity-body .chat-chip"), "clicking the activity line expands to today's chips");
check((await page.locator(".chat-activity > .chat-chip").first().getAttribute("aria-expanded")) === "true", "activity line reports aria-expanded=true");
check((await page.locator(".chat-activity-body .chat-narr").count()) === 4, "expanded line interleaves the 4 narration sentences with the chips");
const order = await page.evaluate(() => [...document.querySelectorAll(".chat-activity-body > *")].slice(0, 3).map((e) => e.classList.contains("chat-narr") ? "narr" : "step"));
check(order[0] === "narr", "narration sits in original order (the opening sentence comes first)");
check((await page.locator(".chat-activity-body .chat-result").count()) === 0, "expanded Normal hides bare ok result lines");
await shot("normal-expanded");
await page.locator(".chat-activity-body .chat-call", { hasText: "Edited src/a.ts" }).locator(".chat-chip").click();
check(await has(".chat-diff"), "clicking a chip shows its diff");
check((await page.locator(".chat-diff .add").count()) === 2 && (await page.locator(".chat-diff .del").count()) === 1, "diff shows the edit (+2 -1 lines)");
await shot("normal-diff");

// --- Subagent: one line, tailed on expand ------------------------------------
const subBtn = page.locator(".chat-activity-body .chat-sub > .chat-chip").first();
check(await cond(() => document.querySelector(".chat-activity-body .chat-sub") !== null), "the Agent call renders as a subagent line once session_subagents answers");
const subText = (await subBtn.textContent())?.replace(/\s+/g, " ").trim() ?? "";
check(/Subagent: Build element 11 Selected work · 4 edits, 25 commands, 8 reads, 1 other\s*· done/.test(subText), `subagent line reads description and counts (got "${subText}")`);
check((await subTailCalls()) === 0, "subagent transcript still unread before it is expanded");
await subBtn.click();
check(await has(".chat-sub-body .chat-activity"), "expanding the subagent shows its own steps folded at the same density");
check((await subTailCalls()) >= 1, "expanding tailed the subagent transcript");
check((await page.locator(".chat-sub-body .chat-subprompt").count()) === 1, "subagent shows its delegated prompt");
await shot("normal-subagent");
check((await page.locator(".chat-unlinked .chat-sub").count()) === 1, "an unlinked subagent is listed once at the end");
const orphan = (await page.locator(".chat-unlinked .chat-chip").textContent())?.replace(/\s+/g, " ").trim() ?? "";
check(/Orphan check · 2 commands\s*· idle/.test(orphan), `unlinked subagent that went idle says so (got "${orphan}")`);

// --- Find opens the activity line --------------------------------------------
await page.locator(".chat-activity > .chat-chip").first().click();
check(await gone(".chat-activity-body"), "activity line collapses again");
await page.locator(".chat-bar-title").click();
await page.keyboard.press("Control+f");
await page.locator(".chat-find input").fill("npm run lint");
check(await has(".chat-activity-body .chat-call.hit"), "Find opens the activity line that holds the hit");
await page.locator(".chat-find input").press("Escape");

await page.keyboard.press("Control+f");
await page.locator(".chat-find input").fill("update the tests");
check(await has(".chat-activity-body .chat-narr.hit"), "Find hits narration text and opens its activity line");
await page.locator(".chat-find input").press("Escape");

// --- Change row opens Review --------------------------------------------------
await page.locator(".chat-files-main").first().click();
check(await has(".rv-drawer .rv-patch-file"), "change row opens Review");
check(await cond(() => document.querySelector(".rv-patch-file")?.textContent === "src/a.ts"), "Review opens at the first changed file (src/a.ts)");
await page.keyboard.press("Escape");
await gone(".rv-drawer");
await page.locator(".chat-files-caret").first().click();
check(await has(".chat-filelist"), "the caret lists the changed files");
await page.locator(".chat-filelist .chat-link", { hasText: "d.ts" }).click();
check(await cond(() => document.querySelector(".rv-patch-file")?.textContent === "src/d.ts"), "a listed file opens Review at that file");
await page.keyboard.press("Escape");
await gone(".rv-drawer");

// --- Verbose = today's rendering ---------------------------------------------
await page.locator('.chat-seg button:has-text("Verbose")').click();
check(await gone(".chat-activity"), "Verbose has no activity lines");
const verboseRows = await rowsBelowPrompt();
check(verboseRows > normalRows, `Verbose shows more rows than Normal (${verboseRows} vs ${normalRows})`);
check((await page.locator(".chat-group > .chat-chip").count()) >= 4, "Verbose shows the per-tool group chips");
console.log(`   rows below the prompt: Normal ${normalRows}, Verbose ${verboseRows}`);
await shot("verbose");

// --- TN1 empty state: no session yet, Claude asking in the terminal ----------
{
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p2.on("pageerror", (e) => pageErrors.push(e.message));
  await p2.addInitScript(boot + "\n" + mock + "\n" + overrides + "\nwindow.__mockOverrides.pane_session_info = () => ({ session_id: null, pinned: false, jsonl_path: null });");
  await p2.goto(URL, { waitUntil: "networkidle" });
  await p2.waitForSelector(".pane", { timeout: 30000 });
  await p2.evaluate(async () => { window.__app = (await import("/src/store.ts")).useApp; });
  const id2 = await p2.evaluate(() => window.__app.getState().workspaces[0].panes[0].id);
  await p2.locator('.pane').first().locator(".pmenubtn").click();
  await p2.getByRole("menuitemcheckbox", { name: /^(✓ )?Chat view$/ }).click();
  await p2.evaluate((id) => window.__app.getState().setPaneState(id, "permission"), id2);
  const msg = await p2.waitForSelector(".chat-empty", { timeout: 15000, state: "visible" }).then(() => true, () => false);
  check(msg && /Claude is asking something in the terminal/.test((await p2.locator(".chat-empty").textContent()) ?? ""), "no session + permission state: Chat says Claude is asking something in the terminal");
  check((await p2.getByRole("button", { name: "Switch to Terminal" }).count()) === 1, "empty-asking state has a single Switch to Terminal button");
  await p2.screenshot({ path: path.join(shots, "chat-density-empty-asking.png") });
  await p2.locator(".chat-gate button", { hasText: "Switch to Terminal" }).click();
  check(await p2.waitForSelector(".chat", { timeout: 15000, state: "detached" }).then(() => true, () => false), "Switch to Terminal leaves Chat for the terminal");
  await p2.close();
}

check(pageErrors.length === 0, "no page errors" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));
await browser.close();
if (failures.length) { console.error(`\nCHAT-DENSITY FAIL (${failures.length})`); process.exit(1); }
console.log("\nCHAT-DENSITY PASS");
