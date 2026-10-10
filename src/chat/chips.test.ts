import { describe, expect, it } from "vitest";
import type { ChatTool, SubagentLink } from "../chatlog";
import type { ToolCall } from "./turns";
import {
  shortPath, diffStat, chipLabel, groupLabel, CLASS_ORDER, toolClass,
  activityLabel, activityIcon, CHIP_GLYPH, chipIcon, subagentCounts,
  SUBAGENT_QUIET_MS, subagentStatus, isBareOk, subagentLabel, changeLabel,
} from "./chips";

const tool = (name: string, extra: Partial<ChatTool> = {}): ChatTool => ({
  id: "tool-1", name, summary: "target", paths: [], added: 0, removed: 0, ...extra,
});
const call = (name: string, paths: string[] = []): ToolCall => {
  const t = tool(name, { paths });
  return {
    tool: t, result: null, resultRec: null,
    rec: { index: 0, block: 0, uuid: null, parent_uuid: null, timestamp: null,
      kind: "tool_use", sidechain: false, text: null, tool: t, result: null },
  };
};
const agent: SubagentLink = {
  id: "agent-1", toolUseId: null, agentType: "reviewer", description: "Review tests",
  jsonlPath: "agent.jsonl", edits: 0, commands: 0, reads: 0, searches: 0, other: 0,
  finished: false, lastActivityMs: 1000,
};

describe("path and change labels", () => {
  it("shortens Windows paths relative to cwd case-insensitively", () => {
    expect(shortPath("D:\\Repo\\src\\app.ts", "d:\\repo\\")).toBe("src/app.ts");
    expect(shortPath("/elsewhere/lib/app.ts", "/repo")).toBe("lib/app.ts");
    expect(shortPath("/repository/src/app.ts", "/repo")).toBe("src/app.ts");
    expect(shortPath("app.ts")).toBe("app.ts");
    expect(shortPath("")).toBe("");
  });
  it("omits zero diff counts and includes additions or removals", () => {
    expect(diffStat({ added: 0, removed: 0 })).toBe("");
    expect(diffStat({ added: 4, removed: 0 })).toBe("+4 -0");
    expect(diffStat({ added: 0, removed: 2 })).toBe("+0 -2");
  });
  it("labels a single relative file or a file count with optional stats", () => {
    expect(changeLabel(["/repo/src/app.ts"], 4, 1, "/repo")).toBe("Changed src/app.ts +4 -1");
    expect(changeLabel(["a.ts", "b.ts"], 0, 0)).toBe("Changed 2 files");
    expect(changeLabel([], 0, 0)).toBe("Changed 0 files");
  });
});

describe("tool chips", () => {
  it.each([
    ["Edit", "Edited target"], ["MultiEdit", "Edited target"],
    ["NotebookEdit", "Edited target"], ["Write", "Wrote target"],
    ["Read", "Read target"], ["Bash", "Ran target"], ["Grep", "Searched target"],
    ["Glob", "Listed target"], ["WebFetch", "Fetched target"],
    ["WebSearch", "Searched web for target"], ["Task", "Subagent: target"],
    ["Agent", "Subagent: target"], ["TodoWrite", "Updated todos"], ["Custom", "Custom target"],
  ])("labels %s", (name, label) => expect(chipLabel(tool(name))).toBe(label));
  it("prefers the first path and adds stats only for writes and edits", () => {
    const extra = { paths: ["/repo/src/a.ts", "/repo/src/b.ts"], added: 3, removed: 1 };
    expect(chipLabel(tool("Edit", extra), "/repo")).toBe("Edited src/a.ts +3 -1");
    expect(chipLabel(tool("Write", extra), "/repo")).toBe("Wrote src/a.ts +3 -1");
    expect(chipLabel(tool("Read", extra), "/repo")).toBe("Read src/a.ts");
    expect(chipLabel(tool("Custom", { summary: "" }))).toBe("Custom");
  });
  it("uses the chip label for one call and unique paths for grouped edits", () => {
    expect(groupLabel("Read", [call("Read", ["/repo/a.ts"])], "/repo")).toBe("Read a.ts");
    expect(groupLabel("Edit", [call("Edit", ["/repo/a.ts"]), call("Edit", ["/repo/a.ts"])], "/repo")).toBe("Edited a.ts x2");
    expect(groupLabel("MultiEdit", [call("MultiEdit", ["a.ts", "b.ts"]), call("MultiEdit", ["a.ts"])])).toBe("Edited 2 files");
  });
  it.each([
    ["Write", "Wrote 2 files"], ["Read", "Read 2 files"], ["Bash", "Ran 2 commands"],
    ["Grep", "Ran 2 searches"], ["Glob", "Listed 2 patterns"], ["WebFetch", "Fetched 2 pages"],
    ["Task", "Ran 2 subagents"], ["Agent", "Ran 2 subagents"], ["Custom", "Custom x2"],
  ])("groups %s calls without paths", (name, label) => {
    expect(groupLabel(name, [call(name), call(name)])).toBe(label);
  });
  it.each([
    ["Edit", "edit", "edits"], ["MultiEdit", "edit", "edits"], ["Write", "edit", "edits"],
    ["NotebookEdit", "edit", "edits"], ["Bash", "run", "commands"], ["Read", "read", "reads"],
    ["Grep", "search", "searches"], ["Glob", "search", "searches"],
    ["WebFetch", "web", "web"], ["WebSearch", "web", "web"],
    ["Task", "agent", "subagents"], ["Agent", "agent", "subagents"], ["Custom", "tool", "other"],
  ])("classifies %s", (name, icon, category) => {
    expect(chipIcon(name)).toBe(icon);
    expect(toolClass(name)).toBe(category);
  });
  it("defines the fixed class order and glyphs", () => {
    expect(CLASS_ORDER).toEqual(["edits", "commands", "reads", "searches", "web", "subagents", "other"]);
    expect(CHIP_GLYPH).toEqual({ edit: "\u270e", run: "\u25b6", read: "\u2630", search: "\u2315", web: "\u25ce", agent: "\u2726", tool: "\u2699" });
  });
});

describe("activity labels and icons", () => {
  it("retains single chips and same-tool group labels", () => {
    expect(activityLabel([call("Read", ["/repo/a.ts"])], 0, "/repo")).toBe("Read a.ts");
    expect(activityLabel([call("Bash"), call("Bash")])).toBe("Ran 2 commands");
    expect(activityLabel([])).toBe("");
  });
  it("orders mixed classes and counts distinct edited and read paths", () => {
    const calls = [call("Read", ["a.ts", "b.ts"]), call("Bash"), call("Edit", ["a.ts"]), call("Write", ["a.ts"]), call("Read", ["a.ts"])];
    expect(activityLabel(calls)).toBe("Edited 1 file, ran 1 command, read 2 files");
    expect(activityIcon(calls)).toBe("edit");
  });
  it("combines side subagents with calls and uses their icon when alone", () => {
    expect(activityLabel([call("Agent")], 2)).toBe("Ran 3 subagents");
    expect(activityLabel([], 1)).toBe("Ran 1 subagent");
    expect(activityIcon([], 1)).toBe("agent");
    expect(activityIcon([])).toBe("tool");
    expect(activityIcon([call("WebSearch"), call("Bash")], 1)).toBe("run");
  });
  it("pluralises mixed searches, web requests and other tools", () => {
    expect(activityLabel([call("Grep"), call("Glob"), call("WebFetch"), call("WebSearch"), call("Custom")])).toBe("Ran 2 searches, made 2 web requests, used 1 other tool");
  });
});

describe("subagents", () => {
  it("drops zero counts and uses singular and plural words", () => {
    expect(subagentCounts(agent)).toBe("");
    expect(subagentCounts({ edits: 1, commands: 2, reads: 1, searches: 2, other: 1 })).toBe("1 edit, 2 commands, 1 read, 2 searches, 1 other");
  });
  it("becomes idle only after the quiet boundary, unless finished", () => {
    expect(SUBAGENT_QUIET_MS).toBe(120000);
    expect(subagentStatus(agent, 1000)).toBe("running");
    expect(subagentStatus(agent, 121000)).toBe("running");
    expect(subagentStatus(agent, 121001)).toBe("idle");
    expect(subagentStatus({ ...agent, finished: true }, 121001)).toBe("done");
  });
  it.each(["ok", " DONE. ", "Success", "succeeded."])("recognises bare acknowledgement %s", (text) => expect(isBareOk(text)).toBe(true));
  it.each([undefined, null, "", "okay", "done with tests", "not ok"])("keeps informative or absent summaries (%s)", (text) => expect(isBareOk(text)).toBe(false));
  it("uses description, then type, then agent, and appends useful counts", () => {
    expect(subagentLabel(agent)).toBe("Subagent: Review tests");
    expect(subagentLabel({ ...agent, description: null, commands: 2 })).toBe("Subagent: reviewer \u00b7 2 commands");
    expect(subagentLabel({ ...agent, description: null, agentType: null })).toBe("Subagent: agent");
  });
});
