import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "./chatlog";
import {
  RESUME_VENDOR, RESUME_VENDORS, OPEN_EVENT, DEFAULT_CONTEXT_WINDOW,
  LONG_CONTEXT_WINDOW, MIN_SEARCH_CHARS, SEARCH_DEBOUNCE_MS,
  canResume, supportsFork, listCommandFor, supportsDeepSearch, sessionWeight,
  chooseSearchPane, openSessionLauncher, resumeArgs, resumeArgsFor, modelShort,
  contextWindowFor, filterSessions, hitCwd, groupHits, highlightParts,
  folderExists, launchResume, stageResumeOfCurrentSession, setFocusModeKeepingSession,
  type ClaudeSession, type SessionSearchHit,
} from "./sessionLauncherLogic";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), addPane: vi.fn(), setPaneFocusMode: vi.fn(),
  pushToast: vi.fn(), resolveExisting: vi.fn(), paneSessionInfo: vi.fn(),
  workspaces: [] as { panes: { id: number; vendor: string; cwd: string }[] }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./store", () => ({ useApp: { getState: () => mocks } }));
vi.mock("./ui", () => ({ useUI: { getState: () => mocks } }));
vi.mock("./pathcheck", () => ({ resolveExisting: mocks.resolveExisting }));
vi.mock("./chatlog", () => ({ paneSessionInfo: mocks.paneSessionInfo }));

const pane = {
  vendor: "claude", cwd: "/repo", worktreePath: "/repo/wt",
  branch: "feature", baseBranch: "main",
};
const sessionId = "12345678-abcd-1234-abcd-123456789abc";
const info = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  session_id: sessionId, pinned: true, jsonl_path: "/transcript.jsonl",
  resume_id: sessionId, ...overrides,
});
const session = (overrides: Partial<ClaudeSession> = {}): ClaudeSession => ({
  id: "alpha-id", modifiedMs: 100, title: "Fix launcher", gitBranch: "feature/resume",
  model: "claude-opus-4-1-20250805", turns: 3, sizeBytes: 2048, ...overrides,
});
const hit = (overrides: Partial<SessionSearchHit> = {}): SessionSearchHit => ({
  sessionId: "alpha", cwd: "/repo", timestampMs: 100, role: "user",
  snippet: "launcher", sessionHits: 5, ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspaces = [];
  mocks.invoke.mockResolvedValue(undefined);
  mocks.paneSessionInfo.mockResolvedValue(info());
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  // Presence, rather than the value, is the host detection contract.
  Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
});
afterEach(() => vi.unstubAllGlobals());

describe("launcher constants and vendor gates", () => {
  it("publishes the launcher constants", () => {
    expect(RESUME_VENDOR).toBe("claude");
    expect(RESUME_VENDORS).toEqual(["claude", "codex"]);
    expect(OPEN_EVENT).toBe("flightdeck:session-launcher");
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000);
    expect(LONG_CONTEXT_WINDOW).toBe(1_000_000);
    expect(MIN_SEARCH_CHARS).toBe(2);
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
  });
  it.each([
    ["claude", true, true, true], ["codex", true, false, false],
    ["pwsh", false, false, false], ["", false, false, false],
  ])("gates resume, fork and deep search for %s", (vendor, resume, fork, deep) => {
    expect(canResume(vendor)).toBe(resume);
    expect(supportsFork(vendor)).toBe(fork);
    expect(supportsDeepSearch(vendor)).toBe(deep);
  });
  it("selects the vendor list command", () => {
    expect(listCommandFor("claude")).toBe("list_claude_sessions");
    expect(listCommandFor("codex")).toBe("list_codex_sessions");
  });
});

describe("session presentation and selection", () => {
  it("shows exact turns or transcript size", () => {
    expect(sessionWeight({ turns: 0, sizeBytes: 2048 })).toBe("0 turns");
    expect(sessionWeight({ turns: 1, sizeBytes: 2048 })).toBe("1 turn");
    expect(sessionWeight({ turns: 3, sizeBytes: 2048 })).toBe("3 turns");
    expect(sessionWeight({ turns: null, sizeBytes: 2048 })).toBe("2 KB transcript");
  });
  it("prefers a focused searchable pane then the first searchable pane", () => {
    const panes = [{ id: 1, vendor: "codex" }, { id: 2, vendor: "claude" }, { id: 3, vendor: "claude" }];
    expect(chooseSearchPane(panes, 3)).toBe(panes[2]);
    expect(chooseSearchPane(panes, 1)).toBe(panes[1]);
    expect(chooseSearchPane(panes, 99)).toBe(panes[1]);
    expect(chooseSearchPane(panes)).toBe(panes[1]);
    expect(chooseSearchPane([panes[0]], 1)).toBeUndefined();
    expect(chooseSearchPane([])).toBeUndefined();
  });
  it("dispatches launcher details with optional search mode", () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("CustomEvent", class extends Event {
      readonly detail: unknown;
      constructor(type: string, options: { detail: unknown }) {
        super(type);
        this.detail = options.detail;
      }
    });
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener(OPEN_EVENT, listener);
    try {
      openSessionLauncher(42, { search: true });
      openSessionLauncher();
      expect(events).toEqual([{ paneId: 42, search: true }, { paneId: undefined }]);
    } finally {
      window.removeEventListener(OPEN_EVENT, listener);
    }
  });
  it("builds resume and fork arguments for each vendor", () => {
    expect(resumeArgs(sessionId, false)).toEqual(["--resume", sessionId]);
    expect(resumeArgs(sessionId, true)).toEqual(["--resume", sessionId, "--fork-session"]);
    expect(resumeArgsFor("claude", sessionId, false)).toEqual(["--resume", sessionId]);
    expect(resumeArgsFor("claude", sessionId, true)).toEqual(["--resume", sessionId, "--fork-session"]);
    for (const fork of [false, true]) {
      expect(resumeArgsFor("codex", sessionId, fork)).toEqual(["resume", sessionId]);
    }
  });
  it.each([
    [null, ""], [undefined, ""], ["", ""],
    ["claude-opus-4-1-20250805", "opus 4.1"],
    ["claude-3-5-haiku-20241022", "haiku 3.5"],
    ["CLAUDE_SONNET_4_6", "sonnet 4.6"], ["claude-fable", "fable"],
    ["claude-unknown-20250805", "unknown"],
  ])("shortens model %s", (model, expected) => expect(modelShort(model)).toBe(expected));
  it("uses reported windows and model context boundaries", () => {
    expect(contextWindowFor("claude-opus-4-6", 128_000)).toBe(128_000);
    for (const reported of [undefined, null, 0, -1]) {
      expect(contextWindowFor(null, reported)).toBe(200_000);
    }
    for (const model of ["claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5", "unknown"]) {
      expect(contextWindowFor(model)).toBe(200_000);
    }
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable", "claude-opus-4-1[1m]", "claude-sonnet-4-5-1m"]) {
      expect(contextWindowFor(model)).toBe(1_000_000);
    }
  });
  it("filters displayed fields case insensitively without changing order", () => {
    const first = session();
    const second = session({ id: "beta", title: "Other", gitBranch: null, model: null });
    const third = session({ id: "gamma", title: "Launcher follow-up" });
    const list = [first, second, third];
    expect(filterSessions(list, "  ")).toBe(list);
    expect(filterSessions(list, " LAUNCHER ")).toEqual([first, third]);
    for (const query of ["alpha-id", "feature/resume", "opus 4.1", "20250805"]) {
      expect(filterSessions([first, second], query)).toEqual([first]);
    }
    expect(filterSessions(list, "absent")).toEqual([]);
    expect(list).toEqual([first, second, third]);
  });
});

describe("search hits", () => {
  it("uses the hit folder with a pane folder fallback", () => {
    expect(hitCwd({ cwd: "/other" }, "/repo")).toBe("/other");
    expect(hitCwd({ cwd: "" }, "/repo")).toBe("/repo");
  });
  it("groups contiguous session hits preserving backend order and total counts", () => {
    const a = hit();
    const b = hit({ snippet: "second", timestampMs: 90 });
    const c = hit({ sessionId: "beta", cwd: "/other", sessionHits: 1 });
    const hits = [a, b, c];
    expect(groupHits(hits)).toEqual([
      { sessionId: "alpha", cwd: "/repo", hits: [a, b], count: 5 },
      { sessionId: "beta", cwd: "/other", hits: [c], count: 1 },
    ]);
    expect(hits).toEqual([a, b, c]);
    expect(groupHits([])).toEqual([]);
  });
  it("highlights literal matches preserving original text and unmatched runs", () => {
    expect(highlightParts("A cat, CAT!", " cat ")).toEqual([
      { text: "A ", hit: false }, { text: "cat", hit: true },
      { text: ", ", hit: false }, { text: "CAT", hit: true }, { text: "!", hit: false },
    ]);
    expect(highlightParts("a.b", ".")).toEqual([
      { text: "a", hit: false }, { text: ".", hit: true }, { text: "b", hit: false },
    ]);
    expect(highlightParts("catcat", "cat")).toEqual([{ text: "cat", hit: true }, { text: "cat", hit: true }]);
    expect(highlightParts("text", " ")).toEqual([{ text: "text", hit: false }]);
    expect(highlightParts("text", "absent")).toEqual([{ text: "text", hit: false }]);
    expect(highlightParts("\u0130 cat", "cat")).toEqual([{ text: "\u0130 cat", hit: false }]);
  });
  it("highlights regex matches and safely handles invalid or zero-width patterns", () => {
    expect(highlightParts("a12 B34!", "[ab]\\d+", true)).toEqual([
      { text: "a12", hit: true }, { text: " ", hit: false },
      { text: "B34", hit: true }, { text: "!", hit: false },
    ]);
    for (const pattern of ["[", "^", "", "absent"]) {
      expect(highlightParts("text", pattern, true)).toEqual([{ text: "text", hit: false }]);
    }
  });
});

describe("resume orchestration", () => {
  it("assumes folders exist in preview without querying the host", async () => {
    expect(await folderExists("/repo")).toBe(true);
    expect(mocks.resolveExisting).not.toHaveBeenCalled();
  });
  it("checks directory hits in the Tauri host", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    for (const [hits, expected] of [[[{ isDir: true }], true], [[{ isDir: false }], false], [[null], false], [[], false]] as const) {
      mocks.resolveExisting.mockResolvedValueOnce(hits);
      expect(await folderExists("/repo")).toBe(expected);
    }
    expect(mocks.resolveExisting).toHaveBeenCalledWith(["/repo"], []);
  });
  it("stages before adding a pane and preserves complete local worktree identity", async () => {
    const exists = vi.fn();
    mocks.invoke.mockImplementationOnce(async () => {
      expect(mocks.addPane).not.toHaveBeenCalled();
    });
    expect(await launchResume(7, pane, sessionId, true, undefined, exists)).toBe("ok");
    expect(mocks.invoke).toHaveBeenCalledWith("stage_launch_args", {
      vendor: "claude", cwd: "/repo", args: ["--resume", sessionId, "--fork-session"],
    });
    expect(mocks.addPane).toHaveBeenCalledWith(7, "claude", "/repo", {
      worktreePath: "/repo/wt", branch: "feature", baseBranch: "main",
    });
    expect(exists).not.toHaveBeenCalled();
  });
  it("resumes elsewhere after checking the folder without carrying worktree identity", async () => {
    const exists = vi.fn(async () => {
      expect(mocks.invoke).not.toHaveBeenCalled();
      return true;
    });
    expect(await launchResume(7, { ...pane, vendor: "codex" }, sessionId, true, "/other", exists)).toBe("ok");
    expect(exists).toHaveBeenCalledWith("/other");
    expect(mocks.invoke).toHaveBeenCalledWith("stage_launch_args", {
      vendor: "codex", cwd: "/other", args: ["resume", sessionId],
    });
    expect(mocks.addPane).toHaveBeenCalledWith(7, "codex", "/other", undefined);
  });
  it("does not carry incomplete worktree identity", async () => {
    expect(await launchResume(7, { ...pane, baseBranch: undefined }, sessionId, false)).toBe("ok");
    expect(mocks.addPane).toHaveBeenCalledWith(7, "claude", "/repo", undefined);
  });
  it("creates no pane when the override folder is missing", async () => {
    expect(await launchResume(7, pane, sessionId, false, "/missing", async () => false)).toBe("cwd-missing");
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.addPane).not.toHaveBeenCalled();
  });
  it("creates no pane when staging fails", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("refused"));
    expect(await launchResume(7, pane, sessionId, false)).toBe("stage-failed");
    expect(mocks.addPane).not.toHaveBeenCalled();
  });
  it("stages the pinned resume id with existing launch arguments", async () => {
    mocks.paneSessionInfo.mockResolvedValueOnce(info({ session_id: "different", launch_args: ["--model", "opus"] }));
    expect(await stageResumeOfCurrentSession(pane, 42)).toBe(true);
    expect(mocks.paneSessionInfo).toHaveBeenCalledWith(42);
    expect(mocks.invoke).toHaveBeenCalledWith("stage_launch_args", {
      vendor: "claude", cwd: "/repo", args: ["--model", "opus", "--resume", sessionId],
    });
    expect(mocks.pushToast).not.toHaveBeenCalled();
  });
  it("skips unsupported vendors and invalid pty ids", async () => {
    expect(await stageResumeOfCurrentSession({ ...pane, vendor: "codex" }, 42)).toBe(false);
    expect(await stageResumeOfCurrentSession(pane, 0)).toBe(false);
    expect(await stageResumeOfCurrentSession(pane, -1)).toBe(false);
    expect(mocks.paneSessionInfo).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.pushToast).not.toHaveBeenCalled();
  });
  it.each([null, undefined, "not-a-uuid"])("declines invalid resume id %s with a transcript toast", async (resume_id) => {
    expect(await stageResumeOfCurrentSession(pane, 42, async () => info({ resume_id }))).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenCalledWith("info", "Couldn't resume this pane's conversation, Claude starts fresh.");
  });
  it("silently declines a pane without a transcript or resume id", async () => {
    expect(await stageResumeOfCurrentSession(pane, 42, async () => info({ resume_id: null, jsonl_path: null }))).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.pushToast).not.toHaveBeenCalled();
  });
  it.each(["lookup", "staging"])("reports %s failure and returns false", async (failure) => {
    if (failure === "lookup") mocks.paneSessionInfo.mockRejectedValueOnce(new Error("lookup"));
    else mocks.invoke.mockRejectedValueOnce(new Error("staging"));
    expect(await stageResumeOfCurrentSession(pane, 42)).toBe(false);
    expect(mocks.pushToast).toHaveBeenCalledTimes(1);
    expect(mocks.pushToast).toHaveBeenCalledWith("info", "Couldn't resume this pane's conversation, Claude starts fresh.");
  });
  it("stages the matching pane before changing focus mode", async () => {
    mocks.workspaces = [{ panes: [{ id: 1, vendor: "codex", cwd: "/other" }] }, { panes: [{ id: 2, ...pane }] }];
    const lookup = vi.fn(async () => {
      expect(mocks.setPaneFocusMode).not.toHaveBeenCalled();
      return info();
    });
    mocks.invoke.mockImplementationOnce(async () => expect(mocks.setPaneFocusMode).not.toHaveBeenCalled());
    await setFocusModeKeepingSession(2, true, 42, lookup);
    expect(lookup).toHaveBeenCalledWith(42);
    expect(mocks.invoke).toHaveBeenCalledWith("stage_launch_args", {
      vendor: "claude", cwd: "/repo", args: ["--resume", sessionId],
    });
    expect(mocks.setPaneFocusMode).toHaveBeenCalledWith(2, true);
  });
  it("changes focus mode even when staging fails or the pane is absent", async () => {
    mocks.workspaces = [{ panes: [{ id: 2, ...pane }] }];
    mocks.invoke.mockRejectedValueOnce(new Error("refused"));
    await setFocusModeKeepingSession(2, false, 42);
    expect(mocks.setPaneFocusMode).toHaveBeenCalledWith(2, false);
    vi.clearAllMocks();
    await setFocusModeKeepingSession(99, true, 42);
    expect(mocks.paneSessionInfo).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.setPaneFocusMode).toHaveBeenCalledWith(99, true);
  });
});
