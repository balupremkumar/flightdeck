import { describe, expect, it } from "vitest";
import type { ChatRecord } from "../chatlog";
import { buildTurns, itemKey, callKey, isSystemPromptText, foldActivity, runningCall, changeSummary } from "./turns";
import { buildPromptPayload, sanitizeDraft } from "./send";
import { activityLabel, changeLabel, chipLabel, groupLabel, shortPath, subagentCounts, subagentLabel, subagentStatus } from "./chips";
import { planFind } from "./find";
import { appendBounded } from "./buffer";
import { promptGate } from "./gate";
import { editPairs, simpleDiff, toolInput, resultText, capLines } from "./raw";

let n = 0;
const base = (o: Partial<ChatRecord>): ChatRecord => ({
  index: (n += 10), block: 0, uuid: null, parent_uuid: null, timestamp: null,
  kind: "other", sidechain: false, text: null, tool: null, result: null, ...o,
});
const user = (text: string, o: Partial<ChatRecord> = {}) => base({ kind: "user", text, ...o });
const say = (text: string, o: Partial<ChatRecord> = {}) => base({ kind: "assistant_text", text, ...o });
const use = (id: string, name: string, summary: string, paths: string[] = [], added = 0, removed = 0, o: Partial<ChatRecord> = {}) =>
  base({ kind: "tool_use", tool: { id, name, summary, paths, added, removed }, ...o });
const res = (id: string, summary: string, is_error = false) =>
  base({ kind: "tool_result", result: { tool_use_id: id, is_error, summary } });

describe("buildTurns", () => {
  it("groups records under each user prompt and attaches results", () => {
    const t = buildTurns([
      user("fix it"), say("ok"), use("a", "Bash", "npm test"), res("a", "boom", true),
      user("again"), say("done"),
    ]);
    expect(t).toHaveLength(2);
    expect(t[0].prompt?.text).toBe("fix it");
    const tools = t[0].items[1];
    expect(tools.kind).toBe("tools");
    if (tools.kind === "tools") {
      expect(tools.calls[0].result?.is_error).toBe(true);
      expect(tools.calls[0].resultRec?.result?.summary).toBe("boom");
    }
    expect(t[1].items).toHaveLength(1);
  });

  it("keeps records before any prompt in a promptless turn", () => {
    const t = buildTurns([say("trailing"), user("p")]);
    expect(t[0].prompt).toBeNull();
    expect(t[1].prompt?.text).toBe("p");
  });

  it("folds consecutive same-tool calls but not across other items", () => {
    const t = buildTurns([
      user("go"), use("1", "Bash", "a"), use("2", "Bash", "b"), use("3", "Read", "x", ["/p/x"]),
      use("4", "Bash", "c"), say("hm"), use("5", "Bash", "d"),
    ]);
    const kinds = t[0].items.map((i) => (i.kind === "tools" ? `${i.name}:${i.calls.length}` : i.kind));
    expect(kinds).toEqual(["Bash:2", "Read:1", "Bash:1", "text", "Bash:1"]);
  });

  it("groups sidechain records into one subagent item and never starts a turn", () => {
    const t = buildTurns([
      user("run agent"), use("t", "Task", "scan"),
      user("sub prompt", { sidechain: true }), say("sub says", { sidechain: true }),
      use("s1", "Read", "f", ["/a/f"], 0, 0, { sidechain: true }),
      say("back in main"),
    ]);
    expect(t).toHaveLength(1);
    const kinds = t[0].items.map((i) => i.kind);
    expect(kinds).toEqual(["tools", "subagent", "text"]);
    const sub = t[0].items[1];
    if (sub.kind === "subagent") expect(sub.items.map((i) => i.kind)).toEqual(["text", "text", "tools"]);
  });

  it("collects unique edited files, ignoring reads", () => {
    const t = buildTurns([
      user("x"), use("1", "Edit", "e", ["/a.ts"], 1, 1), use("2", "Edit", "e", ["/a.ts"], 1, 1),
      use("3", "Write", "w", ["/b.ts"], 3, 0), use("4", "Read", "r", ["/c.ts"]),
    ]);
    expect(t[0].files).toEqual(["/a.ts", "/b.ts"]);
  });
});

describe("chip labels", () => {
  const T = (name: string, summary: string, paths: string[] = [], added = 0, removed = 0) =>
    ({ id: "i", name, summary, paths, added, removed });
  it("summarises single calls", () => {
    expect(chipLabel(T("Edit", "s", ["C:\\proj\\src\\a.ts"], 42, 7), "C:\\proj")).toBe("Edited src/a.ts +42 -7");
    expect(chipLabel(T("Edit", "s", ["/x/a.ts"]))).toBe("Edited x/a.ts");
    expect(chipLabel(T("Bash", "npm test"))).toBe("Ran npm test");
    expect(chipLabel(T("Read", "f", ["/p/q/r.ts"]))).toBe("Read q/r.ts");
    expect(chipLabel(T("Mystery", "thing"))).toBe("Mystery thing");
  });
  it("labels folded groups", () => {
    const t = buildTurns([
      user("x"), use("1", "Bash", "a"), use("2", "Bash", "b"), use("3", "Bash", "c"), use("4", "Bash", "d"),
      use("5", "Read", "a", ["/1"]), use("6", "Read", "b", ["/2"]), use("7", "Read", "c", ["/3"]),
      use("8", "Edit", "e", ["/z/a.ts"], 1, 0), use("9", "Edit", "e", ["/z/a.ts"], 1, 0),
    ]);
    const labels = t[0].items.map((i) => (i.kind === "tools" ? groupLabel(i.name, i.calls) : ""));
    expect(labels).toEqual(["Ran 4 commands", "Read 3 files", "Edited z/a.ts x2"]);
  });
  it("shortPath is cwd-relative when possible", () => {
    expect(shortPath("D:\\a\\b\\c.ts", "D:\\a")).toBe("b/c.ts");
    expect(shortPath("D:\\q\\b\\c.ts", "D:\\a")).toBe("b/c.ts");
  });
});

describe("planFind", () => {
  const turns = buildTurns([
    user("please refactor"), use("1", "Bash", "npm run lint"), use("2", "Bash", "npm test"), res("2", "3 failed: widget.spec"),
    say("Fixed the widget"),
    user("sub"), use("t", "Task", "dig"), say("deep secret", { sidechain: true }),
  ]);
  it("matches inside collapsed tool groups, results and subagents, and plans expansion", () => {
    const a = planFind(turns, "widget.spec");
    expect(a.keys).toHaveLength(1);
    expect(a.keys[0].startsWith("c:")).toBe(true);
    const group = turns[0].items[0];
    if (group.kind === "tools") {
      expect(a.expand.has(itemKey(group))).toBe(true);
      expect(a.expand.has(callKey(group.calls[1]))).toBe(true);
      expect(a.expand.has(callKey(group.calls[0]))).toBe(false);
    }
    const b = planFind(turns, "SECRET");
    expect(b.keys).toHaveLength(1);
    expect([...b.expand].some((k) => k.startsWith("s:"))).toBe(true);
  });
  it("matches prompts and prose, ignores blank queries", () => {
    expect(planFind(turns, "refactor").keys[0].startsWith("p:")).toBe(true);
    expect(planFind(turns, "widget").keys).toHaveLength(2);
    expect(planFind(turns, "  ").keys).toEqual([]);
  });
});

describe("appendBounded", () => {
  it("drops the oldest past the cap and reports the count", () => {
    const mk = (i: number) => base({ index: i });
    const r = appendBounded([mk(1), mk(2), mk(3)], [mk(4), mk(5)], 4);
    expect(r.list.map((x) => x.index)).toEqual([2, 3, 4, 5]);
    expect(r.dropped).toBe(1);
    expect(appendBounded(r.list, [], 4)).toEqual({ list: r.list, dropped: 0 });
  });
});

describe("promptGate", () => {
  it("only sends when idle or waiting with a pty", () => {
    expect(promptGate("waiting", true).canSend).toBe(true);
    expect(promptGate("idle", true).canSend).toBe(true);
    expect(promptGate("running", true).canSend).toBe(false);
    expect(promptGate("starting", true).canSend).toBe(false);
    expect(promptGate("waiting", false).canSend).toBe(false);
  });
  it("refuses an exited pane even when state is idle", () => {
    const g = promptGate("idle", true, true);
    expect(g.canSend).toBe(false);
    expect(g.reason).toBe("exited");
    expect(g.message).toMatch(/Restart it to continue/);
  });
  it("explains the permission block", () => {
    const g = promptGate("permission", true);
    expect(g.canSend).toBe(false);
    expect(g.reason).toBe("permission");
    expect(g.message).toMatch(/switch to Terminal/);
  });
});

describe("raw helpers", () => {
  const raw = { message: { content: [
    { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/a", old_string: "a\nb\nc", new_string: "a\nB\nc" } },
    { type: "tool_use", id: "m1", name: "MultiEdit", input: { file_path: "/m", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] } },
    { type: "tool_result", tool_use_id: "e1", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
  ] } };
  it("extracts edit pairs and a trimmed diff", () => {
    const pairs = editPairs("Edit", toolInput(raw, "e1"));
    expect(pairs).toHaveLength(1);
    expect(simpleDiff(pairs[0].oldText, pairs[0].newText)).toEqual([{ t: "-", s: "b" }, { t: "+", s: "B" }]);
    expect(editPairs("MultiEdit", toolInput(raw, "m1"))).toHaveLength(2);
    expect(editPairs("Write", { file_path: "/w", content: "z" })[0].newText).toBe("z");
  });
  it("reads result text and caps lines", () => {
    expect(resultText(raw, "e1")).toBe("line1\nline2");
    expect(resultText(raw, "nope")).toBe("");
    expect(capLines([1, 2, 3, 4], 2, false)).toEqual({ shown: [1, 2], hidden: 2 });
    expect(capLines([1, 2, 3, 4], 2, true).hidden).toBe(0);
  });
});

describe("prompt payload", () => {
  it("wraps in bracketed paste and submits once", () => {
    expect(buildPromptPayload("a\nb")).toBe("\x1b[200~a\nb\x1b[201~\r");
  });
  it("normalises CRLF and lone CR", () => {
    expect(sanitizeDraft("a\r\nb\rc")).toBe("a\nb\nc");
  });
  it("strips ESC, C0 and DEL but keeps tab and newline", () => {
    expect(sanitizeDraft("a\x1b[31mb\x03\x7f\tc\nd\x00")).toBe("a[31mb\tc\nd");
  });
  it("returns null when nothing is left", () => {
    expect(buildPromptPayload("  \x1b \r\n ")).toBeNull();
  });
  it("cannot smuggle a paste terminator", () => {
    expect(buildPromptPayload("x\x1b[201~rm")).toBe("\x1b[200~x[201~rm\x1b[201~\r");
  });
});

describe("system records", () => {
  it("do not start turns or set prompts", () => {
    const t = buildTurns([user("hi"), say("yo"), base({ kind: "system", text: "<system-reminder>x" }), say("more")]);
    expect(t).toHaveLength(1);
    expect(t[0].prompt?.text).toBe("hi");
  });
  it("defensively skips wrapper-tag user prompts", () => {
    const t = buildTurns([
      user("real"), say("a"),
      user("<task-notification>done</task-notification>"),
      user("<system-reminder>x"), user("<command-name>/x"), user("<local-command-stdout>o"),
      user("<command-message>m"), user("<command-args>a"),
      say("b"),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].items).toHaveLength(2);
    expect(t[0].notes).toHaveLength(6);
  });
  it("keeps ordinary prompts that merely start with <", () => {
    expect(isSystemPromptText("<div> why")).toBe(false);
    expect(isSystemPromptText("  <system-reminder>x")).toBe(true);
    expect(buildTurns([user("<div> why")])).toHaveLength(1);
  });
  it("collects system notes separately from items", () => {
    const t = buildTurns([user("hi"), base({ kind: "system", text: "compact summary" }), say("x")]);
    expect(t[0].items.map((i) => i.kind)).toEqual(["text"]);
    expect(t[0].notes.map((r) => r.text)).toEqual(["compact summary"]);
  });
});

describe("TN2 activity folding", () => {
  const run = () => buildTurns([
    user("go"), say("start"),
    use("e1", "Edit", "a", ["/p/a.ts"], 2, 1), use("e2", "Edit", "b", ["/p/a.ts"], 1, 0), use("e3", "Write", "c", ["/p/c.ts"], 5, 0),
    use("b1", "Bash", "npm test"), use("b2", "Bash", "ls"),
    use("r1", "Read", "x", ["/p/x"]), use("r2", "Read", "y", ["/p/y"]),
    res("e1", "ok"), res("b1", "bad", true),
    say("done"), use("g", "Grep", "foo"), say("end"),
  ]);

  it("folds a run of tool groups into one activity and leaves single groups alone", () => {
    const items = foldActivity(run()[0].items);
    expect(items.map((i) => i.kind)).toEqual(["text", "activity", "text", "tools", "text"]);
    const a = items[1];
    expect(a.kind === "activity" && a.calls.length).toBe(7);
  });

  it("labels verb first in fixed order, unique files for edits and reads", () => {
    const a = foldActivity(run()[0].items)[1];
    if (a.kind !== "activity") throw new Error("not activity");
    expect(activityLabel(a.calls, 0)).toBe("Edited 2 files, ran 2 commands, read 2 files");
  });

  it("caps at three segments with +N more, and counts subagents", () => {
    const t = buildTurns([
      user("go"), use("e", "Edit", "a", ["/a"]), use("b", "Bash", "x"), use("r", "Read", "y", ["/y"]),
      use("g", "Grep", "z"), use("w", "WebFetch", "u"), use("ag", "Agent", "sub"),
    ]);
    const a = foldActivity(t[0].items)[0];
    if (a.kind !== "activity") throw new Error("not activity");
    expect(activityLabel(a.calls, 0)).toBe("Edited 1 file, ran 1 command, read 1 file +3 more");
    expect(activityLabel([a.calls[5]], 1)).toBe("Ran 2 subagents");
  });

  it("single calls keep their chip label", () => {
    const t = buildTurns([user("go"), use("e", "Edit", "a", ["/p/a.ts"], 2, 1)]);
    const only = t[0].items[0];
    if (only.kind !== "tools") throw new Error("not tools");
    expect(activityLabel(only.calls, 0, "/p")).toBe("Edited a.ts +2 -1");
  });

  it("flags the trailing call without a result as running only for the live turn", () => {
    const t = buildTurns([user("go"), use("a", "Read", "x", ["/x"]), use("b", "Bash", "sleep 9"), res("a", "ok")]);
    const live = foldActivity(t[0].items, true)[0];
    const old = foldActivity(t[0].items, false)[0];
    if (live.kind !== "activity" || old.kind !== "activity") throw new Error("not activity");
    expect(runningCall(live)?.tool.id).toBe("b");
    expect(runningCall(old)).toBeNull();
  });

  it("planFind opens the activity line that holds a hit", () => {
    const turns = run();
    const plan = planFind(turns, "npm test");
    const a = foldActivity(turns[0].items)[1];
    expect(plan.keys).toContain(callKey((turns[0].items[3] as Extract<typeof turns[0]["items"][number], { kind: "tools" }>).calls[0]));
    expect(a.kind === "activity" && plan.expand.has(a.key)).toBe(true);
  });
});

describe("TN3 subagent line", () => {
  const link = { id: "a1", toolUseId: "t1", agentType: "fork", description: "Build element 11", jsonlPath: "/x", edits: 4, commands: 25, reads: 0, searches: 0, other: 0, finished: false, lastActivityMs: 1_000_000 };
  it("drops zero counts and pluralises", () => {
    expect(subagentCounts(link)).toBe("4 edits, 25 commands");
    expect(subagentCounts({ ...link, edits: 1, commands: 0, reads: 1 })).toBe("1 edit, 1 read");
    expect(subagentLabel(link)).toBe("Subagent: Build element 11 · 4 edits, 25 commands");
    expect(subagentLabel({ ...link, description: null, edits: 0, commands: 0 })).toBe("Subagent: fork");
  });
  it("is running, quiet after 2 minutes idle, done when finished", () => {
    expect(subagentStatus(link, 1_000_000 + 60_000)).toBe("running");
    expect(subagentStatus(link, 1_000_000 + 121_000)).toBe("quiet");
    expect(subagentStatus({ ...link, finished: true }, 1_000_000 + 999_000)).toBe("done");
  });
});

describe("TN4 change row", () => {
  it("sums +/- over edit-class calls and counts unique files", () => {
    const t = buildTurns([
      user("go"), use("a", "Edit", "x", ["/p/a.ts"], 10, 2), use("b", "Write", "y", ["/p/b.ts"], 100, 0),
      use("c", "Edit", "z", ["/p/a.ts"], 10, 16), use("d", "Bash", "ls", [], 99, 99),
    ]);
    const c = changeSummary(t[0]);
    expect([c.files.length, c.added, c.removed]).toEqual([2, 120, 18]);
    expect(changeLabel(c.files, c.added, c.removed, "/p")).toBe("Changed 2 files +120 -18");
  });
  it("names the file when there is one, and omits a zero stat", () => {
    expect(changeLabel(["/p/src/x.ts"], 4, 1, "/p")).toBe("Changed src/x.ts +4 -1");
    expect(changeLabel(["/p/src/x.ts"], 0, 0, "/p")).toBe("Changed src/x.ts");
  });
});

describe("TN6 density measure", () => {
  // A realistic multi-file edit turn: prompt, prose, 6 Edits over 4 files, 3 Bash, 8 Reads, 2 Grep, a subagent, closing prose.
  const turn = () => {
    const recs: ChatRecord[] = [user("Wire the uploader through the new limiter"), say("Reading the modules, then changing four files.")];
    for (let i = 0; i < 8; i++) recs.push(use(`r${i}`, "Read", `src/m${i}.ts`, [`/p/src/m${i}.ts`]), res(`r${i}`, "ok"));
    const edits: [string, string][] = [["e1", "a"], ["e2", "b"], ["e3", "b"], ["e4", "c"], ["e5", "d"], ["e6", "d"]];
    edits.forEach(([id, f], i) => {
      recs.push(use(id, "Edit", `src/${f}.ts`, [`/p/src/${f}.ts`], 5, 1), res(id, "ok"));
      if (i === 0) recs.push(use("b1", "Bash", "npm run build"), res("b1", "ok"));
    });
    recs.push(use("b2", "Bash", "npm test"), res("b2", "ok"), use("b3", "Bash", "npm run lint"), res("b3", "ok"));
    recs.push(use("g1", "Grep", "limiter"), res("g1", "ok"), use("g2", "Grep", "TODO"), res("g2", "ok"));
    recs.push(use("ag", "Agent", "Build element 11"), res("ag", "done"));
    recs.push(say("All four files are updated and the checks pass."));
    return buildTurns(recs)[0];
  };
  const rows = (t: ReturnType<typeof turn>, normal: boolean) =>
    (normal ? foldActivity(t.items) : t.items).length + (t.files.length ? 1 : 0);

  it("Normal renders the turn in at most 5 rows below the prompt; Verbose keeps every group", () => {
    const t = turn();
    expect(rows(t, true)).toBeLessThanOrEqual(5);
    expect(rows(t, false)).toBeGreaterThan(rows(t, true));
    const a = foldActivity(t.items)[1];
    expect(a.kind === "activity" && activityLabel(a.calls, 0)).toBe("Edited 4 files, ran 3 commands, read 8 files +3 more");
  });
});
