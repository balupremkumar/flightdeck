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

  // Tracks the transform CURRENTLY applied to <body> so a camera() call can
  // undo it before computing the next one — see the big comment in camera()
  // for why this matters.
  let camState = { tx: 0, ty: 0, s: 1 };

  window.__fd = {
    // --- Camera --------------------------------------------------------
    camera(target, opts = {}) {
      const { scale = 1, ms = 2000 } = opts;
      const vw = window.innerWidth, vh = window.innerHeight;
      // getBoundingClientRect() (and the caller's own {x,y}, always sourced
      // from a boundingBox() call on the Node side) both report the
      // target's CURRENT on-screen position — i.e. already passed through
      // whatever transform is active on <body> right now.
      let screenX = vw / 2, screenY = vh / 2;
      const el = resolveEl(target);
      if (el) {
        const r = el.getBoundingClientRect();
        screenX = r.left + r.width / 2;
        screenY = r.top + r.height / 2;
      } else if (target && typeof target.x === "number") {
        screenX = target.x; screenY = target.y;
      } else if (target) {
        console.warn("[fd-rig] camera target not found:", target);
      }
      // Recentre the target at the viewport centre while zooming — anchoring
      // the scale at the target's own on-screen point (the old approach)
      // leaves an off-centre target off-centre after the push-in, and can
      // clip a panel that sits near an edge (QA on the previous cut: the
      // .pdiff push-in sat off-centre, the attention-queue push-in clipped
      // its left edge).
      //
      // Two wrong attempts at the fix before this one, both confirmed wrong
      // with QA frames:
      //  1. `transform-origin: 50% 50%` + an offsetting translate —
      //     percentage transform-origin is relative to the element's OWN
      //     border-box, not the viewport, and <body>'s box can be taller
      //     than the viewport even with `overflow: hidden` (that only clips
      //     paint, not layout size) — landed well below true centre.
      //  2. Fixed `transform-origin: 0 0` (viewport-absolute, unambiguous)
      //     with tx = vw/2 - s*cx — correct in isolation, but cx/cy came
      //     straight from getBoundingClientRect(), which is POST the
      //     transform from the PREVIOUS camera() call. Each call SETS a
      //     fresh `transform` rather than composing onto the existing one,
      //     so feeding it an already-transformed point double-applies the
      //     prior zoom — fine for the first push-in in a sequence (nothing
      //     to undo yet), compounding worse on each subsequent one, blowing
      //     up into a fully off-screen (solid black) frame by the 2nd/3rd
      //     shot in the grid scene's pane-to-pane tracking loop.
      //
      // Fix: undo the CURRENTLY active transform (tracked in camState) to
      // recover the target's true layout-space position first, then solve
      // for the fresh transform from that, with transform-origin pinned at
      // the unambiguous literal "0 0" (body's own top-left corner, which
      // coincides with the viewport's top-left since body never scrolls).
      const cx = (screenX - camState.tx) / camState.s;
      const cy = (screenY - camState.ty) / camState.s;
      const tx = vw / 2 - scale * cx;
      const ty = vh / 2 - scale * cy;
      document.body.style.transitionDuration = `${ms}ms`;
      document.body.style.transformOrigin = "0 0";
      document.body.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      camState = { tx, ty, s: scale };
    },
    resetCamera(ms = 1800) {
      document.body.style.transitionDuration = `${ms}ms`;
      document.body.style.transformOrigin = "0 0";
      document.body.style.transform = "translate(0px, 0px) scale(1)";
      camState = { tx: 0, ty: 0, s: 1 };
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
