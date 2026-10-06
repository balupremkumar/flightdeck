// Shared helpers for the W1b live sweep (0.6.1 Canary, target-drag exe). Builds on w1a-lib (focus-safe input, foreground guard).
import "./w1b-prefix.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as lib from "./w1a-lib.mjs";
export * from "./w1a-lib.mjs";
const { d, here, sleep, pwshCmd, write, CR } = lib;

const win = (mode, extra = []) => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "window.ps1"), "-ProcessId", String(d.canaryPid()), "-Mode", mode, ...extra], { encoding: "utf8" }).trim();
export const closeWindowNative = () => win("close");
export const minimiseWindow = () => win("minimise");
export const unminimiseWindow = (w = 2000, h = 1100) => win("unminimise", ["-X", "-20000", "-Y", "0", "-Width", String(w), "-Height", String(h)]);

/** Claude child command lines of the Canary tree (CIM), for the --settings check. */
export const claudeCmdlines = () => JSON.parse(pwshCmd(`$root=${d.canaryPid()}; $all=Get-CimInstance Win32_Process; $ids=New-Object System.Collections.Generic.List[int]; $ids.Add($root); $q=New-Object System.Collections.Generic.Queue[int]; $q.Enqueue($root); while($q.Count){$c=$q.Dequeue(); foreach($x in ($all|?{$_.ParentProcessId -eq $c -and $_.ProcessId -ne $c})){$ids.Add([int]$x.ProcessId);$q.Enqueue([int]$x.ProcessId)}}; $set=@{}; foreach($i in $ids){$set[$i]=1}; ConvertTo-Json -Compress -InputObject @($all|?{$set.ContainsKey([int]$_.ProcessId) -and $_.CommandLine -match 'claude'}|%{@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=$_.Name;cmd=$_.CommandLine}})`) || "[]");

/** Send text then Enter to a pty (raw, no focus). */
export async function say(page, modelId, text, { enter = true } = {}) {
  await write(page, modelId, text);
  if (enter) { await sleep(400); await write(page, modelId, CR); }
}
export const textOf = async (page, modelId, bytes = 65536) => (await d.tail(page, modelId, bytes)).join("\n");
export const WORKING = /esc\s*to\s*interrupt/i;
/** Wait until Claude is back at its idle prompt and quiet. */
export async function idle(page, modelId, { timeoutMs = 240000 } = {}) {
  await sleep(1500);
  await d.waitQuiet(page, modelId, { quietMs: 6000, minMs: 6000, timeoutMs });
}
export async function ptyOfPane(page, paneIdx) {
  // pty ids of live panes, order unknown: used when a single claude pane is live
  return (await lib.health(page)).map((p) => p.paneId);
}
export const storage = (page) => page.evaluate(() => ({
  agent: localStorage.getItem("flightdeck-agent-settings"),
  migrated: localStorage.getItem("flightdeck-migrated-quiet-default"),
}));

// ---- settings / pane helpers (all page JS, no CDP input) ----
export async function openSettingsJs(page, section = "Agents") {
  await page.locator('button[title^="Settings"]').first().evaluate((el) => el.click());
  await page.waitForTimeout(500);
  const seg = page.locator('[aria-label="Open Claude panes in"]');
  if (!(await seg.count()) && section) {
    await page.getByText(section, { exact: true }).first().evaluate((el) => el.click());
    await page.waitForTimeout(400);
  }
}
export const settingsSeg = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-label="Open Claude panes in"] button')].map((b) => ({ t: b.textContent.trim(), on: b.getAttribute("aria-pressed") === "true" })));
export async function clickSeg(page, label) {
  await page.locator('[aria-label="Open Claude panes in"] button').filter({ hasText: new RegExp(`^${label}$`) }).first().evaluate((el) => el.click());
  await page.waitForTimeout(300);
}
export const closeSettingsJs = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await page.waitForTimeout(400);
};
/** Add a pane of `vendorLabel` to the active workspace through the topbar menu. */
export async function addPaneJs(page, vendorLabel = "Claude") {
  await page.locator(".addpane-wrap > button").evaluate((el) => el.click());
  await page.waitForTimeout(200);
  await page.locator(".apm-item").filter({ hasText: vendorLabel }).first().evaluate((el) => el.click());
  await page.waitForTimeout(800);
}
/** Open pane i's menu, read the Quiet terminal checkbox, optionally click it, else close the menu again. */
export async function quietItem(page, i, { click = false } = {}) {
  const pane = page.locator(".pane").nth(i);
  await pane.locator(".pmenubtn").evaluate((el) => el.click());
  await page.waitForTimeout(250);
  const item = page.locator(".pmenu").getByRole("menuitemcheckbox", { name: /Quiet terminal/ });
  const checked = (await item.getAttribute("aria-checked")) === "true";
  if (click) await item.evaluate((el) => el.click());
  else await pane.locator(".pmenubtn").evaluate((el) => el.click());
  await page.waitForTimeout(250);
  return checked;
}
export const dialogText = (page) => page.evaluate(() => { const d = document.querySelector('[role="dialog"], [role="alertdialog"], .confirm'); return d ? d.innerText.replace(/\s+/g, " ") : null; });
export const paneInfo = (page, ptyId) => d.invoke(page, "pane_session_info", { ptyId });
export const viewOf = (page, i) => page.locator(".pane").nth(i).evaluate((p) => ({ toggle: [...p.querySelectorAll(".pview-toggle-btn")].map((b) => b.getAttribute("aria-pressed")) }));
