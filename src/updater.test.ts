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
  asUpdateError, reportLastUpdate, takeUpdateStatus, installUpdate,
  getUpdateFailure, clearUpdateFailure, reconcileStaleUpdateFailure,
} = await import("./updater");
const { APP_VERSION } = await import("./version");
const { useUI } = await import("./ui");
const { invoke } = await import("@tauri-apps/api/core");
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

// Pure round-trip of the UX-600 "what's new" data — checkForUpdate itself
// needs a live Tauri bridge, but the localStorage contract underneath it
// (what Settings reads back on the next boot) doesn't.
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

// UPD-1: the app exits to install, so nothing that goes wrong during the
// install has a live UI to report it. These cover the hand-back path — the
// only thing standing between "the update silently did nothing" and the user
// knowing about it.
describe("update failure reporting (UPD-1)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    clearUpdateFailure();
    useUI.setState({ toasts: [] });
  });

  it("normalises a typed Rust error", () => {
    const e = asUpdateError({ kind: "installer-truncated", message: "only 12 bytes" });
    expect(e.kind).toBe("installer-truncated");
    expect(e.message).toBe("only 12 bytes");
  });

  it("normalises a bare string rejection rather than rendering [object Object]", () => {
    expect(asUpdateError("bridge is gone")).toEqual({ kind: "unknown", message: "bridge is gone" });
    expect(asUpdateError(new Error("boom")).message).toContain("boom");
  });

  it("installUpdate rejects with the typed error, not a stringified object", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "watcher-spawn-failed", message: "no powershell", manualPath: "D:\\r\\s.exe" });
    await expect(installUpdate("D:\\r\\s.exe")).rejects.toMatchObject({
      kind: "watcher-spawn-failed",
      manualPath: "D:\\r\\s.exe",
    });
  });

  it("the install error still stringifies to the message (Settings renders String(e))", async () => {
    invokeMock.mockRejectedValueOnce({
      kind: "installer-truncated",
      message: "The installer is only 12 bytes. You can still update by hand: run D:\\rel\\setup.exe directly.",
    });
    const err = await installUpdate("D:\\rel\\setup.exe").catch((e) => e);
    expect(String(err)).toContain("run D:\\rel\\setup.exe directly");
    expect(String(err)).not.toContain("[object Object]");
    expect(`${err}`).toBe(err.message);
  });

  it("takeUpdateStatus is null with no bridge", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no ipc"));
    expect(await takeUpdateStatus()).toBeNull();
  });

  it("a failed install toasts loudly and is kept for Settings", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      stage: "installer-failed",
      attemptedVersion: "0.4.1",
      currentVersion: "0.3.0",
      exitCode: 2,
      message: "Flightdeck 0.4.1 did not install: the installer exited with code 2.",
      manualPath: "D:\\rel\\Flightdeck_0.4.1_x64-setup.exe",
    });
    await reportLastUpdate();

    const toasts = useUI.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].text).toContain("code 2");
    expect(toasts[0].detail).toContain("D:\\rel\\Flightdeck_0.4.1_x64-setup.exe");
    expect(toasts[0].detail).toContain("exit code: 2");

    const stored = getUpdateFailure();
    expect(stored?.version).toBe("0.4.1");
    expect(stored?.manualPath).toBe("D:\\rel\\Flightdeck_0.4.1_x64-setup.exe");
  });

  it("a successful install confirms and clears any earlier failure", async () => {
    localStorage.setItem("flightdeck-update-failure", JSON.stringify({ version: "0.4.0", message: "old failure" }));
    invokeMock.mockResolvedValueOnce({
      ok: true,
      stage: "installed",
      attemptedVersion: "0.4.1",
      currentVersion: "0.4.1",
      message: "Flightdeck updated to 0.4.1.",
    });
    await reportLastUpdate();

    expect(useUI.getState().toasts[0].kind).toBe("success");
    expect(getUpdateFailure()).toBeNull();
  });

  it("says nothing at all when no update was attempted", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await reportLastUpdate()).toBeNull();
    expect(useUI.getState().toasts).toHaveLength(0);
  });

  it("ignores a stored failure that isn't the right shape", () => {
    localStorage.setItem("flightdeck-update-failure", "{not json");
    expect(getUpdateFailure()).toBeNull();
    localStorage.setItem("flightdeck-update-failure", JSON.stringify({ nope: 1 }));
    expect(getUpdateFailure()).toBeNull();
  });
});

// The v0.5.4 lesson: the watcher died, the user ran the installer by hand,
// and the stored "0.5.4 didn't install" banner kept showing inside a working
// 0.5.4. Running the failed version (or newer) is proof the update landed.
describe("stale failure reconciliation", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    clearUpdateFailure();
    useUI.setState({ toasts: [] });
  });

  it("running the exact failed version clears the banner and confirms the update", () => {
    localStorage.setItem("flightdeck-update-failure", JSON.stringify({ version: "0.5.4", message: "never got started" }));
    reconcileStaleUpdateFailure("0.5.4");
    expect(getUpdateFailure()).toBeNull();
    const toasts = useUI.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].text).toContain("0.5.4");
  });

  it("running something newer clears the banner silently", () => {
    localStorage.setItem("flightdeck-update-failure", JSON.stringify({ version: "0.5.4", message: "never got started" }));
    reconcileStaleUpdateFailure("0.5.5");
    expect(getUpdateFailure()).toBeNull();
    expect(useUI.getState().toasts).toHaveLength(0);
  });

  it("keeps the banner while the failed version is still ahead of the running one", () => {
    localStorage.setItem("flightdeck-update-failure", JSON.stringify({ version: "0.5.5", message: "never got started" }));
    reconcileStaleUpdateFailure("0.5.3");
    expect(getUpdateFailure()?.version).toBe("0.5.5");
    expect(useUI.getState().toasts).toHaveLength(0);
  });

  it("reportLastUpdate reconciles on the boot after a hand-finished update", async () => {
    localStorage.setItem("flightdeck-update-failure", JSON.stringify({ version: APP_VERSION, message: "never got started" }));
    invokeMock.mockResolvedValueOnce(null); // no fresh attempt since last boot
    expect(await reportLastUpdate()).toBeNull();
    expect(getUpdateFailure()).toBeNull();
    expect(useUI.getState().toasts[0]?.kind).toBe("success");
  });
});
