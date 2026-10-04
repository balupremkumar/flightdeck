import { describe, expect, it } from "vitest";
import { ciTransition, portLabel, portUrl, prLabel, type ChecksState, type PrInfo } from "./chipState";

const pr = (checks: ChecksState, over: Partial<PrInfo> = {}): PrInfo => ({ number: 12, url: "https://github.com/a/b/pull/12", state: "OPEN", checks, ...over });

describe("ciTransition", () => {
  it("toasts once on running -> passed, not on repeat polls", () => {
    const seen = new Map<string, ChecksState>();
    expect(ciTransition(seen, "k", pr("running"))).toBeNull();
    expect(ciTransition(seen, "k", pr("running"))).toBeNull();
    expect(ciTransition(seen, "k", pr("passed"))).toEqual({ kind: "success", text: "CI passed on PR #12", url: "https://github.com/a/b/pull/12" });
    expect(ciTransition(seen, "k", pr("passed"))).toBeNull();
    expect(ciTransition(seen, "k", pr("passed"))).toBeNull();
  });
  it("toasts an error on running -> failed", () => {
    const seen = new Map<string, ChecksState>();
    ciTransition(seen, "k", pr("running"));
    expect(ciTransition(seen, "k", pr("failed"))?.text).toBe("CI failed on PR #12");
  });
  it("never toasts for a PR first seen already finished", () => {
    const seen = new Map<string, ChecksState>();
    expect(ciTransition(seen, "k", pr("passed"))).toBeNull();
    expect(ciTransition(new Map(), "k", pr("failed"))).toBeNull();
  });
  it("a re-run (passed -> running -> passed) toasts again, once", () => {
    const seen = new Map<string, ChecksState>();
    ciTransition(seen, "k", pr("running"));
    expect(ciTransition(seen, "k", pr("passed"))).not.toBeNull();
    expect(ciTransition(seen, "k", pr("running"))).toBeNull();
    expect(ciTransition(seen, "k", pr("passed"))).not.toBeNull();
  });
  it("losing the PR resets, and rejects non-http urls", () => {
    const seen = new Map<string, ChecksState>();
    ciTransition(seen, "k", pr("running"));
    expect(ciTransition(seen, "k", null)).toBeNull();
    expect(ciTransition(seen, "k", pr("passed"))).toBeNull();
    ciTransition(seen, "j", pr("running"));
    expect(ciTransition(seen, "j", pr("passed", { url: "javascript:alert(1)" }))?.url).toBeUndefined();
  });
  it("keys are independent", () => {
    const seen = new Map<string, ChecksState>();
    ciTransition(seen, "a", pr("running"));
    expect(ciTransition(seen, "b", pr("passed"))).toBeNull();
  });
});

describe("labels", () => {
  it("formats port and PR chips", () => {
    expect(portLabel({ port: 5173, pid: 1, processName: "node", paneId: 1 })).toBe("localhost:5173 · node");
    expect(portLabel({ port: 80, pid: 1, processName: "", paneId: 1 })).toBe("localhost:80");
    expect(portUrl({ port: 5173, pid: 1, processName: "node", paneId: 1 })).toBe("http://localhost:5173");
    expect(prLabel(pr("running"))).toBe("PR #12 · checks running");
    expect(prLabel(pr("none"))).toBe("PR #12");
    expect(prLabel(pr("passed", { state: "MERGED" }))).toBe("PR #12 · merged");
  });
});
