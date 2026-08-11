import { beforeEach, describe, expect, it, vi } from "vitest";

// Terminal.tsx pulls in xterm + the Tauri IPC surface on import. The scheme
// allowlist under test is pure, so the IPC edges are stubbed the same way
// PaneView.test.ts does it; the xterm addons now resolve for real (the
// @xterm/addon-ligatures alias in vite.config.ts).
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()), openPath: vi.fn(() => Promise.resolve()), revealItemInDir: vi.fn() }));

const { openUrl } = await import("@tauri-apps/plugin-opener");
const { useUI } = await import("./ui");
const { openTerminalUrl, publishPaneProgress, paneProgressList } = await import("./Terminal");

const toasts = () => useUI.getState().toasts;

beforeEach(() => {
  vi.mocked(openUrl).mockClear();
  useUI.setState({ toasts: [] });
});

// The only URLs a pane can produce are the linkifier's http/https matches and
// OSC 8 hyperlinks, and an OSC 8 URI is whatever the child process printed —
// so this is an allowlist, and openUrl is the OS shell on the other side.
describe("openTerminalUrl allowlist", () => {
  it("opens http and https, case-insensitively", () => {
    for (const uri of [
      "http://example.com",
      "https://example.com/path?q=1#frag",
      "HTTPS://EXAMPLE.COM",
    ]) {
      openTerminalUrl(uri);
    }
    expect(vi.mocked(openUrl).mock.calls.map((c) => c[0])).toEqual([
      "http://example.com",
      "https://example.com/path?q=1#frag",
      "HTTPS://EXAMPLE.COM",
    ]);
    expect(toasts()).toHaveLength(0);
  });

  it("blocks every scheme that isn't http(s)", () => {
    for (const uri of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "file:///C:/Windows/System32/calc.exe",
      "data:text/html,<script>alert(1)</script>",
      "mailto:someone@example.com",
      "ms-msdt:/id PCWDiagnostic",
      "vbscript:msgbox(1)",
      "//example.com/protocol-relative",
      "C:\\Windows\\System32\\calc.exe",
      "\\\\server\\share\\payload.exe",
      "example.com",
      "",
      " https://example.com",
    ]) {
      openTerminalUrl(uri);
    }
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("says why instead of failing silently, and quotes the URI back", () => {
    openTerminalUrl("javascript:alert(1)");
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].kind).toBe("error");
    expect(toasts()[0].text).toMatch(/only http and https/i);
    expect(toasts()[0].detail).toBe("javascript:alert(1)");
  });

  it("caps the quoted URI so a pathological OSC 8 URI can't blow up the toast", () => {
    const long = `javascript:${"a".repeat(1000)}`;
    openTerminalUrl(long);
    expect(toasts()[0].detail).toHaveLength(300);
  });
});

// QL-782: the store the OSC 9;4 parse publishes into, and Notifications reads
// to drive the one taskbar progress bar the shell gives the app.
describe("pane progress store (QL-782)", () => {
  beforeEach(() => {
    for (const p of paneProgressList()) publishPaneProgress(p.paneId, null);
  });

  it("keeps one entry per pane, last reading wins", () => {
    publishPaneProgress(1, { state: "normal", percent: 10 });
    publishPaneProgress(2, { state: "normal", percent: 40 });
    publishPaneProgress(1, { state: "normal", percent: 55 });
    expect(paneProgressList()).toEqual([
      { paneId: 1, state: "normal", percent: 55 },
      { paneId: 2, state: "normal", percent: 40 },
    ]);
  });

  it("clamps a percentage the child made up", () => {
    publishPaneProgress(1, { state: "normal", percent: 300 });
    publishPaneProgress(2, { state: "normal", percent: -5 });
    publishPaneProgress(3, { state: "normal", percent: Number.NaN });
    expect(paneProgressList().map((p) => p.percent)).toEqual([100, 0, 0]);
  });

  it("null removes the pane — that's the clear, the exit and the unmount path", () => {
    publishPaneProgress(1, { state: "normal", percent: 10 });
    publishPaneProgress(1, null);
    expect(paneProgressList()).toEqual([]);
  });

  // Progress can be parsed out of output that arrives before pty_spawn's id
  // round-trips back; attributing it to pane 0 would strand an entry no exit
  // or unmount could ever clear.
  it("ignores a reading with no pane id yet", () => {
    publishPaneProgress(0, { state: "normal", percent: 50 });
    expect(paneProgressList()).toEqual([]);
  });

  it("hands back a stable identity while nothing changes, so readers don't re-render", () => {
    publishPaneProgress(1, { state: "normal", percent: 10 });
    const first = paneProgressList();
    publishPaneProgress(1, { state: "normal", percent: 10 });
    expect(paneProgressList()).toBe(first);
    publishPaneProgress(1, { state: "normal", percent: 11 });
    expect(paneProgressList()).not.toBe(first);
  });
});
