// Shared helpers for the W1a live sweep scripts (non-intrusive: CDP input only, NOACTIVATE window moves).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as d from "./drive.mjs";

export { d };
export const here = path.dirname(fileURLToPath(import.meta.url));
export const DATE = process.env.FD_RESULTS_DATE ?? "2026-10-06";
export const OUT = path.join(here, "results", DATE);
export const REPO = process.env.FD_SWEEP_REPO
  ?? "C:\\Users\\User\\AppData\\Local\\Temp\\claude\\D--Dev-ai-projects-active-flightdeck\\983d423c-fdb0-4599-ba8a-c640f0f5458f\\scratchpad\\sweep-repo";
export const SCRATCH = path.dirname(REPO);
export const FLAGS = ["--model", "haiku", "--permission-mode", "acceptEdits"];
export const sleep = d.sleep;
export const ESC = String.fromCharCode(27), CR = String.fromCharCode(13), LF = String.fromCharCode(10);
mkdirSync(OUT, { recursive: true });

export const pwsh = (args, opts = {}) => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", ...args], { encoding: "utf8", maxBuffer: 64 << 20, ...opts }).trim();
export const pwshCmd = (cmd) => pwsh(["-Command", cmd]);

/** Canary process tree: pids, count, working set and private bytes (MB), per process. */
export function tree() {
  const root = d.canaryPid();
  const out = pwshCmd(`$all=Get-CimInstance Win32_Process; $ids=New-Object System.Collections.Generic.List[int]; $ids.Add(${root}); $q=New-Object System.Collections.Generic.Queue[int]; $q.Enqueue(${root}); while($q.Count){$c=$q.Dequeue(); foreach($x in ($all|?{$_.ParentProcessId -eq $c -and $_.ProcessId -ne $c})){$ids.Add([int]$x.ProcessId);$q.Enqueue([int]$x.ProcessId)}}; $set=@{}; foreach($i in $ids){$set[$i]=1}; $rows=@($all|?{$set.ContainsKey([int]$_.ProcessId)}|%{@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=$_.Name;ws=[double]$_.WorkingSetSize;priv=[double]$_.PrivatePageCount;cmd=$_.CommandLine}}); ConvertTo-Json -Compress -Depth 4 -InputObject @($rows)`);
  const rows = JSON.parse(out);
  const mb = (k) => Math.round(rows.reduce((a, r) => a + r[k], 0) / 1048576);
  return { t: Date.now(), count: rows.length, wsMB: mb("ws"), privMB: mb("priv"), rows };
}
export const treeBrief = (t) => ({ count: t.count, wsMB: t.wsMB, privMB: t.privMB, byName: t.rows.reduce((m, r) => (m[r.name] = (m[r.name] ?? 0) + 1, m), {}) });

/** Read-only snapshot of stable (found by exe path, never touched), its tree size, and the ~/.claude guards. */
export function stableSnapshot() {
  const raw = pwshCmd(`$all=Get-CimInstance Win32_Process; $st=@($all|?{$_.Name -eq 'projectsactivefd-scaffold.exe' -and $_.ExecutablePath -like '*AppData\\Local\\Flightdeck\\*'}); $res=@(); foreach($s in $st){ $ids=New-Object System.Collections.Generic.List[int]; $ids.Add([int]$s.ProcessId); $q=New-Object System.Collections.Generic.Queue[int]; $q.Enqueue([int]$s.ProcessId); while($q.Count){$c=$q.Dequeue(); foreach($x in ($all|?{$_.ParentProcessId -eq $c -and $_.ProcessId -ne $c})){$ids.Add([int]$x.ProcessId);$q.Enqueue([int]$x.ProcessId)}}; $res += @{pid=[int]$s.ProcessId; tree=$ids.Count} }; $h=(Get-FileHash "$env:USERPROFILE\\.claude\\settings.json" -Algorithm SHA256).Hash; $bt=[bool](Select-String -Path "$env:USERPROFILE\\.claude.json" -Pattern briefTranscript -SimpleMatch -Quiet); ConvertTo-Json -Compress -InputObject @{stable=@($res); settingsSha=$h; briefTranscript=$bt}`);
  return JSON.parse(raw);
}

// ---- foreground guard: sample GetForegroundWindow every 250 ms for the whole script ----
let fgProc = null, fgFile = null;
const treeUnion = new Set();
export function fgStart(label) {
  fgFile = path.join(OUT, `${label}-foreground.jsonl`);
  fgProc = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "fgwatch.ps1"), "-Out", fgFile, "-Seconds", "7200"], { stdio: "ignore" });
  // Never leave the watcher behind (it would keep appending to the same file in the next run): stop it however this script ends.
  process.on("exit", () => { try { process.kill(fgProc.pid); } catch { /* already gone */ } });
}
export function fgNoteTree() { try { for (const r of tree().rows) treeUnion.add(r.pid); } catch { /* tree gone */ } }
export async function fgStop() {
  fgNoteTree();
  await sleep(600);
  try { process.kill(fgProc.pid); } catch { /* done */ }
  await sleep(300);
  const rows = readFileSync(fgFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const bad = rows.filter((r) => treeUnion.has(r.pid));
  return { samples: rows.length, canaryForegroundSamples: bad.length, bad: bad.slice(0, 5), distinct: [...new Set(rows.map((r) => `${r.pid}|${r.title.replace(/\d+ waiting/, "N waiting")}`))] };
}

/** Result collector: results/<date>/w1a-<name>.json */
export function result(name) {
  const file = path.join(OUT, `w1a-${name}.json`);
  const r = { name, startedAt: new Date().toISOString(), checks: [], evidence: {}, shots: [] };
  r.check = (label, pass, evidence) => { r.checks.push({ label, pass: !!pass, evidence }); console.log(`[${name}] ${pass ? "PASS" : "FAIL"} ${label}${evidence !== undefined ? " :: " + JSON.stringify(evidence).slice(0, 300) : ""}`); return !!pass; };
  r.shot = (p) => { r.shots.push(p); return p; };
  r.save = () => { r.pass = r.checks.length > 0 && r.checks.every((c) => c.pass); r.finishedAt = new Date().toISOString(); writeFileSync(file, JSON.stringify(r, null, 2)); return r; };
  return r;
}
export const shotPath = (n) => path.join(OUT, `w1a-${n}.png`);


/** Fresh Canary: tear down any previous, launch, connect, mute, decline restore, size the window. */
export async function boot({ width = 2400, height = 1200, keepSession = false } = {}) {
  if (existsSync(path.join(here, ".canary.pid"))) { console.log("[boot]", execFileSync("node", [path.join(here, "teardown.mjs")], { encoding: "utf8" }).trim()); }
  console.log("[boot]", execFileSync("node", [path.join(here, "launch.mjs")], { encoding: "utf8" }).trim().split(/\r?\n/).join(" | "));
  const c = await d.connect();
  if (!keepSession) await jsDeclineRestore(c.page);
  await d.applyTestSettings(c.page, { flags: {}, openClaudeIn: "terminal" });
  if (!keepSession) await jsDeclineRestore(c.page);
  d.setWindow({ width, height });
  await c.page.waitForTimeout(1500);
  fgNoteTree();
  return c;
}
export async function teardown() { try { console.log("[teardown]", execFileSync("node", [path.join(here, "teardown.mjs")], { encoding: "utf8" }).trim()); } catch (e) { console.log("[teardown] failed", String(e)); } }

/** Launcher: N panes with the given vendor ids on `root`. Stages Claude launch args first if any slot is claude. */
export async function launchWorkspace(page, { root = REPO, vendors, stageClaude = true }) {
  await page.waitForSelector(".launcher .dir .path", { timeout: 20000 });
  const count = vendors.length;
  const tile = page.locator(".launcher .tiles .tile").filter({ hasText: new RegExp(`^\\s*${count}\\s*$`) });
  if (await tile.count()) await jsClick(tile.first());
  else {
    const plus = page.locator(".launcher .stepper button").last();
    const minus = page.locator(".launcher .stepper button").first();
    for (let i = 0; i < 16; i++) {
      const n = Number(await page.locator(".launcher .step-n").innerText());
      if (n === count) break;
      await jsClick(n < count ? plus : minus);
    }
  }
  await jsFill(page.locator(".launcher .dir .path"), root);
  await page.waitForTimeout(800);
  const iso = page.locator(".launcher .isolate-row input[type=checkbox]");
  if (await iso.count() && await iso.isChecked()) await jsClick(iso);
  const sels = page.locator(".launcher .vsel");
  for (let i = 0; i < count; i++) await sels.nth(i).selectOption(vendors[i]);
  if (stageClaude && vendors.includes("claude")) await d.invoke(page, "stage_launch_args", { vendor: "claude", cwd: root, args: FLAGS });
  await jsClick(page.locator(".launcher .btn-primary"));
  await page.waitForSelector(".pane", { state: "attached", timeout: 30000 });
}

/** Model ids that currently have a live pty in Rust (pane_tail answers). T.invoke is frozen, so spawn calls cannot be recorded. */
export async function liveModels(page, max = 96) {
  const hits = await page.evaluate(async (max) => {
    const out = [];
    await Promise.all(Array.from({ length: max }, (_, i) => i + 1).map(async (id) => {
      try { await window.__TAURI_INTERNALS__.invoke("pane_tail", { modelId: id, maxBytes: 1024 }); out.push(id); } catch { /* none */ }
    }));
    return out;
  }, max);
  return hits.sort((a, b) => a - b);
}
export async function waitModels(page, n, timeoutMs = 30000) {
  const t0 = Date.now();
  let ids = [];
  while (Date.now() - t0 < timeoutMs) { ids = await liveModels(page); if (ids.length >= n) return ids; await sleep(300); }
  throw new Error(`expected ${n} live ptys, saw ${JSON.stringify(ids)}`);
}
export const health = (page) => d.invoke(page, "pane_health", {});
const PTY = new Map();   // modelId -> pty id, valid until that pane restarts
/** Map pwsh pane model ids to pty ids: write a harmless comment line to each pwsh pty and see whose ring shows it. */
let MAP_CALLS = 0;
export const MAP_DIAG = [];
export async function mapPwsh(page, modelIds) {
  const call = ++MAP_CALLS;
  const h = (await health(page)).filter((p) => /pwsh|powershell/i.test(p.procName ?? "") || !p.procName);
  PTY.clear();
  for (const p of h) await d.invoke(page, "pty_write", { paneId: p.paneId, data: `#FDMAP${call}N${p.paneId}X\r` });
  await sleep(1500);
  const diag = { call, ptys: h.map((p) => p.paneId), crossTalk: [], unmapped: [] };
  for (const m of modelIds) {
    const text = (await d.tail(page, m, 65536)).join(" ");
    const hits = h.filter((p) => text.includes(`FDMAP${call}N${p.paneId}X`)).map((p) => p.paneId);
    if (hits.length === 1) PTY.set(m, hits[0]);
    else if (hits.length > 1) diag.crossTalk.push({ model: m, ptysSeenInItsRing: hits });
    else diag.unmapped.push(m);
  }
  const owners = {};
  for (const [m, pid] of PTY) (owners[pid] ??= []).push(m);
  diag.sharedPtys = Object.entries(owners).filter(([, ms]) => ms.length > 1).map(([pid, ms]) => ({ pty: pid, models: ms }));
  MAP_DIAG.push(diag);
  return Object.fromEntries(PTY);
}
export const ptyOf = (modelId) => { const v = PTY.get(modelId); if (!v) throw new Error(`no pty mapped for model ${modelId}; call mapPwsh first`); return v; };
export const write = (page, modelId, data) => d.invoke(page, "pty_write", { paneId: ptyOf(modelId), data });
export const paneStates = (page) => page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => ({ dot: p.querySelector(".pdot")?.className, band: p.querySelector(".pband")?.className, name: p.querySelector(".pname")?.textContent, proc: p.querySelector(".pproc")?.textContent })));

/** Claude: accept the folder trust prompt if it shows, wait for the input prompt. */
export async function claudeReady(page, modelId, { timeoutMs = 90000, must = null } = {}) {
  const READY = /\?\s*for\s*shortcuts|accept\s*edits|Try\s*"|bypass/i;
  const t0 = Date.now(); let trusted = false;
  while (Date.now() - t0 < timeoutMs) {
    const text = (await d.tail(page, modelId)).join("\n");
    if (!trusted && /Yes,\s*I\s*trust\s*this\s*folder/i.test(text) && /No,\s*exit/i.test(text)) {
      await write(page, modelId, ESC + '[B'); await sleep(400); await write(page, modelId, CR); trusted = true; await sleep(2500); continue;
    }
    if (READY.test(text) && (!must || must.test(text))) return text;
    await sleep(1000);
  }
  throw new Error(`claude in model ${modelId} never reached its prompt`);
}

/** Reload like Ctrl+R. A reload shows "Reopen last session?" (Startup = show launcher); `restore` answers it:
 *  "reopen" clicks Reopen session (panes reattach to their live ptys), "cancel" clicks Cancel (launcher, unclaimed ptys reaped), "none" leaves it. */
export async function reloadAndWait(page, { settle = 3000, restore = "reopen" } = {}) {
  const t0 = Date.now();
  await page.reload({ waitUntil: "load" });
  await d.wrapSpawns(page);
  let tReopen = null;
  if (restore !== "none") {
    const reopen = page.getByRole("button", { name: "Reopen session" });
    await reopen.waitFor({ timeout: 30000 });
    if (restore === "reopen") { tReopen = Date.now(); await jsClick(reopen); await page.waitForSelector(".pane", { state: "attached", timeout: 30000 }); }
    else await jsClick(page.getByRole("button", { name: "Cancel" }));
  }
  const ms = Date.now() - t0;
  await sleep(settle);
  return { totalMs: ms, reopenToPaneMs: tReopen ? Date.now() - settle - tReopen : null };
}

export async function paneMenu(page, i, name) {
  await jsClick(page.locator(".pane").nth(i).locator(".pmenubtn"));
  await sleep(150);
  await jsClick(page.locator(".pmenu").getByRole("button", { name }));
}

export let lastStep = "start";
export const step = (label) => { lastStep = label; console.log(`[step] ${label}`); };
/** Run one script body with the foreground guard on, always save the result file and exit. A live watcher aborts the
 *  run (tearing Canary down at once) the first time a Canary window is seen in the foreground. */
export async function main(name, fn) {
  const r = result(name);
  fgStart(`w1a-${name}`);
  let breached = false;
  const live = setInterval(() => {
    if (breached) return;
    try {
      const rows = readFileSync(fgFile, "utf8").trimEnd().split(/\r?\n/).slice(-2).map((l) => JSON.parse(l));
      const hit = rows.find((x) => /^Flightdeck Canary/.test(x.title) || (existsSync(path.join(here, ".canary.pid")) && x.pid === d.canaryPid()));
      if (hit) {
        breached = true;
        try { execFileSync("node", [path.join(here, "teardown.mjs")], { encoding: "utf8" }); } catch { /* best effort */ }
        r.check("FOREGROUND BREACH: Canary took foreground; run aborted and Canary torn down", false, { lastStep, row: hit });
        r.save();
        console.log(`[${name}] ABORTED on foreground breach at step "${lastStep}"`);
        process.exit(3);
      }
    } catch { /* file mid-write */ }
  }, 400);
  let c = null;
  try { c = await fn(r); }
  catch (e) { r.check("script completed without exception", false, String(e?.stack ?? e).slice(0, 800)); }
  clearInterval(live);
  try { const g = await fgStop(); r.evidence.foreground = g; r.check("foreground never held by a Canary process", g.canaryForegroundSamples === 0, { samples: g.samples, distinct: g.distinct }); } catch (e) { r.check("foreground guard readable", false, String(e)); }
  r.save();
  console.log(`[${name}] ${r.pass ? "ALL PASS" : "HAS FAILURES"} -> ${path.join(OUT, `w1a-${name}.json`)}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// FOCUS-SAFE INPUT. A Playwright click on a pane header + focus() + keyboard.type made the Canary window take
// foreground for ~1 s (observed 2026-10-06 in w1a-bug-reopen, foreground jumped RDP -> Canary -> stable). From
// here on nothing uses CDP Input.* against panes: clicks are element.click() in page JS, text goes in through a
// synthetic ClipboardEvent on xterm's own paste handler (xterm -> onData -> pty_write, the real paste path, no
// system clipboard), keys go straight to pty_write.
// ---------------------------------------------------------------------------------------------
export const jsClick = (loc) => loc.evaluate((el) => el.click());
export async function jsFill(loc, value) {
  await loc.evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
/** Same as d.declineRestore but through page JS. */
export async function jsDeclineRestore(page) {
  try { await page.getByRole("button", { name: "Reopen session" }).waitFor({ timeout: 4000 }); await jsClick(page.getByRole("button", { name: "Cancel" })); await sleep(400); return true; } catch { return false; }
}
/** Paste text into pane i through xterm's paste handler (synthetic ClipboardEvent; no OS clipboard, no focus). */
export async function pasteInto(page, i, text) {
  return page.locator(".pane").nth(i).locator("textarea.xterm-helper-textarea").first().evaluate((ta, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}
/** Raw bytes to a pane's pty by model id (pwsh mapped via mapPwsh, others via claudePty). */
export const sendRaw = (page, modelId, data) => write(page, modelId, data);
const CLAUDE_PTY = new Map();
/** Register a pty id for a model (e.g. Claude: the one new pane_health id after launching it). */
export const setPty = (modelId, ptyId) => PTY.set(modelId, ptyId);
export const healthIdsNow = async (page) => (await health(page)).map((p) => p.paneId);

/** After launching claude pane(s) alone: the only pty ids not in `before` belong to them. One claude -> exact. */
export async function mapClaudeSingle(page, modelId, beforeIds) {
  for (let i = 0; i < 40; i++) {
    const now = (await healthIdsNow(page)).filter((x) => !beforeIds.includes(x));
    if (now.length === 1) { PTY.set(modelId, now[0]); return now[0]; }
    await sleep(250);
  }
  throw new Error("could not isolate the new claude pty id");
}

/** Type text into pane i as raw (non-bracketed) input: a synthetic insertText InputEvent on xterm's textarea, which xterm
 *  turns into onData -> pty_write exactly like typing (and the app's draft tracking sees it). No focus, no Input.* CDP. */
export async function typeInto(page, i, text) {
  return page.locator(".pane").nth(i).locator("textarea.xterm-helper-textarea").first().evaluate((ta, t) => {
    ta.dispatchEvent(new InputEvent("input", { data: t, inputType: "insertText", bubbles: true, cancelable: true }));
  }, text);
}

/** Rename pane i through the header rename box, all in page JS (dblclick, set value, Enter keydown). Gives the pane a
 *  non-null title, which the session saver needs (see w1a-bug-reopen: redactOpt(null) throws, Claude panes start with title null). */
export async function renamePaneJs(page, i, name) {
  const pane = page.locator(".pane").nth(i);
  await pane.locator(".pname").evaluate((el) => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
  const input = pane.locator("input.prename");
  await input.waitFor({ state: "attached", timeout: 4000 });
  await jsFill(input, name);
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await sleep(300);
}
/** Make pane i safe for a reload + Reopen: non-null title and a non-null draft, then let the debounced session save run. */
export async function armReopen(page, i, { name = `pane-${i + 1}`, draftChar = "x", settleMs = 3000 } = {}) {
  await renamePaneJs(page, i, name);
  if (draftChar) await typeInto(page, i, draftChar);
  await sleep(settleMs);
}
