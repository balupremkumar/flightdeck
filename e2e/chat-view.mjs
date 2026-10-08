// Phase 3 C3: the Chat view, end to end with the mock backend.
// A synthetic Claude session (prompts, prose with a path, Edit and Bash calls,
// an error result, a sidechain) is served through pane_session_info /
// session_tail / session_record. Asserts chips, folding, on-demand detail,
// find that opens collapsed chips, the sticky prompt header, the prompt gate,
// Review opening at the clicked file, the exited-pane gate, and that toggling
// back to Terminal keeps the very same xterm node alive (zero pty_kill).
//
// Run from e2e/ with the Vite dev server on :1420: node chat-view.mjs
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
  const rec = (index, kind, extra) => ({ index, block: 0, uuid: "u" + index, parent_uuid: null, timestamp: "2026-10-04T10:00:00Z",
    kind, sidechain: false, text: null, tool: null, result: null, ...extra });
  const tool = (index, id, name, summary, paths, added, removed, extra) =>
    rec(index, "tool_use", { tool: { id, name, summary, paths, added, removed }, ...extra });
  const res = (index, id, isErr, summary) => rec(index, "tool_result", { result: { tool_use_id: id, is_error: isErr, summary } });

  const R = [
    rec(0, "user", { text: "Add rate limiting to the upload endpoint" }),
    rec(100, "assistant_text", { text: "I will start with " + P("src/api/upload.ts") + " and then run the tests." }),
    tool(200, "e1", "Edit", "src/api/upload.ts", [P("src/api/upload.ts")], 3, 1),
    res(210, "e1", false, "File edited"),
    tool(300, "b1", "Bash", "npm test", [], 0, 0),
    res(310, "b1", false, "7 passed"),
    tool(320, "b2", "Bash", "npm run lint --fix-only", [], 0, 0),
    res(330, "b2", true, "lint exited with code 2"),
    rec(400, "assistant_text", { sidechain: true, text: "Subagent is checking the middleware folder" }),
    tool(410, "r1", "Read", "src/middleware/auth.ts", [P("src/middleware/auth.ts")], 0, 0, { sidechain: true }),
    tool(500, "e2", "Edit", "src/other.ts", [P("src/other.ts")], 1, 0),
    res(510, "e2", false, "File edited"),
    rec(600, "user", { text: "Now tidy the status output and summarise" }),
    tool(700, "b3", "Bash", "git status", [], 0, 0),
    res(710, "b3", false, "clean"),
  ];
  for (let i = 0; i < 40; i++) R.push(rec(800 + i * 10, "assistant_text", { text: "Paragraph " + (i + 1) + ". " + "This line of explanation keeps the conversation long enough to scroll. ".repeat(4) }));
  R.push(tool(2000, "e3", "Edit", "src/lone.ts", [P("src/lone.ts")], 2, 0));
  R.push(res(2010, "e3", false, "File edited"));
  R.push(rec(2100, "assistant_text", { text: "All done." }));

  const RAW = {
    200: { message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: P("src/api/upload.ts"), old_string: "keep\\nold-line", new_string: "keep\\nnew-line-a\\nnew-line-b\\nnew-line-c" } }] } },
    210: { message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "File edited" }] } },
  };

  window.__tail = { served: 0 };
  window.__mockOverrides = {
    pane_session_info: () => ({ session_id: "sess-1", pinned: true, jsonl_path: JSONL }),
    session_tail: ({ fromOffset }) => {
      if (fromOffset > 0) return { records: [], next_offset: fromOffset, truncated: false };
      window.__tail.served++;
      return { records: R, next_offset: 99999, truncated: false };
    },
    session_record: ({ index }) => RAW[index] ?? { message: { content: [] } },
    git_diff_summary: ({ cwd }) => /acme-api/.test(String(cwd))
      ? { base: "a1b2c3d", files: [
          { path: "src/api/upload.ts", added: 3, deleted: 1, binary: false },
          { path: "src/other.ts", added: 1, deleted: 0, binary: false },
          { path: "src/lone.ts", added: 2, deleted: 0, binary: false } ], totalAdded: 6, totalDeleted: 1 }
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
const shot = (name) => page.screenshot({ path: path.join(shots, `chat-${name}.png`) });
const chipTexts = async () => (await page.locator(".chat-chip-text").allTextContents()).map((s) => s.trim());

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".pane", { timeout: 30000 });
await page.evaluate(async () => {
  window.__ui = (await import("/src/ui.ts")).useUI;
  window.__app = (await import("/src/store.ts")).useApp;
});
const paneId = await page.evaluate(() => window.__app.getState().workspaces[0].panes[0].id);
const pane = page.locator(".pane").first();

// Wait for the pty to exist before toggling (the chat tails by pty id).
check(await cond((id) => window.__calls.some((x) => x.c === "pty_spawn"), paneId), "pane PTY spawned");
await pane.locator(".pmenubtn").click();
check(await page.getByRole("menuitemcheckbox", { name: /^(✓ )?Chat view$/ }).count() === 1, "Claude pane menu offers Chat view");
await page.keyboard.press("Escape");

// Tag the terminal's DOM node so we can prove it survives the round trip.
await page.evaluate(() => { document.querySelector(".pane .xterm").__fdTag = "alive"; });
await page.evaluate(() => { window.__calls.length = 0; });

// Toggle via the pane menu.
await pane.locator(".pmenubtn").click();
await page.getByRole("menuitemcheckbox", { name: /^(✓ )?Chat view$/ }).click();
check(await has(".chat"), "Chat view menu item switches the pane to chat");
check(await has(".chat-chip"), "session records render as chips");
// TN2: Normal folds tool runs into activity lines (more in chat-density.mjs); the rest of this suite asserts today's chips, i.e. Verbose.
check(!(await chipTexts()).some((t) => /npm test|fix-only/.test(t)), "Normal keeps the folded commands out of sight until the activity line is opened");
await page.locator('.chat-seg button:has-text("Verbose")').click();
check(await has(".chat-group .chat-chip"), "Verbose shows today's chips");
await shot("chips");

const chips = await chipTexts();
console.log("   chips: " + JSON.stringify(chips));
check(chips.some((t) => /^Edited src\/api\/upload\.ts \+3 -1$/.test(t)), 'Edit chip reads "Edited src/api/upload.ts +3 -1"');
check(chips.some((t) => /^Ran git status$/.test(t)), 'Bash chip reads "Ran git status"');
check(chips.some((t) => /^Ran 2 commands$/.test(t)), 'consecutive Bash calls fold into "Ran 2 commands"');
check((await page.locator(".chat-sub > .chat-chip").count()) === 1, "sidechain records appear as one collapsed Subagent chip");
check((await page.locator(".chat-group > .chat-chip.err").count()) === 1, "group containing an error result is flagged failed");

// Expanding a chip fetches session_record and shows the diff.
await page.evaluate(() => { window.__calls.length = 0; });
await page.locator(".chat-call", { hasText: "Edited src/api/upload.ts" }).locator(".chat-chip").click();
check(await has(".chat-diff"), "expanding the Edit chip shows a diff");
check(await cond(() => window.__calls.filter((x) => x.c === "session_record").length >= 1), "expanding fetched session_record");
const adds = await page.locator(".chat-diff .add").count();
const dels = await page.locator(".chat-diff .del").count();
check(adds === 3 && dels === 1, `diff shows +3 -1 lines (got +${adds} -${dels})`);
await shot("expanded-diff");

// Ctrl+F inside chat opens a collapsed group and highlights the call.
await page.locator(".chat-bar-title").click();
await page.keyboard.press("Control+f");
check(await has(".chat-find input"), "Ctrl+F opens the chat find box");
await page.locator(".chat-find input").fill("fix-only");
check(await has(".chat-call.hit"), "find opens the collapsed group and marks the matching call");
check((await chipTexts()).some((t) => /npm run lint --fix-only/.test(t)), "matching command chip is now visible");
check(/1\/1/.test((await page.locator(".chat-find-count").textContent()) ?? ""), "find count reads 1/1");
await shot("find");
await page.locator(".chat-find input").press("Escape");
check(await gone(".chat-find"), "Escape closes the chat find box");

// "N files changed" opens Review AT the file (list for several, direct for one).
const filesBtns = page.locator(".chat-files");
check((await filesBtns.count()) === 2, "each turn that edited files has a files-changed button");
await filesBtns.first().locator(".chat-files-caret").click();
check(await has(".chat-filelist"), "a turn with several files offers a file list");
await page.locator(".chat-filelist .chat-link", { hasText: "other.ts" }).click();
check(await has(".rv-drawer .rv-patch-file"), "Review drawer opens from the chat");
check(await cond(() => document.querySelector(".rv-patch-file")?.textContent === "src/other.ts"), "Review opens at the clicked file (src/other.ts)");
await shot("review-at-file");
await page.keyboard.press("Escape");
check(await gone(".rv-drawer"), "Escape closes Review");
await page.locator(".chat-files").nth(1).scrollIntoViewIfNeeded();
await page.locator(".chat-files").nth(1).locator(".chat-files-main").click();
check(await cond(() => document.querySelector(".rv-patch-file")?.textContent === "src/lone.ts"), "a single-file turn opens Review directly at that file (src/lone.ts)");
await page.keyboard.press("Escape");
await gone(".rv-drawer");

// Sticky prompt header: scroll into the last turn, past its prompt bubble.
await page.evaluate(() => {
  const sc = document.querySelector(".chat-scroll");
  const t = document.querySelectorAll("[data-turn]")[1];
  sc.scrollTop = t.offsetTop + 400;
  sc.dispatchEvent(new Event("scroll"));
});
check(await has(".chat-sticky"), "sticky prompt header appears when scrolled into a turn");
check(/Now tidy the status output/.test((await page.locator(".chat-sticky").textContent()) ?? ""), "sticky header shows the last prompt");
await shot("sticky");

// Prompt box enabled when waiting/idle, disabled on permission.
await page.evaluate((id) => window.__app.getState().setPaneState(id, "waiting"), paneId);
check(await cond(() => !document.querySelector('.chat textarea[aria-label="Message the agent"]')?.disabled), "prompt box is enabled when the pane is waiting");
await page.evaluate((id) => window.__app.getState().setPaneState(id, "permission"), paneId);
check(await cond(() => document.querySelector(".chat-gate") !== null && !document.querySelector('.chat textarea[aria-label="Message the agent"]')), "prompt box is replaced by a gate when the pane is on a permission prompt");
check(/switch to Terminal/i.test((await page.locator(".chat-gate").textContent()) ?? ""), "gate tells the user to switch to Terminal");
await shot("permission-gate");
await page.evaluate((id) => window.__app.getState().setPaneState(id, "waiting"), paneId);

// Back to Terminal: same xterm node, no pty_kill.
await pane.locator(".pmenubtn").click();
await page.getByRole("menuitemcheckbox", { name: /^(✓ )?Chat view$/ }).click();
check(await gone(".chat"), "Chat view menu item returns to the terminal");
check(await page.evaluate(() => document.querySelector(".pane .xterm")?.__fdTag === "alive"), "the same xterm DOM node is still mounted");
check((await page.evaluate(() => window.__calls.filter((x) => x.c === "pty_kill").length)) === 0, "zero pty_kill across the Terminal/Chat round trip");

// Ctrl+Shift+M toggles both ways.
await pane.locator(".xterm").click();
await page.keyboard.press("Control+Shift+M");
check(await has(".chat"), "Ctrl+Shift+M switches to chat");
check(await has(".chat-chip"), "chat renders again after the shortcut");
await page.keyboard.press("Control+Shift+M");
check(await gone(".chat"), "Ctrl+Shift+M switches back to terminal");
check(await page.evaluate(() => document.querySelector(".pane .xterm")?.__fdTag === "alive"), "xterm node still the same after the shortcut round trip");
check((await page.evaluate(() => window.__calls.filter((x) => x.c === "pty_kill").length)) === 0, "still zero pty_kill after the shortcut round trip");

// Exited pane: the prompt box refuses and offers Restart.
await pane.locator(".pmenubtn").click();
await page.getByRole("menuitemcheckbox", { name: /^(✓ )?Chat view$/ }).click();
await has(".chat");
const exitedPty = await page.evaluate(async () => (await import("/src/paneSessions.ts")).get(window.__app.getState().workspaces[0].panes[0].id)?.ptyId);
await page.evaluate((p) => window.__mockEmit("pty://exit", { pane_id: p, crashed: false }), exitedPty);
check(await has(".chat-gate"), "an exited pane replaces the prompt box with a gate");
check(/has exited\. Restart it to continue/.test((await page.locator(".chat-gate").textContent()) ?? ""), "gate reads \"This pane has exited. Restart it to continue\"");
check((await page.locator('.chat textarea[aria-label="Message the agent"]').count()) === 0, "no textarea to send into an exited pane");
await shot("exited");
await page.evaluate(() => { window.__calls.length = 0; });
await page.locator('.chat-gate button:has-text("Restart")').click();
check(await cond(() => !document.querySelector(".chat-gate")), "Restart clears the exited gate");
check(await cond(() => window.__calls.some((x) => x.c === "pty_spawn")), "Restart spawned a fresh PTY");

check(pageErrors.length === 0, `no page errors${pageErrors.length ? ": " + pageErrors.join(" | ") : ""}`);
await browser.close();
if (failures.length) { console.error(`CHAT-VIEW FAIL (${failures.length})`); process.exit(1); }
console.log("CHAT-VIEW PASS");
