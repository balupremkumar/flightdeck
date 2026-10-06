import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const globalListen = vi.fn(async () => () => {});
const windowListen = vi.fn(async () => () => {});
let hasWindow = true;
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => globalListen(...(a as [])) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (!hasWindow) throw new TypeError("Cannot read properties of undefined (reading 'currentWindow')");
    return { listen: (...a: unknown[]) => windowListen(...(a as [])) };
  },
}));

import { listenHere } from "./eventScope";

describe("listenHere", () => {
  beforeEach(() => { globalListen.mockClear(); windowListen.mockClear(); hasWindow = true; });

  it("listens on the current window, never the Any target, under Tauri", async () => {
    const cb = () => {};
    await listenHere("win://adopt", cb);
    expect(windowListen).toHaveBeenCalledWith("win://adopt", cb);
    expect(globalListen).not.toHaveBeenCalled();
  });

  it("falls back to the global listen when there is no window (browser preview)", async () => {
    hasWindow = false;
    const cb = () => {};
    await listenHere("app://flush", cb);
    expect(globalListen).toHaveBeenCalledWith("app://flush", cb);
  });
});

// Every event Rust sends with emit_to(label, ...) must be heard only by that window. Keep this list in step with the
// emit_to call sites in src-tauri/src (windows.rs ADOPT_EVENT/FOCUS_PANE_EVENT/FLUSH_EVENT, summon.rs SUMMON_EVENT).
describe("emit_to events are window-scoped at their listeners", () => {
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  it.each([
    ["windowBoot.ts", "\"win://adopt\""],
    ["windowBoot.ts", "\"app://focus-pane\""],
    ["session.ts", "\"app://flush\""],
    ["Notifications.tsx", "SUMMON_EVENT,"],
  ])("%s listens for %s with listenHere", (file, ev) => {
    const text = src(`./${file}`);
    const line = text.split("\n").find((l) => l.includes(ev) && /listen/.test(l));
    expect(line, `${ev} listener in ${file}`).toBeDefined();
    expect(line).toMatch(/listenHere/);
  });
});
