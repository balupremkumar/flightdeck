// Browser harness for Phase 4 multi-window (docs/plans/phase4-multiwindow.md, "Browser
// harness"). The mock backend cannot open real windows, so the pieces of Rust that
// decide where a workspace and its pty output live are ported to JS and run once, in
// the Playwright Node process, shared by every page of a browser context:
//
//   - the window registry (windows.rs: labels, ownership, ordinals, assign_new_window)
//   - slice acceptance (persist.rs: a label's slice keeps only workspaces it owns)
//   - the pty table and per-pane ring (lib.rs/paneout.rs: spawn, attach, pause/resume,
//     seq on every output event, delta attach, supersede on a duplicate model id)
//
// Pages reach it through context.exposeBinding("__fdBus"); demo/mock-tauri-interactive.js
// routes window and pty commands there when the binding exists, and reads its window
// label from `?label=fw-1`. ws_transfer(New) opens the new window with context.newPage().
// Two pages of one context share localStorage, so the clobbering hazards are real.
//
// Output is generated here too: every pty prints BANNER-<model> then TICK-<model>-<n>
// on a timer, so a test can check continuity (no gap, no duplicate) across a move.

const RING_BYTES = 4 * 1024 * 1024;
const TICK_MS = 120;
const MAX_ORDINAL = 127;

const b64 = (s) => Buffer.from(s, "latin1").toString("base64");

export class MultiWindowBus {
  /** @param {import("playwright").BrowserContext} context @param {string} url dev-server origin */
  constructor(context, url) {
    this.context = context;
    this.url = url.replace(/\/$/, "");
    this.pages = new Map(); // label -> Page
    this.windows = new Map(); // label -> { ordinal, workspaceIds, booted }
    this.nextOrdinal = 1;
    this.ptys = new Map(); // pty id -> pty
    this.byModel = new Map(); // model id -> pty
    this.nextPty = 100;
    this.slices = new Map(); // label -> accepted slice
    this.pending = new Map(); // label -> transfer payload
    this.rejected = []; // { label, id } slice workspaces dropped by the ownership rule
    this.spawns = []; // { label, modelId, ptyId }
    this.kills = []; // { label, ptyId, modelId, reason }
    this.attaches = []; // { label, modelId, hit, delta }
    this.transfers = []; // { from, to, workspaceId }
    this.ensureMain();
  }

  async install() {
    await this.context.exposeBinding("__fdBus", (_source, msg) => this.handle(msg));
  }

  /** Tell the bus which page is which window (main, opened by the test). */
  register(label, page) {
    this.pages.set(label, page);
  }

  // ---- registry (windows.rs) -------------------------------------------------
  ensureMain() {
    if (!this.windows.has("main")) this.windows.set("main", { ordinal: 0, workspaceIds: [], booted: false });
  }

  owns(label, wsId) {
    for (const [l, r] of this.windows) if (r.workspaceIds.includes(wsId)) return l === label;
    return label === "main";
  }

  mintLabel() {
    if (this.nextOrdinal > MAX_ORDINAL) throw new Error("no window ordinals left");
    const ordinal = this.nextOrdinal++;
    const label = `fw-${ordinal}`;
    this.windows.set(label, { ordinal, workspaceIds: [], booted: false });
    return label;
  }

  assignNewWindow(source, wsId) {
    if (!this.owns(source, wsId)) throw new Error(`window ${source} does not own workspace ${wsId}`);
    const label = this.mintLabel();
    for (const r of this.windows.values()) r.workspaceIds = r.workspaceIds.filter((i) => i !== wsId);
    this.windows.get(label).workspaceIds = [wsId];
    return label;
  }

  // ---- rings (ring.rs / paneout.rs, without safe marks: the generated output is line based) ----
  ringPush(p, text) {
    p.buf += text;
    p.seq += text.length;
    if (p.buf.length > RING_BYTES) {
      const drop = p.buf.length - RING_BYTES;
      p.buf = p.buf.slice(drop);
      p.base += drop;
    }
  }

  /** Append, and emit unless the pane is buffer-only. Push and emit are one step, so emit order is seq order. */
  push(p, text) {
    this.ringPush(p, text);
    if (!p.paused) this.emitAll("pty://output", { pane_id: p.id, b64: b64(text), seq: p.seq });
  }

  emitAll(event, payload) {
    for (const page of this.pages.values()) {
      if (page.isClosed()) continue;
      page.evaluate(([e, pl]) => window.__mockEmit?.(e, pl), [event, payload]).catch(() => {});
    }
  }

  killPty(p, label, reason) {
    clearInterval(p.timer);
    clearTimeout(p.startTimer);
    this.ptys.delete(p.id);
    if (this.byModel.get(p.modelId) === p) this.byModel.delete(p.modelId);
    this.kills.push({ label, ptyId: p.id, modelId: p.modelId, reason });
  }

  // ---- commands --------------------------------------------------------------
  async handle({ cmd, args, label }) {
    const a = args ?? {};
    switch (cmd) {
      case "pty_spawn": {
        const old = this.byModel.get(a.modelId);
        if (old) this.killPty(old, label, "superseded");
        const p = { id: ++this.nextPty, modelId: a.modelId, vendor: a.vendor, cwd: a.cwd, gen: a.gen, buf: "", base: 0, seq: 0, paused: false, pausedAt: 0, attached: label, cols: a.cols, rows: a.rows, n: 0 };
        this.ptys.set(p.id, p);
        this.byModel.set(p.modelId, p);
        this.spawns.push({ label, modelId: p.modelId, ptyId: p.id });
        p.startTimer = setTimeout(() => {
          this.emitAll("pty://state", { pane_id: p.id, state: "running" });
          this.push(p, `BANNER-${p.modelId}\r\n`);
          p.timer = setInterval(() => this.push(p, `TICK-${p.modelId}-${++p.n}\r\n`), TICK_MS);
        }, 80);
        return p.id;
      }
      case "pty_attach": {
        const p = this.byModel.get(a.modelId);
        const [, vendor, ...cwd] = String(a.gen).split("|");
        const hit = !!p && p.vendor === vendor && p.cwd === cwd.join("|");
        if (!hit) {
          this.attaches.push({ label, modelId: a.modelId, hit: false, delta: false });
          return null;
        }
        p.attached = label;
        p.paused = false;
        const since = a.sinceSeq;
        const delta = since !== undefined && since >= p.base && since <= p.seq;
        const body = delta ? p.buf.slice(since - p.base) : p.buf;
        this.attaches.push({ label, modelId: a.modelId, hit: true, delta });
        return {
          pty_id: p.id,
          snapshot: { head: "", body: b64(body), start_seq: delta ? since : p.base, next_seq: p.seq, delta },
          cols: p.cols ?? 120, rows: p.rows ?? 30, proc_name: "node",
        };
      }
      case "pty_write":
      case "pty_resize":
        return null;
      case "pty_kill": {
        const p = this.ptys.get(a.paneId);
        if (p) this.killPty(p, label, "pty_kill");
        else this.kills.push({ label, ptyId: a.paneId, modelId: null, reason: "pty_kill (unknown)" });
        return null;
      }
      case "pane_pause": {
        const p = this.byModel.get(a.modelId);
        if (!p) throw new Error(`no live pty for pane model ${a.modelId}`);
        if (!p.paused) { p.paused = true; p.pausedAt = p.seq; }
        return p.pausedAt;
      }
      case "pane_resume": {
        const p = this.byModel.get(a.modelId);
        if (!p) throw new Error(`no live pty for pane model ${a.modelId}`);
        if (!p.paused) return null;
        p.paused = false;
        if (p.seq > p.pausedAt) this.emitAll("pty://output", { pane_id: p.id, b64: b64(p.buf.slice(p.pausedAt - p.base)), seq: p.seq });
        return null;
      }
      case "window_boot": {
        const rec = this.windows.get(label);
        if (!rec) throw new Error(`window ${label} was not created by Flightdeck`);
        rec.booted = true;
        const transfer = this.pending.get(label) ?? null;
        this.pending.delete(label);
        return { label, ordinal: rec.ordinal, slice: label === "main" ? null : (this.slices.get(label) ?? null), transfer };
      }
      case "window_heartbeat":
      case "window_focus_next":
        return null;
      case "session_put_slice": {
        const kept = [];
        for (const w of a.slice.workspaces ?? []) {
          if (this.owns(label, w.id)) kept.push(w);
          else this.rejected.push({ label, id: w.id });
        }
        this.slices.set(label, { ...a.slice, workspaces: kept });
        return null;
      }
      case "ws_transfer": {
        const snap = a.wsSnapshot;
        const to = this.assignNewWindow(label, snap.workspaceId);
        this.slices.set(to, snap.slice);
        this.pending.set(to, snap.transfer);
        this.transfers.push({ from: label, to, workspaceId: snap.workspaceId });
        const page = await this.context.newPage();
        this.pages.set(to, page);
        await page.goto(`${this.url}/?label=${to}`, { waitUntil: "domcontentloaded" });
        return to;
      }
      default:
        throw new Error(`multiwindow bus: no handler for ${cmd}`);
    }
  }

  stop() {
    for (const p of this.ptys.values()) { clearInterval(p.timer); clearTimeout(p.startTimer); }
  }
}
