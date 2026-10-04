// Chip text for tool calls, plus path shortening. Pure.
import type { ChatTool, SubagentLink } from "../chatlog";
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

// TN2: the one-line label for a whole run of calls (Normal density).
export type ToolClass = "edits" | "commands" | "reads" | "searches" | "web" | "subagents" | "other";
/** Fixed segment order: what changed first, then what ran, then what was looked at. */
export const CLASS_ORDER: ToolClass[] = ["edits", "commands", "reads", "searches", "web", "subagents", "other"];
export function toolClass(name: string): ToolClass {
  switch (chipIcon(name)) {
    case "edit": return "edits";
    case "run": return "commands";
    case "read": return "reads";
    case "search": return "searches";
    case "web": return "web";
    case "agent": return "subagents";
    default: return "other";
  }
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SEGMENT: Record<ToolClass, (n: number) => string> = {
  edits: (n) => `edited ${plural(n, "file", "files")}`,
  commands: (n) => `ran ${plural(n, "command", "commands")}`,
  reads: (n) => `read ${plural(n, "file", "files")}`,
  searches: (n) => `ran ${plural(n, "search", "searches")}`,
  web: (n) => `made ${plural(n, "web request", "web requests")}`,
  subagents: (n) => `ran ${plural(n, "subagent", "subagents")}`,
  other: (n) => `used ${plural(n, "other tool", "other tools")}`,
};
const MAX_SEGMENTS = 3;

/**
 * "Edited 4 files, ran 3 commands, read 6 files": verb first, fixed order.
 * Edits and reads count unique files, everything else counts calls. Past three
 * segments the rest collapse into "+N more", N being the remaining actions.
 * A single call keeps its chip label, a run of one tool keeps its group label.
 */
export function activityLabel(calls: ToolCall[], sideSubagents = 0, cwd?: string): string {
  if (!sideSubagents && calls.length === 1) return chipLabel(calls[0].tool, cwd);
  if (!sideSubagents && calls.length > 1 && calls.every((c) => c.tool.name === calls[0].tool.name)) {
    return groupLabel(calls[0].tool.name, calls, cwd);
  }
  const by = new Map<ToolClass, { calls: number; paths: Set<string> }>();
  for (const c of calls) {
    const k = toolClass(c.tool.name);
    const b = by.get(k) ?? { calls: 0, paths: new Set<string>() };
    b.calls++;
    for (const p of c.tool.paths) b.paths.add(p);
    by.set(k, b);
  }
  if (sideSubagents) {
    const b = by.get("subagents") ?? { calls: 0, paths: new Set<string>() };
    b.calls += sideSubagents;
    by.set("subagents", b);
  }
  const segs = CLASS_ORDER.filter((k) => by.has(k)).map((k) => {
    const b = by.get(k)!;
    const n = (k === "edits" || k === "reads") && b.paths.size ? b.paths.size : b.calls;
    return { text: SEGMENT[k](n), calls: b.calls };
  });
  const shown = segs.slice(0, MAX_SEGMENTS).map((s) => s.text).join(", ");
  const rest = segs.slice(MAX_SEGMENTS).reduce((n, s) => n + s.calls, 0);
  const label = rest ? `${shown} +${rest} other` : shown;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Glyph class of the first segment, so the line's icon matches its first word. */
export function activityIcon(calls: ToolCall[], sideSubagents = 0): ChipIcon {
  const present = new Set(calls.map((c) => toolClass(c.tool.name)));
  if (sideSubagents) present.add("subagents");
  const first = CLASS_ORDER.find((k) => present.has(k)) ?? "other";
  return ({ edits: "edit", commands: "run", reads: "read", searches: "search", web: "web", subagents: "agent", other: "tool" } as const)[first];
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

/** TN3: "4 edits, 25 commands"; zero counts dropped. */
export function subagentCounts(l: Pick<SubagentLink, "edits" | "commands" | "reads" | "searches" | "other">): string {
  const part = (n: number, one: string, many: string) => (n > 0 ? [`${n} ${n === 1 ? one : many}`] : []);
  return [
    ...part(l.edits, "edit", "edits"), ...part(l.commands, "command", "commands"), ...part(l.reads, "read", "reads"),
    ...part(l.searches, "search", "searches"), ...part(l.other, "other", "other"),
  ].join(", ");
}

export const SUBAGENT_QUIET_MS = 2 * 60 * 1000;
export type SubagentStatus = "running" | "done" | "idle";
export function subagentStatus(l: Pick<SubagentLink, "finished" | "lastActivityMs">, now: number): SubagentStatus {
  if (l.finished) return "done";
  return now - l.lastActivityMs > SUBAGENT_QUIET_MS ? "idle" : "running";
}

/** A result summary that only says "it worked" adds a row and no information. */
export function isBareOk(summary: string | undefined | null): boolean {
  return /^\s*(ok|done|success|succeeded)\.?\s*$/i.test(summary ?? "");
}

export function subagentLabel(l: SubagentLink): string {
  const counts = subagentCounts(l);
  return `Subagent: ${l.description || l.agentType || "agent"}${counts ? ` · ${counts}` : ""}`;
}

/** TN4: "Changed 5 files +120 -18", or "Changed src/x.ts +4 -1" for a single file. */
export function changeLabel(files: string[], added: number, removed: number, cwd?: string): string {
  const what = files.length === 1 ? shortPath(files[0], cwd) : `${files.length} files`;
  return `Changed ${what}${added || removed ? ` +${added} -${removed}` : ""}`;
}
