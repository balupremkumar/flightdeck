// Browser harness for Phase 4 multi-window (docs/plans/phase4-multiwindow.md, "Browser
// harness"). The mock backend cannot open real windows, so the pieces of Rust that
// decide where a workspace and its pty output live are ported to JS and run once, in
// the Playwright Node process, shared by every page of a browser context:
//
//   - the window registry (windows.rs: labels, ownership, ordinals, assign_new_window)
//   - slice acceptance (persist.rs: a label's slice keeps only workspaces it owns; an unheld
//     workspace in the label's id partition is claimed for it first, claim_unheld)
//   - close semantics (windows.rs): flush then merge into main (closeWindow), merge from
//     the last slice with no flush (crashWindow), retire a secondary left with nothing
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
    this.merges = []; // { label, why, flushed, workspaceIds } secondaries folded into main
    this.retired = []; // labels destroyed because their assignment emptied
    this.focuses = []; // { from, label, wsId, paneId } window_focus_pane calls
    this.multiwindow = false; // set by main's window_boot, like Rust
    this.slicePuts = new Map(); // label -> pushes seen (the flush acknowledgement)
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
    if (!this.windows.has("main")) this.windows.set("main", { ordinal: 0, workspaceIds: [], activeWs: null, booted: false });
  }

  owns(label, wsId) {
    for (const [l, r] of this.windows) if (r.workspaceIds.includes(wsId)) return l === label;
    return label === "main";
  }

  mintLabel() {
    if (this.nextOrdinal > MAX_ORDINAL) throw new Error("no window ordinals left");
    const ordinal = this.nextOrdinal++;
    const label = `fw-${ordinal}`;
    this.windows.set(label, { ordinal, workspaceIds: [], activeWs: null, booted: false });
    return label;
  }

  assignNewWindow(source, wsId) {
    if (!this.owns(source, wsId)) throw new Error(`window ${source} does not own workspace ${wsId}`);
    const label = this.mintLabel();
    for (const r of this.windows.values()) r.workspaceIds = r.workspaceIds.filter((i) => i !== wsId);
    this.windows.get(label).workspaceIds = [wsId];
    this.windows.get(label).activeWs = wsId;
    return label;
  }

  /** windows.rs claim_unheld: a workspace made in a secondary belongs to that secondary. */
  claimUnheld(label, ids) {
    const rec = this.windows.get(label);
    if (!rec || label === "main" || rec.ordinal === 0) return [];
    const held = new Set([...this.windows.values()].flatMap((r) => r.workspaceIds));
    const fresh = ids.filter((id) => id >> 24 === rec.ordinal && !held.has(id));
    for (const id of fresh) if (!rec.workspaceIds.includes(id)) rec.workspaceIds.push(id);
    return fresh;
  }

  /** windows.rs assign_to_window: the target must be another booted window. */
  assignToWindow(source, target, wsId) {
    const rec = this.windows.get(target);
    if (target === source) throw new Error("that workspace is already in this window");
    if (!this.owns(source, wsId)) throw new Error(`window ${source} does not own workspace ${wsId}`);
    if (!rec?.booted) throw new Error(`window ${target} is not open`);
    this.reassign(wsId, target);
  }

  reassign(wsId, to) {
    for (const r of this.windows.values()) {
      r.workspaceIds = r.workspaceIds.filter((i) => i !== wsId);
      if (r.activeWs === wsId) r.activeWs = null;
    }
    const rec = this.windows.get(to);
    if (rec) { rec.workspaceIds.push(wsId); rec.activeWs = wsId; }
  }

  /** windows.rs merge_all: flush every booted secondary, fold each into main. Returns the moved ids. */
  async mergeAll() {
    const labels = [...this.windows.keys()].filter((l) => l !== "main");
    const booted = labels.filter((l) => this.windows.get(l).booted);
    const flushed = new Map(await Promise.all(booted.map(async (l) => [l, await this.flush(l)])));
    const moved = [];
    for (const l of labels) {
      moved.push(...(this.windows.get(l)?.workspaceIds ?? []));
      await this.merge(l, "merged by Merge all windows", flushed.get(l) ?? false);
    }
    return moved;
  }

  // ---- close semantics (windows.rs: close_secondary / merge_window / retire_if_empty) ----
  emitTo(label, event, payload) {
    const page = this.pages.get(label);
    if (!page || page.isClosed()) return Promise.resolve();
    return page.evaluate(([e, pl]) => window.__mockEmit?.(e, pl), [event, payload]).catch(() => {});
  }

  /** Ask a window for its final slice and wait up to `ms` for the push (flush_windows). */
  async flush(label, ms = 500) {
    const base = this.slicePuts.get(label) ?? 0;
    await this.emitTo(label, "app://flush", null);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((this.slicePuts.get(label) ?? 0) > base) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  /** Fold a secondary into main from its last slice, then destroy it. */
  async merge(label, why, flushed) {
    const rec = this.windows.get(label);
    const page = this.pages.get(label);
    if (rec && label !== "main") {
      this.windows.delete(label);
      const main = this.windows.get("main");
      for (const id of rec.workspaceIds) if (!main.workspaceIds.includes(id)) main.workspaceIds.push(id);
      const slice = this.slices.get(label) ?? null;
      this.slices.delete(label);
      this.slicePuts.delete(label);
      this.merges.push({ label, why, flushed, workspaceIds: [...rec.workspaceIds] });
      if (rec.workspaceIds.length > 0) {
        await this.emitTo("main", "win://adopt", { from: label, workspaceIds: rec.workspaceIds, activeWs: rec.activeWs, slice });
      }
    }
    this.pages.delete(label);
    if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => {});
  }

  /** CloseRequested: prevent, flush (500 ms), merge, destroy. */
  async closeWindow(label) {
    const flushed = this.windows.get(label)?.booted ? await this.flush(label) : false;
    await this.merge(label, "closed", flushed);
  }

  /** Destroyed with no prior merge (webview crashed or hung): no flush, last slice only. */
  async crashWindow(label) {
    await this.merge(label, "destroyed without a merge", false);
  }

  /** A secondary left with nothing assigned is destroyed by Rust; nothing folds back. */
  async retire(label) {
    this.windows.delete(label);
    this.slices.delete(label);
    this.slicePuts.delete(label);
    this.retired.push(label);
    const page = this.pages.get(label);
    this.pages.delete(label);
    if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => {});
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
        if (label === "main") this.multiwindow = !!a.multiwindow;
        const transfer = this.pending.get(label) ?? null;
        this.pending.delete(label);
        return { label, ordinal: rec.ordinal, slice: label === "main" ? null : (this.slices.get(label) ?? null), transfer };
      }
      case "window_heartbeat":
      case "window_focus_next":
        return null;
      case "set_multiwindow": {
        const was = this.multiwindow;
        this.multiwindow = !!a.enabled;
        // Turning the flag off runs Merge all windows (windows.rs set_multiwindow).
        if (was && !a.enabled) await this.mergeAll();
        return null;
      }
      case "merge_all_windows": {
        const moved = await this.mergeAll();
        if (label !== "main") await this.pages.get("main")?.bringToFront().catch(() => {});
        return moved;
      }
      case "window_focus_pane": {
        const rec = this.windows.get(a.label);
        const page = this.pages.get(a.label);
        if (!rec || !page) throw new Error(`window ${a.label} is not registered`);
        this.focuses.push({ from: label, label: a.label, wsId: a.wsId, paneId: a.paneId });
        await page.bringToFront().catch(() => {});
        await this.emitTo(a.label, "app://focus-pane", { wsId: a.wsId, paneId: a.paneId });
        return null;
      }
      case "window_summary":
        return [...this.windows.entries()]
          .filter(([l, r]) => l !== label && r.booted)
          .map(([l, r]) => {
            const workspaces = (this.slices.get(l)?.workspaces ?? []).filter((w) => this.owns(l, w.id)).map((w) => ({
              id: w.id, name: w.name, root: w.root, paneId: w.panes?.[0]?.id ?? null,
              livePanes: (w.panes ?? []).filter((p) => this.byModel.has(p.id)).length,
            }));
            return {
              label: l,
              title: l === "main" ? "Flightdeck" : `Window ${r.ordinal + 1}`,
              needsYou: 0,
              workspaces,
              livePanes: workspaces.reduce((n, w) => n + w.livePanes, 0),
            };
          });
      case "window_close_self": {
        if (label === "main") throw new Error("main closes by quitting the app");
        const rec = this.windows.get(label);
        if (rec?.booted && rec.workspaceIds.length === 0) setTimeout(() => this.retire(label), 20);
        else setTimeout(() => this.closeWindow(label), 20);
        return null;
      }
      case "session_put_slice": {
        this.claimUnheld(label, (a.slice.workspaces ?? []).map((w) => w.id));
        const kept = [];
        for (const w of a.slice.workspaces ?? []) {
          if (this.owns(label, w.id)) kept.push(w);
          else this.rejected.push({ label, id: w.id });
        }
        this.slices.set(label, { ...a.slice, workspaces: kept });
        this.slicePuts.set(label, (this.slicePuts.get(label) ?? 0) + 1);
        return null;
      }
      case "ws_transfer": {
        if (!this.multiwindow) throw new Error("Multiple windows are turned off in Settings.");
        const snap = a.wsSnapshot;
        if (a.target?.kind === "label") {
          // Move to an existing window: same slice seeding, delivered over win://adopt.
          const to = a.target.label;
          this.assignToWindow(label, to, snap.workspaceId);
          const have = this.slices.get(to) ?? { ...snap.slice, workspaces: [] };
          if (!have.workspaces.some((w) => w.id === snap.workspaceId)) have.workspaces = [...have.workspaces, ...snap.slice.workspaces];
          this.slices.set(to, have);
          this.transfers.push({ from: label, to, workspaceId: snap.workspaceId });
          await this.emitTo(to, "win://adopt", { from: label, workspaceIds: [snap.workspaceId], activeWs: snap.workspaceId, slice: snap.slice, transfer: snap.transfer });
          await this.pages.get(to)?.bringToFront().catch(() => {});
          const src = this.windows.get(label);
          if (label !== "main" && src?.booted && src.workspaceIds.length === 0) setTimeout(() => this.retire(label), 50);
          return to;
        }
        const to = this.assignNewWindow(label, snap.workspaceId);
        this.slices.set(to, snap.slice);
        this.pending.set(to, snap.transfer);
        this.transfers.push({ from: label, to, workspaceId: snap.workspaceId });
        const page = await this.context.newPage();
        this.pages.set(to, page);
        await page.goto(`${this.url}/?label=${to}`, { waitUntil: "domcontentloaded" });
        // The last workspace left a secondary: Rust closes it (after the reply, so the
        // source can still release its sessions).
        const src = this.windows.get(label);
        if (label !== "main" && src?.booted && src.workspaceIds.length === 0) setTimeout(() => this.retire(label), 50);
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
