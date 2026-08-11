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
const {
  openTerminalUrl, publishPaneProgress, paneProgressList, parseShellMarks, normalizeReportedCwd, nextMarkLine,
  hintLabels, hintTargets, hintCopyText, stickyMarkLine,
} = await import("./Terminal");

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

// QL-752/753/757: the OSC 133 / OSC 9;9 parse. The fixtures below are the
// literal bytes a real pwsh emitted with the injected integration
// (src-tauri/src/shellmarks.rs) dot-sourced — captured from a piped session,
// not hand-written, so the parser is tested against what the shell actually
// prints rather than against the spec as remembered.
const ESC = "\x1b";
const BEL = "\x07";
const promptCycle = (cwd: string) => `${ESC}]133;A${BEL}${ESC}]9;9;${cwd}${BEL}PS ${cwd}> ${ESC}]133;B${BEL}${ESC}]133;C${BEL}`;

describe("parseShellMarks (QL-753)", () => {
  it("reads a whole command cycle out of one chunk", () => {
    const chunk = `${promptCycle("C:\\repo")}"hello"\r\nhello\r\n${ESC}]133;D;0${BEL}`;
    const { events } = parseShellMarks(chunk);
    expect(events).toEqual([
      { kind: "prompt" },
      { kind: "cwd", cwd: "C:\\repo" },
      { kind: "input" },
      { kind: "output" },
      { kind: "done", exit: 0 },
    ]);
  });

  it("carries the exit code of a failed command", () => {
    const { events } = parseShellMarks(`${ESC}]133;D;3${BEL}`);
    expect(events).toEqual([{ kind: "done", exit: 3 }]);
  });

  // The shell reports a bare `133;D` when the user just pressed Enter (or hit
  // Ctrl+C) — nothing ran, so there is no status to paint.
  it("reports a finish with no exit code when nothing ran", () => {
    const { events } = parseShellMarks(`${ESC}]133;D${BEL}`);
    expect(events).toEqual([{ kind: "done" }]);
  });

  it("accepts ST-terminated sequences as well as BEL", () => {
    const { events } = parseShellMarks(`${ESC}]133;A${ESC}\\${ESC}]133;D;1${ESC}\\`);
    expect(events).toEqual([{ kind: "prompt" }, { kind: "done", exit: 1 }]);
  });

  // The PTY splits on byte counts, not sequence boundaries: an exit code
  // routinely lands in the next event. Without the carry the mark is lost and
  // the command never gets a status.
  it("stitches a sequence split across chunks", () => {
    const whole = `out\r\n${ESC}]133;D;7${BEL}${ESC}]133;A${BEL}`;
    for (let cut = 1; cut < whole.length; cut++) {
      const first = parseShellMarks(whole.slice(0, cut));
      const second = parseShellMarks(whole.slice(cut), first.carry);
      expect([...first.events, ...second.events], `split at ${cut}`).toEqual([
        { kind: "done", exit: 7 },
        { kind: "prompt" },
      ]);
      expect(second.carry).toBe("");
    }
  });

  it("keeps no carry for ordinary output, and caps a pathological one", () => {
    expect(parseShellMarks("just some output\r\n").carry).toBe("");
    // An unterminated OSC longer than the cap is not a mark we'd have parsed;
    // holding it would grow without bound on a binary-ish stream.
    expect(parseShellMarks(`${ESC}]${"9".repeat(600)}`).carry).toBe("");
  });

  it("ignores the OSC 9;4 progress sequences that share the 9 prefix", () => {
    const { events } = parseShellMarks(`${ESC}]9;4;1;40${BEL}${ESC}]133;A${BEL}`);
    expect(events).toEqual([{ kind: "prompt" }]);
  });
});

describe("normalizeReportedCwd (QL-757)", () => {
  it("takes a plain Windows path as-is", () => {
    expect(normalizeReportedCwd("C:\\Dev\\ai")).toBe("C:\\Dev\\ai");
  });
  it("unwraps Windows Terminal's quoted form", () => {
    expect(normalizeReportedCwd('"C:\\Dev\\ai"')).toBe("C:\\Dev\\ai");
  });
  it("decodes the file:// form other shells emit", () => {
    expect(normalizeReportedCwd("file://host/C:/Dev/my%20repo")).toBe("C:\\Dev\\my repo");
  });
  it("leaves a posix cwd alone — WSL and git-bash panes are not Windows paths", () => {
    expect(normalizeReportedCwd("/home/balu/dev")).toBe("/home/balu/dev");
  });
});

describe("nextMarkLine (QL-753 Ctrl+Up / Ctrl+Down)", () => {
  const lines = [3, 40, 120];
  it("finds the next mark below the viewport top", () => {
    expect(nextMarkLine(lines, 3, 1)).toBe(40);
    expect(nextMarkLine(lines, 39, 1)).toBe(40);
  });
  it("finds the nearest mark above it", () => {
    expect(nextMarkLine(lines, 120, -1)).toBe(40);
    expect(nextMarkLine(lines, 41, -1)).toBe(40);
  });
  // Better to stay put than to yank the pane to an end the user didn't ask for.
  it("returns null at either end and with no marks at all", () => {
    expect(nextMarkLine(lines, 120, 1)).toBeNull();
    expect(nextMarkLine(lines, 3, -1)).toBeNull();
    expect(nextMarkLine([], 10, 1)).toBeNull();
  });
  it("does not care what order the marks arrived in", () => {
    expect(nextMarkLine([120, 3, 40], 10, 1)).toBe(40);
  });
});

// QL-755: what gets pinned at the top of a scrolled-back pane.
describe("stickyMarkLine (QL-755)", () => {
  const lines = [3, 40, 120];
  it("pins the nearest command mark above the viewport top", () => {
    expect(stickyMarkLine(lines, 60)).toBe(40);
    expect(stickyMarkLine(lines, 121)).toBe(120);
  });
  // The prompt IS the top visible row — pinning a duplicate of a line already
  // on screen reads as a rendering fault, not a feature.
  it("pins nothing when the owning prompt is the top visible row", () => {
    expect(stickyMarkLine(lines, 40)).toBe(3);
    expect(stickyMarkLine([40], 40)).toBeNull();
  });
  it("pins nothing above the first mark, or with no marks at all", () => {
    expect(stickyMarkLine(lines, 3)).toBeNull();
    expect(stickyMarkLine(lines, 0)).toBeNull();
    expect(stickyMarkLine([], 500)).toBeNull();
  });
});

// QL-754: the labelling half of quick-select hints. The overlay itself needs a
// live xterm; everything that decides WHAT a keystroke means is here.
describe("hintLabels (QL-754)", () => {
  it("uses one home-row letter while there are few enough targets", () => {
    expect(hintLabels(3)).toEqual(["a", "s", "d"]);
  });

  // The whole reason labels are fixed-width: no label may be a prefix of
  // another, or typing "a" would have to wait to find out if "as" was coming.
  it("never lets one label prefix another", () => {
    for (const n of [1, 9, 26, 27, 200]) {
      const labels = hintLabels(n);
      expect(new Set(labels.map((l) => l.length)).size).toBe(1);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("switches the whole set to two characters once one row isn't enough", () => {
    const labels = hintLabels(30);
    expect(labels).toHaveLength(30);
    expect(labels[0]).toBe("aa");
    expect(labels.every((l) => l.length === 2)).toBe(true);
  });

  it("stops rather than inventing a third character on an absurd screen", () => {
    expect(hintLabels(5000)).toHaveLength(26 * 26);
  });
});

describe("hintTargets (QL-754)", () => {
  it("labels every linkifier match, top-to-bottom then left-to-right", () => {
    const targets = hintTargets([
      "see src/App.tsx:42 and https://example.com/docs",
      "",
      "  D:\\repo\\notes.md",
    ]);
    expect(targets.map((t) => [t.label, t.row, t.match.raw])).toEqual([
      ["a", 0, "src/App.tsx"],
      ["s", 0, "https://example.com/docs"],
      ["d", 2, "D:\\repo\\notes.md"],
    ]);
  });

  it("carries the column so a chip can be placed on the character it labels", () => {
    const [first] = hintTargets(["error in src/store.ts:9"]);
    expect(first.match.start).toBe("error in ".length);
    expect(first.match.line).toBe(9);
  });

  it("finds nothing in ordinary prose — the empty state is a real one", () => {
    expect(hintTargets(["building 12 of 30, took 1.4s", "", "all good"])).toEqual([]);
  });
});

describe("hintCopyText (QL-754)", () => {
  it("keeps a path's :line suffix — that's what makes it worth pasting", () => {
    const [t] = hintTargets(["at src/App.tsx:42 here"]);
    expect(hintCopyText(t.match)).toBe("src/App.tsx:42");
  });
  it("drops the quotes the output happened to wrap a path in", () => {
    const [t] = hintTargets([`opening "D:\\my repo\\a.txt" now`]);
    expect(hintCopyText(t.match)).toBe("D:\\my repo\\a.txt");
  });
  it("copies a URL verbatim", () => {
    const [t] = hintTargets(["docs at https://example.com/a?b=1"]);
    expect(hintCopyText(t.match)).toBe("https://example.com/a?b=1");
  });
});
