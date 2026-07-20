// Visual QA rig for the Tier 0 worktree/review features. Unlike
// visual-check.mjs (which lets Tauri invokes fail and shots the fallbacks),
// this one MOCKS window.__TAURI_INTERNALS__ so the isolation toggle, diff-stat
// badges, and the Review drawer render with realistic data in a plain browser.
// Run from demo/ with the dev server up:  node visual-check-worktrees.mjs [outDir]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "vshots-worktrees";
const URL = "http://localhost:1420";
const shot = async (page, name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
};

const MOCK = `
  const VENDORS = [
    { id: "claude",   label: "Claude Code",  short: "Claude",      kind: "agent", accent: "--agent-claude", installed: true,  detail: "C:\\\\Users\\\\balu\\\\claude.cmd" },
    { id: "agy",      label: "Antigravity",  short: "Antigravity", kind: "agent", accent: "--accent",       installed: true,  detail: "agy.exe" },
    { id: "pwsh",     label: "pwsh (shell)", short: "pwsh",        kind: "shell", accent: "--aqua",         installed: true,  detail: "pwsh.exe" },
    { id: "cmd",      label: "cmd (shell)",  short: "cmd",         kind: "shell", accent: "--muted",        installed: true,  detail: "cmd.exe" },
    { id: "git-bash", label: "Git Bash",     short: "Git Bash",    kind: "shell", accent: "--st-waiting",   installed: false, detail: "not found" },
    { id: "wsl",      label: "WSL",          short: "WSL",         kind: "shell", accent: "--ice",          installed: true,  detail: "wsl.exe" },
  ];
  const PATCH = [
    "diff --git a/src/auth/session.ts b/src/auth/session.ts",
    "index 3f2a1c8..9b7d4e2 100644",
    "--- a/src/auth/session.ts",
    "+++ b/src/auth/session.ts",
    "@@ -12,7 +12,9 @@ export interface Session {",
    "   userId: string;",
    "   createdAt: number;",
    "-  expiresAt: number;",
    "+  expiresAt: number | null; // null = non-expiring service session",
    "+  refreshedAt: number;",
    "+  scopes: string[];",
    " }",
    " ",
    " export function isExpired(s: Session): boolean {",
    "@@ -31,6 +33,12 @@ export function isExpired(s: Session): boolean {",
    "-  return Date.now() > s.expiresAt;",
    "+  if (s.expiresAt === null) return false;",
    "+  return Date.now() > s.expiresAt;",
    "+}",
    "+",
    "+export function needsRefresh(s: Session): boolean {",
    "+  return Date.now() - s.refreshedAt > REFRESH_INTERVAL_MS;",
    " }",
  ].join("\\n");
  let paneSeq = 100;
  const handlers = {
    detect_vendors: () => VENDORS,
    git_repo_toplevel: (a) => a.cwd || "D:\\\\Dev\\\\ai\\\\projects\\\\flightdeck",
    git_worktree_add: (a) => ({
      path: "C:\\\\Users\\\\balu\\\\AppData\\\\Local\\\\Flightdeck\\\\worktrees\\\\a3f9c2\\\\" + a.slug,
      branch: "flightdeck/" + a.slug, baseBranch: "main", created: true,
    }),
    git_worktree_gc: () => [],
    git_status: () => ({ isRepo: true, branch: "flightdeck/p1a2b3c", dirty: true }),
    git_diff_summary: () => ({
      base: "main",
      files: [
        { path: "src/auth/session.ts",      added: 9,  deleted: 2, binary: false },
        { path: "src/auth/refresh.ts",      added: 64, deleted: 0, binary: false },
        { path: "src/routes/login.tsx",     added: 18, deleted: 7, binary: false },
        { path: "tests/session.test.ts",    added: 41, deleted: 3, binary: false },
      ],
      totalAdded: 132, totalDeleted: 12,
    }),
    git_file_diff: () => PATCH,
    git_merge_back: () => ({ status: "merged", detail: "" }),
    pty_spawn: () => ++paneSeq,
    load_session: () => null,
    is_safe_mode: () => false,
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => cb,
    invoke: (cmd, args) => {
      const h = handlers[cmd];
      if (h) return Promise.resolve(h(args ?? {}));
      return Promise.resolve(null); // pty_write/resize/kill, save_session, ...
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
`;

// PW_CHROMIUM lets CI/cloud containers point at a preinstalled Chromium instead
// of downloading a matching build (e.g. PW_CHROMIUM=/opt/pw-browsers/chromium).
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}
);
const page = await browser.newPage({ viewport: { width: 1380, height: 860 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(MOCK);

await page.goto(URL, { waitUntil: "networkidle" });

// 1-2: launcher with the new isolation toggle (repo detected → enabled), dark + light
await page.fill(".dir .path", "D:\\Dev\\ai\\projects\\flightdeck");
await shot(page, "01-launcher-isolation-dark");
await page.evaluate(() => localStorage.setItem("flightdeck-theme-id", "light"));
await page.reload({ waitUntil: "networkidle" });
await page.fill(".dir .path", "D:\\Dev\\ai\\projects\\flightdeck");
await shot(page, "02-launcher-isolation-light");
await page.evaluate(() => localStorage.setItem("flightdeck-theme-id", "dark"));
await page.reload({ waitUntil: "networkidle" });

// 3: create an isolated workspace → cockpit with branch pills + diff-stat badges
await page.fill(".dir .path", "D:\\Dev\\ai\\projects\\flightdeck");
await page.click(".btn-primary");
await page.waitForTimeout(1200); // worktree prep + badge polls
await shot(page, "03-cockpit-diff-badges");

// 4: the Review drawer (file list + patch + hunk nav + merge back)
const badge = page.locator(".pdiff").first();
if (await badge.count()) {
  await badge.click();
  await page.waitForTimeout(600);
  await shot(page, "04-review-drawer");
  // 5: hunk navigation
  const next = page.locator('button[title="Next hunk"]');
  if (await next.count()) { await next.click(); await shot(page, "05-review-hunk-nav"); }
  await page.keyboard.press("Escape");
}

// 6: palette shows the new "Review changes" actions
await page.keyboard.press("Control+k");
await page.fill(".cp-input, input[placeholder*='Search']", "review").catch(() => {});
await shot(page, "06-palette-review");
await page.keyboard.press("Escape");

// 7: pane overflow menu with "Review changes"
const menuBtn = page.locator(".pmenubtn").first();
if (await menuBtn.count()) { await menuBtn.click(); await shot(page, "07-pane-menu-review"); await page.keyboard.press("Escape"); }

// 8: review drawer in light theme
await page.evaluate(() => localStorage.setItem("flightdeck-theme-id", "light"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const badgeL = page.locator(".pdiff").first();
if (await badgeL.count()) { await badgeL.click(); await page.waitForTimeout(600); await shot(page, "08-review-drawer-light"); }

await page.evaluate(() => localStorage.setItem("flightdeck-theme-id", "dark"));
await browser.close();
console.log("done ->", OUT);
