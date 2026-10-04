import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The suite runs in node, which has no localStorage — same minimal stub
// trust.test.ts uses.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const {
  getPendingReleaseNotes, clearPendingReleaseNotes,
  resolveReleasesDir, checkForUpdate, installNote, REVERT_COMMAND,
} = await import("./updater");
const { useUI } = await import("./ui");
const { invoke } = await import("@tauri-apps/api/core");
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

// Pure round-trip of the UX-600 "what's new" data — the localStorage contract
// underneath checkForUpdate (what Settings reads back on the next boot).
describe("pending release notes (UX-600 source data)", () => {
  afterEach(() => {
    clearPendingReleaseNotes();
  });

  it("returns null when nothing has been saved", () => {
    expect(getPendingReleaseNotes()).toBeNull();
  });

  it("round-trips a saved manifest", () => {
    localStorage.setItem("flightdeck-pending-release-notes", JSON.stringify({ version: "0.4.0", notes: "New things." }));
    expect(getPendingReleaseNotes()).toEqual({ version: "0.4.0", notes: "New things." });
  });

  it("clear removes it", () => {
    localStorage.setItem("flightdeck-pending-release-notes", JSON.stringify({ version: "0.4.0", notes: "x" }));
    clearPendingReleaseNotes();
    expect(getPendingReleaseNotes()).toBeNull();
  });

  it("ignores malformed JSON rather than throwing", () => {
    localStorage.setItem("flightdeck-pending-release-notes", "{not json");
    expect(getPendingReleaseNotes()).toBeNull();
  });

  it("ignores a shape that isn't a {version, notes} pair", () => {
    localStorage.setItem("flightdeck-pending-release-notes", JSON.stringify({ foo: "bar" }));
    expect(getPendingReleaseNotes()).toBeNull();
  });
});

// 0.4b: no baked-in dev path. Saved choice wins, else Rust's suggestion, else "".
describe("releases folder resolution", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.removeItem("flightdeck-releases-dir");
  });

  it("uses the saved folder without asking Rust", async () => {
    localStorage.setItem("flightdeck-releases-dir", "E:\\rel");
    expect(await resolveReleasesDir()).toBe("E:\\rel");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("falls back to Rust's default_releases_dir", async () => {
    invokeMock.mockResolvedValueOnce("F:\\dev\\releases");
    expect(await resolveReleasesDir()).toBe("F:\\dev\\releases");
    expect(invokeMock).toHaveBeenCalledWith("default_releases_dir");
  });

  it("is empty with no bridge, and the check then asks for a folder instead of invoking", async () => {
    invokeMock.mockRejectedValue(new Error("no ipc"));
    expect(await resolveReleasesDir()).toBe("");
    const res = await checkForUpdate();
    expect(res.errorKind).toBe("releases-dir-unset");
    expect(invokeMock).not.toHaveBeenCalledWith("check_update", expect.anything());
  });
});

// 0.5a: notify-only. The check reports and stores; it never installs, and
// nothing in this module schedules itself.
describe("checkForUpdate (notify-only)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.setItem("flightdeck-releases-dir", "E:\\rel");
    useUI.getState().setUpdateAvailable(null);
    clearPendingReleaseNotes();
  });

  it("passes the releases folder to Rust and surfaces a newer version", async () => {
    invokeMock.mockResolvedValueOnce({
      available: true, version: "0.6.0", notes: "Better.", installerPath: "E:\\rel\\Flightdeck_0.6.0_x64-setup.exe",
    });
    const res = await checkForUpdate();
    expect(invokeMock).toHaveBeenCalledWith("check_update", { releasesDir: "E:\\rel" });
    expect(res.available).toBe(true);
    expect(useUI.getState().updateAvailable?.version).toBe("0.6.0");
    expect(getPendingReleaseNotes()).toEqual({ version: "0.6.0", notes: "Better." });
    expect(invokeMock).toHaveBeenCalledTimes(1); // no install_update, ever
  });

  it("clears the available state when up to date", async () => {
    useUI.getState().setUpdateAvailable({ version: "9.9.9", notes: "", installerPath: "x" });
    invokeMock.mockResolvedValueOnce({ available: false });
    expect((await checkForUpdate()).available).toBe(false);
    expect(useUI.getState().updateAvailable).toBeNull();
  });

  it("returns Rust's error without touching the store", async () => {
    invokeMock.mockResolvedValueOnce({ available: false, error: "Couldn't read latest.json", errorKind: "manifest-unreadable" });
    const res = await checkForUpdate();
    expect(res.error).toContain("latest.json");
    expect(res.errorKind).toBe("manifest-unreadable");
    expect(useUI.getState().updateAvailable).toBeNull();
  });

  it("the copyable install note says to close Flightdeck first", () => {
    const note = installNote("0.6.0", "E:\\rel\\Flightdeck_0.6.0_x64-setup.exe");
    expect(note).toContain("Flightdeck 0.6.0 is available");
    expect(note).toContain("Close Flightdeck, then run the installer");
    expect(note).toContain("E:\\rel\\Flightdeck_0.6.0_x64-setup.exe");
  });

  it("the revert command points at tools\\revert.ps1", () => {
    expect(REVERT_COMMAND).toContain("tools\\revert.ps1 -To");
  });
});
