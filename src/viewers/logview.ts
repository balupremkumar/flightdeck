// logview.ts — line classification for the log viewer. Pure.

export type LogLevel = "error" | "warn" | "info" | "debug" | "plain";

// Uppercase tokens only, so prose that merely says "error" is left alone.
const LEVEL_RE = /\b(FATAL|CRITICAL|SEVERE|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|VERBOSE)\b/;
// level=error, "level":"warn" (structured logs, any case).
const KV_RE = /\blevel["']?\s*[:=]\s*["']?(fatal|critical|error|err|warn|warning|info|debug|trace)\b/i;
/** Leading ISO-8601 date-time, optionally bracketed. */
const TS_RE = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?/;
const HEAD = 160; // only the start of a line can carry its level

const MAP: Record<string, LogLevel> = {
  fatal: "error", critical: "error", severe: "error", error: "error", err: "error",
  warn: "warn", warning: "warn",
  info: "info",
  debug: "debug", trace: "debug", verbose: "debug",
};

/** Index just past a leading ISO timestamp, or 0 when the line has none. */
export function timestampEnd(line: string): number {
  const m = TS_RE.exec(line);
  return m ? m[0].length : 0;
}

/** Level named on this line, or null when it names none. */
export function lineLevel(line: string): LogLevel | null {
  const head = line.length > HEAD ? line.slice(0, HEAD) : line;
  const m = LEVEL_RE.exec(head) ?? KV_RE.exec(head);
  return m ? MAP[m[1].toLowerCase()] : null;
}

/** Levels for every line. A line that names no level but is indented (a stack
 *  frame, a wrapped message) takes the level of the line above it. */
export function classifyLines(lines: string[]): LogLevel[] {
  const out: LogLevel[] = new Array(lines.length);
  let prev: LogLevel = "plain";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const own = lineLevel(l);
    if (own) prev = own;
    else if (!(l.length > 0 && (l[0] === " " || l[0] === "\t"))) prev = "plain";
    out[i] = own ?? prev;
  }
  return out;
}
