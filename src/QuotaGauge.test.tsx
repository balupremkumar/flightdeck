import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Match DragDropHint.test.tsx: server rendering with captured hooks, no DOM dependency.
const harness = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0,
  effects: [] as Array<() => (() => void) | void>,
  cleanups: [] as Array<() => void>,
  poll: null as null | (() => Promise<void>),
  invoke: vi.fn(),
  listeners: new Map<string, (event: unknown) => void>(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [harness.states[index], (value: unknown) => { harness.states[index] = value; }];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useId: () => "quota-details",
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | void) => harness.effects.push(effect),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: harness.invoke }));
vi.mock("./poll", () => ({ usePoll: (poll: () => Promise<void>) => { harness.poll = poll; } }));
import QuotaGauge from "./QuotaGauge";
import { closeTopOverlay, __resetOverlayStackForTests } from "./ui";

const now = 1_800_000_000_000;
const plan = {
  fiveHour: { usedTokens: 4200, windowStart: now, resetsAt: now + 114 * 60_000, pct: 0.42 },
  weekly: { usedTokens: 18000, windowStart: now, resetsAt: now + 3 * 86_400_000, pct: 0.18 },
  source: "claude-reported",
};
function renderGauge() {
  harness.cleanups.splice(0).forEach(cleanup => cleanup());
  harness.cursor = 0;
  harness.effects = [];
  const tree = QuotaGauge();
  harness.effects.forEach(effect => { const cleanup = effect(); if (cleanup) harness.cleanups.push(cleanup); });
  return tree;
}
function button(tree: ReturnType<typeof QuotaGauge>) {
  return (tree!.props.children as ReactElement<{ onClick: () => void }>[]) [0];
}
async function load() {
  expect(renderGauge()).toBeNull();
  await harness.poll!();
  expect(harness.invoke).toHaveBeenCalledWith("plan_usage");
  return renderGauge();
}
beforeEach(() => {
  harness.states = []; harness.cursor = 0; harness.effects = []; harness.cleanups = [];
  harness.listeners.clear(); harness.invoke.mockReset(); harness.invoke.mockResolvedValue(plan);
  __resetOverlayStackForTests();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("document", {
    activeElement: null,
    addEventListener: (name: string, handler: (event: unknown) => void) => harness.listeners.set(name, handler),
    removeEventListener: (name: string) => harness.listeners.delete(name),
  });
});
afterEach(() => {
  harness.cleanups.splice(0).forEach(cleanup => cleanup());
  __resetOverlayStackForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it("renders the readable pill and toggles both windows and source details", async () => {
  let tree = await load();
  let html = renderToStaticMarkup(tree);
  for (const text of ["5h", "42%", "1h 54m", "Week", "18%"]) expect(html).toContain(text);
  expect(html).not.toContain("title=");
  expect(html).toContain('aria-expanded="false"');
  button(tree).props.onClick();
  tree = renderGauge(); html = renderToStaticMarkup(tree);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('role="region"');
  expect(html).toContain("5-hour");
  expect(html).toContain("resets in 1h 54m");
  expect(html).toContain("resets in 3d");
  expect(html).toContain("Reset time reported by Claude Code in a session transcript (a limit was hit).");
  button(tree).props.onClick();
  expect(renderToStaticMarkup(renderGauge())).not.toContain('role="region"');
});
it("closes through the shared Escape dispatcher and on outside mousedown", async () => {
  let tree = await load();
  button(tree).props.onClick(); tree = renderGauge();
  // Cockpit routes Escape to closeTopOverlay; exercise the real useOverlayEsc registration.
  expect(closeTopOverlay()).toBe(true);
  tree = renderGauge();
  expect(renderToStaticMarkup(tree)).not.toContain('role="region"');
  button(tree).props.onClick(); tree = renderGauge();
  const ref = tree!.props.ref;
  const inside = {};
  ref.current = { contains: (target: unknown) => target === inside };
  harness.listeners.get("mousedown")!({ target: inside });
  expect(harness.states[1]).toBe(true);
  harness.listeners.get("mousedown")!({ target: {} });
  expect(renderToStaticMarkup(renderGauge())).not.toContain('role="region"');
  expect(harness.listeners.has("mousedown")).toBe(false);
});
it("preserves warning colours and the token fallback when a cap is unknown", async () => {
  harness.invoke.mockResolvedValue({ ...plan, fiveHour: { ...plan.fiveHour, pct: 0.8 }, weekly: { ...plan.weekly, pct: 0.95 } });
  const html = renderToStaticMarkup(await load());
  expect(html).toContain('qg-row warn'); expect(html).toContain('qg-row crit');
  harness.invoke.mockResolvedValue({ ...plan, fiveHour: { ...plan.fiveHour, pct: null } });
  await harness.poll!();
  expect(renderToStaticMarkup(renderGauge())).toContain("4.2k");
});
