import "./w1c-prefix.mjs";
// W1c sweep, live on the Canary, pwsh panes only: port chip and its kill button (WorkspaceChips.tsx), a port opened
// outside the panes never shows a chip, OSC 9;4 progress keeps a pane running through a 4 s silent stall, the Catppuccin
// Mocha theme applies, and twelve panes mount on the WebGL renderer with twelve live ptys.
// Ports 5197/5198 (not 5173) so nothing collides with a dev server Balu may be running.
import { spawn } from "node:child_process";
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, write, health, sleep, shotPath, teardown, stableSnapshot, jsClick, pwshCmd, CR } from "./w1a-lib.mjs";
import { openSettingsJs, closeSettingsJs, addPaneJs } from "./w1b-lib.mjs";

const IN_PANE = 5197, OUTSIDE = 5198;
const chips = (page) => page.evaluate(() => [...document.querySelectorAll(".ws-chips .wsc-main")].map((b) => b.textContent.trim()));
const listenerPid = (port) => { try { return Number(pwshCmd(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`)) || null; } catch { return null; } };
const dots = (page) => page.evaluate(() => [...document.querySelectorAll(".pane .pdot")].map((e) => e.className.replace("pdot", "").trim()));

main("sweep", async (r) => {
  r.evidence.safetyBefore = stableSnapshot();
  let outside = null;
  try {
    const c = await boot({ width: 2400, height: 1300 });
    const { page } = c;
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    step("twelve pwsh panes");
    // The launcher stops at 9 slots: launch 9, then add 3 through the topbar pane menu (Cockpit.tsx:399 .apm-item).
    await launchWorkspace(page, { vendors: Array(9).fill("pwsh") });
    await waitModels(page, 9, 60000);
    for (let i = 0; i < 3; i++) await addPaneJs(page, /PowerShell|pwsh/i);
    const models = await waitModels(page, 12, 60000);
    await sleep(5000);
    const mounts = await page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => ({ xterm: !!p.querySelector(".xterm"), canvas: p.querySelectorAll(".xterm-screen canvas").length, domRows: !!p.querySelector(".xterm-rows")?.children.length })));
    const live = (await health(page)).length;
    r.evidence.twelve = { panes: mounts.length, live, webgl: mounts.filter((m) => m.canvas > 0).length, dom: mounts.filter((m) => m.domRows).length };
    r.shot(await d.shotWindow(page, shotPath("sweep-twelve")));
    // Terminal.tsx:654 loadWebgl: the WebGL renderer draws into canvases under .xterm-screen; the DOM renderer fills .xterm-rows.
    r.check("twelve panes mount an xterm each, all on WebGL, twelve live ptys", mounts.length === 12 && mounts.every((m) => m.xterm) && r.evidence.twelve.webgl === 12 && live === 12, r.evidence.twelve);
    const map = await mapPwsh(page, models);
    const [m0, m1] = models;

    step("port chip for a server started in a pane");
    outside = spawn("node", ["-e", `require('http').createServer((q,s)=>s.end('x')).listen(${OUTSIDE})`], { detached: true, stdio: "ignore" });
    outside.unref();
    await write(page, m0, `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${IN_PANE})"` + CR);
    let seen = [];
    for (let i = 0; i < 30; i++) { await sleep(1000); seen = await chips(page); if (seen.some((t) => t.includes(String(IN_PANE)))) break; }
    r.evidence.chips = seen;
    r.shot(await d.shotWindow(page, shotPath("sweep-port-chip")));
    r.check(`a chip for :${IN_PANE} appears within 30 s`, seen.some((t) => t.includes(String(IN_PANE))), seen);
    r.check(`no chip for :${OUTSIDE}, opened outside any pane`, !seen.some((t) => t.includes(String(OUTSIDE))), seen);

    step("kill button stops the process and the chip goes");
    const pidBefore = listenerPid(IN_PANE);
    await page.locator(`.ws-chips .wsc-x[aria-label*="${IN_PANE}"]`).first().evaluate((el) => el.click());
    await sleep(800);
    await page.locator(".confirm-modal .btn-danger, .confirm-modal .btn-primary").first().evaluate((el) => el.click()).catch(() => {});
    let gone = false, after = [];
    for (let i = 0; i < 20 && !gone; i++) { await sleep(1000); after = await chips(page); gone = !after.some((t) => t.includes(String(IN_PANE))) && !listenerPid(IN_PANE); }
    r.evidence.kill = { pidBefore, pidAfter: listenerPid(IN_PANE), chipsAfter: after };
    r.check("kill: the listener process is gone and so is its chip", !!pidBefore && gone, r.evidence.kill);

    step("OSC 9;4 progress with a 4 s silent stall keeps the pane running");
    const prog = "$e=[char]27; $b=[char]7; foreach($i in 0..4){ [Console]::Write(\"$e]9;4;1;$($i*10)$b\"); Start-Sleep -Milliseconds 700 }; Start-Sleep -Seconds 4; foreach($i in 5..10){ [Console]::Write(\"$e]9;4;1;$($i*10)$b\"); Start-Sleep -Milliseconds 700 }; [Console]::Write(\"$e]9;4;0;0$b\")";
    await write(page, m1, prog + CR);
    const samples = [];
    for (let i = 0; i < 16; i++) { await sleep(500); samples.push((await dots(page))[1]); }
    r.evidence.progress = samples;
    // Pane 1 is the second pane in DOM order; mapPwsh maps model ids in launch order.
    r.check("progress pane never shows waiting during the stall", samples.length > 0 && !samples.some((s) => /waiting|idle/.test(s ?? "")) && samples.some((s) => /running/.test(s ?? "")), samples);

    step("Catppuccin Mocha");
    const keysBefore = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("flightdeck-theme") || k === "flightdeck-accent" || k === "flightdeck-appearance-mode").map((k) => [k, localStorage.getItem(k)])));
    const css = () => page.evaluate(() => ({ accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() }));
    const before = await css();
    await openSettingsJs(page, "Appearance");
    const pick = page.getByText("Catppuccin Mocha", { exact: true }).first();
    const found = await pick.count();
    if (found) await pick.evaluate((el) => (el.closest("button, [role=radio], label") ?? el).click());
    await sleep(800);
    const afterCss = await css();
    r.shot(await d.shotWindow(page, shotPath("sweep-catppuccin")));
    await closeSettingsJs(page);
    r.evidence.theme = { found, before, after: afterCss, keysBefore };
    // A custom accent (flightdeck-accent=custom) deliberately survives a theme change, so only the surfaces must move.
    r.check("Catppuccin Mocha is in the picker and applying it switches the surfaces to its palette (#1E1E2E)", found > 0 && afterCss.bg.toUpperCase() === "#1E1E2E" && afterCss.bg !== before.bg, r.evidence.theme);
    await page.evaluate((keys) => { for (const k of Object.keys(localStorage)) if (k.startsWith("flightdeck-theme") || k === "flightdeck-accent" || k === "flightdeck-appearance-mode") localStorage.removeItem(k); for (const [k, v] of Object.entries(keys)) if (v != null) localStorage.setItem(k, v); }, keysBefore);

    r.check("no pageerror", errors.length === 0, errors.slice(0, 3));
    return c;
  } finally {
    if (outside?.pid) { try { process.kill(outside.pid); } catch { /* gone */ } }
    const stray = listenerPid(OUTSIDE); if (stray) { try { process.kill(stray); } catch { /* gone */ } }
    r.evidence.safetyAfter = stableSnapshot();
    await teardown();
  }
});
