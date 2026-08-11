// ConfigDoctorView.tsx — QL-774 (config doctor) + QL-773 (hook inspector,
// view-only slice), mounted inside Settings > Diagnostics.
//
// WHY THIS EXISTS
// Claude Code settings fail silently. A settings.json with a trailing comma, a
// UTF-8 BOM, or a misspelled top-level key is simply ignored: no warning in the
// CLI, no clue in the pane, just permissions that don't behave the way the file
// says they should. Hooks are worse — they're documented as failing silently by
// design. This surface reads the same files Claude Code reads and says out loud
// what it finds.
//
// SCOPE THIS WAVE (deliberately narrow, and stated in the UI, not just here):
//  * READ ONLY. No write-back, no editing, no "fix it for me".
//  * THREE FILE SCOPES ONLY — user (~/.claude/settings.json), project
//    (<cwd>/.claude/settings.json) and project-local
//    (<cwd>/.claude/settings.local.json). The real precedence chain is
//    managed > CLI flags > local > project > user; managed policy and CLI flags
//    are NOT visible from here, so the merge below is the bottom three rungs and
//    labels itself as such.
//  * No hook fire history. That needs runtime wiring (a hook that reports back
//    into Flightdeck), so the panel says so rather than showing an empty table
//    that pretends to be a log.
//
// Reads go through the existing `fs_read_text_file` IPC (lib.rs:437), which
// takes absolute paths; the home directory comes from Tauri's path API
// (core:path:default, already in the default capability), mirroring how
// usage.rs resolves USERPROFILE on the Rust side.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useApp } from "./store";

// ---------------------------------------------------------------------
// Pure logic (exported for ConfigDoctorView.test.ts — no DOM, no Tauri)
// ---------------------------------------------------------------------

export type ConfigScope = "user" | "project" | "local";

/** Lowest precedence first: a later scope's scalar value wins. */
export const SCOPE_ORDER: ConfigScope[] = ["user", "project", "local"];

export const SCOPE_LABEL: Record<ConfigScope, string> = {
  user: "user",
  project: "project",
  local: "local",
};

export interface ConfigFile {
  scope: ConfigScope;
  path: string;
  /** ok = parsed; invalid = found but Claude Code can't read it; missing = not
   *  on disk (normal); unreadable = the read itself failed (permissions, etc). */
  status: "ok" | "invalid" | "missing" | "unreadable";
  data?: Record<string, unknown>;
  /** Leading U+FEFF — the trap this whole panel exists for. */
  bom?: boolean;
  parseError?: { message: string; line?: number; column?: number };
  readError?: string;
  unknownKeys?: string[];
}

/** Joins with the separator the base path already uses (Windows paths keep
 *  backslashes so the string matches what Explorer and the CLI both show). */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** The three files this wave covers, lowest precedence first. A null home or
 *  cwd simply drops that scope rather than inventing a path. */
export function claudeConfigPaths(home: string | null, cwd: string | null): Array<{ scope: ConfigScope; path: string }> {
  const out: Array<{ scope: ConfigScope; path: string }> = [];
  if (home) out.push({ scope: "user", path: joinPath(home, ".claude", "settings.json") });
  if (cwd) {
    out.push({ scope: "project", path: joinPath(cwd, ".claude", "settings.json") });
    out.push({ scope: "local", path: joinPath(cwd, ".claude", "settings.local.json") });
  }
  return out;
}

/** A read failure that just means "no such file" is not a problem — most people
 *  have no project settings at all. Anything else is a real read error worth
 *  naming (locked file, permissions, a directory where a file should be). */
export function isMissingFileError(message: string): boolean {
  return /os error 2\b|os error 3\b|cannot find the (file|path)|no such file/i.test(message);
}

/** 0-based character offset -> 1-based line/column, for JSON.parse's `position`. */
export function positionToLineCol(text: string, pos: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(pos, text.length));
  const before = text.slice(0, clamped);
  const nl = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: clamped - nl };
}

export interface ParsedSettings {
  bom: boolean;
  data?: Record<string, unknown>;
  error?: { message: string; line?: number; column?: number };
}

/**
 * Parses one settings file the way the failure modes actually present.
 *
 * The BOM case is called out separately and treated as fatal even though the
 * bytes after it are perfect JSON: `JSON.parse` (which is what reads these
 * files) throws on a leading U+FEFF, so the file is ignored in full. That is
 * exactly the trap PowerShell's `Set-Content -Encoding UTF8` sets, and it has
 * already bitten this project once (see STATE.md, the updater's failure
 * reporting). We still parse the stripped text so the panel can show what the
 * file WOULD contribute once the BOM is gone.
 */
export function parseSettingsText(raw: string): ParsedSettings {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  try {
    const value: unknown = JSON.parse(body);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { bom, error: { message: "the file is valid JSON but not an object — settings must be a { } object" } };
    }
    return { bom, data: value as Record<string, unknown> };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // V8 reports either "... at position 42" or "... (line 4 column 3)"
    // depending on version; prefer the explicit line/column when it's there.
    const lc = /line (\d+) column (\d+)/.exec(message);
    if (lc) return { bom, error: { message, line: Number(lc[1]), column: Number(lc[2]) } };
    const p = /position (\d+)/.exec(message);
    if (p) return { bom, error: { message, ...positionToLineCol(body, Number(p[1])) } };
    return { bom, error: { message } };
  }
}

/**
 * Top-level keys Claude Code is known to read. Used ONLY for a gentle warning —
 * an unknown key here is far more likely to mean "this build's list is out of
 * date" than "your config is wrong", so the copy says so and nothing is ever
 * hidden or removed because of it.
 */
export const KNOWN_TOP_LEVEL_KEYS = [
  "$schema", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "cleanupPeriodDays",
  "disableAllHooks", "enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers",
  "env", "forceLoginMethod", "forceLoginOrgUUID", "hooks", "includeCoAuthoredBy", "model",
  "outputStyle", "otelHeadersHelper", "permissions", "statusLine",
];

export function unknownTopLevelKeys(data: Record<string, unknown>): string[] {
  const known = new Set(KNOWN_TOP_LEVEL_KEYS);
  return Object.keys(data).filter((k) => !known.has(k));
}

function getPath(data: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = data;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Scalar permission-relevant keys: last scope in SCOPE_ORDER wins outright. */
export const PERMISSION_SCALAR_KEYS = [
  "permissions.defaultMode",
  "permissions.disableBypassPermissionsMode",
  "enableAllProjectMcpServers",
  "disableAllHooks",
  "apiKeyHelper",
];

/** List-valued permission keys: every scope CONTRIBUTES (rules combine, they
 *  don't replace), so these are shown as a union with the source per rule. */
export const PERMISSION_LIST_KEYS = [
  "permissions.allow",
  "permissions.ask",
  "permissions.deny",
  "permissions.additionalDirectories",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
];

export interface ScalarRow {
  key: string;
  value: string;
  source: ConfigScope;
  /** Scopes that set the same key and lost. */
  overridden: ConfigScope[];
}

export function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? String(v);
}

export function effectiveScalars(files: ConfigFile[]): ScalarRow[] {
  const byScope = new Map<ConfigScope, ConfigFile>();
  for (const f of files) if (f.status === "ok" && f.data) byScope.set(f.scope, f);
  const rows: ScalarRow[] = [];
  for (const key of PERMISSION_SCALAR_KEYS) {
    const setters: Array<{ scope: ConfigScope; value: unknown }> = [];
    for (const scope of SCOPE_ORDER) {
      const f = byScope.get(scope);
      if (!f?.data) continue;
      const v = getPath(f.data, key);
      if (v !== undefined) setters.push({ scope, value: v });
    }
    if (setters.length === 0) continue;
    const winner = setters[setters.length - 1];
    rows.push({
      key,
      value: formatValue(winner.value),
      source: winner.scope,
      overridden: setters.slice(0, -1).map((s) => s.scope),
    });
  }
  return rows;
}

export interface RuleRow {
  key: string;
  rule: string;
  sources: ConfigScope[];
  /** A non-string entry in a rule list — Claude Code expects strings. */
  invalid?: boolean;
}

export function effectiveRules(files: ConfigFile[]): RuleRow[] {
  const byScope = new Map<ConfigScope, ConfigFile>();
  for (const f of files) if (f.status === "ok" && f.data) byScope.set(f.scope, f);
  const index = new Map<string, RuleRow>();
  const rows: RuleRow[] = [];
  for (const key of PERMISSION_LIST_KEYS) {
    for (const scope of SCOPE_ORDER) {
      const f = byScope.get(scope);
      if (!f?.data) continue;
      const v = getPath(f.data, key);
      if (v === undefined) continue;
      if (!Array.isArray(v)) {
        const row: RuleRow = { key, rule: formatValue(v), sources: [scope], invalid: true };
        rows.push(row);
        continue;
      }
      for (const entry of v) {
        const invalid = typeof entry !== "string";
        const rule = formatValue(entry);
        const id = `${key} :: ${rule}`;
        const existing = index.get(id);
        if (existing) {
          if (!existing.sources.includes(scope)) existing.sources.push(scope);
          continue;
        }
        const row: RuleRow = { key, rule, sources: [scope], invalid: invalid || undefined };
        index.set(id, row);
        rows.push(row);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// Hooks (QL-773, view-only slice)
// ---------------------------------------------------------------------

/** Events this build knows. An event outside the list gets a gentle warning,
 *  not an error — Claude Code adds events faster than Flightdeck ships. */
export const HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "Notification", "UserPromptSubmit",
  "Stop", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
];

/** Events where a matcher means something. Everywhere else a matcher is
 *  silently ignored, which is worth saying out loud. */
export const MATCHER_EVENTS = ["PreToolUse", "PostToolUse", "PreCompact", "SessionStart"];

export interface HookRow {
  event: string;
  /** null = no matcher given (runs for every match on a matcher event). */
  matcher: string | null;
  command: string;
  source: ConfigScope;
  issues: string[];
}

export interface HookScan {
  hooks: HookRow[];
  /** Problems with the shape of the `hooks` block itself, per file. */
  problems: Array<{ source: ConfigScope; message: string }>;
}

export function collectHooks(files: ConfigFile[]): HookScan {
  const hooks: HookRow[] = [];
  const problems: Array<{ source: ConfigScope; message: string }> = [];
  for (const scope of SCOPE_ORDER) {
    const file = files.find((f) => f.scope === scope && f.status === "ok" && f.data);
    const block = file?.data?.hooks;
    if (block === undefined) continue;
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      problems.push({ source: scope, message: "`hooks` should be an object keyed by event name." });
      continue;
    }
    for (const [event, groups] of Object.entries(block as Record<string, unknown>)) {
      const eventIssues: string[] = [];
      if (!HOOK_EVENTS.includes(event)) {
        eventIssues.push(`“${event}” isn’t an event this build knows — check the spelling (it may also be newer than Flightdeck).`);
      }
      if (!Array.isArray(groups)) {
        problems.push({ source: scope, message: `hooks.${event} should be a list of matcher groups, not ${typeof groups}.` });
        continue;
      }
      for (const group of groups) {
        if (group === null || typeof group !== "object" || Array.isArray(group)) {
          problems.push({ source: scope, message: `hooks.${event} contains an entry that isn’t an object.` });
          continue;
        }
        const g = group as Record<string, unknown>;
        const groupIssues = [...eventIssues];
        let matcher: string | null = null;
        if (g.matcher !== undefined) {
          if (typeof g.matcher !== "string") {
            groupIssues.push("matcher must be a string (a tool-name pattern), not " + (Array.isArray(g.matcher) ? "a list" : typeof g.matcher) + ".");
            matcher = formatValue(g.matcher);
          } else {
            matcher = g.matcher;
            if (!MATCHER_EVENTS.includes(event) && HOOK_EVENTS.includes(event)) {
              groupIssues.push(`${event} ignores matchers — this hook runs on every ${event}.`);
            }
            try {
              new RegExp(g.matcher);
            } catch {
              groupIssues.push("matcher isn’t a valid regular expression, so it will never match.");
            }
          }
        }
        const list = g.hooks;
        if (!Array.isArray(list)) {
          problems.push({ source: scope, message: `hooks.${event} group is missing its \`hooks\` list.` });
          continue;
        }
        for (const h of list) {
          if (h === null || typeof h !== "object" || Array.isArray(h)) {
            problems.push({ source: scope, message: `hooks.${event} contains a hook that isn’t an object.` });
            continue;
          }
          const hook = h as Record<string, unknown>;
          const issues = [...groupIssues];
          if (hook.type !== undefined && hook.type !== "command") {
            issues.push(`type “${formatValue(hook.type)}” isn’t recognised — hooks run commands.`);
          }
          let command: string;
          if (typeof hook.command !== "string") {
            command = hook.command === undefined ? "(none)" : formatValue(hook.command);
            issues.push(hook.command === undefined
              ? "no command — this hook does nothing."
              : "command must be a string, so this hook never runs.");
          } else {
            command = hook.command;
            if (!hook.command.trim()) issues.push("command is empty, so this hook does nothing.");
          }
          hooks.push({ event, matcher, command, source: scope, issues });
        }
      }
    }
  }
  return { hooks, problems };
}

// ---------------------------------------------------------------------
// Overall state (drives which of the five UI states renders)
// ---------------------------------------------------------------------

export type DoctorState = "empty" | "partial" | "ideal";

/**
 * "partial" is deliberately load-bearing: it means at least one scope could not
 * be read or parsed, so the merge below it is INCOMPLETE and must say so.
 */
export function doctorState(files: ConfigFile[]): DoctorState {
  const usable = files.filter((f) => f.status === "ok");
  const broken = files.filter((f) => f.status === "invalid" || f.status === "unreadable");
  if (usable.length === 0 && broken.length === 0) return "empty";
  if (broken.length > 0) return "partial";
  return "ideal";
}

// ---------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------

// The Diagnostics tables share `.diag-table`/`.diag-tr` (overlays.css:342), but
// that grid is tuned to the 5-column health table. These panels have different
// column counts, so each overrides just the template inline — no new CSS file
// ownership this wave, and every colour/spacing token still comes from the
// shared rules.
const FILE_COLS: CSSProperties = { gridTemplateColumns: "68px minmax(0,1fr) 74px 58px" };
const NOTE_COLS: CSSProperties = { gridTemplateColumns: "minmax(0,1fr)" };
const RULE_COLS: CSSProperties = { gridTemplateColumns: "116px minmax(0,1fr) 104px" };
const SCALAR_COLS: CSSProperties = { gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 104px" };
const HOOK_COLS: CSSProperties = { gridTemplateColumns: "108px 84px minmax(0,1fr) 62px" };

function shortKey(key: string): string {
  return key.startsWith("permissions.") ? key.slice("permissions.".length) : key;
}

function sourceText(scopes: ConfigScope[]): string {
  return scopes.map((s) => SCOPE_LABEL[s]).join(" + ");
}

type Phase = "loading" | "ready" | "error";

export function ConfigDoctorView() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [files, setFiles] = useState<ConfigFile[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [errMsg, setErrMsg] = useState("");
  const seq = useRef(0);

  // The pane whose configuration is actually in play: the focused pane's cwd
  // (which for an isolated pane IS its worktree, and that's the folder Claude
  // Code resolves project settings from), falling back to the workspace root.
  const cwd = useApp((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeId);
    if (!ws) return null;
    const pane = ws.panes.find((p) => p.id === ws.focused) ?? ws.panes[0];
    return pane?.cwd ?? ws.root ?? null;
  });

  const load = useCallback(async () => {
    const my = ++seq.current;
    setPhase("loading");
    let home: string | null = null;
    try {
      home = await homeDir();
    } catch {
      home = null; // no user scope; the project scopes may still work
    }
    const specs = claudeConfigPaths(home, cwd);
    if (seq.current !== my) return;
    if (specs.length === 0) {
      setChecked([]);
      setFiles([]);
      setErrMsg("Flightdeck couldn’t work out where your Claude configuration lives — the home folder didn’t resolve and no pane is open to give a project folder.");
      setPhase("error");
      return;
    }
    const results = await Promise.all(specs.map(async (spec): Promise<ConfigFile> => {
      try {
        const raw = await invoke<string>("fs_read_text_file", { path: spec.path });
        const parsed = parseSettingsText(raw);
        if (parsed.bom) {
          return {
            ...spec, status: "invalid", bom: true, data: parsed.data,
            parseError: parsed.error,
            unknownKeys: parsed.data ? unknownTopLevelKeys(parsed.data) : undefined,
          };
        }
        if (parsed.error) return { ...spec, status: "invalid", parseError: parsed.error };
        return { ...spec, status: "ok", data: parsed.data, unknownKeys: parsed.data ? unknownTopLevelKeys(parsed.data) : [] };
      } catch (e) {
        const message = String(e);
        return isMissingFileError(message)
          ? { ...spec, status: "missing" }
          : { ...spec, status: "unreadable", readError: message };
      }
    }));
    if (seq.current !== my) return;
    setChecked(specs.map((s) => s.path));
    setFiles(results);
    // Every read failing for a non-missing reason means the read path itself is
    // broken (no IPC outside Tauri, for instance), not that the config is bad.
    if (results.length > 0 && results.every((r) => r.status === "unreadable")) {
      setErrMsg(results[0].readError ?? "the files couldn’t be read");
      setPhase("error");
      return;
    }
    setErrMsg("");
    setPhase("ready");
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);

  const state = useMemo(() => doctorState(files), [files]);
  const scalars = useMemo(() => effectiveScalars(files), [files]);
  const rules = useMemo(() => effectiveRules(files), [files]);
  const { hooks, problems } = useMemo(() => collectHooks(files), [files]);
  const brokenFiles = files.filter((f) => f.status === "invalid" || f.status === "unreadable");

  return (
    <>
      <div className="set-row">
        <div className="set-row-t">
          <span className="set-row-name">Config doctor</span>
          <span className="set-row-sub">
            Read-only check of the Claude settings behind your panes: user, project and project-local.
            {" "}Managed policy and CLI flags outrank all three and aren’t visible from here.
          </span>
        </div>
        <button className="set-btn" onClick={() => void load()} disabled={phase === "loading"}>
          {phase === "loading" ? "Reading…" : "Refresh"}
        </button>
      </div>

      {/* LOADING */}
      {phase === "loading" && <div className="diag-empty">Reading your Claude configuration…</div>}

      {/* ERROR */}
      {phase === "error" && (
        <>
          <div className="diag-empty diag-crit">Couldn’t read the configuration: {errMsg}</div>
          {checked.length > 0 && (
            <div className="diag-empty">Tried: {checked.join(" · ")}. Nothing was changed — this panel only reads.</div>
          )}
        </>
      )}

      {/* EMPTY — nothing on disk at all. Not a fault: Claude Code runs on its
          defaults until you write one of these files. */}
      {phase === "ready" && state === "empty" && (
        <>
          <div className="diag-empty">
            No Claude settings files found, so Claude Code is running on its defaults — nothing here is broken.
          </div>
          <div className="diag-table" role="table" aria-label="Paths checked for Claude settings">
            <div className="diag-tr diag-th" role="row" style={FILE_COLS}>
              <span>Scope</span><span>Path</span><span>Status</span><span />
            </div>
            {files.map((f) => (
              <div className="diag-tr" role="row" key={f.path} style={FILE_COLS}>
                <span>{SCOPE_LABEL[f.scope]}</span>
                <span className="diag-proc" title={f.path}>{f.path}</span>
                <span>not found</span>
                <span />
              </div>
            ))}
          </div>
          <div className="diag-empty">
            Create one of these files to set permissions or hooks, then hit Refresh.
          </div>
        </>
      )}

      {/* PARTIAL + IDEAL */}
      {phase === "ready" && state !== "empty" && (
        <>
          {state === "partial" && (
            <div className="diag-empty diag-warn">
              {brokenFiles.length} of {files.length} file{files.length === 1 ? "" : "s"} couldn’t be used
              ({brokenFiles.map((f) => SCOPE_LABEL[f.scope]).join(", ")}), so the merged view below is incomplete —
              Claude Code is ignoring the same files.
            </div>
          )}

          <div className="diag-table" role="table" aria-label="Claude settings files">
            <div className="diag-tr diag-th" role="row" style={FILE_COLS}>
              <span>Scope</span><span>Path</span><span>Status</span><span>Keys</span>
            </div>
            {/* Fragment, not a wrapper div: `.diag-tr:first-child` (overlays.css:351)
                drops the top border, so a wrapper element would make every row in
                the table its own first child and lose all the separators. */}
            {files.map((f) => (
              <Fragment key={f.path}>
                <div className="diag-tr" role="row" style={FILE_COLS}>
                  <span>{SCOPE_LABEL[f.scope]}</span>
                  <span className="diag-proc" title={f.path}>{f.path}</span>
                  <span className={f.status === "ok" ? "" : f.status === "missing" ? "" : "diag-crit"}>
                    {f.status === "ok" ? "valid" : f.status === "missing" ? "not found" : f.status === "invalid" ? "ignored" : "unreadable"}
                  </span>
                  <span>{f.data ? Object.keys(f.data).length : "—"}</span>
                </div>
                {f.bom && (
                  <div className="diag-tr diag-crit" role="row" style={NOTE_COLS}>
                    Starts with a UTF-8 BOM (U+FEFF). JSON parsers reject it, so Claude Code ignores this whole file
                    even though the rest of it is fine. Re-save it as UTF-8 without BOM.
                  </div>
                )}
                {f.parseError && (
                  <div className="diag-tr diag-crit" role="row" style={NOTE_COLS}>
                    JSON error{f.parseError.line ? ` at line ${f.parseError.line}, column ${f.parseError.column}` : ""}: {f.parseError.message}
                  </div>
                )}
                {f.readError && (
                  <div className="diag-tr diag-crit" role="row" style={NOTE_COLS}>
                    Couldn’t read this file: {f.readError}
                  </div>
                )}
                {f.unknownKeys && f.unknownKeys.length > 0 && (
                  <div className="diag-tr diag-warn" role="row" style={NOTE_COLS}>
                    Top-level key{f.unknownKeys.length === 1 ? "" : "s"} Flightdeck doesn’t recognise: {f.unknownKeys.join(", ")}.
                    Worth a spell-check, though it may simply be newer than this build.
                  </div>
                )}
              </Fragment>
            ))}
          </div>

          {/* Effective merge — scalars */}
          <div className="set-row">
            <div className="set-row-t">
              <span className="set-row-name">Effective settings</span>
              <span className="set-row-sub">Last one wins across local &gt; project &gt; user; the winning file is named per key.</span>
            </div>
          </div>
          {scalars.length === 0 ? (
            <div className="diag-empty">No permission-related settings are set in any of these files.</div>
          ) : (
            <div className="diag-table" role="table" aria-label="Effective permission settings">
              <div className="diag-tr diag-th" role="row" style={SCALAR_COLS}>
                <span>Key</span><span>Value</span><span>Winning file</span>
              </div>
              {scalars.map((r) => (
                <div className="diag-tr" role="row" key={r.key} style={SCALAR_COLS}>
                  <span className="diag-proc" title={r.key}>{shortKey(r.key)}</span>
                  <span className="diag-proc" title={r.value}>{r.value}</span>
                  <span title={r.overridden.length ? `Also set in ${sourceText(r.overridden)}, overridden` : undefined}>
                    {SCOPE_LABEL[r.source]}{r.overridden.length > 0 ? " ✱" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Effective merge — rule lists */}
          <div className="set-row">
            <div className="set-row-t">
              <span className="set-row-name">Permission rules</span>
              <span className="set-row-sub">Rule lists combine across all three files rather than replacing each other; deny wins at match time.</span>
            </div>
          </div>
          {rules.length === 0 ? (
            <div className="diag-empty">No allow/ask/deny rules in any of these files.</div>
          ) : (
            <div className="diag-table" role="table" aria-label="Merged permission rules">
              <div className="diag-tr diag-th" role="row" style={RULE_COLS}>
                <span>List</span><span>Rule</span><span>From</span>
              </div>
              {rules.map((r, i) => (
                <div className="diag-tr" role="row" key={`${r.key}-${r.rule}-${i}`} style={RULE_COLS}>
                  <span className="diag-proc" title={r.key}>{shortKey(r.key)}</span>
                  <span className={"diag-proc" + (r.invalid ? " diag-crit" : "")} title={r.invalid ? "Not a string — Claude Code expects rule strings here." : r.rule}>
                    {r.rule}{r.invalid ? "  (not a string)" : ""}
                  </span>
                  <span>{sourceText(r.sources)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Hooks (QL-773) */}
          <div className="set-row">
            <div className="set-row-t">
              <span className="set-row-name">Hooks</span>
              <span className="set-row-sub">Every hook these files declare, with schema checks. Hooks fail silently in Claude Code, so this is the only place they’re visible.</span>
            </div>
          </div>
          {hooks.length === 0 && problems.length === 0 ? (
            <div className="diag-empty">No hooks declared in any of these files.</div>
          ) : (
            <>
              {hooks.length > 0 && (
                <div className="diag-table" role="table" aria-label="Declared hooks">
                  <div className="diag-tr diag-th" role="row" style={HOOK_COLS}>
                    <span>Event</span><span>Matcher</span><span>Command</span><span>File</span>
                  </div>
                  {hooks.map((h, i) => (
                    <Fragment key={`${h.source}-${h.event}-${i}`}>
                      <div className="diag-tr" role="row" style={HOOK_COLS}>
                        <span className="diag-proc" title={h.event}>{h.event}</span>
                        <span className="diag-proc" title={h.matcher ?? "no matcher"}>{h.matcher ?? "—"}</span>
                        <span className="diag-proc" title={h.command}>{h.command}</span>
                        <span>{SCOPE_LABEL[h.source]}</span>
                      </div>
                      {h.issues.map((issue, j) => (
                        <div className="diag-tr diag-warn" role="row" key={j} style={NOTE_COLS}>{issue}</div>
                      ))}
                    </Fragment>
                  ))}
                </div>
              )}
              {problems.length > 0 && (
                <div className="diag-table" role="table" aria-label="Hook block problems">
                  {problems.map((p, i) => (
                    <div className="diag-tr diag-crit" role="row" key={i} style={NOTE_COLS}>
                      {SCOPE_LABEL[p.source]}: {p.message}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="diag-empty">Fire history requires hook wiring, coming later.</div>
        </>
      )}
    </>
  );
}
