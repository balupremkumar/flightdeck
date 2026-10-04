import { describe, expect, it } from "vitest";
import { isOscBusy, nextOscBusy, OSC_BUSY_TTL_MS } from "./oscBusy";

describe("oscBusy", () => {
  it("states 1-3 mark busy and suppress waiting", () => {
    for (const s of [1, 2, 3]) expect(isOscBusy(nextOscBusy(null, s, 1000), 1001)).toBe(true);
  });
  it("states 0 and 4 clear", () => {
    const busy = nextOscBusy(null, 3, 0);
    expect(isOscBusy(nextOscBusy(busy, 0, 5), 6)).toBe(false);
    expect(isOscBusy(nextOscBusy(busy, 4, 5), 6)).toBe(false);
  });
  it("expires after 60 s", () => {
    const busy = nextOscBusy(null, 1, 0);
    expect(isOscBusy(busy, OSC_BUSY_TTL_MS - 1)).toBe(true);
    expect(isOscBusy(busy, OSC_BUSY_TTL_MS)).toBe(false);
  });
  it("a refresh extends the window", () => {
    const busy = nextOscBusy(nextOscBusy(null, 1, 0), 1, 50_000);
    expect(isOscBusy(busy, 100_000)).toBe(true);
  });
  it("unknown states leave it unchanged", () => {
    const busy = nextOscBusy(null, 1, 0);
    expect(nextOscBusy(busy, 9, 10)).toBe(busy);
  });
  it("idle pane is not busy", () => expect(isOscBusy(null, 0)).toBe(false));
});
