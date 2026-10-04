import { beforeEach, describe, expect, it } from "vitest";
import { clearMcpNotices, isMcpInputPrompt, mcpChip, MCP_NOTICE_TTL_MS, noteMcpLine, scanMcpLine } from "./mcphealth";
import { attentionKind, lastLine } from "./attention";
import type { PaneModel } from "./store";

describe("scanMcpLine (strings from claude 2.1.289)", () => {
  it("reads the disconnect toast", () => {
    expect(scanMcpLine('MCP server "github" disconnected · open /mcp to reconnect')).toEqual({ kind: "disconnected", server: "github" });
  });
  it("reads the sign-in notices", () => {
    expect(scanMcpLine('MCP server "linear" needs you to sign in; run /mcp to authenticate.')).toEqual({ kind: "auth", server: "linear" });
    expect(scanMcpLine('MCP server "linear" needs you to sign in again (run /mcp to reconnect)')).toEqual({ kind: "auth", server: "linear" });
  });
  it("reads the stuck input prompt and ignores other text", () => {
    expect(scanMcpLine("An MCP server needs your input")).toEqual({ kind: "input" });
    expect(isMcpInputPrompt("An MCP server needs your input")).toBe(true);
    expect(scanMcpLine("I added an MCP server config")).toBeNull();
    expect(scanMcpLine("")).toBeNull();
    expect(scanMcpLine(undefined)).toBeNull();
  });
});

describe("mcpChip", () => {
  beforeEach(() => clearMcpNotices(1));
  it("names the server and expires", () => {
    expect(mcpChip(1)).toBeNull();
    expect(noteMcpLine(1, 'MCP server "github" disconnected · open /mcp to reconnect', 1000)).toBe(true);
    expect(noteMcpLine(1, 'MCP server "github" disconnected · open /mcp to reconnect', 2000)).toBe(false);
    const c = mcpChip(1, 3000)!;
    expect(c.label).toBe("MCP down");
    expect(c.title).toContain("github");
    expect(mcpChip(1, 2000 + MCP_NOTICE_TTL_MS + 1)).toBeNull();
  });
  it("collapses several into one chip", () => {
    noteMcpLine(1, 'MCP server "a" disconnected', 1000);
    noteMcpLine(1, 'MCP server "b" needs you to sign in', 1001);
    const c = mcpChip(1, 1002)!;
    expect(c.label).toBe("MCP 2 down");
    expect(c.title).toContain("a, b");
  });
});

describe("attentionKind and a stuck MCP prompt", () => {
  const pane = (state: PaneModel["state"]) => ({ id: 77, state } as PaneModel);
  it("is needs-human when quiet on the prompt, ambient otherwise", () => {
    lastLine.set(77, "An MCP server needs your input");
    expect(attentionKind(pane("waiting"))).toBe("permission");
    expect(attentionKind(pane("running"))).toBeNull();
    lastLine.set(77, 'MCP server "github" disconnected · open /mcp to reconnect');
    expect(attentionKind(pane("waiting"))).toBeNull();
  });
});
