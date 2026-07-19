// Flightdeck demo reel v2 — deterministic master-clock engine.
// Every visual is a pure function of t (seconds since reel start).
// Normal playback drives t from requestAnimationFrame(performance.now()).
// ?at=SECONDS renders one exact paused frame at t=SECONDS (no playback).
//
// Resolves window.REEL_DONE when the reel finishes (used by record.mjs).

window.REEL_DONE = new Promise((resolve) => { window.__reelResolve = resolve; });

const $ = (sel, root) => (root || document).querySelector(sel);
const byId = (id) => document.getElementById(id);

/* ============================================================
   Scene timeline (seconds)
   ============================================================ */
const T = {
  openStart: 0.0, openEnd: 4.4,
  cockpitStart: 4.0, cockpitEnd: 19.0,
  kanbanStart: 18.6, kanbanEnd: 26.6,
  paletteStart: 26.2, paletteEnd: 32.7,
  themeStart: 32.3, themeEnd: 39.8,
  notifyStart: 39.4, notifyEnd: 45.9,
  closeStart: 45.5, closeEnd: 50.7,
};
const TOTAL = T.closeEnd + 0.3;
const FX = 80, FY = 40, FW = 1120, FH = 640;

/* ============================================================
   Easing + numeric helpers
   ============================================================ */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, p) => a + (b - a) * p;
const prog = (t, start, dur) => (dur <= 0 ? (t >= start ? 1 : 0) : clamp01((t - start) / dur));
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
function easeOutBack(p, s) {
  s = s == null ? 1.15 : s;
  const c3 = s + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);
}
function fadeWindow(t, s, e, fade) {
  fade = fade == null ? 0.5 : fade;
  const inP = easeOutCubic(prog(t, s, fade));
  const outP = easeInOutCubic(prog(t, e - fade, fade));
  return clamp01(inP * (1 - outP));
}
function revealStyle(el, p, distance) {
  distance = distance == null ? 14 : distance;
  el.style.opacity = String(clamp01(p));
  el.style.transform = 'translateY(' + (1 - clamp01(p)) * distance + 'px)';
}

/* ============================================================
   Icons
   ============================================================ */
const ICO = {
  panel: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4.5" width="14" height="11" rx="2"/><path d="M8 4.5 V15.5"/></svg>',
  bell: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3a4.5 4.5 0 0 0-4.5 4.5v2.4c0 .9-.35 1.76-.98 2.4L4 13h12l-.52-.7a3.4 3.4 0 0 1-.98-2.4V7.5A4.5 4.5 0 0 0 10 3Z"/><path d="M8.2 15.5a1.8 1.8 0 0 0 3.6 0"/></svg>',
  file: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 3h6l4 4v10H5V3Z"/><path d="M11 3v4h4"/></svg>',
  theme: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 1 0 13Z" fill="currentColor" stroke="none"/></svg>',
  gear: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="2.6"/><path d="M10 3.5v2M10 14.5v2M3.5 10h2M14.5 10h2M5.6 5.6l1.4 1.4M13 13l1.4 1.4M5.6 14.4l1.4-1.4M13 7l1.4-1.4"/></svg>',
  board: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3.5" width="4" height="13" rx="1"/><rect x="8.5" y="3.5" width="4" height="9" rx="1"/><rect x="14" y="3.5" width="3" height="6" rx="1"/></svg>',
  branch: '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="15" r="2"/><circle cx="14" cy="9" r="2"/><path d="M6 7v6M6 9c0-2.2 2-2 6-2"/></svg>',
  ws: '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/></svg>',
  gearSm: '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="2.4"/><path d="M10 4v2.2M10 13.8V16M4 10h2.2M13.8 10H16"/></svg>',
  check: '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10.5l3.5 3.5L16 6"/></svg>',
};

/* ---------- shared app-shell (topbar + left rail) ---------- */
function shellHtml(opts) {
  opts = opts || {};
  const activeWs = opts.activeWs || 'flightdeck';
  const wsLabel = opts.wsLabel || 'flightdeck';
  const bellId = opts.bellId || 'bell';
  const badge = opts.badge ? '<span class="bell-badge show" id="' + bellId + '-badge">' + opts.badge + '</span>' : '<span class="bell-badge" id="' + bellId + '-badge"></span>';
  return (
    '<div class="c-topbar">' +
      '<span class="tb-ico">' + ICO.panel + '</span>' +
      '<svg class="brand-mark" width="18" height="18" viewBox="0 0 128 128" fill="none"><defs><linearGradient id="tg-' + bellId + '" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse"><stop stop-color="#9AE9FF"/><stop offset="0.48" stop-color="#43A6F5"/><stop offset="1" stop-color="#3F6BFF"/></linearGradient></defs><path d="M64 28 L99 96 L64 79 L29 96 Z" fill="url(#tg-' + bellId + ')"/></svg>' +
      '<span class="tb-brand">Flightdeck</span>' +
      '<span class="tb-ws" id="' + bellId + '-wslabel">' + wsLabel + '</span>' +
      '<span class="tb-sp"></span>' +
      '<span class="bell-wrap"><span class="bell" id="' + bellId + '">' + ICO.bell + badge + '</span></span>' +
      '<span class="tb-ico">' + ICO.file + '</span>' +
      '<span class="tb-ico">' + ICO.theme + '</span>' +
      '<span class="tb-ico">' + ICO.gear + '</span>' +
    '</div>' +
    '<div class="c-body">' +
      '<div class="c-rail">' +
        '<div class="rail-head">WORKSPACES</div>' +
        '<div class="rail-ws ' + (activeWs === 'flightdeck' ? 'active' : '') + '" id="' + bellId + '-rail-flightdeck"><span class="rail-i">FD</span><div class="rail-meta"><span class="rail-name">flightdeck</span><span class="rail-stat run"><i></i>2 running</span></div></div>' +
        '<div class="rail-ws ' + (activeWs === 'billing' ? 'active' : '') + '" id="' + bellId + '-rail-billing"><span class="rail-i">BS</span><div class="rail-meta"><span class="rail-name">billing-service</span><span class="rail-stat wait"><i></i>1 waiting</span></div></div>' +
        '<div class="rail-ws ' + (activeWs === 'docs' ? 'active' : '') + '" id="' + bellId + '-rail-docs"><span class="rail-i">DS</span><div class="rail-meta"><span class="rail-name">docs-site</span><span class="rail-stat"><i></i>idle</span></div></div>' +
        '<div class="rail-sep"></div>' +
        '<div class="rail-app ' + (activeWs === 'board' ? 'active' : '') + '"><span class="rail-i board">' + ICO.board + '</span><span class="rail-name">Board</span></div>' +
      '</div>' +
      '<div class="c-main" id="' + bellId + '-main"></div>' +
    '</div>'
  );
}

function paneHtml(id, name, repo, branch) {
  return (
    '<div class="pane" id="' + id + '">' +
      '<div class="pband" id="' + id + '-band"></div>' +
      '<div class="phead">' +
        '<span class="pdot" id="' + id + '-dot"></span>' +
        '<span class="pname">' + name + '</span>' +
        '<span class="prepo">' + repo + '</span>' +
        '<span class="branch">' + ICO.branch + branch + '</span>' +
      '</div>' +
      '<div class="pbody" style="flex:1;min-height:0;"><div class="term" id="' + id + '-term"></div></div>' +
    '</div>'
  );
}

function paneGridHtml(idPrefix) {
  return (
    '<div class="b-grid">' +
      paneHtml(idPrefix + '1', 'claude', 'pagination-fix', 'main') +
      paneHtml(idPrefix + '2', 'agy', 'test-suite', 'feature/tests') +
      paneHtml(idPrefix + '3', 'pwsh', 'flightdeck', 'feature/pane-resize') +
      paneHtml(idPrefix + '4', 'claude', 'auth-middleware', 'feature/auth-mw') +
    '</div>'
  );
}

function setPaneState(idPrefix, cls) {
  const band = byId(idPrefix + '-band');
  const dot = byId(idPrefix + '-dot');
  if (band) band.className = 'pband ' + cls;
  if (dot) dot.className = 'pdot ' + cls;
}

/* ============================================================
   Terminal typing engine — pure function of time
   ============================================================ */
function buildScript(t0, steps, cps) {
  let cursor = t0;
  const out = [];
  for (const step of steps) {
    if (step.type === 'input') {
      const dur = step.text.length / (step.cps || cps || 50);
      out.push({ kind: 'input', text: step.text, t0: cursor, t1: cursor + dur });
      cursor += dur;
    } else {
      cursor += (step.delay == null ? 80 : step.delay) / 1000;
      out.push({ kind: 'stream', text: step.text, cls: step.cls, t: cursor });
    }
  }
  out.end = cursor;
  return out;
}
function renderTerm(el, script, t) {
  let html = '';
  for (const s of script) {
    if (s.kind === 'input') {
      if (t < s.t0) break;
      if (t >= s.t1) {
        html += '<div class="tl tl-cmd">' + s.text + '</div>';
      } else {
        const n = Math.max(1, Math.floor(((t - s.t0) / (s.t1 - s.t0)) * s.text.length));
        html += '<div class="tl tl-cmd">' + s.text.slice(0, n) + '<span class="tcursor"></span></div>';
      }
    } else {
      if (t < s.t) break;
      html += '<div class="tl ' + s.cls + '">' + s.text + '</div>';
    }
  }
  if (el.__lastHtml !== html) { el.innerHTML = html; el.__lastHtml = html; }
}

const SCRIPT_CLAUDE1_STEPS = [
  { type: 'input', text: '$ claude' },
  { type: 'input', text: '> fix the off-by-one in pagination.ts' },
  { cls: 'tl-faint', text: 'Reading src/pagination.ts…', delay: 260 },
  { cls: 'tl-out', text: 'Found it — slice(start, end) used page*size instead of (page-1)*size.', delay: 90 },
  { cls: 'tl-rm', text: '-  const start = page * size;', delay: 90 },
  { cls: 'tl-add', text: '+  const start = (page - 1) * size;', delay: 90 },
  { cls: 'tl-faint', text: 'Running pagination.test.ts…', delay: 100 },
  { cls: 'tl-ok', text: '✓ 12 tests passed in 340ms', delay: 100 },
  { cls: 'tl-ok', text: 'Committed as 4a1f0c2', delay: 90 },
];
const SCRIPT_AGY_STEPS = [
  { type: 'input', text: '$ agy' },
  { type: 'input', text: '> run the full suite before merge' },
  { cls: 'tl-faint', text: 'pytest -q', delay: 240 },
  { cls: 'tl-out', text: '....................................', delay: 100 },
  { cls: 'tl-out', text: '36 passed in 4.87s', delay: 100 },
  { cls: 'tl-ok', text: 'Coverage 91.2% — no regressions', delay: 90 },
];
const SCRIPT_PWSH_STEPS = [
  { type: 'input', text: 'PS D:\\project> git add -A' },
  { type: 'input', text: 'PS D:\\project> git commit -m "fix: pane resize race on spawn"' },
  { cls: 'tl-out', text: '[feature/pane-resize 7c3e9a1] fix: pane resize race on spawn', delay: 220 },
  { cls: 'tl-faint', text: '1 file changed, 6 insertions(+), 2 deletions(-)', delay: 100 },
];
const SCRIPT_CLAUDE2_STEPS = [
  { type: 'input', text: '$ claude' },
  { type: 'input', text: '> refactor the auth middleware' },
  { cls: 'tl-faint', text: 'Drafting the change…', delay: 260 },
  { cls: 'tl-out', text: 'One thing to confirm before I continue —', delay: 110 },
  { cls: 'tl-out', text: 'expired tokens: redirect to /login, or return 401?', delay: 100 },
  { cls: 'tl-faint', text: 'Waiting on your reply…', delay: 8317 },
];

const TERM_STATIC = {
  1: '<div class="tl tl-cmd">$ claude</div><div class="tl tl-ok">✓ Committed as 4a1f0c2</div>',
  2: '<div class="tl tl-cmd">$ agy</div><div class="tl tl-ok">36 passed in 4.87s</div>',
  3: '<div class="tl tl-cmd">PS&gt; git commit</div><div class="tl tl-faint">1 file changed</div>',
  4: '<div class="tl tl-cmd">$ claude</div><div class="tl tl-faint">Waiting on your reply…</div>',
};

/* ============================================================
   Build DOM once (never inserted/removed after this)
   ============================================================ */
let SCRIPTS = null; // filled in build()
const PANE_FLIPS = []; // {t, id, cls}

function build() {
  // ---- cockpit ----
  byId('scene-cockpit').innerHTML = shellHtml({ activeWs: 'flightdeck', wsLabel: 'flightdeck', bellId: 'bell-b' });
  byId('bell-b-main').outerHTML = '<div class="c-main" id="bell-b-main">' + paneGridHtml('b-p') + '</div>';

  SCRIPTS = {
    p1: buildScript(4.9, SCRIPT_CLAUDE1_STEPS, 48),
    p2: buildScript(5.4, SCRIPT_AGY_STEPS, 48),
    p3: buildScript(5.9, SCRIPT_PWSH_STEPS, 48),
    p4: buildScript(6.4, SCRIPT_CLAUDE2_STEPS, 48),
  };
  PANE_FLIPS.push(
    { t: 4.9, id: 'b-p1', cls: 'starting' }, { t: 5.05, id: 'b-p1', cls: 'running' },
    { t: 5.4, id: 'b-p2', cls: 'starting' }, { t: 5.55, id: 'b-p2', cls: 'running' },
    { t: 5.9, id: 'b-p3', cls: 'starting' }, { t: 6.05, id: 'b-p3', cls: 'running' },
    { t: 6.4, id: 'b-p4', cls: 'starting' }, { t: 6.55, id: 'b-p4', cls: 'running' },
    { t: 16.0, id: 'b-p4', cls: 'waiting' }
  );

  // ---- kanban ----
  byId('scene-kanban').innerHTML = shellHtml({ activeWs: 'board', wsLabel: 'flightdeck', bellId: 'bell-c' });
  byId('bell-c-main').outerHTML =
    '<div class="c-main" id="bell-c-main"><div class="k-wrap">' +
      '<div class="k-head"><div class="k-title">Board</div><div class="k-sub">drag a card to In Progress and an agent picks it up</div></div>' +
      '<div class="k-cols" id="k-cols">' +
        kColHtml('todo', 'var(--st-idle)', 'To Do', 'k-todo-count',
          kCardHtml('card-ratelimit', 'Add rate limiting to the auth endpoint', '<span class="k-chip k-chip-prio">Medium</span>') +
          kCardHtml('card-readme', 'Update README screenshots for the new theme picker', '<span class="k-chip k-chip-prio hi">High</span>'), false) +
        kColHtml('inprogress', 'var(--accent)', 'In Progress', 'k-inprog-count',
          '<div class="k-card" id="card-landed" style="display:none;"><div class="k-card-title">Add rate limiting to the auth endpoint</div><div class="k-chips"><span class="k-chip k-chip-agent" id="k-newchip"><span class="k-chip-dot run"></span>claude</span></div></div>' +
          '<div class="k-dropslot" id="k-dropslot-inprogress">Drop here</div>' +
          kCardHtml('card-sqlite', 'Migrate settings store to SQLite', '<span class="k-chip k-chip-agent"><span class="k-chip-dot run"></span>claude</span>'), true) +
        kColHtml('review', 'var(--ice)', 'In Review', null,
          kCardHtml('card-resize', 'Fix pane resize race on spawn', '<span class="k-chip k-chip-agent"><span class="k-chip-dot"></span>pwsh</span>'), false) +
        kColHtml('complete', 'var(--aqua)', 'Complete', null,
          kCardHtml('card-tests', 'Wire test suite into CI', '<span class="k-check">' + ICO.check + ' Done</span>'), false) +
      '</div>' +
    '</div></div>';
  byId('scene-kanban').insertAdjacentHTML('beforeend', '<div class="k-ghost" id="k-ghost"><div class="k-card"><div class="k-card-title">Add rate limiting to the auth endpoint</div><div class="k-chips"><span class="k-chip k-chip-prio">Medium</span></div></div></div>');

  // ---- palette ----
  byId('scene-palette').innerHTML = shellHtml({ activeWs: 'flightdeck', wsLabel: 'flightdeck', bellId: 'bell-d' });
  byId('bell-d-main').outerHTML = '<div class="c-main dim" id="bell-d-main">' + paneGridHtml('d-p') + '</div>';
  [1, 2, 3, 4].forEach((n) => { byId('d-p' + n + '-term').innerHTML = TERM_STATIC[n]; setPaneState('d-p' + n, n === 4 ? 'waiting' : 'running'); });
  byId('scene-palette').insertAdjacentHTML('beforeend',
    '<div class="cmdp-scrim" id="cmdp-scrim"><div class="cmdp-modal" id="cmdp-modal">' +
      '<div class="cmdp-inputrow">' + ICO.ws + '<span class="cmdp-input" id="cmdp-input"></span><span class="cmdp-caret"></span></div>' +
      '<div class="cmdp-list">' +
        '<div class="cmdp-list-inner" id="cmdp-list-full">' +
          '<div class="cmdp-section">Workspaces</div>' +
          '<div class="cmdp-item">' + ICO.ws + '<span>flightdeck</span></div>' +
          '<div class="cmdp-item">' + ICO.ws + '<span>billing-service</span></div>' +
          '<div class="cmdp-item">' + ICO.ws + '<span>docs-site</span></div>' +
          '<div class="cmdp-section">Actions</div>' +
          '<div class="cmdp-item">' + ICO.gearSm + '<span>Open settings</span><span class="cmdp-hint">Ctrl+,</span></div>' +
        '</div>' +
        '<div class="cmdp-list-inner" id="cmdp-list-filtered">' +
          '<div class="cmdp-section">Workspaces</div>' +
          '<div class="cmdp-item active" id="cmdp-filtered-item">' + ICO.ws + '<span>billing-service</span><span class="cmdp-hint">D:\\dev\\billing-service</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="cmdp-foot"><span><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate</span><span><kbd>Enter</kbd> select</span><span><kbd>Esc</kbd> close</span></div>' +
    '</div></div>');

  // ---- theme montage ----
  byId('scene-theme').innerHTML = shellHtml({ activeWs: 'flightdeck', wsLabel: 'flightdeck', bellId: 'bell-e' });
  byId('bell-e-main').outerHTML = '<div class="c-main" id="bell-e-main">' + paneGridHtml('e-p') + '</div>';
  [1, 2, 3, 4].forEach((n) => { byId('e-p' + n + '-term').innerHTML = TERM_STATIC[n]; setPaneState('e-p' + n, n === 4 ? 'waiting' : 'running'); });

  // ---- notify ----
  byId('scene-notify').innerHTML = shellHtml({ activeWs: 'flightdeck', wsLabel: 'flightdeck', bellId: 'bell-f', badge: '3' });
  byId('bell-f-main').outerHTML = '<div class="c-main dim" id="bell-f-main">' + paneGridHtml('f-p') + '</div>';
  [1, 2, 3, 4].forEach((n) => { byId('f-p' + n + '-term').innerHTML = TERM_STATIC[n]; setPaneState('f-p' + n, n === 4 ? 'waiting' : 'running'); });
  byId('bell-f').classList.add('on');
  byId('scene-notify').insertAdjacentHTML('beforeend',
    '<div class="bell-menu" id="bell-menu">' +
      '<div class="bell-h">Waiting on you</div>' +
      '<div class="bell-item" id="bi-1"><span class="bi-dot"></span><span class="bi-ws">flightdeck — auth-middleware</span><span class="bi-ag">claude</span></div>' +
      '<div class="bell-item" id="bi-2"><span class="bi-dot"></span><span class="bi-ws">billing-service — rate-limit</span><span class="bi-ag">claude</span></div>' +
      '<div class="bell-item" id="bi-3"><span class="bi-dot"></span><span class="bi-ws">docs-site — build check</span><span class="bi-ag">pwsh</span></div>' +
    '</div>');
}

function kColHtml(id, accentVar, name, countId, cardsHtml, withDropSlot) {
  return (
    '<div class="k-col" id="k-col-' + id + '">' +
      '<div class="k-accent" style="background:' + accentVar + '"></div>' +
      '<div class="k-colhead"><span class="k-coldot" style="background:' + accentVar + '"></span><span class="k-colname">' + name + '</span>' +
        (countId ? '<span class="k-colcount" id="' + countId + '"></span>' : '') + '</div>' +
      '<div class="k-list" id="k-list-' + id + '">' + cardsHtml + '</div>' +
    '</div>'
  );
}
function kCardHtml(id, title, chipsHtml) {
  return '<div class="k-card" id="' + id + '"><div class="k-card-title">' + title + '</div><div class="k-chips">' + chipsHtml + '</div></div>';
}

/* ============================================================
   Measurement pass — capture element rects (stage-space, scale 1)
   ============================================================ */
const RECTS = {};
function rectRel(el) {
  const r = el.getBoundingClientRect();
  const s = byId('stage').getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height, cx: r.left - s.left + r.width / 2, cy: r.top - s.top + r.height / 2 };
}
function measure() {
  RECTS.pane1 = rectRel(byId('b-p1'));
  RECTS.pane4 = rectRel(byId('b-p4'));
  RECTS.kanbanInprogress = rectRel(byId('k-col-inprogress'));
  RECTS.cardRatelimit = rectRel(byId('card-ratelimit'));
  const dropEl = byId('k-dropslot-inprogress');
  dropEl.style.display = 'flex';
  RECTS.dropslot = rectRel(dropEl);
  dropEl.style.display = 'none';
  RECTS.paletteModal = rectRel(byId('cmdp-modal'));
  const fullListEl = byId('cmdp-list-full'), filteredListEl = byId('cmdp-list-filtered');
  filteredListEl.style.display = '';
  fullListEl.style.display = 'none';
  RECTS.filteredItem = rectRel(byId('cmdp-filtered-item'));
  fullListEl.style.display = '';
  filteredListEl.style.display = 'none';
  RECTS.bellIcon = rectRel(byId('bell-f'));
  RECTS.bellMenu = rectRel(byId('bell-menu'));
  RECTS.biFlash = rectRel(byId('bi-1'));
  RECTS.appframe = { cx: FX + FW / 2, cy: FY + FH / 2 };
}

/* ============================================================
   Camera keyframes — continuous across the whole reel
   ============================================================ */
const CAM = [
  { t: T.cockpitStart, target: 'appframe', S: 1.00 },
  { t: 6.6, target: 'appframe', S: 1.02 },
  { t: 7.3, target: 'pane1', S: 1.55, ease: 'back' },
  { t: 9.6, target: 'pane1', S: 1.55 },
  { t: 10.3, target: 'appframe', S: 1.03, ease: 'out' },
  { t: 15.6, target: 'appframe', S: 1.06 },
  { t: 16.3, target: 'pane4', S: 1.55, ease: 'back' },
  { t: 18.3, target: 'pane4', S: 1.55 },
  { t: 19.0, target: 'appframe', S: 1.0, ease: 'out' },

  { t: 20.6, target: 'appframe', S: 1.0 },
  { t: 21.4, target: 'kanbanInprogress', S: 1.45, ease: 'back' },
  { t: 24.0, target: 'kanbanInprogress', S: 1.45 },
  { t: 24.8, target: 'appframe', S: 1.05, ease: 'out' },
  { t: 26.6, target: 'appframe', S: 1.06 },

  { t: 27.2, target: 'appframe', S: 1.02 },
  { t: 28.1, target: 'paletteModal', S: 1.4, ease: 'back' },
  { t: 30.8, target: 'paletteModal', S: 1.4 },
  { t: 31.6, target: 'appframe', S: 1.0, ease: 'out' },
  { t: 32.7, target: 'appframe', S: 1.0 },

  { t: 39.8, target: 'appframe', S: 1.06 },

  { t: 40.6, target: 'appframe', S: 1.0 },
  { t: 41.3, target: 'bellMenu', S: 1.4, ease: 'back' },
  { t: 43.6, target: 'bellMenu', S: 1.4 },
  { t: 44.4, target: 'appframe', S: 1.02, ease: 'out' },
  { t: 45.9, target: 'appframe', S: 1.02 },
];

// Targets close to a corner of the app window pull in the topbar/rail at
// high zoom; bias the crop center toward the frame's own center to keep
// the shot inside the target's own chrome-free area, and clamp the
// resulting viewport to the appframe bounds so we never reveal backdrop.
const TARGET_BIAS = { pane1: 0.3, pane4: 0.12, kanbanInprogress: 0.06, paletteModal: 0, bellMenu: 0.32 };
function resolveCenter(key, S) {
  let cx, cy;
  if (key === 'appframe') { cx = RECTS.appframe.cx; cy = RECTS.appframe.cy; }
  else {
    const r = RECTS[key];
    const bias = TARGET_BIAS[key] || 0;
    cx = lerp(r.cx, RECTS.appframe.cx, bias);
    cy = lerp(r.cy, RECTS.appframe.cy, bias);
  }
  const hw = 640 / S, hh = 360 / S;
  const minX = FX + hw, maxX = FX + FW - hw;
  const minY = FY + hh, maxY = FY + FH - hh;
  if (minX <= maxX) cx = Math.min(Math.max(cx, minX), maxX);
  if (minY <= maxY) cy = Math.min(Math.max(cy, minY), maxY);
  return { cx, cy };
}

let zoomTargetKey = null, zoomOpacity = 0;

const cameraEl = byId('camera');
const spotRingEl = byId('spot-ring');
function renderCamera(t) {
  let i = 0;
  while (i < CAM.length - 1 && CAM[i + 1].t <= t) i++;
  const a = CAM[Math.min(i, CAM.length - 1)];
  const b = CAM[Math.min(i + 1, CAM.length - 1)];
  let S, cx, cy, activeKey = null, activeP = 0;
  if (a === b || b.t <= a.t) {
    S = a.S; const c = resolveCenter(a.target, S); cx = c.cx; cy = c.cy;
    if (a.target !== 'appframe') { activeKey = a.target; activeP = 1; }
  } else {
    const p = clamp01((t - a.t) / (b.t - a.t));
    const ease = b.ease === 'back' ? easeOutBack(p, 0.9) : b.ease === 'out' ? easeOutCubic(p) : p;
    S = lerp(a.S, b.S, ease);
    const ca = resolveCenter(a.target, a.S), cb = resolveCenter(b.target, b.S);
    cx = lerp(ca.cx, cb.cx, ease);
    cy = lerp(ca.cy, cb.cy, ease);
    if (a.target === 'appframe' && b.target !== 'appframe') { activeKey = b.target; activeP = clamp01(p); }
    else if (a.target !== 'appframe' && b.target === 'appframe') { activeKey = a.target; activeP = clamp01(1 - p); }
    else if (a.target !== 'appframe' && a.target === b.target) { activeKey = a.target; activeP = 1; }
  }
  const C = { x: 640, y: 360 };
  const Tx = C.x / S - cx;
  const Ty = C.y / S - cy;
  cameraEl.style.transform = 'scale(' + S + ') translate(' + Tx + 'px,' + Ty + 'px)';

  const appframeEl = byId('appframe');
  appframeEl.style.filter = S > 1.2 ? 'saturate(1.10) contrast(1.02)' : 'none';

  const ringOp = activeKey ? clamp01(activeP) : 0;
  spotRingEl.style.opacity = String(ringOp * 0.9);
  if (activeKey && RECTS[activeKey]) {
    const r = RECTS[activeKey];
    const pad = 8;
    spotRingEl.style.left = (r.x - pad) + 'px';
    spotRingEl.style.top = (r.y - pad) + 'px';
    spotRingEl.style.width = (r.w + pad * 2) + 'px';
    spotRingEl.style.height = (r.h + pad * 2) + 'px';
  }
}

/* ============================================================
   Cursor actor
   ============================================================ */
const cursorEl = byId('cursor');
const cursorRingEl = byId('cursor-ring');
function setCursor(x, y, opacity, clickT, tNow, scale) {
  cursorEl.style.opacity = String(opacity);
  cursorEl.style.left = x + 'px';
  cursorEl.style.top = y + 'px';
  let dip = 1;
  if (clickT != null) {
    const d = Math.abs(tNow - clickT);
    if (d < 0.16) dip = 1 - 0.22 * (1 - d / 0.16);
  }
  cursorEl.style.transform = 'translate(-2px,-1px) scale(' + (scale == null ? dip : scale * dip) + ')';
  if (clickT != null) {
    const rp = prog(tNow, clickT, 0.5);
    if (rp > 0 && rp < 1) {
      cursorRingEl.style.opacity = String(0.85 * (1 - rp));
      cursorRingEl.style.transform = 'scale(' + lerp(0.4, 2.3, easeOutCubic(rp)) + ')';
    } else {
      cursorRingEl.style.opacity = '0';
    }
  } else {
    cursorRingEl.style.opacity = '0';
  }
}
function curvedPoint(p0, p1, bow, p) {
  const mx = (p0.x + p1.x) / 2 + (p1.y - p0.y) * bow;
  const my = (p0.y + p1.y) / 2 - (p1.x - p0.x) * bow;
  const e = easeInOutCubic(p);
  const ax = lerp(p0.x, mx, e), ay = lerp(p0.y, my, e);
  const bx = lerp(mx, p1.x, e), by = lerp(my, p1.y, e);
  return { x: lerp(ax, bx, e), y: lerp(ay, by, e) };
}

function renderCursor(t) {
  // Kanban drag: 19.7 approach, 20.0 mousedown, 20.1-21.9 drag, 22.0 release, 22.4 fade
  if (t >= 19.7 && t <= 22.5) {
    const src = RECTS.cardRatelimit, dst = RECTS.dropslot;
    const p0 = { x: src.x + src.w - 30, y: src.y + 22 };
    const p1 = { x: dst.x + dst.w / 2, y: dst.y + dst.h / 2 };
    let x, y, op;
    if (t < 20.0) { const p = prog(t, 19.7, 0.3); x = p0.x; y = p0.y; op = p; }
    else if (t < 21.9) { const p = prog(t, 20.0, 1.9); const pt = curvedPoint(p0, p1, 0.18, p); x = pt.x; y = pt.y; op = 1; }
    else if (t < 22.2) { x = p1.x; y = p1.y; op = 1; }
    else { x = p1.x; y = p1.y; op = 1 - prog(t, 22.2, 0.3); }
    setCursor(x, y, op, 20.0, t, null);
    return;
  }
  // Palette: approach + click the filtered workspace item
  if (t >= 28.5 && t <= 31.3) {
    const target = RECTS.filteredItem;
    const p0 = { x: target.x - 90, y: target.y - 60 };
    const p1 = { x: target.x + target.w - 40, y: target.y + target.h / 2 };
    let x, y, op;
    if (t < 29.1) { const p = easeInOutCubic(prog(t, 28.5, 0.6)); const pt = curvedPoint(p0, p1, 0.14, p); x = pt.x; y = pt.y; op = prog(t, 28.5, 0.25); }
    else if (t < 30.8) { x = p1.x; y = p1.y; op = 1; }
    else { x = p1.x; y = p1.y; op = 1 - prog(t, 30.8, 0.5); }
    setCursor(x, y, op, 30.8, t, null);
    return;
  }
  // Notify: click bell, then move to first item
  if (t >= 40.1 && t <= 43.7) {
    const bell = RECTS.bellIcon, item = RECTS.biFlash;
    const p0 = { x: bell.x + bell.w / 2 - 60, y: bell.y - 40 };
    const p1 = { x: bell.x + bell.w / 2, y: bell.y + bell.h / 2 };
    const p2 = { x: item.x + item.w - 50, y: item.y + item.h / 2 };
    let x, y, op;
    if (t < 40.5) { const p = easeInOutCubic(prog(t, 40.1, 0.4)); const pt = curvedPoint(p0, p1, 0.16, p); x = pt.x; y = pt.y; op = prog(t, 40.1, 0.25); }
    else if (t < 41.6) { x = p1.x; y = p1.y; op = 1; }
    else if (t < 42.5) { const p = easeInOutCubic(prog(t, 41.6, 0.9)); const pt = curvedPoint(p1, p2, 0.12, p); x = pt.x; y = pt.y; op = 1; }
    else if (t < 43.2) { x = p2.x; y = p2.y; op = 1; }
    else { x = p2.x; y = p2.y; op = 1 - prog(t, 43.2, 0.5); }
    setCursor(x, y, op, t < 41.6 ? 40.5 : 42.6, t, null);
    return;
  }
  setCursor(-100, -100, 0, null, t, null);
}

/* ============================================================
   Captions (kinetic lower-third)
   ============================================================ */
const CAPTIONS = [
  { start: 5.6, end: 11.0, text: 'Live parallel agents' },
  { start: 11.0, end: 16.0, text: 'Subscription CLIs — no API keys' },
  { start: 16.0, end: 19.4, text: 'Flags you when it needs input' },
  { start: 19.6, end: 26.6, text: 'Drop a task. An agent picks it up.' },
  { start: 27.0, end: 32.7, text: 'Ctrl+K — jump anywhere.' },
  { start: 32.9, end: 39.8, text: 'Your cockpit, your palette.' },
  { start: 40.0, end: 45.9, text: 'Never miss what needs you.' },
];
CAPTIONS.forEach((c) => {
  c.words = c.text.split(' ');
  c.html = c.words.map((w) => '<span class="cap-word"><span>' + w + '</span></span>').join(' ');
});
const captionEl = byId('caption');
const capWordsEl = byId('cap-words');
let capCurrentIdx = -1;
function renderCaption(t) {
  let idx = -1;
  for (let k = 0; k < CAPTIONS.length; k++) if (t >= CAPTIONS[k].start - 0.5 && t <= CAPTIONS[k].end) idx = k;
  if (idx === -1) { captionEl.style.opacity = '0'; capCurrentIdx = -1; return; }
  const c = CAPTIONS[idx];
  if (capCurrentIdx !== idx) { capWordsEl.innerHTML = c.html; capCurrentIdx = idx; }
  const spans = capWordsEl.querySelectorAll('.cap-word > span');
  const stagger = 0.055;
  spans.forEach((sp, i) => {
    const wp = easeOutCubic(prog(t, c.start + i * stagger, 0.32));
    sp.style.opacity = String(wp);
    sp.style.transform = 'translateY(' + (1 - wp) * 100 + '%)';
  });
  const containerFade = fadeWindow(t, c.start - 0.15, c.end + 0.05, 0.35);
  captionEl.style.opacity = String(containerFade);
}

/* ============================================================
   Theme montage
   ============================================================ */
const THEME_SEGMENTS = [
  { t0: T.themeStart, t1: 34.1, attr: null, label: 'Deep Cove' },
  { t0: 34.1, t1: 35.9, attr: 'dracula', label: 'Dracula' },
  { t0: 35.9, t1: 37.7, attr: 'nord', label: 'Nord' },
  { t0: 37.7, t1: T.themeEnd, attr: null, label: 'Deep Cove' },
];
const themeTagEl = byId('theme-tag');
function renderTheme(t) {
  const appframeEl = byId('appframe');
  if (t < T.themeStart - 0.3 || t > T.themeEnd + 0.3) {
    themeTagEl.style.opacity = '0';
    if (appframeEl.getAttribute('data-theme')) appframeEl.removeAttribute('data-theme');
    return;
  }
  let seg = THEME_SEGMENTS[0];
  for (const s of THEME_SEGMENTS) if (t >= s.t0) seg = s;
  if (seg.attr) appframeEl.setAttribute('data-theme', seg.attr); else appframeEl.removeAttribute('data-theme');
  themeTagEl.textContent = seg.label;
  themeTagEl.style.opacity = String(fadeWindow(t, T.themeStart, T.themeEnd, 0.4));
}

/* ============================================================
   Scene opacity / z-index
   ============================================================ */
const APP_SCENES = [
  { id: 'scene-cockpit', s: T.cockpitStart, e: T.cockpitEnd, z: 10 },
  { id: 'scene-kanban', s: T.kanbanStart, e: T.kanbanEnd, z: 11 },
  { id: 'scene-palette', s: T.paletteStart, e: T.paletteEnd, z: 12 },
  { id: 'scene-theme', s: T.themeStart, e: T.themeEnd, z: 13 },
  { id: 'scene-notify', s: T.notifyStart, e: T.notifyEnd, z: 14 },
];
function renderScenes(t) {
  let anyAppSceneActive = false;
  APP_SCENES.forEach((sc) => {
    const el = byId(sc.id);
    const op = fadeWindow(t, sc.s, sc.e, 0.45);
    el.style.opacity = String(op);
    el.style.zIndex = String(sc.z);
    if (op > 0.01) anyAppSceneActive = true;
  });
  const appframeEl = byId('appframe');
  const camOp = fadeWindow(t, T.cockpitStart - 0.45, T.notifyEnd + 0.45, 0.45);
  appframeEl.parentElement.style.opacity = String(camOp); // .camera
  byId('scene-open').style.opacity = String(fadeWindow(t, T.openStart, T.openEnd, 0.5));
  byId('scene-close').style.opacity = String(fadeWindow(t, T.closeStart, T.closeEnd, 0.5));
}

/* ============================================================
   Cockpit render (typing + pane state + waiting line)
   ============================================================ */
function renderCockpit(t) {
  [1, 2, 3, 4].forEach((n) => renderTerm(byId('b-p' + n + '-term'), SCRIPTS['p' + n], t));
  let states = { 'b-p1': 'starting', 'b-p2': 'starting', 'b-p3': 'starting', 'b-p4': 'starting' };
  PANE_FLIPS.forEach((f) => { if (t >= f.t) states[f.id] = f.cls; });
  Object.keys(states).forEach((id) => setPaneState(id, states[id]));
}

/* ============================================================
   Kanban render (permanent DOM, opacity/display driven by t)
   ============================================================ */
const DRAG_LIFT = 19.85, DRAG_START = 20.0, DRAG_END = 21.9, DRAG_LAND = 22.05;
function renderKanban(t) {
  const src = byId('card-ratelimit');
  const ghost = byId('k-ghost');
  const landed = byId('card-landed');
  const dropSlot = byId('k-dropslot-inprogress');
  const col = byId('k-col-inprogress');
  const chip = byId('k-newchip');
  const todoCount = byId('k-todo-count');
  const inprogCount = byId('k-inprog-count');

  if (t < DRAG_LIFT) {
    src.style.opacity = '1'; src.style.display = '';
    ghost.style.opacity = '0';
    landed.style.display = 'none';
    dropSlot.style.display = 'none';
    col.classList.remove('drop-active');
    todoCount.textContent = '2'; inprogCount.textContent = '1';
  } else if (t < DRAG_LAND) {
    src.style.display = 'none';
    dropSlot.style.display = 'flex';
    col.classList.add('drop-active');
    landed.style.display = 'none';
    todoCount.textContent = '2'; inprogCount.textContent = '1';
    const p = clamp01((t - DRAG_START) / (DRAG_END - DRAG_START));
    const ease = t < DRAG_START ? 0 : easeOutBack(p, 0.7);
    // ghost's containing block is #scene-kanban, which sits inside #appframe
    // (offset FX,FY from the stage) — RECTS are stage-relative, so subtract.
    const x = lerp(RECTS.cardRatelimit.x, RECTS.dropslot.x, clamp01(ease)) - FX;
    const y = lerp(RECTS.cardRatelimit.y, RECTS.dropslot.y, clamp01(ease)) - FY;
    ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; ghost.style.width = RECTS.cardRatelimit.w + 'px';
    ghost.style.opacity = String(fadeWindow(t, DRAG_LIFT, DRAG_LAND + 0.05, 0.15));
  } else {
    src.style.display = 'none';
    ghost.style.opacity = '0';
    dropSlot.style.display = 'none';
    col.classList.remove('drop-active');
    landed.style.display = 'flex';
    todoCount.textContent = '1'; inprogCount.textContent = '2';
    const cp = easeOutCubic(prog(t, DRAG_LAND + 0.05, 0.3));
    chip.style.opacity = String(cp);
    chip.style.transform = 'scale(' + lerp(0.85, 1, cp) + ')';
  }
}

/* ============================================================
   Palette render
   ============================================================ */
const PALETTE_OPEN = 26.9, TYPE_START = 27.6, TYPE_END = 28.3, FILTER_SWAP = 28.5, SCRIM_CLOSE = 30.9, SWITCH_AT = 31.1;
const QUERY = 'billing';
function renderPalette(t) {
  const scrim = byId('cmdp-scrim');
  const modal = byId('cmdp-modal');
  const input = byId('cmdp-input');
  const full = byId('cmdp-list-full');
  const filtered = byId('cmdp-list-filtered');

  const openP = easeOutCubic(prog(t, PALETTE_OPEN, 0.35));
  const closeP = easeInOutCubic(prog(t, SCRIM_CLOSE, 0.38));
  const visible = clamp01(openP * (1 - closeP));
  scrim.style.opacity = String(visible);
  modal.style.opacity = String(visible);
  modal.style.transform = 'translateY(' + (1 - openP) * -10 + 'px) scale(' + lerp(0.98, 1, openP) + ')';

  if (t < TYPE_START) input.textContent = '';
  else if (t < TYPE_END) input.textContent = QUERY.slice(0, Math.max(1, Math.floor(((t - TYPE_START) / (TYPE_END - TYPE_START)) * QUERY.length)));
  else input.textContent = QUERY;

  if (t < FILTER_SWAP) { full.style.display = ''; filtered.style.display = 'none'; }
  else { full.style.display = 'none'; filtered.style.display = ''; }

  const railFD = byId('bell-d-rail-flightdeck');
  const railBS = byId('bell-d-rail-billing');
  const wsLabel = byId('bell-d-wslabel');
  if (t < SWITCH_AT) { railFD.classList.add('active'); railBS.classList.remove('active'); wsLabel.textContent = 'flightdeck'; }
  else { railFD.classList.remove('active'); railBS.classList.add('active'); wsLabel.textContent = 'billing-service'; }
}

/* ============================================================
   Notify render
   ============================================================ */
const MENU_OPEN = 40.6, FLASH_START = 42.6, FLASH_END = 43.2, MENU_CLOSE = 43.6;
function renderNotify(t) {
  const menu = byId('bell-menu');
  const bi1 = byId('bi-1');
  const openP = easeOutCubic(prog(t, MENU_OPEN, 0.35));
  const closeP = easeInOutCubic(prog(t, MENU_CLOSE, 0.35));
  const visible = clamp01(openP * (1 - closeP));
  menu.style.opacity = String(visible);
  menu.style.transform = 'translateY(' + (1 - openP) * -8 + 'px)';
  bi1.classList.toggle('flash', t >= FLASH_START && t < FLASH_END + 0.5);
}

/* ============================================================
   Open / close card scenes
   ============================================================ */
function renderOpen(t) {
  revealStyle(byId('open-mark'), prog(t, T.openStart + 0.15, 0.6), 14);
  revealStyle(byId('open-word'), prog(t, T.openStart + 0.75, 0.55), 10);
  revealStyle(byId('open-tag'), prog(t, T.openStart + 1.3, 0.55), 8);
}
function renderClose(t) {
  revealStyle(byId('close-mark'), prog(t, T.closeStart + 0.2, 0.55), 14);
  revealStyle(byId('close-word'), prog(t, T.closeStart + 0.75, 0.5), 10);
  revealStyle(byId('close-sub'), prog(t, T.closeStart + 1.2, 0.5), 0);
}

/* ============================================================
   Master render
   ============================================================ */
function renderFrame(t) {
  renderScenes(t);
  renderOpen(t);
  renderClose(t);
  renderCockpit(t);
  renderKanban(t);
  renderPalette(t);
  renderTheme(t);
  renderNotify(t);
  renderCamera(t);
  renderCursor(t);
  renderCaption(t);
}

/* ============================================================
   Bootstrap
   ============================================================ */
build();
measure();

const params = new URLSearchParams(location.search);
const SEEK_AT = params.has('at') ? parseFloat(params.get('at')) : null;

if (SEEK_AT !== null && !Number.isNaN(SEEK_AT)) {
  renderFrame(SEEK_AT);
  document.title = 'Flightdeck reel — seek @ ' + SEEK_AT + 's';
  window.__reelResolve();
} else {
  const t0 = performance.now();
  function loop(now) {
    const t = (now - t0) / 1000;
    renderFrame(Math.min(t, TOTAL));
    if (t < TOTAL) requestAnimationFrame(loop);
    else window.__reelResolve();
  }
  requestAnimationFrame(loop);
}
