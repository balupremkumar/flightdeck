// sessionLauncherLogic.ts: the non-UI half of SessionLauncher (types, pure helpers,
// the open event). Eager because the palette and PaneView use it; the launcher
// overlay itself is a lazy chunk. SessionLauncher.tsx re-exports everything here.
import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel } from "./store";
import { useUI } from "./ui";
import { bytes } from "./format";
import { resolveExisting } from "./pathcheck";
import { paneSessionInfo, type SessionInfo } from "./chatlog";
// QL-764 — resume/fork launcher.
//
// Claude Code keeps every past session as a transcript under
// ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl, and `claude --resume <id>`
// (optionally with --fork-session) picks one back up. The backend
// (usage.rs::list_claude_sessions) indexes those files; this overlay lists them
// for the pane you're looking at and opens the chosen one as a NEW pane in the
// same folder, running the same vendor command plus the resume args.
//
// Open state lives here rather than in ui.ts, the same shape CommandPalette and
// Shortcuts already use for their own overlays: one component, its own key
// listener, mounted once in Cockpit.

/** The only vendor this applies to — resume is a Claude Code feature, and the
 *  transcripts the list is built from are Claude Code's own (same gate the ctx
 *  chip's data source implies: no transcript, nothing to show). */
export const RESUME_VENDOR = "claude";

/** Vendors whose past sessions the launcher can list and reopen. Codex keeps
 *  rollouts under ~/.codex/sessions (codexsessions.rs) and reopens one with
 *  `codex resume <uuid>`. */
export const RESUME_VENDORS = ["claude", "codex"] as const;
export function canResume(vendor: string): boolean {
  return (RESUME_VENDORS as readonly string[]).includes(vendor);
}
/** Codex has no fork. */
export function supportsFork(vendor: string): boolean {
  return vendor === "claude";
}
/** Backend command that lists this vendor's past sessions for a folder. */
export function listCommandFor(vendor: string): string {
  return vendor === "codex" ? "list_codex_sessions" : "list_claude_sessions";
}
/** Deep (full-text) search only exists for Claude's transcripts. */
export function supportsDeepSearch(vendor: string): boolean {
  return vendor === "claude";
}

export const OPEN_EVENT = "flightdeck:session-launcher";

export interface ClaudeSession {
  id: string;
  modifiedMs: number;
  title: string;
  gitBranch: string | null;
  model: string | null;
  /** null when the transcript was too big to read whole — see usage.rs. */
  turns: number | null;
  sizeBytes: number;
}

/** The one-slot "how big is this session" reading: an exact turn count when the
 *  backend could read the transcript whole, the transcript's size when it
 *  couldn't. Never an invented number. */
export function sessionWeight(s: Pick<ClaudeSession, "turns" | "sizeBytes">): string {
  return s.turns != null ? `${s.turns} turn${s.turns === 1 ? "" : "s"}` : `${bytes(s.sizeBytes)} transcript`;
}

/** Open the launcher for a specific pane (defaults to the focused one).
 *  Exported so the pane menu and the command palette can reach it without a
 *  store field — same re-dispatch pattern the palette already uses for the
 *  side panel and cheat sheet. */
export function openSessionLauncher(paneId?: number) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { paneId } }));
}

/** The argv Claude Code needs to reopen `sessionId`. Fork leaves the original
 *  session untouched and branches a copy — the safe way to revisit a session
 *  you may still want to continue elsewhere. */
export function resumeArgs(sessionId: string, fork: boolean): string[] {
  return fork ? ["--resume", sessionId, "--fork-session"] : ["--resume", sessionId];
}

/** Per-vendor argv that reopens `sessionId`. Claude as `resumeArgs`; Codex is
 *  `resume <uuid>` and never forks (the flag is ignored). The backend only
 *  accepts exactly that shape for codex, since it lands in a pwsh -Command line. */
export function resumeArgsFor(vendor: string, sessionId: string, fork: boolean): string[] {
  if (vendor === "codex") return ["resume", sessionId];
  return resumeArgs(sessionId, fork);
}

/** "claude-opus-4-1-20250805" -> "opus 4.1", "claude-3-5-haiku-20241022" ->
 *  "haiku 3.5". Unknown ids fall back to the id with the date stamp dropped,
 *  so a model this doesn't know still reads as something. */
export function modelShort(model: string | null | undefined): string {
  if (!model) return "";
  const parts = model.toLowerCase().replace(/[^a-z0-9-]/g, "-").split("-").filter(Boolean);
  const isDate = (t: string) => /^\d{8}$/.test(t);
  const isNum = (t: string) => /^\d+$/.test(t) && !isDate(t);
  const fam = parts.findIndex((p) => ["opus", "sonnet", "haiku", "fable"].includes(p));
  if (fam === -1) return parts.filter((p) => !isDate(p) && p !== "claude").join("-");
  // Generation sits either after the family (opus-4-1) or before it (3-5-haiku).
  const after = parts.slice(fam + 1).filter(isNum);
  const before = parts.slice(0, fam).filter(isNum);
  const gen = (after.length ? after : before).slice(0, 2).join(".");
  return gen ? `${parts[fam]} ${gen}` : parts[fam];
}

/** QL-765: context window used for the "% of window" reading.
 *  Claude transcripts don't state the window, so for Claude this is the one
 *  inferred number in the chip. Per https://platform.claude.com/docs/en/models/overview
 *  (checked 2026-10-04): Fable, Opus 5.5 and Sonnet 5.5 are 1M, Opus and
 *  Sonnet 4.6 and later are 1M at standard price, everything older (Haiku 4.5,
 *  Opus/Sonnet 4.5 and before) is 200k. The "[1m]" / "-1m" variants of older
 *  models still advertise themselves in the id. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const LONG_CONTEXT_WINDOW = 1_000_000;
export function contextWindowFor(model: string | null | undefined, reported?: number | null): number {
  // Codex rollouts state their own window (model_context_window): trust it.
  if (reported && reported > 0) return reported;
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  if (/(\[1m\]|-1m\b)/i.test(model)) return LONG_CONTEXT_WINDOW;
  const [fam, major = "0", minor = "0"] = modelShort(model).split(/[ .]/);
  if (fam === "fable" || fam === "mythos") return LONG_CONTEXT_WINDOW;
  if ((fam === "opus" || fam === "sonnet") && Number(major) * 100 + Number(minor) >= 406) return LONG_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}

/** Substring filter over the fields a row actually shows. Order is preserved
 *  (the backend already sorted newest-first). */
export function filterSessions(list: ClaudeSession[], query: string): ClaudeSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) =>
    [s.title, s.id, s.gitBranch ?? "", modelShort(s.model), s.model ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
}

// QL-771 — deep search.
//
// The filter box above is a title filter: it can only find a session by what
// its row already says. Deep search asks the backend
// (usage.rs::search_claude_sessions) to read what was actually SAID in every
// transcript for this folder, and lists the matching lines grouped by session.
// Resuming from a hit is the same path as resuming from a row — a hit is just a
// session you found by its content.

/** One matching message line. */
export interface SessionSearchHit {
  sessionId: string;
  /** Epoch ms of the line, 0 when the transcript line carried no timestamp. */
  timestampMs: number;
  role: string;
  snippet: string;
  /** Matching lines in that session (capped backend-side). */
  sessionHits: number;
  /** Project folder the transcript belongs to; "" when the line carried none. */
  cwd: string;
}

export interface SessionSearchResults {
  hits: SessionSearchHit[];
  /** A cap stopped the scan — the footer says so rather than implying totality. */
  truncated: boolean;
  sessionsSearched: number;
  /** The time budget or file cap stopped the scan early ("partial results"). */
  partial?: boolean;
  /** The regex did not compile. */
  error?: string | null;
}

/** Where a hit resumes: its own project folder when the backend reported one,
 *  else the pane's. */
export function hitCwd(h: Pick<SessionSearchHit, "cwd">, paneCwd: string): string {
  return h.cwd || paneCwd;
}

/** Shorter than this isn't a search, it's a folder-wide read for no signal —
 *  the same floor the backend enforces. */
export const MIN_SEARCH_CHARS = 2;
/** Typing pause before a search is sent. Long enough that a typed word costs
 *  one scan, short enough to feel like it's keeping up. */
export const SEARCH_DEBOUNCE_MS = 300;

export interface HitGroup {
  sessionId: string;
  cwd: string;
  hits: SessionSearchHit[];
  /** Total in that session, which can exceed hits.length when capped. */
  count: number;
}

/** Hits into one group per session. The backend already returns them
 *  contiguous and newest-session-first, so this only walks the list — the
 *  order the user sees is the order the backend chose. */
export function groupHits(hits: SessionSearchHit[]): HitGroup[] {
  const out: HitGroup[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && last.sessionId === h.sessionId) {
      last.hits.push(h);
      continue;
    }
    out.push({ sessionId: h.sessionId, cwd: h.cwd, hits: [h], count: h.sessionHits });
  }
  return out;
}

/** A snippet split into matched/unmatched runs for highlighting,
 *  case-insensitively. Bails out to a single unmatched run when lowercasing
 *  changes the string's length (a handful of Unicode cases do), since the
 *  offsets would no longer line up with the original text. */
export function highlightParts(text: string, query: string, regex = false): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (regex) {
    let re: RegExp;
    try { re = new RegExp(q, "gi"); } catch { return [{ text, hit: false }]; }
    const runs: { text: string; hit: boolean }[] = [];
    let at0 = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      const at = m.index ?? 0;
      if (at > at0) runs.push({ text: text.slice(at0, at), hit: false });
      runs.push({ text: m[0], hit: true });
      at0 = at + m[0].length;
    }
    if (at0 < text.length) runs.push({ text: text.slice(at0), hit: false });
    return runs.length ? runs : [{ text, hit: false }];
  }
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  if (!needle || hay.length !== text.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) break;
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    i = at + needle.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

export type ResumeResult = "ok" | "stage-failed" | "cwd-missing";

/** N9: does this project folder still exist? Outside the Tauri host there is
 *  nothing to ask, so assume yes rather than block every resume in a preview. */
export async function folderExists(cwd: string): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in globalThis)) return true;
  const [hit] = await resolveExisting([cwd], []);
  return !!hit?.isDir;
}

/** Stage the resume args for the next spawn in this folder, then create the
 *  pane that will consume them (usage.rs holds the staging; build_command in
 *  lib.rs applies it). Returns false when the backend refused the staging —
 *  in which case NO pane is created, since a pane spawned without the args
 *  would silently start a fresh session instead of resuming. */
export async function launchResume(
  wsId: number,
  pane: Pick<PaneModel, "vendor" | "cwd" | "worktreePath" | "branch" | "baseBranch">,
  sessionId: string,
  fork: boolean,
  /** Resume in a different project folder (an all-projects search hit). */
  cwdOverride?: string,
  exists: (cwd: string) => Promise<boolean> = folderExists
): Promise<ResumeResult> {
  const cwd = cwdOverride || pane.cwd;
  const elsewhere = cwd !== pane.cwd;
  // N9: an all-projects hit can point at a folder that has since been moved or
  // deleted; a pane spawned there would fail with no explanation.
  if (elsewhere && !(await exists(cwd))) return "cwd-missing";
  try {
    await invoke("stage_launch_args", {
      vendor: pane.vendor,
      cwd,
      args: resumeArgsFor(pane.vendor, sessionId, fork),
    });
  } catch {
    return "stage-failed";
  }
  // The pane's worktree belongs to its own folder, never to another project.
  const wt =
    !elsewhere && pane.worktreePath && pane.branch && pane.baseBranch
      ? { worktreePath: pane.worktreePath, branch: pane.branch, baseBranch: pane.baseBranch }
      : undefined;
  useApp.getState().addPane(wsId, pane.vendor, cwd, wt);
  return "ok";
}

/** Stage `--resume <id>` for this pane's NEXT spawn when its Claude session has a
 *  transcript on disk, so a restart reopens the same conversation. The id is the
 *  backend's `resume_id`: the pane's own pinned session, followed only along the
 *  conversation-reset records in its own transcripts. Never the newest file in the
 *  folder, which may belong to another claude process.
 *  Returns false, staging nothing, when there is no pty, no transcript yet (a pane
 *  with no turn: `--resume` would fail), or the backend refuses; the caller then
 *  restarts plain. A toast says so when a conversation existed or the lookup failed. */
export async function stageResumeOfCurrentSession(
  pane: Pick<PaneModel, "vendor" | "cwd">,
  ptyId: number,
  info: (ptyId: number) => Promise<SessionInfo> = paneSessionInfo
): Promise<boolean> {
  if (pane.vendor !== RESUME_VENDOR || ptyId <= 0) return false;
  const noResume = () => useUI.getState().pushToast("info", "Couldn't resume this pane's conversation, Claude starts fresh.");
  try {
    const si = await info(ptyId);
    const id = si.resume_id;
    if (!id || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      if (si.jsonl_path) noResume();
      return false;
    }
    await invoke("stage_launch_args", { vendor: pane.vendor, cwd: pane.cwd, args: [...(si.launch_args ?? []), ...resumeArgs(id, false)] });
    return true;
  } catch {
    noResume();
    return false;
  }
}

/** Switch a Claude pane between the quiet and full terminal without losing the
 *  conversation: stage the resume first, then restart through the store. */
export async function setFocusModeKeepingSession(
  paneId: number,
  on: boolean,
  ptyId: number,
  info?: (ptyId: number) => Promise<SessionInfo>
): Promise<void> {
  const pane = useApp.getState().workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId);
  if (pane) await stageResumeOfCurrentSession(pane, ptyId, info);
  useApp.getState().setPaneFocusMode(paneId, on);
}

