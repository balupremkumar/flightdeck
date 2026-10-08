import { beforeEach, describe, expect, it } from "vitest";
import { lastLine, needsHumanQueue, stateSince } from "./attention";
import type { PrInfo } from "./chipState";
import type { PaneModel, PaneState, Workspace } from "./store";
import {
  activityLine, approveKeyFor, buildHome, cardName, classifyPane, diffKey, homeKeyAllowed, isProcessTitle, markPaneMerged,
  mergedPanes, otherWindowSummaries, permissionAsk, permissionPrompt, prCwd, type HomeCtx, type DiffStat,
} from "./home";

const NOW = Date.now(); // needsHumanQueue reads the real clock for snooze
const pane = (id: number, state: PaneState, extra: Partial<PaneModel> = {}): PaneModel =>
  ({ id, vendor: "claude", cwd: `/w/p${id}`, state, epoch: 0, ...extra });
const ws = (id: number, panes: PaneModel[]): Workspace => ({ id, name: `ws${id}`, root: `/w${id}`, focused: null, panes });
const pr = (state: string, checks: PrInfo["checks"], n = 1): PrInfo => ({ number: n, url: "https://x/1", state, checks });

const ctxOf = (over: Partial<HomeCtx> = {}): HomeCtx => ({
  now: NOW,
  snoozed: {},
  lastLine: lastLine,
  stateSince: stateSince,
  lastOutputAt: new Map(),
  diff: {},
  pr: {},
  merged: new Set(),
  isAgent: (v) => v !== "pwsh",
  ...over,
});

beforeEach(() => {
  lastLine.clear();
  stateSince.clear();
  mergedPanes.clear();
});

describe("classifyPane precedence", () => {
  const w = ws(1, []);
  const withDiff = (p: PaneModel): Record<string, DiffStat> => ({ [diffKey(p)]: { files: 2, added: 5, deleted: 1 } });

  it("needs beats working (permission state is never also working)", () => {
    expect(classifyPane(pane(1, "permission"), w, ctxOf())).toBe("needs");
  });

  it("needs beats merged and review", () => {
    const p = pane(1, "permission");
    expect(classifyPane(p, w, ctxOf({ merged: new Set([1]), diff: withDiff(p) }))).toBe("needs");
  });

  it("working beats merged", () => {
    expect(classifyPane(pane(1, "running"), w, ctxOf({ merged: new Set([1]) }))).toBe("working");
  });

  it("starting counts as working", () => {
    expect(classifyPane(pane(1, "starting"), w, ctxOf())).toBe("working");
  });

  it("merged outranks review: a merged PR with a leftover diff does not ask for review", () => {
    const p = pane(1, "idle");
    const c = ctxOf({ diff: withDiff(p), pr: { [prCwd(p, w)]: pr("MERGED", "passed") } });
    expect(classifyPane(p, w, c)).toBe("merged");
  });

  it("a locally merged pane is merged even without a PR", () => {
    expect(classifyPane(pane(1, "idle"), w, ctxOf({ merged: new Set([1]) }))).toBe("merged");
  });

  it("review: diff with files, or an open PR whose checks are not running", () => {
    const p = pane(1, "idle");
    expect(classifyPane(p, w, ctxOf({ diff: withDiff(p) }))).toBe("review");
    expect(classifyPane(p, w, ctxOf({ pr: { [prCwd(p, w)]: pr("OPEN", "passed") } }))).toBe("review");
    expect(classifyPane(p, w, ctxOf({ pr: { [prCwd(p, w)]: pr("OPEN", "running") } }))).toBe("idle");
  });

  it("an empty diff, a closed PR and unfetched data fall to idle", () => {
    const p = pane(1, "idle");
    expect(classifyPane(p, w, ctxOf({ diff: { [diffKey(p)]: { files: 0, added: 0, deleted: 0 } } }))).toBe("idle");
    expect(classifyPane(p, w, ctxOf({ pr: { [prCwd(p, w)]: pr("CLOSED", "none") } }))).toBe("idle");
    expect(classifyPane(p, w, ctxOf())).toBe("idle");
  });

  it("a quiet waiting pane without a question is idle (ambient)", () => {
    lastLine.set(1, "Done, anything else");
    expect(classifyPane(pane(1, "waiting"), w, ctxOf())).toBe("idle");
  });

  it("a waiting pane on an open question is needs", () => {
    lastLine.set(1, "Which package manager should I use?");
    expect(classifyPane(pane(1, "waiting"), w, ctxOf())).toBe("needs");
  });

  it("prCwd prefers the worktree path, else the workspace root", () => {
    expect(prCwd(pane(1, "idle", { worktreePath: "/wt/a" }), ws(1, []))).toBe("/wt/a");
    expect(prCwd(pane(1, "idle"), ws(7, []))).toBe("/w7");
  });
});

describe("buildHome", () => {
  it("a snoozed pane lands in Idle with snoozedUntil, and is not in the bell queue", () => {
    const p = pane(1, "permission");
    const w = ws(1, [p]);
    const snoozed = { 1: NOW + 20 * 60_000 };
    const h = buildHome([w], ctxOf({ snoozed }));
    expect(h.needsCount).toBe(0);
    expect(h.columns.idle.map((c) => c.paneId)).toEqual([1]);
    expect(h.columns.idle[0].snoozedUntil).toBe(NOW + 20 * 60_000);
    expect(h.columns.idle[0].kind).toBeNull();
  });

  it("a snoozed permission pane stays Idle even with a diff (never hidden, never nagging)", () => {
    const p = pane(1, "permission");
    const h = buildHome([ws(1, [p])], ctxOf({ snoozed: { 1: NOW + 60_000 }, diff: { [diffKey(p)]: { files: 3, added: 1, deleted: 0 } } }));
    expect(h.columns.idle).toHaveLength(1);
    expect(h.columns.review).toHaveLength(0);
  });

  it("an expired snooze counts as needs again", () => {
    const h = buildHome([ws(1, [pane(1, "error")])], ctxOf({ snoozed: { 1: NOW - 1 } }));
    expect(h.needsCount).toBe(1);
  });

  it("QRP5: a shell pane never needs you, not even in error (matches the bell); calm shells are nowhere", () => {
    const w = ws(1, [pane(1, "error", { vendor: "pwsh" }), pane(2, "idle", { vendor: "pwsh" }), pane(3, "running", { vendor: "pwsh" })]);
    const h = buildHome([w], ctxOf());
    expect(h.needsCount).toBe(0);
    expect(h.columns.needs).toHaveLength(0);
    expect(h.needsCount).toBe(needsHumanQueue([w], {}).length);
    expect(h.columns.idle).toHaveLength(0);
    expect(h.columns.working).toHaveLength(0);
  });

  it("a pane never appears twice", () => {
    const w = ws(1, [pane(1, "permission"), pane(2, "running"), pane(3, "idle"), pane(4, "idle")]);
    const h = buildHome([w], ctxOf({ merged: new Set([4]) }));
    const ids = Object.values(h.columns).flat().map((c) => c.paneId).sort();
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it("needs: approvals, then errors, then questions, longest-blocked first", () => {
    lastLine.set(3, "Which one?");
    stateSince.set(1, NOW - 10);
    stateSince.set(2, NOW - 500);
    stateSince.set(3, NOW - 900);
    stateSince.set(4, NOW - 100);
    const w = ws(1, [pane(1, "error"), pane(2, "permission"), pane(3, "waiting"), pane(4, "permission")]);
    const h = buildHome([w], ctxOf());
    expect(h.columns.needs.map((c) => c.paneId)).toEqual([2, 4, 1, 3]);
    expect(h.columns.needs.map((c) => c.kind)).toEqual(["permission", "permission", "error", "question"]);
  });

  it("working: most recent output first", () => {
    const w = ws(1, [pane(1, "running"), pane(2, "running"), pane(3, "starting")]);
    const h = buildHome([w], ctxOf({ lastOutputAt: new Map([[1, NOW - 50], [2, NOW - 5]]) }));
    expect(h.columns.working.map((c) => c.paneId)).toEqual([2, 1, 3]);
  });

  it("merged: newest first", () => {
    stateSince.set(1, NOW - 900);
    stateSince.set(2, NOW - 100);
    const h = buildHome([ws(1, [pane(1, "idle"), pane(2, "idle")])], ctxOf({ merged: new Set([1, 2]) }));
    expect(h.columns.merged.map((c) => c.paneId)).toEqual([2, 1]);
  });

  it("review: failed CI first, then passed, then bigger diff first", () => {
    const a = pane(1, "idle", { worktreePath: "/wt/a" });
    const b = pane(2, "idle", { worktreePath: "/wt/b" });
    const c = pane(3, "idle", { worktreePath: "/wt/c" });
    const d = pane(4, "idle", { worktreePath: "/wt/d" });
    const h = buildHome([ws(1, [a, b, c, d])], ctxOf({
      pr: { "/wt/a": pr("OPEN", "passed"), "/wt/b": pr("OPEN", "failed") },
      diff: {
        [diffKey(c)]: { files: 1, added: 3, deleted: 0 },
        [diffKey(d)]: { files: 4, added: 90, deleted: 10 },
      },
    }));
    expect(h.columns.review.map((x) => x.paneId)).toEqual([2, 1, 4, 3]);
  });

  it("idle: longest idle first", () => {
    stateSince.set(1, NOW - 100);
    stateSince.set(2, NOW - 9000);
    const h = buildHome([ws(1, [pane(1, "idle"), pane(2, "idle")])], ctxOf());
    expect(h.columns.idle.map((c) => c.paneId)).toEqual([2, 1]);
  });

  it("ragged nulls: unfetched data is absent, fetched-none is null, no activity is null", () => {
    const p = pane(1, "idle", { branch: undefined });
    const h = buildHome([ws(1, [p])], ctxOf({ diff: { [diffKey(p)]: null } }));
    const c = h.columns.idle[0];
    expect("diff" in c).toBe(true);
    expect(c.diff).toBeNull();
    expect("pr" in c).toBe(false);
    expect(c.activity).toBeNull();
    expect(c.branch).toBeUndefined();
    expect(c.title).toBe("");
  });

  it("carries branch, title, activity and workspace name onto the card", () => {
    lastLine.set(1, "Editing src/a.ts");
    const p = pane(1, "running", { title: "api fix", branch: "fix-x", worktreePath: "/wt/x", baseBranch: "main" });
    const c = buildHome([ws(2, [p])], ctxOf()).columns.working[0];
    expect(c).toMatchObject({ paneId: 1, wsId: 2, wsName: "ws2", title: "api fix", branch: "fix-x", activity: "Editing src/a.ts" });
  });

  it("spans every workspace", () => {
    const h = buildHome([ws(1, [pane(1, "running")]), ws(2, [pane(2, "running")])], ctxOf());
    expect(h.columns.working.map((c) => c.wsId).sort()).toEqual([1, 2]);
  });

  it("markPaneMerged feeds the merged set", () => {
    markPaneMerged(5);
    expect(mergedPanes.has(5)).toBe(true);
  });

  it("no summary rows means no other windows", () => {
    expect(otherWindowSummaries()).toEqual([]);
    expect(otherWindowSummaries([])).toEqual([]);
  });

  it("other windows list their workspaces read-only, with live panes not needing you as working", () => {
    const rows = otherWindowSummaries([
      { label: "fw-1", livePanes: 3, title: "Window 2", needsYou: 1, workspaces: [{ id: 5, name: "acme", paneId: 9 }, { id: 6, name: "api", paneId: null }] },
      { label: "fw-2", livePanes: 0 },
    ]);
    expect(rows[0]).toEqual({
      label: "fw-1", title: "Window 2", needsYou: 1, working: 2,
      workspaces: [{ id: 5, name: "acme", paneId: 9 }, { id: 6, name: "api", paneId: null }],
    });
    expect(rows[1]).toEqual({ label: "fw-2", title: "fw-2", needsYou: 0, working: 0, workspaces: [] });
  });
});

describe("approveKeyFor", () => {
  it("claude numbered menu with the cursor on 1. Yes sends Enter", () => {
    const tail = ["Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No, and tell Claude what to do differently"];
    expect(approveKeyFor("claude", tail)).toBe("\r");
    expect(approveKeyFor("agy", tail)).toBe("\r");
  });

  it("returns null when the cursor has moved off 1. Yes", () => {
    const tail = ["Do you want to proceed?", "  1. Yes", "❯ 2. Yes, and don't ask again", "  3. No"];
    expect(approveKeyFor("claude", tail)).toBeNull();
  });

  it("codex approval overlay sends y", () => {
    const tail = ["Would you like to run the following command?", "  $ npm test", "› 1. Yes, just this once", "  2. Yes, and don't ask again", "  3. No, and tell Codex what to do differently"];
    expect(approveKeyFor("codex", tail)).toBe("y");
  });

  it("codex overlay with the cursor moved is null", () => {
    expect(approveKeyFor("codex", ["Would you like to run the following command?", "❯ 3. No, and tell Codex what to do differently"])).toBeNull();
  });

  it("a literal (y/n) prompt sends y and Enter", () => {
    expect(approveKeyFor("claude", ["Overwrite config.json? (y/n)"])).toBe("y\r");
    expect(approveKeyFor("codex", ["Continue [Y/N]"])).toBe("y\r");
  });

  it("anything else is null: never a guess", () => {
    expect(approveKeyFor("claude", ["Which package manager?"])).toBeNull();
    expect(approveKeyFor("claude", [])).toBeNull();
    expect(approveKeyFor("claude", ["", "  "])).toBeNull();
  });

  it("a stale prompt far above the visible tail is ignored", () => {
    const tail = ["❯ 1. Yes", ...Array.from({ length: 14 }, (_, i) => `output line ${i}`)];
    expect(approveKeyFor("claude", tail)).toBeNull();
  });
});

describe("homeKeyAllowed", () => {
  const k = (key: string, m: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) =>
    ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...m });

  it("lets through only the Home-compatible chords", () => {
    expect(homeKeyAllowed(k("H", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(homeKeyAllowed(k("a", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(homeKeyAllowed(k(",", { ctrlKey: true }))).toBe(true);
    for (const z of ["=", "+", "-", "_", "0"]) expect(homeKeyAllowed(k(z, { ctrlKey: true }))).toBe(true);
  });

  it("blocks everything that would focus or close a pane behind Home", () => {
    expect(homeKeyAllowed(k("`"))).toBe(false);
    expect(homeKeyAllowed(k("3"))).toBe(false);
    expect(homeKeyAllowed(k("3", { altKey: true }))).toBe(false);
    expect(homeKeyAllowed(k("ArrowRight", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(homeKeyAllowed(k("ArrowRight", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(homeKeyAllowed(k("Tab", { ctrlKey: true }))).toBe(false);
    expect(homeKeyAllowed(k("w", { ctrlKey: true }))).toBe(false);
    expect(homeKeyAllowed(k("b", { ctrlKey: true }))).toBe(false);
    expect(homeKeyAllowed(k("h", { ctrlKey: true }))).toBe(false);
  });
});

describe("card identity and activity line", () => {
  it("ignores a process-name title, falls back to vendor plus branch", () => {
    expect(isProcessTitle("node")).toBe(true);
    expect(isProcessTitle("pwsh.exe")).toBe(true);
    expect(isProcessTitle("Fix login flow")).toBe(false);
    expect(cardName("node", "Claude", "fix-x")).toEqual({ name: "Claude · fix-x", branchShown: true });
    expect(cardName("claude", "Claude", "fix-x", true)).toEqual({ name: "claude", branchShown: false });
    expect(cardName("", "Codex")).toEqual({ name: "Codex", branchShown: false });
    expect(cardName("Fix login flow", "Claude", "fix-x")).toEqual({ name: "Fix login flow", branchShown: false });
  });

  it("skips lines that are only prompt or spinner glyphs", () => {
    for (const g of [">", "▸", "☾", "❯ ", "⠋", "  │  ", "─────"]) expect(activityLine(g, null)).toBeNull();
    expect(activityLine("Editing src/a.ts", null)).toBe("Editing src/a.ts");
    expect(activityLine(undefined, null)).toBeNull();
  });

  it("never shows a menu option on a permission card", () => {
    expect(activityLine("3. No, tell Claude what to do differently", "permission")).toBeNull();
    expect(activityLine("  ❯ 1. Yes", "permission")).toBeNull();
    expect(activityLine("3. Not an option on a non-permission card", null)).not.toBeNull();
  });

  it("permissionAsk returns the line above the numbered options", () => {
    expect(permissionAsk(["Bash command", "  rm -rf build", "Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No, tell Claude what to do differently"]))
      .toBe("Do you want to proceed?");
    expect(permissionAsk(["│ Allow this edit? │", "│ ❯ 1. Yes │", "│   2. No │"])).toBe("Allow this edit?");
    expect(permissionAsk(["old menu", "1. Yes", "2. No", "new question?", "1. Yes", "2. No"])).toBe("new question?");
    expect(permissionAsk(["no menu here", "just text"])).toBeNull();
    expect(permissionAsk(["❯ 1. Yes", "2. No"])).toBeNull();
  });

  it("permissionPrompt returns the request lines above the question", () => {
    const tail = ["noise", "Bash command", "  rm -rf build", "Do you want to proceed?", "❯ 1. Yes", "  2. No"];
    expect(permissionPrompt(tail)).toEqual({ question: "Do you want to proceed?", request: ["Bash command", "rm -rf build"] });
    expect(permissionPrompt(["Do you want to run this command?", "❯ 1. Yes"])).toEqual({ question: "Do you want to run this command?", request: [] });
    expect(permissionPrompt(["just text"])).toEqual({ question: null, request: [] });
  });

  it("buildHome puts the glyph-free line on the card", () => {
    lastLine.set(1, "▸");
    lastLine.set(2, "Writing tests");
    const { columns } = buildHome([ws(1, [pane(1, "running"), pane(2, "running")])], ctxOf());
    expect(columns.working.find((c) => c.paneId === 1)!.activity).toBeNull();
    expect(columns.working.find((c) => c.paneId === 2)!.activity).toBe("Writing tests");
  });
});
