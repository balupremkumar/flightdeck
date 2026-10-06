import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const harness = vi.hoisted(() => ({
  value: null as unknown,
  effects: [] as Array<() => (() => void) | void>,
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
  remove: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: () => [harness.value, (value: unknown) => { harness.value = value; }],
  useEffect: (effect: () => (() => void) | void) => harness.effects.push(effect),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    harness.callbacks.set(name, callback);
    return harness.remove;
  }),
}) }));
import { DragDropHint } from "./DragDropHint";

beforeEach(() => { harness.value = null; harness.effects = []; harness.callbacks.clear(); harness.remove.mockClear(); });
it("renders the hover pill and tint, then clears on hover-end", async () => {
  expect(renderToStaticMarkup(<DragDropHint />)).toBe("");
  const cleanup = harness.effects[0]();
  await Promise.resolve();
  harness.callbacks.get("drag://hover")!({ payload: { name: "Acme <repo>", tint: "#123456", from: "main" } });
  const html = renderToStaticMarkup(<DragDropHint />);
  expect(html).toContain("Drop to move Acme &lt;repo&gt; here");
  expect(html).toContain("--drag-tint:#123456");
  harness.callbacks.get("drag://hover-end")!({ payload: null });
  expect(renderToStaticMarkup(<DragDropHint />)).toBe("");
  cleanup?.();
  expect(harness.remove).toHaveBeenCalledTimes(2);
});
it("cleans up registrations that finish after unmount and ignores late events", async () => {
  renderToStaticMarkup(<DragDropHint />);
  const cleanup = harness.effects[0]();
  cleanup?.();
  await Promise.resolve();
  expect(harness.remove).toHaveBeenCalledTimes(2);
  harness.callbacks.get("drag://hover")!({ payload: { name: "Late", tint: "", from: "main" } });
  expect(harness.value).toBeNull();
});
