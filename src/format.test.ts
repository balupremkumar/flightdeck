import { describe, expect, it } from "vitest";
import { relTime, duration, num, compact, bytes } from "./format";

describe("format", () => {
  it("relTime buckets across all units", () => {
    const now = 1_000_000_000_000;
    expect(relTime(now - 2_000, now)).toBe("just now");
    expect(relTime(now - 45_000, now)).toBe("45s ago");
    expect(relTime(now - 12 * 60_000, now)).toBe("12m ago");
    expect(relTime(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(relTime(now - 50 * 3600_000, now)).toBe("2d ago");
  });

  it("duration omits the ago suffix and splits hours", () => {
    const now = 1_000_000_000_000;
    expect(duration(now - 10_000, now)).toBe("just now");
    expect(duration(now - 3 * 60_000, now)).toBe("3m");
    expect(duration(now - 65 * 60_000, now)).toBe("1h 5m");
  });

  it("compact and num format counts", () => {
    expect(compact(940)).toBe("940");
    expect(compact(1234)).toBe("1.2k");
    expect(compact(45_000)).toBe("45k");
    expect(compact(2_400_000)).toBe("2.4M");
    expect(num(41234)).toBe((41234).toLocaleString());
  });

  it("bytes scales units", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(2048)).toBe("2 KB");
    expect(bytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(bytes(3 * 1024 ** 3)).toBe("3.00 GB");
  });
});
