import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

// Same node-env DOM stand-ins as paneSessions.test.ts: the registry only touches
// appendChild / remove / contains / rect.
class FakeEl {
  id = "";
  style = { cssText: "" };
  parentElement: FakeEl | null = null;
  children: FakeEl[] = [];
  get isConnected(): boolean {
    for (let n: FakeEl | null = this; n; n = n.parentElement) if (n === body) return true;
    return false;
  }
  appendChild(c: FakeEl) { c.parentElement?.removeChild(c); c.parentElement = this; this.children.push(c); return c; }
  removeChild(c: FakeEl) { this.children = this.children.filter((x) => x !== c); c.parentElement = null; }
  remove() { this.parentElement?.removeChild(this); }
  contains(n: FakeEl | null): boolean { return !!n && (n === this || this.children.some((c) => c.contains(n))); }
  setAttribute() {}
  getBoundingClientRect() { return { width: 800, height: 600 }; }
}
const body = new FakeEl();
vi.stubGlobal("document", { createElement: () => new FakeEl(), body, activeElement: null });

const { invoke } = await import("@tauri-apps/api/core");
const { useApp } = await import("./store");
const { useUI } = await import("./ui");
const ps = await import("./paneSessions");
const { moveWorkspaceToNewWindow, moveWorkspaceToWindow } = await import("./windowMove");

const log: string[] = [];
let ptyOf: Record<number, number> = {};
let snapshotOf: (modelId: number, seq: number) => Promise<{ serialized: string; cols: number; rows: number } | null>;

function fakeSession(modelId: number, gen: string, container: HTMLElement) {
  const host = document.createElement("div") as HTMLDivElement;
  container.appendChild(host);
  const s = {
    modelId, gen, host, fit: {}, search: {}, serialize: null, ligatures: null, ptyId: ptyOf[modelId] ?? 0,
    term: { dispose: vi.fn(), cols: 100, rows: 30 },
    handlers: {}, live: {}, theme: { current: {} },
    api: {
      jumpMark: () => false, showHints: () => false, remeasure: () => {}, onAttach: () => {},
      snapshot: (seq: number) => { log.push(`snapshot:${modelId}`); return snapshotOf(modelId, seq); },
    },
    owner: null, saved: { viewportY: 0, atBottom: true, hadFocus: false },
    disposers: [() => { log.push(`release:${modelId}`); }], disposed: false,
  };
  return s as unknown as import("./paneSessions").PaneSession;
}

const spec = { vendor: "claude", cwd: "C:\\repo", epoch: 0, fontSize: 12, osc52: false, quietMs: 3000 };
let container: HTMLElement;
let unsub: () => void = () => {};

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  ps._resetForTests();
  log.length = 0;
  ptyOf = { 1: 41, 2: 42 };
  snapshotOf = async (id, seq) => ({ serialized: `screen-${id}@${seq}`, cols: 100, rows: 30 });
  handlers = {
    pane_pause: (a) => (a.modelId as number) * 1000,
    ws_transfer: () => "fw-1",
  };
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
    log.push(`invoke:${cmd}${args && "modelId" in args ? `:${args.modelId}` : ""}`);
    try { return Promise.resolve(handlers[cmd]?.(args ?? {})); } catch (e) { return Promise.reject(e); }
  }) as never);
  body.children.splice(0);
  container = document.createElement("div") as unknown as HTMLElement;
  (body as unknown as { appendChild(c: unknown): void }).appendChild(container);
  ps.setSessionFactory((id, gen, _sp, _h, c) => fakeSession(id, gen, c));
  useUI.setState({ toasts: [] } as never);
  useApp.setState({
    workspaces: [
      { id: 7, name: "acme", root: "C:\\repo", focused: 1, panes: [
        { id: 1, vendor: "claude", cwd: "C:\\repo", state: "running", epoch: 0 },
        { id: 2, vendor: "pwsh", cwd: "C:\\repo", state: "running", epoch: 0 },
      ] },
      { id: 8, name: "other", root: "C:\\other", focused: null, panes: [] },
    ],
    activeId: 7,
  });
  for (const p of useApp.getState().workspaces[0].panes) ps.acquire(p.id, { ...spec, vendor: p.vendor }, {}, container);
  log.length = 0; // the acquires above are setup, not the move
  unsub = useApp.subscribe((s) => { if (!s.workspaces.some((w) => w.id === 7) && !log.includes("detach")) log.push("detach"); });
});
afterEach(() => unsub());

describe("moveWorkspaceToNewWindow", () => {
  it("pauses, serialises, transfers, then releases and detaches, in that order and without a kill", async () => {
    const r = await moveWorkspaceToNewWindow(7);
    expect(r).toEqual({ ok: true, label: "fw-1" });
    expect(log).toEqual([
      "invoke:pane_pause:1", "invoke:pane_pause:2",
      "snapshot:1", "snapshot:2",
      "invoke:ws_transfer",
      "release:1", "release:2",
      "detach",
    ]);
    expect(calls("pty_kill")).toHaveLength(0);
    expect(useApp.getState().workspaces.map((w) => w.id)).toEqual([8]);
    expect(ps.size()).toBe(0);
  });

  it("hands the target each pane's screen with the seq pane_pause returned", async () => {
    await moveWorkspaceToNewWindow(7);
    const args = calls("ws_transfer")[0][1] as { wsSnapshot: { workspaceId: number; transfer: { workspace: { id: number }; panes: Record<number, unknown> }; slice: { workspaces: { id: number }[]; activeWorkspaceId: number } }; target: unknown };
    expect(args.target).toEqual({ kind: "new" });
    expect(args.wsSnapshot.workspaceId).toBe(7);
    expect(args.wsSnapshot.transfer.workspace.id).toBe(7);
    expect(args.wsSnapshot.transfer.panes).toEqual({
      1: { serialized: "screen-1@1000", seq: 1000, cols: 100, rows: 30 },
      2: { serialized: "screen-2@2000", seq: 2000, cols: 100, rows: 30 },
    });
    expect(args.wsSnapshot.slice.workspaces.map((w) => w.id)).toEqual([7]);
    expect(args.wsSnapshot.slice.activeWorkspaceId).toBe(7);
  });

  it("a pane that cannot be serialised moves with serialized null (the target replays the ring)", async () => {
    snapshotOf = async (id, seq) => (id === 1 ? null : { serialized: `s${seq}`, cols: 90, rows: 20 });
    await moveWorkspaceToNewWindow(7);
    const t = (calls("ws_transfer")[0][1] as { wsSnapshot: { transfer: { panes: Record<number, { serialized: string | null; cols: number }> } } }).wsSnapshot.transfer.panes;
    expect(t[1].serialized).toBeNull();
    expect(t[1].cols).toBe(100); // falls back to the live terminal size
    expect(t[2].serialized).toBe("s2000");
  });

  it("refuses while a pane's pty_spawn is still in flight: nothing paused, nothing released", async () => {
    ps.get(2)!.ptyId = 0;
    const r = await moveWorkspaceToNewWindow(7);
    expect(r.ok).toBe(false);
    expect(log).toEqual([]);
    expect(useApp.getState().workspaces.map((w) => w.id)).toContain(7);
    expect(useUI.getState().toasts.some((t: { text: string }) => /still starting/.test(t.text))).toBe(true);
  });

  it("a failed ws_transfer resumes every paused pane and leaves the workspace where it was", async () => {
    handlers.ws_transfer = () => { throw new Error("no window for you"); };
    const r = await moveWorkspaceToNewWindow(7);
    expect(r.ok).toBe(false);
    expect(log.filter((l) => l.startsWith("invoke:pane_resume"))).toEqual(["invoke:pane_resume:1", "invoke:pane_resume:2"]);
    expect(log.some((l) => l.startsWith("release:") || l === "detach")).toBe(false);
    expect(useApp.getState().workspaces.map((w) => w.id)).toContain(7);
    expect(ps.size()).toBe(2);
  });

  it("a pane added during the snapshot drain aborts the move: everything paused is resumed, nothing released", async () => {
    snapshotOf = async (id, seq) => {
      if (id === 2) {
        useApp.setState((s) => ({
          workspaces: s.workspaces.map((w) => (w.id === 7 ? { ...w, panes: [...w.panes, { id: 3, vendor: "pwsh", cwd: "C:\repo", state: "starting", epoch: 0 }] } : w)),
        }));
      }
      return { serialized: `screen-${id}@${seq}`, cols: 100, rows: 30 };
    };
    const r = await moveWorkspaceToNewWindow(7);
    expect(r.ok).toBe(false);
    expect(calls("ws_transfer")).toHaveLength(0);
    expect(log.filter((l) => l.startsWith("invoke:pane_resume"))).toEqual(["invoke:pane_resume:1", "invoke:pane_resume:2"]);
    expect(log.some((l) => l.startsWith("release:") || l === "detach")).toBe(false);
    expect(useApp.getState().workspaces.map((w) => w.id)).toContain(7);
    expect(ps.size()).toBe(2);
    expect(useUI.getState().toasts.some((t: { text: string }) => /changed|still starting/.test(t.text))).toBe(true);
  });

  const addPane3During = () => {
    handlers.ws_transfer = () => {
      useApp.setState((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === 7 ? { ...w, panes: [...w.panes, { id: 3, vendor: "pwsh", cwd: "C:\\repo", state: "running", epoch: 0 }] } : w)),
      }));
      ptyOf[3] = 0;
      ps.acquire(3, { ...spec, vendor: "pwsh" }, {}, container);
      return "fw-1";
    };
  };

  it("a pane added during the ws_transfer await stays alive in the source (moved to another workspace), never killed", async () => {
    addPane3During();
    const r = await moveWorkspaceToNewWindow(7);
    expect(r.ok).toBe(true);
    expect(ps.get(3)?.disposed).toBe(false);
    expect(log).not.toContain("release:3");
    expect(calls("pty_kill")).toHaveLength(0);
    const ws = useApp.getState().workspaces;
    expect(ws.map((w) => w.id)).toEqual([8]);
    expect(ws[0].panes.map((p) => p.id)).toEqual([3]);
    expect(ps.size()).toBe(1);
  });

  it("with no other workspace the extra pane lands in a fresh workspace, never id 7", async () => {
    useApp.setState((s) => ({ workspaces: s.workspaces.filter((w) => w.id === 7) }));
    addPane3During();
    const r = await moveWorkspaceToNewWindow(7);
    expect(r.ok).toBe(true);
    expect(ps.get(3)?.disposed).toBe(false);
    expect(calls("pty_kill")).toHaveLength(0);
    const ws = useApp.getState().workspaces;
    expect(ws.some((w) => w.id === 7)).toBe(false);
    expect(ws).toHaveLength(1);
    expect(ws[0].panes.map((p) => p.id)).toEqual([3]);
    expect(ws[0].focused).toBe(3);
    expect(log).toContain("release:1");
    expect(log).toContain("release:2");
  });

  it("a pane whose pty went away during the drain aborts the move", async () => {
    snapshotOf = async (id, seq) => {
      if (id === 2) ps.get(1)!.ptyId = 0;
      return { serialized: `screen-${id}@${seq}`, cols: 100, rows: 30 };
    };
    const r = await moveWorkspaceToNewWindow(7);
    expect(r.ok).toBe(false);
    expect(calls("ws_transfer")).toHaveLength(0);
    expect(log.filter((l) => l.startsWith("invoke:pane_resume"))).toEqual(["invoke:pane_resume:1", "invoke:pane_resume:2"]);
    expect(ps.size()).toBe(2);
  });

  it("a pane that cannot be paused aborts the move and resumes the ones already paused", async () => {
    handlers.pane_pause = (a) => { if (a.modelId === 2) throw new Error("no live pty"); return 1000; };
    const r = await moveWorkspaceToNewWindow(7);
    expect(r.ok).toBe(false);
    expect(log).toEqual(["invoke:pane_pause:1", "invoke:pane_pause:2", "invoke:pane_resume:1"]);
    expect(calls("ws_transfer")).toHaveLength(0);
    expect(useApp.getState().workspaces.map((w) => w.id)).toContain(7);
  });

  it("moving to an existing window uses the same order and names the target label", async () => {
    handlers.ws_transfer = () => "fw-2";
    const r = await moveWorkspaceToWindow(7, "fw-2");
    expect(r).toEqual({ ok: true, label: "fw-2" });
    expect((calls("ws_transfer")[0][1] as { target: unknown }).target).toEqual({ kind: "label", label: "fw-2" });
    expect(log).toEqual([
      "invoke:pane_pause:1", "invoke:pane_pause:2",
      "snapshot:1", "snapshot:2",
      "invoke:ws_transfer",
      "release:1", "release:2",
      "detach",
    ]);
    expect(calls("pty_kill")).toHaveLength(0);
  });

  it("a refused move to a window resumes the panes and keeps the workspace", async () => {
    handlers.ws_transfer = () => { throw new Error("window fw-9 is not open"); };
    const r = await moveWorkspaceToWindow(7, "fw-9");
    expect(r.ok).toBe(false);
    expect(log.filter((l) => l.startsWith("invoke:pane_resume"))).toEqual(["invoke:pane_resume:1", "invoke:pane_resume:2"]);
    expect(useApp.getState().workspaces.map((w) => w.id)).toContain(7);
  });

  it("an empty workspace moves without touching any pty", async () => {
    const r = await moveWorkspaceToNewWindow(8);
    expect(r.ok).toBe(true);
    expect(calls("pane_pause")).toHaveLength(0);
    expect(useApp.getState().workspaces.map((w) => w.id)).toEqual([7]);
  });
});
