// Stop exactly the Canary PID in .canary.pid and its descendant tree. Never kills by name.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.env.FD_CANARY_EXE
  ?? "D:\\Dev\\ai\\projects\\active\\flightdeck\\src-tauri\\target-canary\\release\\projectsactivefd-scaffold.exe";
const PID_FILE = path.join(here, ".canary.pid");
if (!existsSync(PID_FILE)) { console.log("no .canary.pid, nothing to stop"); process.exit(0); }
console.log(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "teardown.ps1"), "-PidFile", PID_FILE, "-Exe", EXE], { encoding: "utf8" }).trim());
