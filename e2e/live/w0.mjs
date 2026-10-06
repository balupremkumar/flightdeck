// Job W0: Claude in the classic terminal vs Claude's focus view ("Quiet terminal") on the SAME real task.
// Needs a running Canary (node launch.mjs). Stages so a re-run never relaunches the app:
//   node w0.mjs setup     settings, scratch repo workspace with two Claude panes, trust prompt, pane 2 -> focus mode
//   node w0.mjs terminal  prompt in pane 1 (classic), screenshot
//   node w0.mjs quiet     reset repo, same prompt in pane 2 (focus view), screenshot, Ctrl+O screenshot
//   node w0.mjs window    both panes side by side
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as d from "./drive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATE = process.env.FD_RESULTS_DATE ?? "2026-10-06";
const OUT = path.join(here, "results", DATE);
const REPO = process.env.FD_SWEEP_REPO
  ?? "C:\\Users\\User\\AppData\\Local\\Temp\\claude\\D--Dev-ai-projects-active-flightdeck\\983d423c-fdb0-4599-ba8a-c640f0f5458f\\scratchpad\\sweep-repo";
const PROMPT = "Add a slugify(text) function to src/strings.ts, use it in src/routes.ts, and add a test for it in src/strings.test.ts. Keep it short. Do not run any commands.";
const ZOOM = Number(process.env.FD_ZOOM ?? 0.75);
const FLAGS = "--model haiku --permission-mode acceptEdits";
const READY = /\?\s*for\s*shortcuts|accept\s*edits|Try\s*"|bypass/i;
const stage = process.argv[2] ?? "setup";
mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, "w0-log.json");
const log = existsSync(logFile) ? JSON.parse(readFileSync(logFile, "utf8")) : {};
const save = () => writeFileSync(logFile, JSON.stringify(log, null, 2));
const say = (m) => console.log(`[w0:${stage}] ${m}`);
const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();

const { browser, page } = await d.connect();
log.foreground = log.foreground ?? {};
log.foreground[`start-${stage}`] = d.foreground();

async function ids() {
  const m = await d.modelIds(page);
  if (m.length < 2) throw new Error(`expected 2 spawned panes, saw ${m.length}`);
  return m;
}

async function handleTrustAndReady(modelId, label, must = null) {
  const t0 = Date.now();
  let trusted = false;
  while (Date.now() - t0 < 90000) {
    const text = (await d.tail(page, modelId)).join("\n");
    if (!trusted && /Yes,\s*I\s*trust\s*this\s*folder/i.test(text) && /No,\s*exit/i.test(text)) {
      // This Claude build highlights "No, exit" by default: move to "Yes, I trust this folder" first.
      say(`${label}: folder trust prompt, choosing Yes, I trust this folder`);
      await d.pressInPane(page, label === "pane1" ? 0 : 1, "ArrowDown");
      await d.sleep(400);
      await d.pressInPane(page, label === "pane1" ? 0 : 1, "Enter");
      trusted = true;
      await d.sleep(2500);
      continue;
    }
    if (READY.test(text) && (!must || must.test(text))) return { trusted, text };
    await d.sleep(1000);
  }
  throw new Error(`${label}: Claude never reached its prompt`);
}

if (stage === "setup") {
  // 2400x1200 physical = about 2180x1090 CSS px at the 110% display scale: two 640px+ panes beside the sidebar.
  d.setWindow({ width: 2400, height: 1200 });
  if (await d.panes(page).count() < 2) {
    await d.declineRestore(page);
    await d.applyTestSettings(page, { flags: { claude: FLAGS }, openClaudeIn: "terminal" });
    await d.declineRestore(page);
    await d.createWorkspace(page, { root: REPO, count: 2, vendor: "claude" });
  } else { await page.evaluate(() => 0); say("workspace already open, resuming"); await d.wrapSpawns(page); }
  await page.waitForTimeout(3000);
  const m = await ids();
  say(`spawned: ${JSON.stringify(m)}`);
  log.spawn1 = m;
  log.setup1 = await handleTrustAndReady(m[0].modelId, "pane1");
  log.setup2 = await handleTrustAndReady(m[1].modelId, "pane2");
  // Settings > Agents "extra CLI flags" is stored but never read by this build (no consumer in src/ or src-tauri/),
  // so the cheap-model flags go through the app's own one-shot launch-args staging (stage_launch_args, the
  // same call the session launcher uses), then a pane restart consumes them.
  const ARGS = FLAGS.split(" ");
  const paneMenu = async (i, name) => { await d.panes(page).nth(i).locator(".pmenubtn").click(); await page.getByRole(name.role, { name: name.name }).click(); };
  await d.invoke(page, "stage_launch_args", { vendor: "claude", cwd: REPO, args: ARGS });
  await paneMenu(0, { role: "button", name: /Restart/ });
  await d.sleep(4000);
  log.setup1b = await handleTrustAndReady(m[0].modelId, "pane1", /haiku/i);
  // Pane 2 -> Claude's focus view through the pane menu (restarts the pane, consuming freshly staged args).
  await d.invoke(page, "stage_launch_args", { vendor: "claude", cwd: REPO, args: ARGS });
  await paneMenu(1, { role: "menuitemcheckbox", name: /Focus mode/ });
  await page.getByRole("button", { name: "Restart pane" }).click();
  await d.sleep(4000);
  const m2 = await ids();
  say(`after focus toggle: ${JSON.stringify(m2)}`);
  log.spawn2 = m2;

  log.setup2b = await handleTrustAndReady(m2[1].modelId, "pane2", /haiku/i);
  say("pane2 banner: " + log.setup2b.text.split(String.fromCharCode(10)).slice(-12).join(" | "));
  log.panes = await page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => ({ cls: p.className, band: p.querySelector(".pband")?.className, w: p.clientWidth, h: p.clientHeight })));
  await d.shotWindow(page, path.join(OUT, "w0-setup.png"));
  save();
  say("setup done");
}

if (stage === "reset") {
  // Fresh Haiku sessions at the final (tall) viewport so no resize reflow muddies the evidence.
  // CDP viewport emulation does not take on WebView2, so shrink the page with the webview zoom the app is allowed to set:
  // more terminal rows fit, so one pane screenshot holds the whole turn.
  await d.invoke(page, "plugin:webview|set_webview_zoom", { value: ZOOM });
  await d.sleep(3000);
  const ARGS = FLAGS.split(" ");
  const m = await ids();
  for (const i of [0, 1]) {
    await d.invoke(page, "stage_launch_args", { vendor: "claude", cwd: REPO, args: ARGS });
    await d.panes(page).nth(i).locator(".pmenubtn").click();
    await page.locator(".pmenu").getByRole("button", { name: /^\s*Restart/ }).click();
    await d.sleep(4000);
    log[`reset${i + 1}`] = await handleTrustAndReady(m[i].modelId, `pane${i + 1}`, /haiku/i);
    say(`pane ${i + 1} fresh on Haiku`);
  }
  git("checkout", "--", "."); git("clean", "-fdq");
  say("scratch repo reset");
  save();
}

if (stage === "terminal" || stage === "quiet") {
  const idx = stage === "terminal" ? 0 : 1;
  const m = await ids();
  const mid = m[idx].modelId;
  if (stage === "quiet") { git("checkout", "--", "."); git("clean", "-fdq"); say("scratch repo reset to the initial commit"); }
  const before = git("status", "--short");
  await d.typeInPane(page, idx, PROMPT, { enter: true, delay: 6 });
  const t0 = Date.now();
  say(`prompt sent to pane ${idx + 1} (model ${mid})`);
  await d.sleep(5000);
  await d.waitQuiet(page, mid, { quietMs: 12000, minMs: 20000, timeoutMs: 300000 });
  log[`${stage}Seconds`] = Math.round((Date.now() - t0) / 1000);
  log[`${stage}Tail`] = await d.tail(page, mid, 65536);
  log[`${stage}RepoBefore`] = before;
  log[`${stage}RepoAfter`] = git("status", "--short");
  log[`${stage}Diff`] = git("diff");
  await d.shotPane(page, idx, path.join(OUT, stage === "terminal" ? "w0-terminal.png" : "w0-quiet.png"), { zoom: ZOOM });
  if (stage === "quiet") {
    await d.pressInPane(page, idx, "Control+o");
    await d.sleep(2500);
    await d.shotPane(page, idx, path.join(OUT, "w0-quiet-ctrlo.png"), { zoom: ZOOM });
    log.quietCtrlOTail = await d.tail(page, mid, 65536);
  }
  save();
  say(`done in ${log[`${stage}Seconds`]}s; repo: ${JSON.stringify(log[`${stage}RepoAfter`])}`);
}

if (stage === "window") {
  await d.shotWindowZ(page, path.join(OUT, "w0-window.png"), ZOOM);
  log.foreground["end-window"] = d.foreground();
  save();
  say("window screenshot written");
}

log.foreground[`end-${stage}`] = d.foreground();
save();
await browser.close();
