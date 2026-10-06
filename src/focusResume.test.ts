import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

const { stageResumeOfCurrentSession, setFocusModeKeepingSession } = await import("./sessionLauncherLogic");
const { invoke } = await import("@tauri-apps/api/core");
const { useApp } = await import("./store");
const { useUI } = await import("./ui");

const toasts = () => useUI.getState().toasts.map((t) => t.text);

// Switching Quiet terminal on a Claude pane restarts it; the restart must reopen
// the same conversation, so a --resume is staged first.
describe("switching Quiet terminal keeps the conversation", () => {
  const sid = "11111111-2222-3333-4444-555555555555";
  const foreign = "99999999-2222-3333-4444-555555555555";
  const info = (jsonl: string | null, resume: string | null = sid) => async () => ({ session_id: sid, pinned: true, jsonl_path: jsonl, resume_id: resume });
  const pane = { vendor: "claude", cwd: "D:\\here" };

  it("stages --resume of the backend's resume id, not the transcript file name", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    // jsonl_path names a foreign (newer) file; the pinned id is what must be staged.
    const ok = await stageResumeOfCurrentSession(pane, 7, info(`C:\\Users\\u\\.claude\\projects\\D--here\\${foreign}.jsonl`));
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("stage_launch_args", { vendor: "claude", cwd: "D:\\here", args: ["--resume", sid] });
  });

  it("keeps the pane's launch args (e.g. --model) ahead of the resume", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    const withArgs = async () => ({ session_id: sid, pinned: true, jsonl_path: `C:\\p\\${sid}.jsonl`, resume_id: sid, launch_args: ["--model", "haiku"] });
    expect(await stageResumeOfCurrentSession(pane, 7, withArgs)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("stage_launch_args", { vendor: "claude", cwd: "D:\\here", args: ["--model", "haiku", "--resume", sid] });
  });

  it("restarts plain, silently, when the pane has no transcript yet, no live pty, or is not Claude", async () => {
    vi.mocked(invoke).mockReset();
    useUI.setState({ toasts: [] });
    expect(await stageResumeOfCurrentSession(pane, 7, info(null, null))).toBe(false);
    expect(await stageResumeOfCurrentSession(pane, 0, info(`C:\\p\\${sid}.jsonl`))).toBe(false);
    expect(await stageResumeOfCurrentSession({ vendor: "codex", cwd: "D:\\here" }, 7, info(`C:\\p\\${sid}.jsonl`))).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it("restarts plain with a toast when a transcript exists but no own session can be named", async () => {
    vi.mocked(invoke).mockReset();
    useUI.setState({ toasts: [] });
    expect(await stageResumeOfCurrentSession(pane, 7, info(`C:\\p\\${foreign}.jsonl`, null))).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(toasts()).toEqual(["Couldn't resume this pane's conversation, Claude starts fresh."]);
  });

  it("restarts plain with a toast when the session lookup or staging throws", async () => {
    vi.mocked(invoke).mockReset();
    useUI.setState({ toasts: [] });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("no"));
    expect(await stageResumeOfCurrentSession(pane, 7, info(`C:\\p\\${sid}.jsonl`))).toBe(false);
    expect(await stageResumeOfCurrentSession(pane, 7, async () => { throw new Error("no such pane"); })).toBe(false);
    expect(toasts()).toHaveLength(2);
  });

  it("toggling focus mode stages the resume BEFORE the restart bumps the epoch", async () => {
    useApp.setState({ workspaces: [], activeId: null, creating: false, selectedPaneIds: [], groups: [] });
    useApp.getState().createWorkspace("D:\\here", [{ vendor: "claude", cwd: "D:\\here" }]);
    const p0 = useApp.getState().workspaces[0].panes[0];
    const order: string[] = [];
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => { order.push(`${cmd}@${useApp.getState().workspaces[0].panes[0].epoch}`); });
    await setFocusModeKeepingSession(p0.id, !p0.focusMode, 9, info(`C:\\p\\${sid}.jsonl`));
    expect(order).toEqual([`stage_launch_args@${p0.epoch}`]);
    const p1 = useApp.getState().workspaces[0].panes[0];
    expect(p1.epoch).toBe(p0.epoch + 1);
    expect(!!p1.focusMode).toBe(!p0.focusMode);
  });

  it("an exited pane whose lookup is refused still restarts, with the toast", async () => {
    useApp.setState({ workspaces: [], activeId: null, creating: false, selectedPaneIds: [], groups: [] });
    useApp.getState().createWorkspace("D:\\here", [{ vendor: "claude", cwd: "D:\\here" }]);
    const p0 = useApp.getState().workspaces[0].panes[0];
    useUI.setState({ toasts: [] });
    await setFocusModeKeepingSession(p0.id, !p0.focusMode, 9, async () => { throw new Error("no such pane"); });
    expect(toasts()).toHaveLength(1);
    expect(useApp.getState().workspaces[0].panes[0].epoch).toBe(p0.epoch + 1);
  });
});
