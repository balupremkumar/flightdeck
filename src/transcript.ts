// transcript.ts — pure logic behind the per-pane transcript browser (UX-546),
// scrollback export + redaction (UX-547) and "copy the last command" (UX-549).
// No Tauri/DOM dependency here on purpose — everything is plain string/array
// in, string/array out, so it's fully unit-testable and reusable from both
// Transcript.tsx and PaneView.tsx's pane-menu actions.
//
// Source of the lines: Terminal.tsx's xterm buffer — see HANDOFF EDITS for
// the `getScrollbackText()` addition to TerminalHandle this module expects.

/** Splits raw scrollback text into trimmed-of-trailing-whitespace lines,
 *  preserving blank lines (they're real gaps in the output) but normalising
 *  CRLF -> LF so search/line-numbering behaves the same on every platform. */
export function toLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

export interface TranscriptMatch {
  /** 0-based index into the line array. */
  index: number;
  text: string;
}

/** Case-insensitive substring search across the transcript, in document
 *  order. Empty query matches nothing (an empty result set, not "everything"
 *  — the browser falls back to showing the full transcript itself). */
export function searchTranscript(lines: string[], query: string): TranscriptMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: TranscriptMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(q)) out.push({ index: i, text: lines[i] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Redaction (UX-547) — reuses the idea behind src-tauri/src/support.rs's
// `redact()` (159): strip anything key/token-shaped before it leaves the
// machine. Reimplemented in TS (not called via invoke) since scrollback only
// exists in the frontend's xterm buffer — see that file's doc comment.
// ---------------------------------------------------------------------------

const KEY_PREFIXES = [
  "sk-ant-", "sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "glpat-", "AIza", "xoxb-", "xoxp-", "xoxa-", "xoxs-",
];

function stripWrapping(s: string): string {
  return s.replace(/^["',;)(\[\]{}]+|["',;)(\[\]{}]+$/g, "");
}

// Heuristic: a long run of alnum/._- with no path or URL separators, mixing
// letters and digits, looks like an opaque token/secret rather than prose or
// a filesystem path. Mirrors support.rs::is_key_shaped exactly.
function isKeyShaped(word: string): boolean {
  const core = stripWrapping(word);
  if (core.length < 24) return false;
  if (core.includes("/") || core.includes("\\") || core.includes(":")) return false;
  if (!/^[A-Za-z0-9_.-]+$/.test(core)) return false;
  return /[0-9]/.test(core) && /[A-Za-z]/.test(core);
}

function isSecretToken(word: string): boolean {
  const core = stripWrapping(word);
  if (!core) return false;
  return KEY_PREFIXES.some((p) => core.startsWith(p)) || isKeyShaped(word);
}

/** Strips anything key-shaped (API keys, tokens) out of arbitrary text,
 *  token-by-token, line-by-line — same heuristic as the Rust support-bundle
 *  redactor, not cryptographically precise but catches the common shapes. */
export function redactText(input: string): string {
  return input
    .split("\n")
    .map((line) => line.split(" ").map((tok) => (isSecretToken(tok) ? "[REDACTED]" : tok)).join(" "))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Last command (UX-549)
// ---------------------------------------------------------------------------

// Vendor-agnostic markers for "the agent just ran a shell command" — Claude
// Code's CLI prints tool calls as `⏺ Bash(<cmd>)` (a plain `●` bullet in
// narrower terminals/fonts); a bare shell pane just shows its own `$ ` or
// `> ` prompt echo. Ordered most-specific first so a `Bash(...)` line always
// wins over a coincidental `$ ` elsewhere in the same output.
const COMMAND_PATTERNS: RegExp[] = [
  /^\s*[⏺●]\s*Bash\(([^)]+)\)\s*$/,
  /^\s*\$\s+(\S.*)$/,
  /^\s*>\s+(\S.*)$/,
];

/** Scans scrollback lines from the end for the most recent line that looks
 *  like a command the agent (or the shell itself) ran, per COMMAND_PATTERNS
 *  above. Returns null if nothing matches — never guesses. */
export function extractLastCommand(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    for (const re of COMMAND_PATTERNS) {
      const m = re.exec(line);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/** File-safe-ish name for a scrollback export, e.g. "claude-2026-08-01.log". */
export function scrollbackFilename(vendor: string, redacted: boolean): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeVendor = vendor.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "pane";
  return `${safeVendor}-scrollback-${date}${redacted ? "-redacted" : ""}.log`;
}
