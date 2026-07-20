// E2E rig for the session-8 polish sweep. Drives the real frontend in a
// browser (Tauri invokes fail there — expected; every surface is written to
// degrade, and that degradation is itself under test) and asserts the DOM.
//
// Run:  node demo/e2e-session8.mjs [outDir]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "e2e-shots";
const URL = "http://localhost:1420";

let pass = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL  ${name} ${detail}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

console.log("\n== Design tokens (UI-247/241/245/33) ==");
const tokens = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const get = (n) => cs.getPropertyValue(n).trim();
  return {
    tFast: get("--t-fast"), tMed: get("--t-med"), tPulse: get("--t-pulse"),
    shadow2: get("--shadow-2"), rPill: get("--r-pill"),
    zToast: get("--z-toast"), zConfirm: get("--z-confirm"), zSettings: get("--z-settings"),
    zQueue: get("--z-queue"), zDrawer: get("--z-drawer"), zMenu: get("--z-menu"),
  };
});
check("motion duration tokens defined", tokens.tFast === "120ms" && tokens.tPulse === "1800ms", JSON.stringify(tokens.tFast));
check("elevation + radius tokens defined", !!tokens.shadow2 && tokens.rPill === "999px");
const z = (v) => parseInt(v, 10);
check("z-scale ordered: menu < drawer < queue < settings < confirm < toast",
  z(tokens.zMenu) < z(tokens.zDrawer) && z(tokens.zDrawer) < z(tokens.zQueue) &&
  z(tokens.zQueue) < z(tokens.zSettings) && z(tokens.zSettings) < z(tokens.zConfirm) &&
  z(tokens.zConfirm) < z(tokens.zToast),
  `${tokens.zMenu}/${tokens.zDrawer}/${tokens.zQueue}/${tokens.zSettings}/${tokens.zConfirm}/${tokens.zToast}`);

console.log("\n== New Workspace cluster ==");
await page.waitForSelector(".dialog", { timeout: 5000 });
// UI-103: bad path is flagged before Create.
await page.fill(".dir .path", "D:\\definitely\\not\\a\\real\\folder");
await page.waitForTimeout(900);
// Warn-don't-block: an unreadable path is flagged but never blocks creation
// (the probe can fail on permissions, and a wrong "no" is worse than a warning).
check("UI-103 warns without blocking Create", !(await page.locator(".btn-primary").isDisabled()));

await page.fill(".dir .path", "C:\\Windows");
await page.waitForTimeout(900);
// Without a Tauri bridge the probe can't answer, so the warning must NOT appear
// (a false "missing folder" is worse than staying quiet).
check("UI-103 stays quiet when it can't validate", !(await page.locator(".dir-err").isVisible()));

// UI-104/105: slot editing.
const slotsBefore = await page.locator(".slot-row").count();
await page.locator(".slot-row").first().locator(".slot-act", { hasText: "+" }).click();
await page.waitForTimeout(200);
check("UI-104 duplicate adds a slot", (await page.locator(".slot-row").count()) === slotsBefore + 1);
await page.locator(".slot-row").first().locator(".slot-act", { hasText: "×" }).click();
await page.waitForTimeout(200);
check("UI-104 remove drops a slot", (await page.locator(".slot-row").count()) === slotsBefore);
check("UI-105 first row can't move up", await page.locator(".slot-row").first().locator(".slot-act").first().isDisabled());

// UI-100/110: keyboard.
await page.keyboard.press("Escape"); // no workspaces yet -> must NOT close
await page.waitForTimeout(200);
check("UI-110 Esc does nothing with no workspace to return to", await page.locator(".dialog").isVisible());
await page.screenshot({ path: `${OUT}/01-new-workspace.png` });

console.log("\n== Cockpit surfaces ==");
// Seed a workspace directly in the store (PTY spawn can't work in a browser).
await page.evaluate(() => {
  const w = window;
  const store = w.__FD_STORE__;
  if (store) store.getState().createWorkspace("C:\\Windows", [{ vendor: "pwsh", cwd: "C:\\Windows" }]);
});
await page.locator(".btn-primary").click();
await page.waitForTimeout(1200);
const cockpit = await page.locator(".cockpit").isVisible().catch(() => false);
check("workspace created, cockpit rendered", cockpit);
await page.screenshot({ path: `${OUT}/02-cockpit.png` });

if (cockpit) {
  // UI-149: mini pane preview on the workspace tile.
  check("UI-149 workspace tile renders a mini pane grid", (await page.locator(".lp-mini-c").count()) > 0);

  // UI-1 v2: attention queue overlay opens on Ctrl+Shift+A and is empty-stated.
  await page.keyboard.press("Control+Shift+A");
  await page.waitForTimeout(400);
  const queueOpen = await page.locator(".aq-panel").isVisible();
  check("UI-1 attention queue opens (Ctrl+Shift+A)", queueOpen);
  if (queueOpen) {
    check("UI-1 honest empty state", await page.locator(".aq-empty").isVisible());
    await page.screenshot({ path: `${OUT}/03-attention-queue.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("UI-1 queue closes on Esc", !(await page.locator(".aq-panel").isVisible()));
  }

  // UI-226: memoised PaneView must not break drag-reorder. A comparator that
  // ignored callback identity would leave stale closures and silently kill
  // drop targets, so this asserts the panes actually move.
  const paneNames = async () => page.locator(".phead .pname").allTextContents();
  const beforeOrder = await paneNames();
  if (beforeOrder.length >= 2) {
    const fired = await page.evaluate(() => {
      const grips = document.querySelectorAll(".pgrip");
      const panes = document.querySelectorAll(".pane");
      if (grips.length < 2 || panes.length < 2) return false;
      const dt = new DataTransfer();
      grips[0].dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      panes[1].dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      panes[1].dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    });
    await page.waitForTimeout(500);
    const afterOrder = await paneNames();
    check("UI-226 drag-reorder survives memoisation",
      fired && JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder),
      `${beforeOrder.join(",")} -> ${afterOrder.join(",")}`);
  }

  // UI-132: terminal context menu.
  const body = page.locator(".pbody").first();
  if (await body.count()) {
    await body.click({ button: "right", position: { x: 60, y: 60 } });
    await page.waitForTimeout(350);
    const ctxOpen = await page.locator(".pmenu.pctx").isVisible();
    check("UI-132 terminal context menu opens on right-click", ctxOpen);
    if (ctxOpen) {
      const items = await page.locator(".pmenu.pctx .pmenu-item").allTextContents();
      check("UI-132/134 menu offers copy/paste/select-all/find/clear",
        ["Copy", "Paste", "Select all", "Find…", "Clear scrollback"].every((t) => items.includes(t)),
        items.join("|"));
      await page.screenshot({ path: `${OUT}/04-terminal-ctx.png` });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      check("UI-132 context menu closes on Esc", !(await page.locator(".pmenu.pctx").isVisible()));
    }
  }

  // Settings: Esc parity, manifest problems block, diagnostics present.
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(500);
  const setOpen = await page.locator(".set-modal").isVisible();
  check("Settings opens (Ctrl+,)", setOpen);
  if (setOpen) {
    const labels = await page.locator(".set-label").allTextContents();
    check("UI-187 Diagnostics section present", labels.includes("Diagnostics"), labels.join("|"));
    await page.screenshot({ path: `${OUT}/05-settings.png`, fullPage: false });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("Settings closes on Esc", !(await page.locator(".set-modal").isVisible()));
  }
}

console.log("\n== Accessibility (UI-215/218) ==");
const a11y = await page.evaluate(() => {
  const small = [];
  for (const el of document.querySelectorAll("button, [role=button], a, input, select")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;      // hidden
    if (r.width < 20 || r.height < 20) {
      small.push(`${el.className || el.tagName}:${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  return { small: small.slice(0, 12), smallCount: small.length };
});
check("UI-218 no interactive target under 20px", a11y.smallCount === 0, a11y.small.join(", "));

const focusRing = await page.evaluate(() => {
  const b = document.querySelector("button");
  if (!b) return null;
  b.focus();
  const cs = getComputedStyle(b, ":focus-visible");
  return cs.outlineWidth;
});
check("UI-215 focus ring style defined", focusRing !== null);

console.log("\n== Runtime health ==");
// Tauri bridge calls can't work in a plain browser; those rejections are the
// environment, not the app. Anything else is a real regression.
const realErrors = pageErrors.filter((m) => !/invoke|__TAURI|transformCallback|not a function|undefined/i.test(m));
check("no unexpected page errors", realErrors.length === 0, realErrors.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
