// Shared helpers for the W3 multi-window live checks (Canary, Balu away). See w3-drag.mjs for the drag mechanics:
// the real rail pointer handler gets synthetic pointer events, drag_debug_script scripts the OS cursor.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { d, sleep, here, SCRATCH } from "./w1a-lib.mjs";

export const SESSION = path.join(process.env.APPDATA, "ai.flightdeck.canary", "session.json");
export const DESK = [3800, 300];
export const win = (mode, extra = []) => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "window.ps1"), "-ProcessId", String(d.canaryPid()), "-Mode", mode, ...extra], { encoding: "utf8" }).trim();
export const listWins = () => JSON.parse(win("list") || "[]");
export const label = (p) => p.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null);
export const rect = (p) => p.evaluate(() => ({ x: screenX, y: screenY, w: outerWidth, h: outerHeight }));
export const tiles = (p) => p.evaluate(() => [...new Set([...document.querySelectorAll("[data-workspace-id]")].map((e) => Number(e.dataset.workspaceId)))]);
export const savedDoc = () => { try { return JSON.parse(readFileSync(SESSION, "utf8")); } catch { return null; } };

/** Move the Canary session aside (Canary test profile only; moved to scratch, never deleted). */
export function clearCanarySession() {
  if (!existsSync(SESSION)) return null;
  const to = path.join(SCRATCH, `canary-session-${Date.now()}.json`);
  renameSync(SESSION, to);
  return to;
}
/** Shipped drag defaults (absent = on) and a manual rail sort, applied before the harness settings reload. */
export const dragFlags = async (p) => {
  await p.evaluate(() => { localStorage.removeItem("flightdeck-multiwindow"); localStorage.removeItem("flightdeck-window-drag"); localStorage.setItem("flightdeck-ws-sort", "0"); });
  await p.reload({ waitUntil: "load" }); await d.wrapSpawns(p);
};
/** Every app page keyed by window label (devtools and the drag ghost skipped). */
export async function pagesByLabel(ctx) {
  const out = {};
  for (const p of ctx.pages()) {
    if (/devtools|ghost/.test(p.url())) continue;
    try { const l = await label(p); if (l) out[l] = p; } catch { /* closing */ }
  }
  return out;
}
const shim = (p) => p.evaluate(() => {
  // Synthetic pointer ids are not active pointers, so capture calls throw; the harness swallows that, nothing else.
  for (const k of ["setPointerCapture", "releasePointerCapture"]) {
    const o = Element.prototype[k]; if (o.__fd) continue;
    const f = function (id) { try { return o.call(this, id); } catch { /* synthetic pointer */ } }; f.__fd = true; Element.prototype[k] = f;
  }
});
/** Tear workspace `wsId` out of `src` and drop it at screen point `to` (empty desktop -> new window; inside another window -> join). */
export async function dragTo(src, wsId, to, { ticks = 40 } = {}) {
  const r = await rect(src);
  await shim(src);
  await d.invoke(src, "drag_debug_script", { points: [[r.x + Math.round(r.w / 2), r.y + 300], [r.x + r.w + 12, r.y + 300], ...Array.from({ length: ticks }, () => to)], release: true });
  const ok = await src.evaluate((id) => {
    const el = document.querySelector(`[data-workspace-id="${id}"]`);
    if (!el) return false;
    const rc = el.getBoundingClientRect();
    const b = { bubbles: true, cancelable: true, pointerId: 41, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...b, clientX: rc.x + 20, clientY: rc.y + 10 }));
    el.dispatchEvent(new PointerEvent("pointermove", { ...b, button: -1, clientX: rc.x + 40, clientY: rc.y + 10 }));
    el.dispatchEvent(new PointerEvent("pointermove", { ...b, button: -1, clientX: innerWidth + 60, clientY: rc.y + 10 }));
    return true;
  }, wsId);
  await sleep(ticks * 16 + 3000);
  return ok;
}
/** HWND of the app window whose page reports this screen rect (GetWindowRect includes the invisible resize border). */
export const hwndAt = (rc) => listWins().find((w) => w.title !== "Flightdeck drag" && w.w > 1000 && Math.abs(w.x - rc.x) < 24 && Math.abs(w.y - rc.y) < 48)?.hwnd;
/** Close one window like its title-bar X (WM_CLOSE), found by its page's screen rect. */
export async function closeLikeUser(p) {
  const h = hwndAt(await rect(p));
  return h ? JSON.parse(win("closehwnd", ["-Hwnd", String(h)])) : null;
}
/** Launch on the saved session WITHOUT the harness settings reload, which would land while "Reopen last session?" is
 *  open and trip the reload-while-prompt bug (qol/fix-prompt-save). Test settings persist in the Canary profile. */
export async function launchNoReload({ width = 2000, height = 1000 } = {}) {
  execFileSync("node", [path.join(here, "launch.mjs")], { encoding: "utf8" });
  const c = await d.connect();
  d.setWindow({ width, height });
  return c;
}
/** Park a window off-screen beside main, NOACTIVATE. */
export async function park(p, x = -17500) {
  const h = hwndAt(await rect(p));
  if (h) win("movehwnd", ["-Hwnd", String(h), "-X", String(x), "-Y", "0", "-Width", "1600", "-Height", "1000"]);
  await sleep(600);
  return !!h;
}
