// Chip text for tool calls, plus path shortening. Pure.
import type { ChatTool } from "../chatlog";
import type { ToolCall } from "./turns";

/** cwd-relative path when it sits under cwd, else the last two segments. */
export function shortPath(p: string, cwd?: string): string {
  const norm = p.replace(/\\/g, "/");
  if (cwd) {
    const c = cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    if (norm.toLowerCase().startsWith(c.toLowerCase())) return norm.slice(c.length);
  }
  const parts = norm.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || p;
}

export function diffStat(t: Pick<ChatTool, "added" | "removed">): string {
  if (!t.added && !t.removed) return "";
  return `+${t.added} -${t.removed}`;
}

const withStat = (label: string, t: ChatTool) => {
  const s = diffStat(t);
  return s ? `${label} ${s}` : label;
};

export function chipLabel(tool: ChatTool, cwd?: string): string {
  const target = tool.paths[0] ? shortPath(tool.paths[0], cwd) : tool.summary;
  switch (tool.name) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return withStat(`Edited ${target}`, tool);
    case "Write":
      return withStat(`Wrote ${target}`, tool);
    case "Read":
      return `Read ${target}`;
    case "Bash":
      return `Ran ${tool.summary}`;
    case "Grep":
      return `Searched ${tool.summary}`;
    case "Glob":
      return `Listed ${tool.summary}`;
    case "WebFetch":
      return `Fetched ${tool.summary}`;
    case "WebSearch":
      return `Searched web for ${tool.summary}`;
    case "Task":
    case "Agent":
      return `Subagent: ${tool.summary}`;
    case "TodoWrite":
      return "Updated todos";
    default:
      return `${tool.name} ${tool.summary}`.trim();
  }
}

/** Label for a run of consecutive same-tool calls. One call falls back to its chip. */
export function groupLabel(name: string, calls: ToolCall[], cwd?: string): string {
  if (calls.length === 1) return chipLabel(calls[0].tool, cwd);
  const n = calls.length;
  const files = new Set(calls.flatMap((c) => c.tool.paths)).size;
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      if (files <= 1) {
        const p = calls[0].tool.paths[0];
        return `Edited ${p ? shortPath(p, cwd) : name} x${n}`;
      }
      return `Edited ${files} files`;
    }
    case "Write":
      return `Wrote ${files || n} files`;
    case "Read":
      return `Read ${files || n} files`;
    case "Bash":
      return `Ran ${n} commands`;
    case "Grep":
      return `Ran ${n} searches`;
    case "Glob":
      return `Listed ${n} patterns`;
    case "WebFetch":
      return `Fetched ${n} pages`;
    case "Task":
    case "Agent":
      return `Ran ${n} subagents`;
    default:
      return `${name} x${n}`;
  }
}

export type ChipIcon = "edit" | "run" | "read" | "search" | "web" | "agent" | "tool";
export const CHIP_GLYPH: Record<ChipIcon, string> = {
  edit: "✎", run: "▶", read: "☰", search: "⌕", web: "◎", agent: "✦", tool: "⚙",
};
export function chipIcon(name: string): ChipIcon {
  switch (name) {
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return "edit";
    case "Bash": return "run";
    case "Read": return "read";
    case "Grep": case "Glob": return "search";
    case "WebFetch": case "WebSearch": return "web";
    case "Task": case "Agent": return "agent";
    default: return "tool";
  }
}
