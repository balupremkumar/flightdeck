// Guards Explorer opening, the pending reveal queue, and subscriber cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setExplorerOpen } = vi.hoisted(() => ({ setExplorerOpen: vi.fn() }));

vi.mock("./ui", () => ({
  useUI: { getState: () => ({ setExplorerOpen }) },
}));

import { requestReveal, subscribeReveal, takePendingReveal } from "./revealInTree";

const cleanups: (() => void)[] = [];

function subscribe(fn: (path: string) => void): () => void {
  const unsubscribe = subscribeReveal(fn);
  cleanups.push(unsubscribe);
  return unsubscribe;
}

beforeEach(() => {
  takePendingReveal();
  setExplorerOpen.mockClear();
});

afterEach(() => {
  for (const unsubscribe of cleanups.splice(0)) unsubscribe();
});

describe("requestReveal", () => {
  it("opens the Explorer, notifies every subscriber, and queues the path once", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribe(first);
    subscribe(second);
    const path = "D:\\Projects\\Flightdeck\\src\\revealInTree.ts";

    requestReveal(path);

    expect(setExplorerOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(first).toHaveBeenCalledExactlyOnceWith(path);
    expect(second).toHaveBeenCalledExactlyOnceWith(path);
    expect(takePendingReveal()).toBe(path);
    expect(takePendingReveal()).toBeNull();
  });

  it("keeps only the latest pending path when there are no subscribers", () => {
    expect(takePendingReveal()).toBeNull();

    requestReveal("first.ts");
    requestReveal("latest.ts");

    expect(setExplorerOpen).toHaveBeenCalledTimes(2);
    expect(setExplorerOpen).toHaveBeenNthCalledWith(1, true);
    expect(setExplorerOpen).toHaveBeenNthCalledWith(2, true);
    expect(takePendingReveal()).toBe("latest.ts");
    expect(takePendingReveal()).toBeNull();
  });
});

describe("subscribeReveal", () => {
  it("stops notifying an unsubscribed listener while keeping other listeners active", () => {
    const removed = vi.fn();
    const active = vi.fn();
    const unsubscribe = subscribe(removed);
    subscribe(active);

    requestReveal("before.ts");
    unsubscribe();
    requestReveal("after.ts");

    expect(removed).toHaveBeenCalledExactlyOnceWith("before.ts");
    expect(active).toHaveBeenCalledTimes(2);
    expect(active).toHaveBeenNthCalledWith(1, "before.ts");
    expect(active).toHaveBeenNthCalledWith(2, "after.ts");
  });

  it("continues notifying other subscribers when a subscriber removes itself", () => {
    const selfRemoving = vi.fn(() => unsubscribe());
    const unsubscribe = subscribe(selfRemoving);
    const other = vi.fn();
    subscribe(other);

    requestReveal("first.ts");
    requestReveal("second.ts");

    expect(selfRemoving).toHaveBeenCalledExactlyOnceWith("first.ts");
    expect(other).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenNthCalledWith(1, "first.ts");
    expect(other).toHaveBeenNthCalledWith(2, "second.ts");
  });
});
