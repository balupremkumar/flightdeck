// mcphealth.ts: G2, MCP health per pane. Pure matchers plus a tiny per-pane map.
//
// The strings are the ones Claude Code 2.1.289 prints in its TUI, read from the
// installed binary (npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe):
//   disconnect toast  MCP server "NAME" disconnected · open /mcp to reconnect
//   sign-in needed    MCP server "NAME" needs you to sign in again (run /mcp ...)
//                     MCP server "NAME" needs you to sign in; run /mcp to authenticate.
//   stuck prompt      An MCP server needs your input   (elicitation dialog; the
//                     Notification hook carries the same text, type elicitation_dialog
//                     or elicitation_url_dialog)
// A disconnect or sign-in notice is ambient (a chip, never rings). A pane sitting
// on the input prompt is blocked on a human, so attention.ts treats it as such.

export type McpSignal =
  | { kind: "disconnected"; server: string }
  | { kind: "auth"; server: string }
  | { kind: "input" };

const DISCONNECTED_RE = /MCP server "([^"]+)" disconnected/i;
const AUTH_RE = /MCP server "([^"]+)" needs you to sign in/i;
export const MCP_INPUT_RE = /an mcp server needs your input/i;

/** Classify one line of pane output, or null when it is not an MCP notice. */
export function scanMcpLine(line: string | undefined | null): McpSignal | null {
  if (!line) return null;
  if (MCP_INPUT_RE.test(line)) return { kind: "input" };
  const d = DISCONNECTED_RE.exec(line);
  if (d) return { kind: "disconnected", server: d[1] };
  const a = AUTH_RE.exec(line);
  if (a) return { kind: "auth", server: a[1] };
  return null;
}

/** True when the line is Claude's "an MCP server needs your input" prompt. */
export function isMcpInputPrompt(line: string | undefined | null): boolean {
  return !!line && MCP_INPUT_RE.test(line);
}

export interface McpNotice { kind: "disconnected" | "auth"; server: string; at: number }

/** How long a disconnect/sign-in chip stays up with no newer word from Claude.
 *  The toast itself is gone after 12s and there is no "reconnected" line to key
 *  on, so the chip expires rather than lying forever. */
export const MCP_NOTICE_TTL_MS = 30 * 60 * 1000;

const notices = new Map<number, Map<string, McpNotice>>();

/** Feed a pane output line. Returns true when the chip's content changed. */
export function noteMcpLine(paneId: number, line: string, now: number = Date.now()): boolean {
  const sig = scanMcpLine(line);
  if (!sig || sig.kind === "input") return false;
  let m = notices.get(paneId);
  if (!m) notices.set(paneId, (m = new Map()));
  const prev = m.get(sig.server);
  m.set(sig.server, { kind: sig.kind, server: sig.server, at: now });
  return !prev || prev.kind !== sig.kind;
}

export function clearMcpNotices(paneId: number): void {
  notices.delete(paneId);
}

/** The one chip a pane header shows, or null. Live notices only, oldest first. */
export function mcpChip(paneId: number, now: number = Date.now()): { label: string; title: string } | null {
  const m = notices.get(paneId);
  if (!m) return null;
  const live = [...m.values()].filter((n) => now - n.at < MCP_NOTICE_TTL_MS).sort((a, b) => a.at - b.at);
  if (live.length === 0) return null;
  const names = live.map((n) => n.server).join(", ");
  const allAuth = live.every((n) => n.kind === "auth");
  return {
    label: live.length === 1 ? (allAuth ? "MCP sign-in" : "MCP down") : `MCP ${live.length} down`,
    title: `MCP ${allAuth ? "needs sign-in" : "disconnected"}: ${names}. Run /mcp in the pane to reconnect or sign in.`,
  };
}
