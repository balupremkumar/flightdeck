// applog.test.ts — the flight recorder's frontend half must be a good citizen:
// it logs through the log_event command, collapses duplicate spam, hard-caps
// per session, and is a silent no-op outside Tauri.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from "@tauri-apps/api/core";
import { logEvent, logError, _resetForTests } from "./applog";

const invokeMock = vi.mocked(invoke);

function markTauri(on: boolean) {
  const g = globalThis as unknown as Record<string, unknown>;
  if (on) g.__TAURI_INTERNALS__ = {};
  else delete g.__TAURI_INTERNALS__;
}

beforeEach(() => {
  invokeMock.mockClear();
  _resetForTests();
  markTauri(true);
});

describe("logEvent", () => {
  it("forwards level, source and message to the log_event command", () => {
    logEvent("error", "toast", "Couldn't open the terminal");
    expect(invokeMock).toHaveBeenCalledWith("log_event", {
      level: "error",
      source: "toast",
      message: "Couldn't open the terminal",
    });
  });

  it("is a no-op outside Tauri", () => {
    markTauri(false);
    logEvent("error", "toast", "boom");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("collapses consecutive duplicates into one entry plus a repeat note", () => {
    logEvent("error", "render", "same crash");
    logEvent("error", "render", "same crash");
    logEvent("error", "render", "same crash");
    logEvent("info", "boot", "moving on");
    // 1 original + 1 "repeated x2" + 1 new = 3 sends, not 4.
    expect(invokeMock).toHaveBeenCalledTimes(3);
    const repeat = invokeMock.mock.calls[1][1] as { message: string };
    expect(repeat.message).toContain("repeated x2");
  });

  it("stops at the session cap with one final notice", () => {
    for (let i = 0; i < 260; i++) logEvent("info", "spam", `entry ${i}`);
    // 200 entries + 1 cap notice.
    expect(invokeMock).toHaveBeenCalledTimes(201);
    const last = invokeMock.mock.calls[200][1] as { message: string };
    expect(last.message).toContain("cap");
  });

  it("truncates oversized messages", () => {
    logEvent("warn", "big", "x".repeat(20_000));
    const sent = invokeMock.mock.calls[0][1] as { message: string };
    expect(sent.message.length).toBeLessThanOrEqual(8_000);
  });
});

describe("logError", () => {
  it("includes the stack for real Errors", () => {
    const err = new Error("kaboom");
    logError("react-render", err, "  at Cockpit");
    const sent = invokeMock.mock.calls[0][1] as { message: string; level: string };
    expect(sent.level).toBe("error");
    expect(sent.message).toContain("kaboom");
    expect(sent.message).toContain("at Cockpit");
  });

  it("stringifies non-Error throws", () => {
    logError("unhandledrejection", { code: 42 });
    const sent = invokeMock.mock.calls[0][1] as { message: string };
    expect(sent.message).toContain("42");
  });

  it("never throws on unstringifiable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => logError("x", cyclic)).not.toThrow();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
