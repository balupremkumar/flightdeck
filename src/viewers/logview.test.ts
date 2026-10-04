import { describe, expect, it } from "vitest";
import { classifyLines, lineLevel, timestampEnd } from "./logview";

describe("lineLevel", () => {
  it("maps level tokens", () => {
    expect(lineLevel("2026-01-01T10:00:00Z ERROR boom")).toBe("error");
    expect(lineLevel("[FATAL] gone")).toBe("error");
    expect(lineLevel("WARN  disk low")).toBe("warn");
    expect(lineLevel("WARNING: x")).toBe("warn");
    expect(lineLevel("INFO started")).toBe("info");
    expect(lineLevel("DEBUG x")).toBe("debug");
    expect(lineLevel("TRACE x")).toBe("debug");
  });
  it("reads structured levels in any case", () => {
    expect(lineLevel('{"level":"error","msg":"x"}')).toBe("error");
    expect(lineLevel("ts=1 level=warn msg=x")).toBe("warn");
  });
  it("ignores lowercase prose and whole-word misses", () => {
    expect(lineLevel("this is an error in prose")).toBeNull();
    expect(lineLevel("INFORMATION only")).toBeNull();
  });
  it("only looks at the head of a long line", () => {
    expect(lineLevel("x".repeat(400) + " ERROR")).toBeNull();
  });
});

describe("timestampEnd", () => {
  it("finds ISO timestamps, bracketed or not", () => {
    expect(timestampEnd("2026-01-02T03:04:05.123Z INFO x")).toBe("2026-01-02T03:04:05.123Z".length);
    expect(timestampEnd("[2026-01-02 03:04:05,678] x")).toBe("[2026-01-02 03:04:05,678]".length);
    expect(timestampEnd("2026-01-02T03:04:05+13:00 x")).toBe("2026-01-02T03:04:05+13:00".length);
  });
  it("is 0 when absent", () => {
    expect(timestampEnd("INFO no stamp")).toBe(0);
  });
});

describe("classifyLines", () => {
  it("lets indented continuation lines inherit, and plain lines reset", () => {
    const l = classifyLines([
      "ERROR failed",
      "    at foo (a.js:1)",
      "\tat bar",
      "plain text",
      "    indented after plain",
      "INFO ok",
    ]);
    expect(l).toEqual(["error", "error", "error", "plain", "plain", "info"]);
  });
  it("handles 100k lines", () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `2026-01-01T00:00:00Z ${i % 10 === 0 ? "ERROR" : "INFO"} m${i}`);
    const out = classifyLines(lines);
    expect(out[0]).toBe("error");
    expect(out[1]).toBe("info");
    expect(out.length).toBe(100_000);
  });
});
