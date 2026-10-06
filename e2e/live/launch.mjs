// Launch the Canary build with the WebView2 remote-debugging port, outside this process tree.
// Usage: node launch.mjs   (env FD_CANARY_EXE overrides the exe path)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9333;
const EXE = process.env.FD_CANARY_EXE
  ?? "D:\\Dev\\ai\\projects\\active\\flightdeck\\src-tauri\\target-canary\\release\\projectsactivefd-scaffold.exe";
const PID_FILE = path.join(here, ".canary.pid");
const ps = (file, args) => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, file), ...args], { encoding: "utf8" }).trim();

if (!existsSync(EXE)) { console.error(`no exe at ${EXE}`); process.exit(1); }
if (existsSync(PID_FILE)) { console.error(`${PID_FILE} exists; run teardown.mjs first`); process.exit(1); }
const out = ps("launch.ps1", ["-Exe", EXE, "-PidFile", PID_FILE, "-Port", String(PORT)]);
const pid = Number(readFileSync(PID_FILE, "utf8"));
console.log(`launched pid ${pid} (${out.split(/\r?\n/).pop()})`);
for (let i = 0; i < 90; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) { console.log("cdp up:", (await r.json()).Browser); process.exit(0); }
  } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error("CDP port never came up; stopping the pid");
console.error(ps("teardown.ps1", ["-PidFile", PID_FILE, "-Exe", EXE]));
process.exit(1);
