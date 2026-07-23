// demo/lib/rig.js — browser-side director's rig, injected after the real app
// mounts. Every function here just SETS styles/DOM; all timing is owned by
// the Node-side frame-stepped capture loop (demo/lib/capture.mjs), which
// advances the page's virtual clock and lets these CSS transitions play out
// deterministically. Never shipped, never touches src/**.
(() => {
  if (window.__fd) return; // idempotent — safe if evaluated twice

  const host = document.createElement("div");
  host.id = "fd-overlay-root";
  host.innerHTML = `
    <div id="fd-vignette"></div>
    <div id="fd-caption"><div class="bar"></div><div class="t" id="fd-cap-t"></div><div class="s" id="fd-cap-s"></div></div>
    <div id="fd-keys"></div>
    <div id="fd-cursor">
      <div class="fd-ring"></div>
      <svg width="28" height="28" viewBox="0 0 26 26">
        <path d="M4 2 L4 20 L9 15.5 L12.5 22 L15.5 20.5 L12 14 L19 14 Z" fill="#EAF1F8" stroke="#0A1220" stroke-width="1.2"/>
      </svg>
    </div>
    <div id="fd-card">
      <div class="fd-glow"></div>
      <svg class="fd-mark" viewBox="0 0 20 20"><path d="M10 3 L16.5 16 L10 12.5 L3.5 16 Z" fill="#9AE9FF"/></svg>
      <div class="fd-word" id="fd-card-title">Flightdeck</div>
      <div class="fd-tag" id="fd-card-tag"></div>
    </div>
    <div id="fd-dip"></div>
  `;
  // Sibling of <body> under <html> — never affected by the camera transform
  // we apply to <body>, so captions/cursor/cards stay pinned to the viewport.
  document.documentElement.appendChild(host);
  document.body.style.transformOrigin = "50% 50%";
  document.body.style.transform = "scale(1)";

  const $ = (id) => document.getElementById(id);
  let curX = window.innerWidth / 2;
  let curY = window.innerHeight / 2;

  function resolveEl(target) {
    if (!target) return null;
    if (typeof target === "string") return document.querySelector(target);
    if (target.getBoundingClientRect) return target;
    return null;
  }

  window.__fd = {
    // --- Camera --------------------------------------------------------
    camera(target, opts = {}) {
      const { scale = 1, ms = 2000 } = opts;
      let cx = window.innerWidth / 2;
      let cy = window.innerHeight / 2;
      const el = resolveEl(target);
      if (el) {
        const r = el.getBoundingClientRect();
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
      } else if (target && typeof target.x === "number") {
        cx = target.x; cy = target.y;
      } else if (target) {
        console.warn("[fd-rig] camera target not found:", target);
      }
      document.body.style.transitionDuration = `${ms}ms`;
      document.body.style.transformOrigin = `${cx}px ${cy}px`;
      document.body.style.transform = `scale(${scale})`;
    },
    resetCamera(ms = 1800) {
      document.body.style.transitionDuration = `${ms}ms`;
      document.body.style.transformOrigin = "50% 50%";
      document.body.style.transform = "scale(1)";
    },

    // --- Spotlight -------------------------------------------------------
    spotlight(target, opts = {}) {
      const v = $("fd-vignette");
      let w = 700, h = 420;
      let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      const el = resolveEl(target);
      if (el) {
        const r = el.getBoundingClientRect();
        w = r.width * (opts.pad ?? 1.35);
        h = r.height * (opts.pad ?? 1.35);
        cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      }
      const mask = `radial-gradient(ellipse ${w}px ${h}px at ${cx}px ${cy}px, transparent 0%, transparent 55%, black 100%)`;
      v.style.maskImage = mask;
      v.style.webkitMaskImage = mask;
      v.style.opacity = String(opts.strength ?? 0.5);
    },
    clearSpotlight() { $("fd-vignette").style.opacity = "0"; },

    // --- Cursor actor ------------------------------------------------------
    showCursor() { $("fd-cursor").style.opacity = "1"; },
    hideCursor() { $("fd-cursor").style.opacity = "0"; },
    cursorTo(x, y, ms = 640) {
      const c = $("fd-cursor");
      c.style.transitionDuration = `${ms}ms`;
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
      curX = x; curY = y;
    },
    cursorToEl(target, opts = {}) {
      const el = resolveEl(target);
      if (!el) { console.warn("[fd-rig] cursorToEl not found:", target); return null; }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width * (opts.px ?? 0.5);
      const y = r.top + r.height * (opts.py ?? 0.5);
      this.cursorTo(x, y, opts.ms);
      return { x, y };
    },
    press() {
      $("fd-cursor").classList.add("down");
      const rip = document.createElement("div");
      rip.className = "fd-ripple";
      rip.style.left = `${curX}px`;
      rip.style.top = `${curY}px`;
      $("fd-overlay-root").appendChild(rip);
      setTimeout(() => rip.remove(), 700);
    },
    release() { $("fd-cursor").classList.remove("down"); },
    cursorPos() { return { x: curX, y: curY }; },

    // --- Keycap chips --------------------------------------------------
    keys(labels) {
      const el = $("fd-keys");
      el.innerHTML = labels
        .map((k, i) => (i > 0 ? '<span class="fd-key plus">+</span>' : "") + `<span class="fd-key">${k}</span>`)
        .join("");
      el.classList.add("on");
    },
    hideKeys() { $("fd-keys").classList.remove("on"); },

    // --- Captions --------------------------------------------------------
    caption(title, sub = "", opts = {}) {
      const el = $("fd-caption");
      $("fd-cap-t").textContent = title;
      $("fd-cap-s").textContent = sub;
      const top = opts.side === "top";
      el.style.top = top ? "34px" : "";
      el.style.bottom = top ? "" : "40px";
      el.classList.add("on");
    },
    hideCaption() { $("fd-caption").classList.remove("on"); },

    // --- Brand cards -------------------------------------------------------
    card(title, tag) {
      $("fd-card-title").textContent = title;
      $("fd-card-tag").textContent = tag;
      $("fd-card").classList.add("on");
    },
    hideCard() { $("fd-card").classList.remove("on"); },

    // --- Scene dip ---------------------------------------------------------
    dip(on) { $("fd-dip").classList.toggle("on", !!on); },
  };
  console.log("[fd-rig] installed");
})();
