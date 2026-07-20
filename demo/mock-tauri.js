// mock-tauri.js — a fake Tauri backend, injected BEFORE the app loads.
//
// Why this exists: the old demo reel was a hand-drawn recreation of the cockpit
// in ~800 lines of motion graphics. It looked right the day it was built and
// then drifted the moment the app changed — worktrees, the review drawer and
// the attention queue all landed after it, and none of them are in it.
//
// This records the REAL frontend instead. Everything on screen is the actual
// component tree, the actual CSS, the actual state machine. Only the backend is
// simulated: PTY output, git responses and vendor detection. A demo built this
// way cannot misrepresent the product, because it IS the product.
//
// Tauri v2's frontend talks to Rust through window.__TAURI_INTERNALS__.invoke.
// Providing that one function is enough for @tauri-apps/api to work.

(() => {
  const listeners = new Map(); // event name -> Set<callback>
  let nextPaneId = 0;
  const panes = new Map(); // id -> { vendor, cwd, script, line, timer }

  const emit = (event, payload) => {
    for (const cb of listeners.get(event) ?? []) {
      // Tauri delivers { event, id, payload }
      cb({ event, id: 0, payload });
    }
  };

  // --- Scripted agent output -------------------------------------------------
  // Written as what these CLIs actually print, so the recording reads as real
  // work rather than lorem ipsum.
  const SCRIPTS = {
    claude: [
      { t: 300, s: "\x1b[38;5;208m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m\r\n\r\n" },
      { t: 900, s: "\x1b[2m  /help for help · cwd: {cwd}\x1b[0m\r\n\r\n" },
      { t: 1600, s: "\x1b[38;5;245m> \x1b[0mAdd rate limiting to the upload endpoint\r\n\r\n" },
      { t: 2600, s: "\x1b[38;5;208m✻\x1b[0m Thinking…\r\n\r\n" },
      { t: 3600, s: "\x1b[32m●\x1b[0m Read \x1b[1msrc/api/upload.ts\x1b[0m \x1b[2m(142 lines)\x1b[0m\r\n" },
      { t: 4300, s: "\x1b[32m●\x1b[0m Read \x1b[1msrc/middleware/index.ts\x1b[0m \x1b[2m(38 lines)\x1b[0m\r\n\r\n" },
      { t: 5200, s: "  I'll add a token-bucket limiter as middleware so it\r\n  composes with the existing auth check.\r\n\r\n" },
      { t: 6400, s: "\x1b[32m●\x1b[0m Write \x1b[1msrc/middleware/rateLimit.ts\x1b[0m\r\n" },
      { t: 7300, s: "\x1b[32m●\x1b[0m Edit \x1b[1msrc/api/upload.ts\x1b[0m \x1b[2m(+4 −1)\x1b[0m\r\n\r\n" },
      { t: 8600, s: "\x1b[32m●\x1b[0m Bash \x1b[2mnpm test -- upload\x1b[0m\r\n" },
      { t: 10200, s: "\x1b[2m  PASS  src/api/upload.test.ts (7 tests)\x1b[0m\r\n\r\n" },
      { t: 11400, s: "  Done. Rate limiting is in place at 100 req/min per\r\n  token, with tests covering the limit and the reset.\r\n\r\n" },
      { t: 12600, s: "\x1b[38;5;245m> \x1b[0m" },
    ],
    // A second Claude pane that stops for permission — this is what the
    // attention queue and the "needs you" badge exist for.
    "claude-approval": [
      { t: 300, s: "\x1b[38;5;208m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m\r\n\r\n" },
      { t: 1200, s: "\x1b[38;5;245m> \x1b[0mMigrate the session store to Redis\r\n\r\n" },
      { t: 2400, s: "\x1b[32m●\x1b[0m Read \x1b[1msrc/session/store.ts\x1b[0m\r\n" },
      { t: 3400, s: "\x1b[32m●\x1b[0m Write \x1b[1msrc/session/redisStore.ts\x1b[0m\r\n\r\n" },
      { t: 4800, s: "\x1b[33m●\x1b[0m Bash \x1b[2mdocker compose up -d redis\x1b[0m\r\n\r\n" },
      { t: 5600, s: "  \x1b[1mDo you want to run this command?\x1b[0m\r\n\r\n" },
      { t: 6100, s: "  \x1b[36m❯ 1. Yes\x1b[0m\r\n    2. Yes, and don't ask again\r\n    3. No, tell Claude what to do differently\r\n\r\n" },
    ],
    agy: [
      { t: 400, s: "\x1b[38;5;39m◆\x1b[0m \x1b[1mAntigravity\x1b[0m \x1b[2mgemini-3-pro\x1b[0m\r\n\r\n" },
      { t: 1400, s: "\x1b[2m› \x1b[0mWrite integration tests for the billing webhook\r\n\r\n" },
      { t: 2800, s: "\x1b[38;5;39m◆\x1b[0m Scanning workspace…\r\n" },
      { t: 4000, s: "\x1b[32m✓\x1b[0m src/billing/webhook.ts\r\n" },
      { t: 4800, s: "\x1b[32m✓\x1b[0m src/billing/events.ts\r\n\r\n" },
      { t: 6000, s: "  Adding tests for the signature check, the replay\r\n  guard and the three event types you handle.\r\n\r\n" },
      { t: 7600, s: "\x1b[32m✓\x1b[0m Created \x1b[1msrc/billing/webhook.test.ts\x1b[0m\r\n\r\n" },
      { t: 9200, s: "\x1b[2m$ npx vitest run billing\x1b[0m\r\n" },
      { t: 10800, s: "\x1b[32m ✓ src/billing/webhook.test.ts (11 tests) 218ms\x1b[0m\r\n\r\n" },
      { t: 12000, s: "  11 tests, all green.\r\n\r\n\x1b[2m› \x1b[0m" },
    ],
    "agy-refactor": [
      { t: 400, s: "\x1b[38;5;39m◆\x1b[0m \x1b[1mAntigravity\x1b[0m \x1b[2mgemini-3-pro\x1b[0m\r\n\r\n" },
      { t: 1500, s: "\x1b[2m› \x1b[0mSplit the report generator into pure functions\r\n\r\n" },
      { t: 3000, s: "\x1b[38;5;39m◆\x1b[0m Reading \x1b[1msrc/reports/generate.ts\x1b[0m \x1b[2m(310 lines)\x1b[0m\r\n\r\n" },
      { t: 4600, s: "  It's one function doing fetch, transform and render.\r\n  Pulling the transform out makes it testable.\r\n\r\n" },
      { t: 6400, s: "\x1b[32m✓\x1b[0m Created \x1b[1msrc/reports/transform.ts\x1b[0m\r\n" },
      { t: 7400, s: "\x1b[32m✓\x1b[0m Updated \x1b[1msrc/reports/generate.ts\x1b[0m \x1b[2m(+12 −86)\x1b[0m\r\n\r\n" },
      { t: 9000, s: "\x1b[2m$ npx tsc --noEmit\x1b[0m\r\n" },
      { t: 11000, s: "\x1b[32m  no errors\x1b[0m\r\n\r\n  Same output, 86 fewer lines in the entry point.\r\n\r\n\x1b[2m› \x1b[0m" },
    ],
    pwsh: [
      { t: 400, s: "\x1b[2mPowerShell 7.5.0\x1b[0m\r\n\r\n" },
      { t: 1200, s: "\x1b[36mPS\x1b[0m {cwd}\x1b[36m>\x1b[0m npm ci\r\n" },
      { t: 2400, s: "\x1b[2mnpm\x1b[0m \x1b[2minfo\x1b[0m resolving dependencies\r\n" },
      { t: 4200, s: "added 412 packages in 6s\r\n\r\n" },
      { t: 5600, s: "\x1b[36mPS\x1b[0m {cwd}\x1b[36m>\x1b[0m " },
    ],
  };

  // Which script a pane gets. The second claude pane is the approval one, so a
  // recording always has something in the attention queue.
  // Assignment must be DETERMINISTIC — the walkthrough narrates "one agent needs
  // you", so exactly one Claude pane has to hit the approval prompt every time.
  // A hash gave both panes the same script on a coin flip; a bare counter
  // drifted under StrictMode's double mount. Keyed by cwd, assigned in order of
  // first sighting, so a remount of the same pane always gets the same scene.
  const assigned = new Map(); // cwd -> script
  const seenPerVendor = new Map(); // vendor -> count of distinct cwds

  function scriptFor(vendor, cwd) {
    if (assigned.has(cwd)) return assigned.get(cwd);
    const n = (seenPerVendor.get(vendor) ?? 0);
    seenPerVendor.set(vendor, n + 1);
    let script;
    if (vendor === "claude") script = n === 1 ? SCRIPTS["claude-approval"] : SCRIPTS.claude;
    else if (vendor === "agy") script = n === 1 ? SCRIPTS["agy-refactor"] : SCRIPTS.agy;
    else script = SCRIPTS[vendor] ?? SCRIPTS.pwsh;
    assigned.set(cwd, script);
    return script;
  }

  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  function startPane(id, vendor, cwd) {
    const script = scriptFor(vendor, cwd);
    const short = cwd.split(/[\\/]/).pop() || cwd;
    const timers = [];
    for (const step of script) {
      timers.push(
        setTimeout(() => {
          emit("pty://output", { pane_id: id, b64: b64(step.s.replaceAll("{cwd}", short)) });
        }, step.t)
      );
    }
    // The real backend flips the pane to "running" on first output; without
    // this the demo would show "Launching…" over live text.
    if (script.length) {
      timers.push(setTimeout(() => emit("pty://state", { pane_id: id, state: "running" }), script[0].t + 30));
    }
    // Root process name, as the real backend emits at spawn.
    emit("pty://proc", { pane_id: id, name: vendor === "agy" ? "agy" : "node" });
    panes.set(id, { vendor, cwd, timers });
  }

  // --- Fake git state --------------------------------------------------------
  // Diffs grow over time so the review drawer has something real to show.
  const DIFF_FILES = [
    { path: "src/middleware/rateLimit.ts", added: 48, deleted: 0, binary: false },
    { path: "src/api/upload.ts", added: 4, deleted: 1, binary: false },
    { path: "src/api/upload.test.ts", added: 26, deleted: 2, binary: false },
  ];

  const PATCH = `diff --git a/src/api/upload.ts b/src/api/upload.ts
index 8a1f2c4..b93d7e1 100644
--- a/src/api/upload.ts
+++ b/src/api/upload.ts
@@ -12,9 +12,12 @@ import { authenticate } from "../middleware/auth";
 import type { Request, Response } from "express";

 // Uploads are the only endpoint that touches object storage directly.
-router.post("/upload", authenticate, async (req, res) => {
+router.post("/upload", authenticate, rateLimit({ perMinute: 100 }), async (req, res) => {
   const file = req.files?.payload;
   if (!file) return res.status(400).json({ error: "no file" });

@@ -28,6 +31,7 @@ router.post("/upload", authenticate, async (req, res) => {
   const key = \`uploads/\${req.user.id}/\${nanoid()}\`;
   await storage.put(key, file.data);

+  metrics.increment("upload.accepted");
   return res.json({ key });
 });
`;

  const VENDORS = [
    { id: "claude", label: "Claude Code", short: "Claude", kind: "agent", accent: "--agent-claude",
      installed: true, detail: "C:\\\\Users\\\\dev\\\\AppData\\\\Roaming\\\\npm\\\\claude.cmd",
      authState: "ok", authDetail: "", quietSeconds: 3, installHint: "", installUrl: "", needsTrust: false },
    { id: "agy", label: "Antigravity", short: "Antigravity", kind: "agent", accent: "--accent",
      installed: true, detail: "C:\\\\Users\\\\dev\\\\AppData\\\\Local\\\\agy\\\\bin\\\\agy.exe",
      authState: "ok", authDetail: "", quietSeconds: 6, installHint: "", installUrl: "", needsTrust: true },
    { id: "pwsh", label: "pwsh (shell)", short: "pwsh", kind: "shell", accent: "--aqua",
      installed: true, detail: "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe",
      authState: "ok", authDetail: "", quietSeconds: 2, installHint: "", installUrl: "", needsTrust: false },
    { id: "opencode-local", label: "OpenCode (Local)", short: "OpenCode", kind: "agent", accent: "#3FD79B",
      installed: false, detail: "`opencode` not on PATH",
      authState: "unknown", authDetail: "", quietSeconds: 3,
      installHint: "npm install -g opencode", installUrl: "https://opencode.ai", needsTrust: false },
  ];

  const DIRS = {
    "C:\\dev": [{ name: "acme-api", dir: true }, { name: "acme-web", dir: true }, { name: "scratch", dir: true }],
    "C:\\dev\\acme-api": [
      { name: "src", dir: true }, { name: "tests", dir: true }, { name: "node_modules", dir: true },
      { name: "package.json", dir: false }, { name: "package-lock.json", dir: false }, { name: "README.md", dir: false },
    ],
    "C:\\dev\\acme-api\\src": [
      { name: "api", dir: true }, { name: "billing", dir: true }, { name: "middleware", dir: true },
      { name: "session", dir: true }, { name: "index.ts", dir: false },
    ],
    "C:\\dev\\acme-api\\src\\middleware": [
      { name: "auth.ts", dir: false }, { name: "index.ts", dir: false }, { name: "rateLimit.ts", dir: false },
    ],
  };

  const handlers = {
    // --- PTY ---
    pty_spawn: ({ vendor, cwd }) => {
      const id = ++nextPaneId;
      startPane(id, vendor, cwd);
      return id;
    },
    pty_write: () => null,
    pty_resize: () => null,
    pty_kill: ({ paneId }) => {
      const p = panes.get(paneId);
      p?.timers.forEach(clearTimeout);
      panes.delete(paneId);
      return null;
    },

    // --- Vendors ---
    detect_vendors: () => VENDORS,
    vendors_dir: () => "C:\\Users\\dev\\AppData\\Roaming\\ai.flightdeck.app\\vendors",
    manifest_problems: () => [],

    // --- Filesystem ---
    fs_list_dir: ({ path }) => DIRS[path] ?? [],

    // --- Git ---
    git_repo_toplevel: ({ cwd }) => (String(cwd).includes("acme") ? "C:\\dev\\acme-api" : null),
    git_status: ({ cwd }) => ({ isRepo: String(cwd).includes("acme"), branch: String(cwd).includes("wt-") ? "flightdeck/rate-limit-uploads" : "main", dirty: true }),
    detect_setup_command: () => "npm ci",
    git_diff_summary: () => ({ base: "a1b2c3d", files: DIFF_FILES, totalAdded: 78, totalDeleted: 3 }),
    git_file_diff: () => PATCH,
    git_branch_context: () => ({
      commits: [
        { hash: "9f2c1ab", subject: "Add token-bucket rate limiter", at: Math.floor(Date.now() / 1000) - 400 },
        { hash: "3d81e07", subject: "Cover the limit and reset in tests", at: Math.floor(Date.now() / 1000) - 120 },
      ],
      baseAhead: 2, baseBranch: "main", branch: "flightdeck/rate-limit-uploads",
    }),
    git_worktree_add: ({ slug }) => ({
      path: `C:\\Users\\dev\\AppData\\Roaming\\ai.flightdeck.app\\worktrees\\a663bad2\\wt-${slug}`,
      branch: `flightdeck/${slug}`, baseBranch: "main", created: true,
    }),
    git_worktree_remove: () => ({ status: "removed", detail: "" }),
    git_worktree_gc: () => [],
    git_worktree_list: () => [
      { path: "C:\\...\\worktrees\\a663bad2\\wt-rate-limit", repo: "C:\\dev\\acme-api", branch: "flightdeck/rate-limit-uploads", baseBranch: "main", bytes: 41_500_000, orphan: false },
      { path: "C:\\...\\worktrees\\a663bad2\\wt-billing-tests", repo: "C:\\dev\\acme-api", branch: "flightdeck/billing-tests", baseBranch: "main", bytes: 39_800_000, orphan: false },
    ],
    git_merge_back: () => ({ status: "merged", detail: "", conflictFiles: [] }),
    git_update_from_base: () => ({ status: "merged", detail: "", conflictFiles: [] }),
    git_pr_handoff: () => ({ status: "pushed", url: "https://github.com/acme/acme-api/compare/main...flightdeck/rate-limit-uploads?expand=1", detail: "" }),
    git_repo_web_url: () => "https://github.com/acme/acme-api",

    // --- Health / diagnostics ---
    pane_health: () => [...panes.keys()].map((id, i) => ({
      paneId: id, pid: 4200 + i * 7, cpuPercent: 6 + ((i * 13 + Date.now() / 900) % 22), memoryMb: 180 + i * 45, procName: "node",
    })),
    recover_orphans: () => [],
    kill_orphans: () => 0,
    export_support_bundle: () => "C:\\Users\\dev\\Desktop\\flightdeck-support.zip",
    pane_usage: ({ cwd }) => (String(cwd).includes("wt-") || String(cwd).includes("acme")
      ? { contextTokens: 41_200 + Math.floor((Date.now() / 1000) % 900), outputTokens: 8_140, turns: 12 }
      : null),

    // --- Session ---
    is_safe_mode: () => false,
    has_previous_session: () => false,
    load_session: () => null,
    save_session: () => null,
    list_restore_points: () => [
      { id: "rp-1", savedAt: Date.now() - 1000 * 60 * 12 },
      { id: "rp-2", savedAt: Date.now() - 1000 * 60 * 63 },
    ],
    restore_from_point: () => ({ version: 1, savedAt: Date.now(), activeWorkspaceId: null, workspaces: [], uiPrefs: null }),
    export_backup: () => null,
    import_backup: () => null,
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = Math.floor(Math.random() * 1e9);
      window[`_${id}`] = cb;
      return id;
    },
    invoke: (cmd, args) => {
      // Tauri's event plugin rides the same invoke channel.
      if (cmd === "plugin:event|listen") {
        const { event, handler } = args;
        const cb = typeof handler === "number" ? window[`_${handler}`] : handler;
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(cb);
        return Promise.resolve(Math.floor(Math.random() * 1e9));
      }
      if (cmd === "plugin:event|unlisten") return Promise.resolve();
      if (String(cmd).startsWith("plugin:")) return Promise.resolve(null);

      const fn = handlers[cmd];
      if (!fn) {
        console.warn("[mock] unhandled command:", cmd, args);
        return Promise.reject(new Error(`mock: no handler for ${cmd}`));
      }
      // A touch of latency so busy states are actually visible on camera.
      return new Promise((resolve) => setTimeout(() => resolve(fn(args ?? {})), 40));
    },
  };

  window.__FD_MOCK__ = true;
  console.log("[mock] Tauri bridge installed");
})();
