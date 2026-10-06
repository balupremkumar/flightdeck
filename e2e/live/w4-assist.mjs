import "./w3-prefix.mjs";
// W4 assisted: Balu drives the real mouse; this script sets the Canary up, puts it in front of everything on the
// primary monitor, then only WATCHES (no input of any kind) and records what each of his gestures did:
// windows and the workspaces in each, rail order, ghost visibility, pane order, pty ids. Stops when the file
// `.assist-done` appears next to this script (or after 20 minutes) and writes results/<date>/w3-assist.json.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, health, sleep, teardown, stableSnapshot, jsClick, here, REPO, SCRATCH } from "./w1a-lib.mjs";
import { pagesByLabel, tiles, clearCanarySession, dragFlags, rect, listWins } from "./w3-lib.mjs";

const DONE = path.join(here, ".assist-done");
const win = (mode, extra = []) => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "window.ps1"), "-ProcessId", String(d.canaryPid()), "-Mode", mode, ...extra], { encoding: "utf8" }).trim();

main("assist", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  r.evidence.canarySessionMovedTo = clearCanarySession();
  if (existsSync(DONE)) rmSync(DONE);
  try {
    const c = await boot({ width: 2000, height: 1000, beforeSettings: dragFlags });
    const { ctx, page } = c;
    step("setup: sweep-repo (2 pwsh), scratchpad (1 pwsh)");
    await launchWorkspace(page, { root: REPO, vendors: ["pwsh", "pwsh"] });
    await waitModels(page, 2);
    await jsClick(page.locator("button.lp-ic.add, button.lp-add").first());
    await launchWorkspace(page, { root: SCRATCH, vendors: ["pwsh"] });
    await waitModels(page, 3);
    await sleep(2500);
    const ptys0 = (await health(page)).map((p) => p.paneId).sort();
    const mainRect = await rect(page);
    const h = listWins().find((w) => w.title !== "Flightdeck drag" && w.w > 1000 && Math.abs(w.x - mainRect.x) < 24)?.hwnd;
    r.evidence.present = win("present", ["-Hwnd", String(h), "-X", "300", "-Y", "150", "-Width", "1800", "-Height", "1000"]);
    console.log("[assist] READY: Canary is on the primary monitor, in front. Waiting for Balu.");

    const timeline = [];
    let last = "";
    const t0 = Date.now();
    while (!existsSync(DONE) && Date.now() - t0 < 20 * 60 * 1000) {
      try {
        const pg = await pagesByLabel(ctx);
        const windows = {};
        for (const [l, p] of Object.entries(pg)) windows[l] = { tiles: await tiles(p), panes: await p.evaluate(() => [...document.querySelectorAll(".pane")].map((x) => x.getAttribute("data-pane-id") ?? "")).catch(() => []) };
        const ghost = listWins().some((w) => w.title === "Flightdeck drag" && w.visible);
        const ptys = (await health(page)).map((x) => x.paneId).sort();
        const snap = JSON.stringify({ windows, ghost, ptys });
        if (snap !== last) { timeline.push({ t: Math.round((Date.now() - t0) / 1000), windows, ghost, ptys }); last = snap; console.log("[assist]", snap); }
      } catch (e) { timeline.push({ t: Math.round((Date.now() - t0) / 1000), error: String(e).slice(0, 160) }); }
      await sleep(250);
    }
    r.evidence.ptys0 = ptys0;
    r.evidence.timeline = timeline;
    const everNew = timeline.some((s) => s.windows && Object.keys(s.windows).length > 1);
    const ghostSeen = timeline.some((s) => s.ghost);
    const ptysKept = timeline.filter((s) => s.ptys).every((s) => JSON.stringify(s.ptys) === JSON.stringify(ptys0));
    r.check("a real drag opened a second window at some point", everNew, null);
    r.check("the ghost was visible during a real drag", ghostSeen, null);
    r.check("no pane was restarted at any point (pty ids constant)", ptysKept, null);
    return c;
  } finally {
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
}, { abortOnForeground: false });
