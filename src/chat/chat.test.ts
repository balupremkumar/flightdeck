import { describe, expect, it } from "vitest";
import type { ChatRecord } from "../chatlog";
import { buildTurns, itemKey, callKey } from "./turns";
import { chipLabel, groupLabel, shortPath } from "./chips";
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
