import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { REMOTE_PATH_MSG } from "./linkify";
import { revealPath } from "./reveal";

const pushToast = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./ui", () => ({ useUI: { getState: () => ({ pushToast }) } }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("revealPath", () => {
  it("reveals a local path unchanged on every request", async () => {
    const path = "D:\\project with spaces\\report.txt";
    await revealPath(path);
    await revealPath(path);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["reveal_in_explorer", { path }],
      ["reveal_in_explorer", { path }],
    ]);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it.each(["\\\\server\\share\\file.txt", "//server/share/file.txt", "%5C%5Cserver%5Cshare%5Cfile.txt"])(
    "refuses the remote path %s without invoking Explorer", async (path) => {
      await expect(revealPath(path)).resolves.toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
      expect(pushToast).toHaveBeenCalledExactlyOnceWith("error", REMOTE_PATH_MSG);
    },
  );

  it("reports backend failures with the path and error without rejecting", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("access denied"));
    await expect(revealPath("D:\\report.txt")).resolves.toBeUndefined();
    expect(pushToast).toHaveBeenCalledExactlyOnceWith("error", "Couldn't reveal D:\\report.txt: Error: access denied");
  });
});
