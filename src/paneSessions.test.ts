import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

// The vitest env is node (no DOM), so the few DOM calls the registry makes
// (appendChild / parent tracking / contains / rect) are faked.
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
const applog = await import("./applog");
const ps = await import("./paneSessions");
const { closePaneWithCleanup, closeWorkspaceWithCleanup } = await import("./worktrees");

// xterm cannot run under vitest, so the session is a hand-built stand-in that
// exposes exactly what the registry touches. Reparenting, WebGL and focus are
// covered for real by e2e/reflow-keeps-agents.mjs.
function fakeSession(modelId: number, gen: string, spec: { vendor: string }, container: HTMLElement) {
  const host = document.createElement("div") as HTMLDivElement;
  container.appendChild(host);
  const disposers = [vi.fn(), vi.fn()];
  const term = {
    dispose: vi.fn(),
    refresh: vi.fn(),
    focus: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    rows: 24,
    buffer: { active: { viewportY: 3, baseY: 10 } },
  };
  const s = {
    modelId, gen, term, host, fit: { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) }, search: {}, serialize: null, ligatures: null, ptyId: 40 + modelId,
    handlers: {}, live: {}, theme: { current: {} },
    api: { jumpMark: () => false, showHints: () => false, remeasure: () => {}, onAttach: vi.fn() },
    owner: null, saved: { viewportY: 0, atBottom: true, hadFocus: false }, disposers, disposed: false,
    _vendor: spec.vendor,
  };
  return s as unknown as import("./paneSessions").PaneSession & { _vendor: string };
}

const spec = (over: Partial<import("./paneSessions").SpawnSpec> = {}): import("./paneSessions").SpawnSpec => ({
  vendor: "claude", cwd: "C:\\repo", epoch: 0, fontSize: 12, osc52: false, quietMs: 3000, ...over,
});

let container: HTMLElement;
let created = 0;
beforeEach(() => {
  ps._resetForTests();
  created = 0;
  vi.mocked(invoke).mockClear();
  body.children.splice(0);
  container = document.createElement("div") as unknown as HTMLElement;
  (body as unknown as { appendChild(c: unknown): void }).appendChild(container);
  ps.setSessionFactory((id, gen, sp, _h, c) => { created++; return fakeSession(id, gen, sp, c); });
});

const kills = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "pty_kill");

describe("paneSessions", () => {
  it("acquire is idempotent per (modelId, gen): a second mount reuses the session", () => {
    const a = ps.acquire(1, spec(), {}, container);
    const b = ps.acquire(1, spec(), { onBell: () => {} }, container);
    expect(b).toBe(a);
    expect(created).toBe(1);
    expect(b.handlers.onBell).toBeTypeOf("function"); // handlers refreshed
    expect(kills()).toHaveLength(0);
  });

  it("dispose kills the pty once, tears down, and is idempotent", () => {
    const s = ps.acquire(1, spec(), {}, container);
    ps.dispose(1);
    ps.dispose(1);
    expect(kills()).toEqual([["pty_kill", { paneId: 41 }]]);
    expect(s.term.dispose).toHaveBeenCalledTimes(1);
    expect(ps.get(1)).toBeUndefined();
  });

  it("dispose runs every disposer before the kill", () => {
    const s = ps.acquire(1, spec(), {}, container);
    const [d1, d2] = s.disposers as unknown as ReturnType<typeof vi.fn>[];
    ps.dispose(1);
    expect(d1).toHaveBeenCalledTimes(1);
    expect(d2).toHaveBeenCalledTimes(1);
  });

  it("a gen change (restart, vendor or cwd change) disposes the old session and creates a new one", () => {
    const a = ps.acquire(1, spec({ epoch: 0 }), {}, container);
    const b = ps.acquire(1, spec({ epoch: 1 }), {}, container);
    expect(b).not.toBe(a);
    expect(created).toBe(2);
    expect(kills()).toEqual([["pty_kill", { paneId: 41 }]]);
    ps.acquire(1, spec({ epoch: 1, cwd: "C:\\other" }), {}, container);
    expect(kills()).toHaveLength(2);
  });

  it("detach never kills, and a stale token is ignored", () => {
    const s = ps.acquire(1, spec(), {}, container);
    const t1 = ps.attach(1, container)!;
    const other = document.createElement("div") as unknown as HTMLElement;
    document.body.appendChild(other);
    const t2 = ps.attach(1, other)!; // the new owner attaches first
    ps.detach(1, t1); // the old owner's cleanup arrives late: ignored
    expect(s.host.parentElement).toBe(other);
    ps.detach(1, t2);
    expect(s.host.parentElement?.id).toBe("fd-term-park");
    expect(s.host.isConnected).toBe(true); // parked, not destroyed
    expect(kills()).toHaveLength(0);
    expect(s.term.dispose).not.toHaveBeenCalled();
  });

  it("attach moves the same host node and restores focus only if it had it", () => {
    const s = ps.acquire(1, spec(), {}, container);
    const host = s.host;
    const t = ps.attach(1, container)!;
    ps.detach(1, t);
    s.saved.hadFocus = true;
    const other = document.createElement("div") as unknown as HTMLElement;
    document.body.appendChild(other);
    ps.attach(1, other);
    expect(s.host).toBe(host);
    expect(host.parentElement).toBe(other);
    expect(s.term.focus).toHaveBeenCalledTimes(1);
    expect(s.api.onAttach).toHaveBeenCalled();
  });

  it("sweepOrphans disposes a session whose pane left the store, and logs it", () => {
    applog._resetForTests();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    ps.acquire(1, spec(), {}, container);
    ps.acquire(2, spec(), {}, container);
    ps.sweepOrphans(new Set([2]));
    expect(ps.get(1)).toBeUndefined();
    expect(ps.get(2)).toBeDefined();
    expect(kills()).toEqual([["pty_kill", { paneId: 41 }]]);
    const logged = vi.mocked(invoke).mock.calls.filter(([c]) => c === "log_event");
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0][1])).toContain("missed close path");
    vi.unstubAllGlobals();
    vi.stubGlobal("document", { createElement: () => new FakeEl(), body, activeElement: null });
  });

  it("removing a pane straight from the store disposes its session (safety net)", () => {
    const pane = { id: 7, vendor: "claude", cwd: "C:\\repo", state: "idle" as const, epoch: 0 };
    useApp.setState({ workspaces: [{ id: 1, name: "w", root: "C:\\repo", panes: [pane], focused: 7 } as never] });
    ps.acquire(7, spec(), {}, container);
    useApp.setState({ workspaces: [{ id: 1, name: "w", root: "C:\\repo", panes: [], focused: null } as never] });
    expect(ps.get(7)).toBeUndefined();
    expect(kills()).toEqual([["pty_kill", { paneId: 47 }]]);
  });

  describe("release / detach / adopt (Phase 4 move)", () => {
    const mkPane = (id: number) => ({ id, vendor: "claude", cwd: "C:\repo", state: "idle" as const, epoch: 0 });
    const seedWs = (ids: number[]) => {
      useApp.setState({ workspaces: [{ id: 1, name: "w", root: "C:\repo", panes: ids.map(mkPane), focused: ids[0] } as never], activeId: 1 });
      for (const id of ids) ps.acquire(id, spec(), {}, container);
    };

    it("release tears down without pty_kill and is idempotent", () => {
      const s = ps.acquire(1, spec(), {}, container);
      ps.release(1);
      ps.release(1);
      expect(kills()).toHaveLength(0);
      expect(s.term.dispose).toHaveBeenCalledTimes(1);
      expect(s.disposers).toHaveLength(0);
      expect(ps.get(1)).toBeUndefined();
    });

    it("releaseWorkspace then detach never calls pty_kill; the sweep finds nothing", () => {
      seedWs([1, 2]);
      const ws = ps.releaseWorkspace(1);
      expect(ws?.panes.map((p) => p.id)).toEqual([1, 2]);
      expect(useApp.getState().workspaces).toHaveLength(0);
      expect(ps.size()).toBe(0);
      expect(kills()).toHaveLength(0);
    });

    it("the sweep still disposes a genuine orphan alongside a released workspace", () => {
      seedWs([1, 2]);
      ps.acquire(9, spec(), {}, container); // not in any workspace
      ps.releaseWorkspace(1);
      expect(kills()).toEqual([["pty_kill", { paneId: 49 }]]);
    });

    it("adopt of a detached workspace re-adds it with the same pane ids", () => {
      seedWs([1, 2]);
      const ws = ps.releaseWorkspace(1)!;
      useApp.getState().adoptWorkspace(ws);
      const back = useApp.getState().workspaces;
      expect(back).toHaveLength(1);
      expect(back[0].panes.map((p) => p.id)).toEqual([1, 2]);
      expect(useApp.getState().activeId).toBe(1);
      expect(kills()).toHaveLength(0);
    });
  });

  describe("close funnels", () => {
    const mkPane = (id: number) => ({ id, vendor: "claude", cwd: "C:\repo", state: "idle" as const, epoch: 0 });
    const seed = (ids: number[]) => {
      useApp.setState({ workspaces: [{ id: 1, name: "w", root: "C:\repo", panes: ids.map(mkPane), focused: ids[0] } as never] });
      for (const id of ids) ps.acquire(id, spec(), {}, container);
    };

    it("closing a pane kills exactly that pane's pty", () => {
      seed([1, 2, 3]);
      closePaneWithCleanup(1, mkPane(2));
      expect(kills()).toEqual([["pty_kill", { paneId: 42 }]]);
      expect(ps.get(1)).toBeDefined();
      expect(ps.get(3)).toBeDefined();
    });

    it("closing a workspace kills one pty per pane", () => {
      seed([1, 2, 3]);
      closeWorkspaceWithCleanup({ id: 1, panes: [mkPane(1), mkPane(2), mkPane(3)] });
      expect(kills().map(([, a]) => (a as { paneId: number }).paneId).sort()).toEqual([41, 42, 43]);
    });
  });
});

describe("fitIfSane", () => {
  const mk = (d: { cols: number; rows: number } | undefined) => ({ fit: vi.fn(), proposeDimensions: () => d });
  it("fits only when the proposed size is sane", async () => {
    const ps = await import("./paneSessions");
    const ok = mk({ cols: 80, rows: 24 });
    expect(ps.fitIfSane(ok)).toBe(true);
    expect(ok.fit).toHaveBeenCalledTimes(1);
    for (const d of [{ cols: 2, rows: 47 }, { cols: 13, rows: 5 }, { cols: 80, rows: 2 }, undefined]) {
      const bad = mk(d);
      expect(ps.fitIfSane(bad)).toBe(false);
      expect(bad.fit).not.toHaveBeenCalled();
    }
  });
});
