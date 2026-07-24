// mock-tauri-interactive.js — the INTERACTIVE fake Tauri backend for the
// kove.nz live demo. Separate file from mock-tauri.js on purpose: that file
// backs the scripted showcase video recording (demo/showcase.mjs) and must
// not change behaviour. This one boots straight into a live cockpit and
// answers typed prompts / suggestion-chip clicks with believable, vendor-
// flavoured streamed output, entirely client-side.
//
// Same bridge contract as mock-tauri.js: Tauri v2's frontend talks to Rust
// through window.__TAURI_INTERNALS__.invoke — providing that is enough for
// @tauri-apps/api to work with no other src/** changes.
//
// How typing works: Terminal.tsx sends every keystroke to `pty_write` verbatim
// (xterm does no local echo) and relies entirely on `pty://output` events to
// show anything, including the user's own typed characters. So this file
// implements a small raw-terminal line editor per pane (echo, backspace,
// Enter-to-submit) and, on Enter, runs an intent-matched scripted response.
// Pane state (running/waiting/permission) is NOT pushed by this file for the
// waiting/permission cases — Terminal.tsx computes those itself from a quiet
// timer plus a regex scan of recent output, so a script just needs to stop
// talking on a line that reads like an approval prompt and the real frontend
// takes it from there.

(() => {
  const listeners = new Map(); // event name -> Set<callback>
  let nextPaneId = 0;
  const panes = new Map(); // ptyId -> pane runtime state

  const emit = (event, payload) => {
    for (const cb of listeners.get(event) ?? []) cb({ event, id: 0, payload });
  };
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  // --- ANSI helpers -----------------------------------------------------
  const RESET = "\x1b[0m", DIM = "\x1b[2m", BOLD = "\x1b[1m";
  const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m";
  function rgb(hex) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
  }

  // Accent colours: claude/agy/pwsh reuse the app's own theme tokens (stays
  // theme-reactive); codex/kimi are new vendors with no existing token, so
  // literal hex — same pattern the app already supports for manifest vendors
  // (see vendors.ts `accentCss`, and the "opencode-local" fallback entry in
  // mock-tauri.js). Chosen to sit tastefully in the Deep Cove ramp (ice/azure/
  // aqua/agent-claude) without colliding with any status colour.
  const ACCENT_TOKEN = { claude: "--agent-claude", agy: "--accent", pwsh: "--aqua" };
  const ACCENT_HEX = { claude: "#8FA2FF", agy: "#43A6F5", pwsh: "#57E5C6", codex: "#FF9D5C", kimi: "#C792EA" };

  // --- Vendor registry ----------------------------------------------------
  // needsTrust is false across the board for the demo: the real trust gate
  // (trust.ts) only fires on the "add a pane" path, not on session hydrate,
  // so a visitor adding a 5th Antigravity pane here would otherwise hit a
  // modal that has nothing to do with the point of this demo. Documented in
  // demo/_demo-blockers.md.
  const VENDORS = [
    { id: "claude", label: "Claude Code", short: "Claude", kind: "agent", accent: ACCENT_TOKEN.claude,
      installed: true, detail: "C:\\Users\\demo\\AppData\\Roaming\\npm\\claude.cmd",
      authState: "ok", authDetail: "", quietSeconds: 3, installHint: "", installUrl: "", needsTrust: false },
    { id: "agy", label: "Antigravity", short: "Antigravity", kind: "agent", accent: ACCENT_TOKEN.agy,
      installed: true, detail: "C:\\Users\\demo\\AppData\\Local\\agy\\bin\\agy.exe",
      authState: "ok", authDetail: "", quietSeconds: 6, installHint: "", installUrl: "", needsTrust: false },
    { id: "codex", label: "Codex CLI", short: "Codex", kind: "agent", accent: ACCENT_HEX.codex,
      installed: true, detail: "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd",
      authState: "ok", authDetail: "", quietSeconds: 2, installHint: "", installUrl: "", needsTrust: false },
    { id: "kimi", label: "Kimi", short: "Kimi", kind: "agent", accent: ACCENT_HEX.kimi,
      installed: true, detail: "C:\\Users\\demo\\AppData\\Local\\kimi\\bin\\kimi.exe",
      authState: "ok", authDetail: "", quietSeconds: 4, installHint: "", installUrl: "", needsTrust: false },
    { id: "pwsh", label: "pwsh (shell)", short: "pwsh", kind: "shell", accent: ACCENT_TOKEN.pwsh,
      installed: true, detail: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      authState: "ok", authDetail: "", quietSeconds: 2, installHint: "", installUrl: "", needsTrust: false },
  ];

  // --- Boot session (session.ts silently hydrates this — see the localStorage
  // flags this file sets at the bottom) ------------------------------------
  const MIGRATE_CWD = "C:\\dev\\acme-web"; // the one pane that auto-runs to a permission prompt

  const SESSION_DOC = {
    version: 1,
    savedAt: Date.now(),
    activeWorkspaceId: 1,
    workspaces: [
      {
        id: 1, name: "acme-api", root: "C:\\dev\\acme-api", setupCmd: "npm ci",
        panes: [
          { id: 1, vendor: "claude", cwd: "C:\\dev\\acme-api" },
          { id: 2, vendor: "agy", cwd: "C:\\dev\\acme-api\\billing" },
          { id: 3, vendor: "codex", cwd: "C:\\dev\\acme-api\\api" },
          { id: 4, vendor: "kimi", cwd: "C:\\dev\\acme-api\\web" },
        ],
      },
      {
        id: 2, name: "acme-web", root: "C:\\dev\\acme-web", setupCmd: "npm ci",
        panes: [
          { id: 5, vendor: "claude", cwd: MIGRATE_CWD },
          { id: 6, vendor: "codex", cwd: "C:\\dev\\acme-web\\src" },
        ],
      },
    ],
    uiPrefs: { board: null }, // filled in below once BOARD_SEED exists
  };

  const nowTs = Date.now();
  const BOARD_SEED = {
    todo: [
      { id: "card-1", title: "Add pagination to the activity feed", description: "Cursor-based, 50 per page.", priority: "MEDIUM", labels: [], checklist: [], createdAt: nowTs - 86_400_000 * 2 },
      { id: "card-2", title: "Write onboarding email copy", description: "", priority: "LOW", labels: [], checklist: [], createdAt: nowTs - 86_400_000 * 3 },
    ],
    inprogress: [
      { id: "card-3", title: "Migrate session store to Redis", description: "Move off in-memory sessions before the next deploy.", priority: "HIGH", agent: "claude",
        labels: [{ id: "lbl-1", name: "backend", colorVar: "--accent" }],
        checklist: [
          { id: "chk-1", text: "Write RedisStore", done: true },
          { id: "chk-2", text: "Update session.ts", done: true },
          { id: "chk-3", text: "docker compose for local redis", done: false },
        ],
        createdAt: nowTs - 3_600_000 * 5, wsId: 2, paneId: 5 }, // linked to the live "acme-web" Claude pane
    ],
    review: [
      { id: "card-4", title: "Rate limit the upload endpoint", description: "100 req/min per token.", priority: "MEDIUM", agent: "claude", labels: [], checklist: [], createdAt: nowTs - 3_600_000 * 20 },
    ],
    complete: [
      { id: "card-5", title: "Fix flaky checkout test", description: "", priority: "HIGH", labels: [],
        checklist: [{ id: "chk-4", text: "repro", done: true }, { id: "chk-5", text: "fix", done: true }], createdAt: nowTs - 86_400_000 },
      { id: "card-6", title: "Bump vitest to v4", description: "", priority: "LOW", labels: [], checklist: [], createdAt: nowTs - 86_400_000 * 4 },
    ],
  };
  SESSION_DOC.uiPrefs.board = BOARD_SEED;

  const DIRS = {
    "C:\\dev": [{ name: "acme-api", dir: true }, { name: "acme-web", dir: true }, { name: "scratch", dir: true }],
    "C:\\dev\\acme-api": [
      { name: "src", dir: true }, { name: "tests", dir: true }, { name: "node_modules", dir: true },
      { name: "package.json", dir: false }, { name: "package-lock.json", dir: false }, { name: "README.md", dir: false },
    ],
    "C:\\dev\\acme-api\\src": [
      { name: "api", dir: true }, { name: "billing", dir: true }, { name: "middleware", dir: true },
      { name: "web", dir: true }, { name: "index.ts", dir: false },
    ],
    "C:\\dev\\acme-web": [
      { name: "src", dir: true }, { name: "public", dir: true }, { name: "package.json", dir: false }, { name: "README.md", dir: false },
    ],
    "C:\\dev\\acme-web\\src": [
      { name: "auth", dir: true }, { name: "components", dir: true }, { name: "session", dir: true },
      { name: "styles", dir: true }, { name: "App.tsx", dir: false },
    ],
  };

  // --- Repo/diff/usage state, keyed by pane cwd ----------------------------
  const repoState = new Map();
  function getRepo(cwd) {
    if (!repoState.has(cwd)) {
      repoState.set(cwd, {
        files: new Map(),
        usage: { contextTokens: 34_000 + Math.floor(Math.random() * 5_000), outputTokens: 5_200 + Math.floor(Math.random() * 1_800), turns: 2 },
      });
    }
    return repoState.get(cwd);
  }
  function applyScenario(cwd, scenario) {
    const repo = getRepo(cwd);
    for (const f of scenario.files) {
      const prev = repo.files.get(f.path) || { added: 0, deleted: 0 };
      repo.files.set(f.path, { added: prev.added + f.added, deleted: prev.deleted + f.deleted, patch: f.patch });
    }
    repo.usage.contextTokens += 1_400 + Math.floor(Math.random() * 1_100);
    repo.usage.outputTokens += 900 + Math.floor(Math.random() * 600);
    repo.usage.turns += 1;
  }
  function syntheticPatch(path, f) {
    const added = f?.added ?? 12, deleted = f?.deleted ?? 0;
    const lines = [`diff --git a/${path} b/${path}`, "index 8a1f2c4..b93d7e1 100644", `--- a/${path}`, `+++ b/${path}`, `@@ -1,${Math.max(1, deleted)} +1,${Math.max(1, added)} @@`];
    for (let i = 0; i < deleted; i++) lines.push(`-// removed line ${i + 1}`);
    for (let i = 0; i < added; i++) lines.push(`+// updated implementation, line ${i + 1}`);
    return lines.join("\n") + "\n";
  }

  const UPLOAD_PATCH = `diff --git a/src/api/upload.ts b/src/api/upload.ts
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

  // --- Scenario library -----------------------------------------------------
  // Keyed content, rendered into each vendor's own voice below. Chosen so the
  // suggestion chips AND the QA script's exact typed phrase both land on rich,
  // hand-written content; anything else falls through to a graceful generic.
  const SCEN = {
    ratelimit: {
      files: [
        { path: "src/middleware/rateLimit.ts", action: "write", added: 48, deleted: 0 },
        { path: "src/api/upload.ts", action: "edit", added: 4, deleted: 1, patch: UPLOAD_PATCH },
        { path: "src/api/upload.test.ts", action: "edit", added: 26, deleted: 2 },
      ],
      test: { path: "src/api/upload.test.ts", count: 7 },
      summary: "Rate limiting is in place at 100 req/min per token, with tests covering the limit and the reset.",
    },
    checkout: {
      files: [
        { path: "src/api/checkout.ts", action: "edit", added: 9, deleted: 3 },
        { path: "src/api/checkout.test.ts", action: "edit", added: 14, deleted: 1 },
      ],
      test: { path: "src/api/checkout.test.ts", count: 9 },
      summary: "Found it — totals were double-counting the loyalty discount when a coupon stacked with a promo. Fixed, both paths covered now.",
    },
    darkmode: {
      files: [
        { path: "src/components/ThemeToggle.tsx", action: "write", added: 54, deleted: 0 },
        { path: "src/styles/tokens.css", action: "edit", added: 21, deleted: 3 },
        { path: "src/App.tsx", action: "edit", added: 6, deleted: 1 },
      ],
      test: { path: "src/components/ThemeToggle.test.tsx", count: 4 },
      summary: "Toggle lives in the header, persists to localStorage, and respects prefers-color-scheme on first load.",
    },
    loginrefactor: {
      files: [
        { path: "src/auth/LoginForm.tsx", action: "edit", added: 18, deleted: 64 },
        { path: "src/auth/useLoginForm.ts", action: "write", added: 58, deleted: 0 },
        { path: "src/auth/validators.ts", action: "write", added: 22, deleted: 0 },
      ],
      test: { path: "src/auth/useLoginForm.test.ts", count: 6 },
      summary: "Pulled the validation and submit logic into a hook — the component is markup only now, and it's testable in isolation.",
    },
  };
  function genericScenario(subject) {
    return {
      files: [{ path: "src/index.ts", action: "edit", added: 11, deleted: 4 }],
      test: { path: "src/index.test.ts", count: 3 },
      summary: subject ? `Done — ${subject}.` : "Done.",
    };
  }
  function classifyScenario(textRaw) {
    const t = textRaw.toLowerCase();
    if (/rate ?limit/.test(t)) return SCEN.ratelimit;
    if (/checkout/.test(t)) return SCEN.checkout;
    if (/dark ?mode|theme toggle/.test(t)) return SCEN.darkmode;
    if (/login/.test(t) && /refactor|form|clean/.test(t)) return SCEN.loginrefactor;
    return genericScenario(textRaw.trim());
  }
  function detectVerb(t) {
    if (/fix|bug|broken|failing/i.test(t)) return "fix";
    if (/migrat/i.test(t)) return "migrate";
    if (/refactor|clean ?up|split|simplify/i.test(t)) return "refactor";
    if (/test/i.test(t)) return "test";
    return "update";
  }

  // --- Per-vendor voice: same scenario content, four different renders ------
  function renderScenario(vendor, scenario) {
    const acc = rgb(ACCENT_HEX[vendor] ?? "#94A6BC");
    const files = scenario.files, test = scenario.test;
    const steps = [];
    if (vendor === "claude") {
      steps.push([260, `${rgb(ACCENT_HEX.claude)}✻${RESET} Thinking…\r\n\r\n`]);
      let t = 900;
      for (const f of files) {
        const tag = f.action === "write" ? "Write" : "Edit";
        const stat = f.action === "edit" ? ` ${DIM}(+${f.added} −${f.deleted})${RESET}` : "";
        steps.push([t, `${GREEN}●${RESET} ${tag} ${BOLD}${f.path}${RESET}${stat}\r\n`]);
        t = 750;
      }
      steps.push([250, "\r\n"]);
      if (test) {
        steps.push([500, `${GREEN}●${RESET} Bash ${DIM}npm test -- ${test.path.split("/").pop().replace(/\.test\.[jt]sx?$/, "")}${RESET}\r\n`]);
        steps.push([1500, `${DIM}  PASS  ${test.path} (${test.count} tests)${RESET}\r\n\r\n`]);
      }
      steps.push([500, `  ${scenario.summary}\r\n\r\n`]);
      steps.push([250, `\x1b[38;5;245m> ${RESET}`]);
    } else if (vendor === "agy") {
      steps.push([300, `${acc}◆${RESET} Scanning workspace…\r\n`]);
      let t = 1000;
      for (const f of files) { steps.push([t, `${GREEN}✓${RESET} ${f.path}\r\n`]); t = 650; }
      steps.push([300, "\r\n"]);
      steps.push([600, `  ${scenario.summary}\r\n\r\n`]);
      if (test) {
        steps.push([500, `${DIM}$ npx vitest run ${test.path.split("/").pop()}${RESET}\r\n`]);
        steps.push([1400, `${GREEN} ✓ ${test.path} (${test.count} tests)${RESET}\r\n\r\n`]);
      }
      steps.push([300, `${DIM}› ${RESET}`]);
    } else if (vendor === "codex") {
      // Terse, test-first: the failing test lands before the fix does.
      if (test) {
        steps.push([250, `${DIM}writing test${RESET} ${BOLD}${test.path}${RESET}\r\n`]);
        steps.push([700, `${DIM}$ npx vitest run ${test.path.split("/").pop()}${RESET}\r\n`]);
        steps.push([1100, `${RED} ✗ ${test.count} failing${RESET}\r\n\r\n`]);
      }
      let t = 500;
      for (const f of files.filter((f) => f.path !== test?.path)) {
        steps.push([t, `${acc}▸${RESET} ${f.action === "write" ? "new" : "patch"} ${f.path} ${DIM}(+${f.added} −${f.deleted})${RESET}\r\n`]);
        t = 500;
      }
      if (test) {
        steps.push([700, `${DIM}$ npx vitest run ${test.path.split("/").pop()}${RESET}\r\n`]);
        steps.push([1100, `${GREEN} ✓ ${test.count} passing${RESET}\r\n\r\n`]);
      }
      steps.push([300, `${scenario.summary}\r\n\r\n`]);
      steps.push([200, `${acc}▸ ${RESET}`]);
    } else { // kimi
      const total = files.length + (test ? 1 : 0);
      let n = 1, t = 350;
      for (const f of files) {
        steps.push([t, `${acc}[${n}/${total}]${RESET} ${f.action === "write" ? "creating" : "updating"} ${BOLD}${f.path}${RESET} ${DIM}(+${f.added} −${f.deleted})${RESET}\r\n`]);
        n++; t = 700;
      }
      if (test) {
        steps.push([t, `${acc}[${n}/${total}]${RESET} running ${test.path.split("/").pop()}…\r\n`]);
        steps.push([1300, `${GREEN}  passed — ${test.count}/${test.count}${RESET}\r\n\r\n`]);
      }
      steps.push([400, `  ${scenario.summary}\r\n`]);
      steps.push([250, `${DIM}~${600 + Math.floor(Math.random() * 400)} tokens${RESET}\r\n\r\n`]);
      steps.push([200, `${acc}☾ ${RESET}`]);
    }
    return steps;
  }

  // --- Boot banners (played once per pane at spawn, then idle at a prompt) --
  const BANNERS = {
    claude: [[300, `${rgb(ACCENT_HEX.claude)}✻${RESET} Welcome to ${BOLD}Claude Code${RESET}\r\n\r\n`], [500, `${DIM}  /help for help · cwd: {cwd}${RESET}\r\n\r\n`], [300, `\x1b[38;5;245m> ${RESET}`]],
    agy: [[300, `${rgb(ACCENT_HEX.agy)}◆${RESET} ${BOLD}Antigravity${RESET} ${DIM}gemini-3-pro${RESET}\r\n\r\n`], [400, `${DIM}› ${RESET}`]],
    codex: [[300, `${rgb(ACCENT_HEX.codex)}▸${RESET} ${BOLD}Codex CLI${RESET} ${DIM}gpt-5.1-codex${RESET}\r\n\r\n`], [350, `${rgb(ACCENT_HEX.codex)}▸ ${RESET}`]],
    kimi: [[300, `${rgb(ACCENT_HEX.kimi)}☾${RESET} ${BOLD}Kimi${RESET} ${DIM}k2-coder${RESET} — hi, what are we building?\r\n\r\n`], [350, `${rgb(ACCENT_HEX.kimi)}☾ ${RESET}`]],
    pwsh: [[300, `${DIM}PowerShell 7.5.0${RESET}\r\n\r\n`], [300, `${CYAN}PS${RESET} {cwd}${CYAN}>${RESET} `]],
  };

  // The one pane that's already mid-task on load, ending in a live approval
  // prompt ~20s in (task requirement) — this is what the attention queue and
  // the workspace-tile severity badge exist to surface.
  const MIGRATE_STEPS = [
    [300, `${rgb(ACCENT_HEX.claude)}✻${RESET} Welcome to ${BOLD}Claude Code${RESET}\r\n\r\n`],
    [1200, `\x1b[38;5;245m> ${RESET}Migrate the session store to Redis\r\n\r\n`],
    [2600, `${GREEN}●${RESET} Read ${BOLD}src/session/store.ts${RESET}\r\n`],
    [3200, `${GREEN}●${RESET} Write ${BOLD}src/session/redisStore.ts${RESET}\r\n\r\n`],
    [4400, `${YELLOW}●${RESET} Bash ${DIM}docker compose up -d redis${RESET}\r\n\r\n`],
    [5200, `  ${BOLD}Do you want to run this command?${RESET}\r\n\r\n`],
    [600, `  ${CYAN}❯ 1. Yes${RESET}\r\n    2. Yes, and don't ask again\r\n    3. No, tell Claude what to do differently\r\n\r\n`],
  ]; // sums to ~17.6s + the frontend's own quiet timer (3s default) lands the permission badge right around 20s.
  const MIGRATE_CONTINUE = [
    [250, `${CYAN}1${RESET}\r\n\r\n`],
    [900, `${DIM}  Starting redis ... done${RESET}\r\n\r\n`],
    [1200, `${GREEN}●${RESET} Bash ${DIM}npm test -- session${RESET}\r\n`],
    [1500, `${DIM}  PASS  src/session/store.test.ts (5 tests)${RESET}\r\n\r\n`],
    [600, `  Session store now backed by Redis; docker compose is running the local instance.\r\n\r\n`],
    [250, `\x1b[38;5;245m> ${RESET}`],
  ];
  const MIGRATE_SCENARIO = {
    files: [
      { path: "src/session/redisStore.ts", action: "write", added: 71, deleted: 0 },
      { path: "src/session/store.ts", action: "edit", added: 8, deleted: 32 },
    ],
  };

  // --- Playback + input handling --------------------------------------------
  function playSteps(id, steps, done) {
    const p = panes.get(id); if (!p) return;
    p.streaming = true;
    let acc = 0;
    for (const [dt, text] of steps) {
      acc += dt;
      const timer = setTimeout(() => {
        const pp = panes.get(id); if (!pp) return;
        emit("pty://output", { pane_id: id, b64: b64(text.replaceAll("{cwd}", pp.cwdShort)) });
      }, acc);
      p.timers.push(timer);
    }
    const endTimer = setTimeout(() => {
      const pp = panes.get(id); if (!pp) return;
      pp.streaming = false;
      done?.();
    }, acc + 60);
    p.timers.push(endTimer);
  }

  function runFlow(id, text) {
    const p = panes.get(id); if (!p || p.streaming) return;
    const scenario = classifyScenario(text);
    void detectVerb(text); // reserved for future per-verb flavour; kept cheap and harmless today
    const steps = renderScenario(p.vendor, scenario);
    const totalMs = steps.reduce((n, [dt]) => n + dt, 0);
    const applyTimer = setTimeout(() => applyScenario(p.cwd, scenario), Math.max(300, Math.floor(totalMs * 0.55)));
    p.timers.push(applyTimer);
    playSteps(id, steps);
  }

  function printPrompt(id) {
    const p = panes.get(id); if (!p) return;
    const prompt = { claude: `\x1b[38;5;245m> ${RESET}`, agy: `${DIM}› ${RESET}`, codex: `${rgb(ACCENT_HEX.codex)}▸ ${RESET}`, kimi: `${rgb(ACCENT_HEX.kimi)}☾ ${RESET}`, pwsh: `${CYAN}PS>${RESET} ` }[p.vendor] ?? "> ";
    emit("pty://output", { pane_id: id, b64: b64(prompt) });
  }

  function onEnter(id, line) {
    const p = panes.get(id); if (!p) return;
    if (p.awaitingApproval) {
      p.awaitingApproval = false;
      playSteps(id, MIGRATE_CONTINUE, () => applyScenario(p.cwd, MIGRATE_SCENARIO));
      return;
    }
    if (p.streaming) return;
    if (!line) { printPrompt(id); return; }
    runFlow(id, line);
  }

  function handleInput(id, data) {
    const p = panes.get(id); if (!p || p.streaming) return;
    if (data.length > 1 && data.charCodeAt(0) === 27) return; // arrow keys / escape sequences — not modelled, ignore quietly
    for (const ch of data) {
      const code = ch.codePointAt(0);
      if (ch === "\r" || ch === "\n") {
        emit("pty://output", { pane_id: id, b64: b64("\r\n") });
        const line = p.inputLine; p.inputLine = "";
        onEnter(id, line.trim());
      } else if (code === 127 || code === 8) {
        if (p.inputLine.length) { p.inputLine = p.inputLine.slice(0, -1); emit("pty://output", { pane_id: id, b64: b64("\b \b") }); }
      } else if (code === 3) {
        /* ctrl-c: not modelled */
      } else if (code >= 32) {
        p.inputLine += ch;
        emit("pty://output", { pane_id: id, b64: b64(ch) });
      }
    }
  }

  function startPane(id, vendor, cwd) {
    const short = cwd.split(/[\\/]/).pop() || cwd;
    const p = { vendor, cwd, cwdShort: short, inputLine: "", streaming: false, awaitingApproval: false, timers: [] };
    panes.set(id, p);
    emit("pty://proc", { pane_id: id, name: vendor === "pwsh" ? "pwsh" : vendor === "agy" ? "agy" : "node" });
    p.timers.push(setTimeout(() => emit("pty://state", { pane_id: id, state: "running" }), 60));
    const isMigratePane = vendor === "claude" && cwd === MIGRATE_CWD;
    const banner = isMigratePane ? MIGRATE_STEPS : (BANNERS[vendor] || BANNERS.pwsh);
    playSteps(id, banner, () => { if (isMigratePane) p.awaitingApproval = true; });
  }

  // --- Command handlers -------------------------------------------------
  const handlers = {
    // PTY
    pty_spawn: ({ vendor, cwd }) => { const id = ++nextPaneId; startPane(id, vendor, cwd); return id; },
    pty_write: ({ paneId, data }) => { handleInput(paneId, String(data ?? "")); return null; },
    pty_resize: () => null,
    pty_kill: ({ paneId }) => { const p = panes.get(paneId); p?.timers.forEach(clearTimeout); panes.delete(paneId); return null; },

    // Vendors
    detect_vendors: () => VENDORS,
    vendors_dir: () => "C:\\Users\\demo\\AppData\\Roaming\\ai.flightdeck.app\\vendors",
    manifest_problems: () => [],

    // Filesystem
    fs_list_dir: ({ path }) => DIRS[path] ?? [],
    reveal_in_explorer: () => null,

    // Git
    git_repo_toplevel: ({ cwd }) => (String(cwd).startsWith("C:\\dev\\acme-web") ? "C:\\dev\\acme-web" : String(cwd).startsWith("C:\\dev\\acme-api") ? "C:\\dev\\acme-api" : null),
    git_status: ({ cwd }) => { const repo = repoState.get(cwd); return { isRepo: /acme/.test(String(cwd)), branch: "main", dirty: !!(repo && repo.files.size > 0) }; },
    detect_setup_command: () => "npm ci",
    git_diff_summary: ({ cwd }) => {
      const repo = repoState.get(cwd);
      if (!repo || repo.files.size === 0) return { base: "a1b2c3d", files: [], totalAdded: 0, totalDeleted: 0 };
      const files = [...repo.files.entries()].map(([path, f]) => ({ path, added: f.added, deleted: f.deleted, binary: false }));
      return { base: "a1b2c3d", files, totalAdded: files.reduce((n, f) => n + f.added, 0), totalDeleted: files.reduce((n, f) => n + f.deleted, 0) };
    },
    git_file_diff: ({ cwd, path }) => {
      const f = repoState.get(cwd)?.files.get(path);
      return f?.patch ?? syntheticPatch(path, f);
    },
    git_branch_context: () => ({
      commits: [
        { hash: "9f2c1ab", subject: "Add token-bucket rate limiter", at: Math.floor(Date.now() / 1000) - 900 },
        { hash: "3d81e07", subject: "Cover the limit and reset in tests", at: Math.floor(Date.now() / 1000) - 300 },
      ],
      baseAhead: 2, baseBranch: "main", branch: "main",
    }),
    git_worktree_add: ({ slug }) => ({ path: `C:\\Users\\demo\\AppData\\Roaming\\ai.flightdeck.app\\worktrees\\demo\\wt-${slug}`, branch: `flightdeck/${slug}`, baseBranch: "main", created: true }),
    git_worktree_remove: () => ({ status: "removed", detail: "" }),
    git_worktree_gc: () => [],
    git_worktree_list: () => [],
    git_merge_back: () => ({ status: "merged", detail: "", conflictFiles: [] }),
    git_update_from_base: () => ({ status: "merged", detail: "", conflictFiles: [] }),
    git_pr_handoff: () => ({ status: "pushed", url: "https://github.com/acme/acme-api/compare/main...flightdeck-demo?expand=1", detail: "" }),
    git_repo_web_url: () => "https://github.com/acme/acme-api",

    // Health / diagnostics
    pane_health: () => [...panes.keys()].map((id, i) => ({
      paneId: id, pid: 5200 + i * 11, cpuPercent: 4 + ((i * 17 + Date.now() / 1100) % 20), memoryMb: 160 + i * 38,
      procName: panes.get(id)?.vendor === "pwsh" ? "pwsh" : "node",
    })),
    recover_orphans: () => [],
    kill_orphans: () => 0,
    export_support_bundle: () => "C:\\Users\\demo\\Desktop\\flightdeck-support.zip",
    pane_usage: ({ cwd }) => (/acme/.test(String(cwd)) ? { ...getRepo(cwd).usage } : null),

    // Session
    is_safe_mode: () => false,
    has_previous_session: () => true,
    load_session: () => JSON.parse(JSON.stringify(SESSION_DOC)),
    save_session: () => null, // demo never persists — Reset always returns to this same boot state
    list_restore_points: () => [],
    restore_from_point: () => JSON.parse(JSON.stringify(SESSION_DOC)),
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
        console.warn("[fd-demo] unhandled command:", cmd, args);
        return Promise.reject(new Error(`mock: no handler for ${cmd}`));
      }
      return new Promise((resolve) => setTimeout(() => resolve(fn(args ?? {})), 40));
    },
  };

  // @tauri-apps/api/event's `listen()` return value (the unlisten function)
  // calls this directly (event.js `_unlisten`) rather than going through
  // invoke — every Terminal teardown was throwing "Cannot read properties of
  // undefined (reading 'unregisterListener')" into the console without it.
  // A no-op is correct here: our listener bookkeeping lives entirely in the
  // module-level `listeners` map above, cleaned up on the plugin:event|unlisten
  // invoke call that already runs alongside this.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

  window.__FD_MOCK__ = true;
  window.__FD_DEMO__ = true;
  console.log("[fd-demo] interactive Tauri bridge installed");
})();
