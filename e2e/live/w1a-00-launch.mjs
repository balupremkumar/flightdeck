// Step 1: focus-proof launch. Samples the foreground window every 250 ms from just before launch for 15 s,
// then fails if any sample belongs to the Canary pid or any of its descendants. Tears down on failure.
// Usage: node w1a-00-launch.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as d from "./drive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "results", process.env.FD_RESULTS_DATE ?? "2026-10-06");
mkdirSync(OUT, { recursive: true });
const fgFile = path.join(OUT, "w1a-00-foreground.jsonl");
const pwsh = (args) => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", ...args], { encoding: "utf8" }).trim();

const watcher = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "fgwatch.ps1"), "-Out", fgFile, "-Seconds", "18"], { stdio: "ignore" });
const watcherDone = new Promise((r) => watcher.on("exit", r));
await d.sleep(1500);
const before = d.foreground();
let launchOut = "";
try { launchOut = execFileSync("node", [path.join(here, "launch.mjs")], { encoding: "utf8" }); } catch (e) { launchOut = String(e.stdout ?? "") + String(e.stderr ?? ""); }
console.log(launchOut.trim());
await watcherDone;
const rows = readFileSync(fgFile, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
const pid = existsSync(path.join(here, ".canary.pid")) ? d.canaryPid() : null;
const tree = pid ? JSON.parse(pwsh(["-Command", `$all=Get-CimInstance Win32_Process; $ids=@(${pid}); $q=@(${pid}); while($q.Count){$c=$q[0];$q=@($q | select -Skip 1); foreach($x in ($all|?{$_.ParentProcessId -eq $c -and $_.ProcessId -ne $c})){$ids+=[int]$x.ProcessId;$q+=[int]$x.ProcessId}}; ConvertTo-Json -Compress @($ids)`])) : [];
const bad = rows.filter((r) => tree.includes(r.pid));
const winInfo = pid ? pwsh(["-File", path.join(here, "window.ps1"), "-ProcessId", String(pid), "-Mode", "info"]) : null;
const result = { step: "launch", pass: !!pid && bad.length === 0, canaryPid: pid, treeSize: tree.length, foregroundBeforeLaunch: before,
  samples: rows.length, distinctForeground: [...new Set(rows.map((r) => `${r.pid}|${r.title}`))], canaryForegroundSamples: bad, windowInfo: winInfo && JSON.parse(winInfo), launchOut };
writeFileSync(path.join(OUT, "w1a-00-launch.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ pass: result.pass, samples: rows.length, distinct: result.distinctForeground, bad: bad.length }, null, 1));
if (!result.pass) { console.error(execFileSync("node", [path.join(here, "teardown.mjs")], { encoding: "utf8" })); process.exit(2); }
// CDP + render proof
const { browser, page } = await d.connect();
await page.waitForSelector(".launcher, .cockpit, .pane, body", { timeout: 30000 });
await d.sleep(2000);
await d.shotWindow(page, path.join(OUT, "w1a-00-render.png"));
result.render = await page.evaluate(() => ({ url: location.href, title: document.title, bodyText: document.body.innerText.slice(0, 200), w: innerWidth, h: innerHeight }));
result.foregroundAfterCdp = d.foreground();
writeFileSync(path.join(OUT, "w1a-00-launch.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.render));
await browser.close();
