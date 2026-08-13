import { forwardRef, useEffect, useImperativeHandle, useRef, useSyncExternalStore } from "react";
import { useApp } from "./store";
import { Terminal as XTerm } from "@xterm/xterm";
import type { ILinkProvider, ILink, ITheme, IMarker, IDecoration } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
// QL-762: TYPE-only. The addon itself is ~32KB of vendor code that is not
// needed to paint a pane — only to snapshot one for the session doc, which
// first happens ~20s in — so it is dynamically imported below and deliberately
// NOT added to vite.config.ts's `xterm` manualChunk (that chunk is eagerly
// loaded; listing it there would put it straight back in the boot payload and
// blow perfbudget.test.ts's cold-start budget).
import type { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { terminalThemeFor } from "./terminal-theme";
import { getTerminalSettings } from "./Settings";
import { linkify, resolvePath, type LinkMatch } from "./linkify";
import { openInEditor } from "./editor";
import { useUI } from "./ui";

// Reads the app's active theme straight off the DOM — the app dispatches no
// theme-change event, so this (plus the MutationObserver below) is how the
// terminal stays in sync with Settings' theme picker.
function activeThemeId(): string {
  return document.documentElement.getAttribute("data-theme") ?? "dark";
}

/** Schemes we will hand to the OS opener from terminal output. Deliberately an
 *  ALLOWLIST, and deliberately narrower than markdown preview's (no mailto/tel):
 *  the only URLs a pane can produce are the regex linkifier's http/https matches
 *  and OSC 8 hyperlinks, and an OSC 8 URI is whatever the child process chose to
 *  print. `openUrl` is the shell, so `javascript:`, `file:`, `ms-msdt:` and
 *  friends must never reach it — same rule as SAFE_LINK_SCHEMES in markdown.ts. */
const SAFE_TERMINAL_URL = /^https?:\/\//i;

/** The single open-a-URL path for a pane: WebLinksAddon's regex matches and
 *  OSC 8 hyperlinks both come through here, so they can't drift apart. A
 *  blocked scheme says so rather than making the click look broken. */
export function openTerminalUrl(uri: string): void {
  if (!SAFE_TERMINAL_URL.test(uri)) {
    useUI.getState().pushToast("error", "Blocked link — only http and https links open from a terminal", { detail: uri.slice(0, 300) });
    return;
  }
  openUrl(uri).catch(() => { /* best-effort */ });
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Overview-ruler / highlight colours for search matches — derived from the
// terminal's own active theme (not the app-level light/dark tokens), so
// they stay legible whichever palette the terminal is currently painted in.
function searchDecorations(theme: ITheme) {
  return {
    matchOverviewRuler: theme.yellow as string,
    activeMatchColorOverviewRuler: theme.cursor as string,
    matchBackground: hexToRgba(theme.yellow as string, 0.25),
    activeMatchBackground: hexToRgba(theme.cursor as string, 0.35),
  };
}

// UX-501..504/523: clickable file paths in terminal output. URLs are left to
// WebLinksAddon (registered alongside this in the mount effect below) — this
// provider only emits `linkify()`'s 'path' matches, so the two never fight
// over the same span. Plain click previews the file in-app (UX-505); Ctrl/Cmd
// +click opens it in the editor configured in Settings (src/editor.ts), the
// same helper Review's file rows use. Existence is checked via the
// one Rust command that's actually available for it (`fs_list_dir`, reading
// the parent directory) — a path that isn't there loses its link styling and
// its click turns into a "not found" toast instead of a dead navigation.
// QL-757: `cwdRef` is a ref, not a string, because the pane's folder moves —
// the shell reports the live one via OSC 9;9 after every `cd`, and a relative
// path in output must resolve against where the shell actually IS, not where
// the pane was spawned.
function registerPathLinks(term: XTerm, cwdRef: { current: string }, fontSizeRef: { current: number }): { dispose(): void } {
  const dirCache = new Map<string, Promise<Set<string>>>();
  const dirOf = (p: string): string => {
    const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return i > 0 ? p.slice(0, i) : p;
  };
  const baseOf = (p: string): string => {
    const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return i >= 0 ? p.slice(i + 1) : p;
  };
  const listDir = (dir: string): Promise<Set<string>> => {
    let cached = dirCache.get(dir);
    if (!cached) {
      cached = invoke<{ name: string; dir: boolean }[]>("fs_list_dir", { path: dir })
        .then((entries) => new Set(entries.map((e) => e.name.toLowerCase())))
        .catch(() => new Set<string>()); // unreadable/missing dir — nothing in it "exists"
      dirCache.set(dir, cached);
    }
    return cached;
  };

  // UX-504: a small DOM tooltip explaining click vs Ctrl+click. Per xterm's
  // own ILink.hover doc it must live inside term.element and carry the
  // xterm-hover class so xterm doesn't treat the pointer leaving the link
  // text (onto the tooltip itself) as ending the hover.
  const tip = document.createElement("div");
  tip.className = "xterm-hover";
  tip.style.cssText =
    "position:fixed;z-index:1000;pointer-events:none;display:none;white-space:nowrap;" +
    "background:var(--elevated);color:var(--text);border:1px solid var(--line-strong);" +
    "border-radius:6px;padding:4px 8px;font:11px var(--font-sans);box-shadow:var(--shadow-2);";
  term.element?.appendChild(tip);
  const showTip = (event: MouseEvent, msg: string) => {
    tip.textContent = msg;
    tip.style.left = `${event.clientX + 12}px`;
    tip.style.top = `${event.clientY + 16}px`;
    tip.style.display = "block";
  };
  const hideTip = () => { tip.style.display = "none"; };

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const matches = linkify(text).filter((m) => m.kind === "path");
      if (!matches.length) { callback(undefined); return; }

      const links: ILink[] = matches.map((m) => {
        const abs = resolvePath(m, cwdRef.current);
        // UX-517: the editor chosen in Settings, at the line the output named
        // (`src/App.tsx:42` jumps to 42). editor.ts owns the fallback to the OS
        // hand-off this used to do directly, and reports its own failures.
        // Column is parsed by linkify but has no placeholder in the command
        // template, so it isn't passed on.
        const openEditor = () => { void openInEditor(abs, m.line); };
        const openInPreview = () => {
          useUI.getState().openPreview(abs, { line: m.line, fontSize: fontSizeRef.current });
        };
        const link: ILink = {
          range: { start: { x: m.start + 1, y: bufferLineNumber }, end: { x: m.end, y: bufferLineNumber } },
          text: m.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => { if (event.ctrlKey || event.metaKey) openEditor(); else openInPreview(); },
          hover: (event) => showTip(event, "Click — preview   ·   Ctrl+click — open in editor"),
          leave: hideTip,
        };
        // Fire-and-forget existence check; ILink.decorations is documented as
        // tracked, so mutating it in place after the fact still repaints.
        listDir(dirOf(abs)).then((names) => {
          if (names.has(baseOf(abs).toLowerCase())) return;
          link.decorations = { pointerCursor: false, underline: false };
          link.activate = () => useUI.getState().pushToast("error", `${abs} — not found on disk`);
          link.hover = (event) => showTip(event, "Not found on disk");
        });
        return link;
      });
      callback(links);
    },
  };
  const disp = term.registerLinkProvider(provider);
  return { dispose() { disp.dispose(); tip.remove(); } };
}

// ---------------------------------------------------------------------------
// QL-782: per-pane OSC 9;4 progress, published app-wide.
//
// UI-136 already parsed these sequences, but the number stopped at the pane's
// own status band — behind whatever window is in front of Flightdeck, which is
// exactly where the user is while `npm ci` runs. The parse is unchanged; it now
// also publishes here, and Notifications.tsx (the one always-mounted surface)
// folds every reporting pane into the single taskbar progress bar Windows gives
// an application. Same shape as poll.ts's heavy-pane store: a module-level map,
// a signature check so an unchanged reading re-renders nothing, and
// useSyncExternalStore for readers.
// ---------------------------------------------------------------------------

/** OSC 9;4 states, named. `none` is never stored — it removes the pane. */
export type PaneProgressState = "normal" | "error" | "indeterminate";
export interface PaneProgress {
  paneId: number;
  state: PaneProgressState;
  /** 0-100. Meaningless (and 0) for `indeterminate`. */
  percent: number;
}

const NO_PROGRESS: PaneProgress[] = [];
const progressById = new Map<number, PaneProgress>();
let progressList: PaneProgress[] = NO_PROGRESS;
let progressSig = "";
const progressListeners = new Set<() => void>();

function subscribeProgress(fn: () => void): () => void {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

function republishProgress() {
  const next = [...progressById.values()];
  const sig = next.map((p) => `${p.paneId}:${p.state}:${p.percent}`).join("|");
  if (sig === progressSig) return;
  progressSig = sig;
  progressList = next.length ? next : NO_PROGRESS;
  for (const fn of [...progressListeners]) fn();
}

/** Record one pane's progress. `null` means "this pane reports nothing" —
 *  a cleared sequence (state 0), an exited process, or an unmounted pane. */
export function publishPaneProgress(paneId: number, p: { state: PaneProgressState; percent: number } | null): void {
  if (!paneId) return; // pre-spawn: no pane to attribute it to
  if (p === null) {
    if (!progressById.delete(paneId)) return;
  } else {
    progressById.set(paneId, {
      paneId,
      state: p.state,
      percent: Math.max(0, Math.min(100, Math.round(p.percent) || 0)),
    });
  }
  republishProgress();
}

/** The current snapshot, outside React. Same array the hook below serves —
 *  identity only changes when a reading actually changes. */
export function paneProgressList(): PaneProgress[] {
  return progressList;
}

/** Every pane currently reporting progress, or an empty list. */
export function usePaneProgress(): PaneProgress[] {
  return useSyncExternalStore(subscribeProgress, paneProgressList, () => NO_PROGRESS);
}

// ---------------------------------------------------------------------------
// QL-753 / QL-757: OSC 133 command marks + OSC 9;9 cwd reports.
//
// The shell integration injected at spawn (src-tauri/src/shellmarks.rs) makes a
// PowerShell pane announce where each command starts, where its output begins,
// what it exited with, and which folder it is sitting in. Everything below is
// the parse; the mount effect turns the events into xterm markers, gutter
// decorations, the overview-ruler ticks and the Ctrl+Up/Down jump.
//
// Agent panes are NOT injected (see shellmarks.rs), but an agent that emits its
// own 133 sequences is parsed here just the same — there is nothing to
// double-mark, because the marks come only from the stream.
// ---------------------------------------------------------------------------

export type ShellMarkKind = "prompt" | "input" | "output" | "done" | "cwd";

export interface ShellMarkEvent {
  kind: ShellMarkKind;
  /** `done` only: the command's exit code. Absent when the shell reported that
   *  nothing actually ran (a bare Enter, or Ctrl+C at the prompt). */
  exit?: number;
  /** `cwd` only: the reported folder, already normalised. */
  cwd?: string;
}

/** 133;A/B/C/D (with optional parameters) and 9;9;<cwd>, BEL- or ST-terminated. */
const SHELL_MARK_RE = /\x1b\]133;([ABCD])((?:;[^\x07\x1b]*)?)(?:\x07|\x1b\\)|\x1b\]9;9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const MARK_KIND: Record<string, ShellMarkKind> = { A: "prompt", B: "input", C: "output", D: "done" };
/** Longest partial sequence worth holding onto between chunks. A cwd report is
 *  the long one (a path); beyond this it isn't a mark we'd have parsed anyway. */
const MARK_CARRY_CAP = 512;

/** A cwd as PowerShell reports it, as a path this app can hand to Rust:
 *  Windows Terminal's convention allows a quoted path or a file:// URL. */
export function normalizeReportedCwd(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/[^/]*/i, "");
    try { s = decodeURIComponent(s); } catch { /* malformed escape — take it raw */ }
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1); // /C:/repo -> C:/repo
  }
  // Windows paths only: a posix cwd (WSL, git-bash) must keep its slashes.
  if (/^[A-Za-z]:[\\/]/.test(s)) s = s.replace(/\//g, "\\");
  return s;
}

/** Pull every complete mark out of a chunk. `carry` is whatever the previous
 *  call left unterminated — the PTY splits on byte boundaries, not sequence
 *  boundaries, so `ESC ] 1 3 3 ; D ; 1` and its BEL routinely land in separate
 *  events. Returns the new carry. */
export function parseShellMarks(text: string, carry = ""): { events: ShellMarkEvent[]; carry: string } {
  const s = carry + text;
  const events: ShellMarkEvent[] = [];
  let consumed = 0;
  SHELL_MARK_RE.lastIndex = 0;
  for (const m of s.matchAll(SHELL_MARK_RE)) {
    consumed = (m.index ?? 0) + m[0].length;
    if (m[3] !== undefined) {
      const cwd = normalizeReportedCwd(m[3]);
      if (cwd) events.push({ kind: "cwd", cwd });
      continue;
    }
    const kind = MARK_KIND[m[1]];
    if (kind !== "done") { events.push({ kind }); continue; }
    // `133;D` = nothing ran; `133;D;<code>` = a command finished. Extra
    // parameters (some shells append the command line) are ignored.
    const code = parseInt((m[2] ?? "").replace(/^;/, "").split(";")[0] ?? "", 10);
    events.push(Number.isFinite(code) ? { kind, exit: code } : { kind });
  }
  // Keep only a trailing, still-unterminated OSC introducer. The split can land
  // anywhere, including between the ESC and its `]`, so a lone trailing ESC is
  // kept too. Anything else (a CSI, plain text) is dropped — the carry feeds
  // the parser only, never what gets written to the terminal.
  const rest = s.slice(consumed);
  const open = rest.lastIndexOf("\x1b");
  let next = "";
  if (open >= 0) {
    const tail = rest.slice(open);
    const plausible = tail === "\x1b" || tail.startsWith("\x1b]");
    if (plausible && !/\x07|\x1b\\/.test(tail.slice(1)) && tail.length <= MARK_CARRY_CAP) next = tail;
  }
  return { events, carry: next };
}

/** Ctrl+Up / Ctrl+Down target: the nearest command mark strictly above
 *  (`dir` -1) or below (`dir` 1) the top of the viewport. `null` = no more
 *  marks that way, so the pane stays where it is rather than jumping to an end. */
export function nextMarkLine(lines: number[], viewportY: number, dir: 1 | -1): number | null {
  const sorted = [...lines].sort((a, b) => a - b);
  if (dir === 1) return sorted.find((l) => l > viewportY) ?? null;
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i] < viewportY) return sorted[i];
  return null;
}

/** QL-755: the command mark that OWNS the top row of the viewport — the
 *  nearest `ran` mark strictly above it. null means there's nothing to pin:
 *  either the viewport sits above every mark, or the owning prompt IS the top
 *  visible row, and pinning a copy of a line the user can already see reads as
 *  a rendering fault rather than a feature. */
export function stickyMarkLine(lines: number[], viewportY: number): number | null {
  let best: number | null = null;
  for (const l of lines) if (l < viewportY && (best === null || l > best)) best = l;
  return best;
}

// ---------------------------------------------------------------------------
// QL-754: quick-select hints.
//
// Ctrl+Shift+Space labels every path/URL the linkifier can see on screen and
// turns the pane into a one-keystroke mode: type the label to copy the match,
// Shift+label to open it (editor for a path, browser for a URL). It reuses
// linkify() — the exact same matcher the click-to-open link provider above
// runs — so a thing that is clickable is always hintable, and vice versa.
// ---------------------------------------------------------------------------

/** Home row first, then the row above, then the row below: the keys a touch
 *  typist reaches without looking, in the order they should be spent. Letters
 *  only — punctuation keys move between layouts. */
const HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

/** `count` labels, all the same width. Fixed width is the point: no label can
 *  be a prefix of another, so a typed label is never ambiguous and the mode
 *  never has to wait on a timeout to decide what the user meant. */
export function hintLabels(count: number): string[] {
  const a = HINT_ALPHABET;
  const out: string[] = [];
  if (count <= a.length) {
    for (let i = 0; i < count; i++) out.push(a[i]);
    return out;
  }
  for (let i = 0; i < Math.min(count, a.length * a.length); i++) {
    out.push(a[Math.floor(i / a.length)] + a[i % a.length]);
  }
  return out;
}

export interface HintTarget {
  /** Row within the viewport — 0 is the top row on screen, not a buffer line. */
  row: number;
  match: LinkMatch;
  label: string;
}

/** Every linkifier match across the given viewport rows, labelled top-to-
 *  bottom then left-to-right (the order the eye scans, so the labels read in
 *  alphabet order down the screen). Pure, so labelling and ordering are
 *  testable without a live terminal. */
export function hintTargets(rows: string[]): HintTarget[] {
  const found: { row: number; match: LinkMatch }[] = [];
  rows.forEach((text, row) => {
    for (const match of linkify(text)) found.push({ row, match });
  });
  const labels = hintLabels(found.length);
  return found.slice(0, labels.length).map((f, i) => ({ ...f, label: labels[i] }));
}

/** What typing a label copies. URLs go over verbatim; a path keeps its
 *  `:line` suffix (that's what makes it useful to paste back at an editor)
 *  but loses the quotes the output happened to wrap it in. */
export function hintCopyText(m: LinkMatch): string {
  return m.kind === "url" ? m.raw : m.text.replace(/^["']|["']$/g, "");
}

/** Gutter/ruler colours for command marks, off the app's --st-* tokens so they
 *  follow the theme (and the colour-blind palette) like every other status. */
function markColours(): { ok: string; err: string } {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return { ok: pick("--st-running", "#52E08A"), err: pick("--st-error", "#FF5C6A") };
}

export interface TerminalHandle {
  findNext: (query: string, opts?: { incremental?: boolean }) => boolean;
  findPrevious: (query: string) => boolean;
  clearSearch: () => void;
  onSearchResults: (cb: (e: ISearchResultChangeEvent) => void) => () => void;
  /** UI-134: wipe the scrollback without restarting the agent. */
  clearScrollback: () => void;
  /** UI-128: jump back to the live tail. */
  scrollToBottom: () => void;
  /** UX-546/547: the whole scrollback as text, for the transcript browser
   *  and the save / save-redacted / copy-last-command actions. */
  getScrollbackText: () => string;
  /** UI-132: selection helpers for the context menu. */
  getSelection: () => string;
  selectAll: () => void;
  copySelection: () => Promise<void>;
  paste: (text: string) => void;
  /** QL-753: scroll to the previous (-1) / next (1) command mark. False when
   *  there is none that way (or the shell emits no marks at all). Same action
   *  Ctrl+Up/Ctrl+Down performs inside the pane. */
  jumpToCommandMark: (dir: 1 | -1) => boolean;
  /** QL-754: raise the quick-select hint overlay. False when there was nothing
   *  on screen to label. Same action Ctrl+Shift+Space performs inside the pane;
   *  exposed so the pane menu can show people the feature exists. */
  showQuickHints: () => boolean;
  /** QL-762: this pane's buffer as a replayable ANSI string, capped (see
   *  SCROLLBACK_SAVE_STEPS). "" when the addon isn't up yet or the buffer
   *  can't be squeezed under the cap. Synchronous and not cheap — call it off
   *  the hot path (session.ts serialises on an idle callback). */
  serializeScrollback: () => string;
}

/** QL-762: line counts to try when serialising for the session doc, largest
 *  first. A pane painting full-width colour can produce a megabyte from far
 *  fewer than 2000 lines, so the byte cap — not the line cap — is what
 *  actually bounds the document; stepping down keeps SOME history rather than
 *  dropping the pane's scrollback entirely. */
const SCROLLBACK_SAVE_STEPS = [2000, 800, 300, 100];
/** ~1MB of serialised ANSI per pane. The session doc is rewritten AND
 *  snapshotted on every save (persist.rs), so this is a disk-write budget as
 *  much as a memory one. */
const SCROLLBACK_SAVE_MAX_CHARS = 1_000_000;

interface TerminalProps {
  vendor: string;
  cwd: string;
  /** Worktree setup command to run before the agent (fresh worktrees only).
   *  Captured at mount; `onSetupConsumed` fires once the spawn has taken it so
   *  the store can clear the pane's needsSetup flag (Restart skips setup). */
  setup?: string;
  onSetupConsumed?: () => void;
  /** UX-581: the pane's unsent input line from the previous run, re-typed on
   *  spawn so a restart doesn't silently discard it. */
  initialDraft?: string;
  /** QL-762: last session's serialised buffer for this pane, painted before
   *  the PTY attaches so the pane comes back with its history rather than a
   *  blank screen. Read once at mount (a restart deliberately passes nothing).  */
  restoredScrollback?: string;
  /** QL-758: honour OSC 52 clipboard WRITES from the child process. Off by
   *  default and per pane — an agent silently taking the clipboard is not
   *  something to opt everyone into. Reads are never answered, at any setting. */
  osc52?: boolean;
  fontSize?: number;
  ligatures?: boolean;
  /** How long the pane must be quiet before it's marked "waiting" — computed
   *  entirely on the frontend so it's user-configurable without a Rust round-trip. */
  quietThresholdMs?: number;
  onExit?: (crashed: boolean) => void;
  onState?: (state: string) => void;
  /** Live foreground process name (backend `pty://proc`), e.g. "claude" -> "node". */
  onProc?: (name: string) => void;
  /** UI-135: the child emitted BEL (). */
  onBell?: () => void;
  /** UI-141: latest non-empty output line, ANSI-stripped, for the queue. */
  onLine?: (line: string) => void;
  /** UI-128: user has scrolled off the live tail; carries how many new lines
   *  have arrived since. 0 means they're back at the bottom. */
  onScrollAway?: (linesBehind: number) => void;
  /** UI-136: ConEmu/Windows-Terminal OSC 9;4 progress. null = no progress
   *  reported; otherwise 0-100, or -1 for an indeterminate/error state. */
  onProgress?: (pct: number | null) => void;
  /** QL-757: the shell reported its working directory (OSC 9;9), e.g. after a
   *  `cd`. Fresher than the spawn cwd, so it's what "new pane here" should use.
   *  Optional — this pane already re-bases its own file links internally.
   *  CAUTION for the consumer: do NOT write this back into `PaneModel.cwd`.
   *  The mount effect keys on `cwd`, so that would remount the terminal and
   *  respawn the PTY on every `cd`. It needs its own store field. */
  onCwd?: (cwd: string) => void;
}

// Cap on buffered bytes for a pane hidden behind another workspace / focus mode —
// avoids both wasted xterm writes while invisible and an unbounded memory grow.
const HIDDEN_BUFFER_CAP = 262144; // 256KB

// One live terminal bound to a PTY in the Rust core.
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { vendor, cwd, setup, onSetupConsumed, initialDraft, restoredScrollback, osc52 = false, fontSize = 12.5, ligatures = false, quietThresholdMs = 3000, onExit, onState, onProc, onBell, onLine, onScrollAway, onProgress, onCwd },
  ref
) {
  const elRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const ligAddonRef = useRef<LigaturesAddon | null>(null);
  // QL-762: mount-time value only. The mount effect keys on [vendor, cwd], so
  // reading the prop directly inside it would be a stale-closure trap; a ref
  // initialised once says "the scrollback this pane was born with" exactly.
  const restoredRef = useRef(restoredScrollback);
  // QL-758: read inside the OSC handler, so flipping the pane menu's toggle
  // takes effect immediately without remounting the terminal (and respawning
  // the agent, which is what a prop in the mount deps would cost).
  const osc52Ref = useRef(osc52);
  const quietThresholdRef = useRef(quietThresholdMs);
  // UX-510: the preview drawer reads this at open-time so it starts at the
  // same zoom as the pane the click came from, without forcing a re-register
  // of the link provider on every zoom step.
  const fontSizeRef = useRef(fontSize);
  const themeRef = useRef<ITheme>(terminalThemeFor(activeThemeId()));
  // Mirrors the effect-local paneId so imperative handle methods (paste, etc.)
  // can reach the live PTY.
  const paneIdRef = useRef(0);
  // QL-753: set by the mount effect, which owns the mark list. Same bridge
  // pattern as paneIdRef — the handle is built once with [] deps.
  const jumpMarkRef = useRef<(dir: 1 | -1) => boolean>(() => false);
  // QL-754: ditto for the hint overlay, which the mount effect owns.
  const showHintsRef = useRef<() => boolean>(() => false);
  // QL-754/755: both overlays are positioned in pixels off the cell size, so a
  // font-size change has to re-measure them. Same bridge pattern again.
  const remeasureOverlaysRef = useRef<() => void>(() => {});

  useImperativeHandle(ref, () => ({
    findNext: (query, opts) =>
      searchAddonRef.current?.findNext(query, { ...opts, decorations: searchDecorations(themeRef.current) } as ISearchOptions) ?? false,
    findPrevious: (query) =>
      searchAddonRef.current?.findPrevious(query, { decorations: searchDecorations(themeRef.current) } as ISearchOptions) ?? false,
    clearSearch: () => searchAddonRef.current?.clearDecorations(),
    onSearchResults: (cb) => {
      const d = searchAddonRef.current?.onDidChangeResults(cb);
      return () => d?.dispose();
    },
    clearScrollback: () => termRef.current?.clear(),
    scrollToBottom: () => termRef.current?.scrollToBottom(),
    // UX-546/547: whole scrollback as plain text. Walks the buffer rather than
    // selecting, so it never disturbs the user's own selection.
    getScrollbackText: () => {
      const t = termRef.current;
      if (!t) return "";
      const buf = t.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n");
    },
    getSelection: () => termRef.current?.getSelection() ?? "",
    selectAll: () => termRef.current?.selectAll(),
    copySelection: async () => {
      const sel = termRef.current?.getSelection() ?? "";
      if (sel) await navigator.clipboard.writeText(sel);
    },
    paste: (text: string) => { if (paneIdRef.current) invoke("pty_write", { paneId: paneIdRef.current, data: text }); },
    jumpToCommandMark: (dir) => jumpMarkRef.current(dir),
    showQuickHints: () => showHintsRef.current(),
    // QL-762: try the biggest window first and step down until the result fits
    // the per-pane byte cap — a pane whose output is mostly colour codes still
    // gets SOME history back rather than none.
    serializeScrollback: () => {
      const addon = serializeAddonRef.current;
      if (!addon) return "";
      for (const scrollback of SCROLLBACK_SAVE_STEPS) {
        try {
          // Modes and the alt buffer are deliberately excluded: this string is
          // replayed into a fresh terminal BEFORE its shell attaches, and
          // restoring (say) an alt-buffer or bracketed-paste mode the new shell
          // knows nothing about would leave the pane in a state it can't undo.
          const out = addon.serialize({ scrollback, excludeModes: true, excludeAltBuffer: true });
          if (out.length <= SCROLLBACK_SAVE_MAX_CHARS) return out;
        } catch {
          return ""; // buffer mid-teardown — no history is better than a throw
        }
      }
      return "";
    },
  }), []);

  useEffect(() => {
    const el = elRef.current!;
    themeRef.current = terminalThemeFor(activeThemeId());
    // Terminal settings from Settings > Terminal (QOL 319 — they were persisted
    // but never read). fontSize stays a per-pane prop (zoom control).
    const ts = getTerminalSettings();
    const term = new XTerm({
      // The Unicode11 addon (QL-751), registerDecoration for command marks
      // (QL-753) and parser.registerOscHandler (OSC 52) are all xterm
      // "proposed API": without this flag the first pane mount throws and the
      // ErrorBoundary takes down the whole cockpit (the 0.5.3 boot loop).
      allowProposedApi: true,
      fontFamily: `'${ts.fontFamily}','JetBrains Mono','Cascadia Code',Consolas,monospace`,
      fontSize,
      cursorBlink: true,
      cursorStyle: ts.cursorStyle,
      scrollback: ts.scrollback,
      theme: themeRef.current,
      // QL-756: OSC 8 hyperlinks — agents and modern CLIs (gh, cargo, vitest)
      // emit them so a PR/docs URL is clickable without printing the raw link.
      // xterm hands the URI over verbatim, so it goes through the same
      // allowlisted opener as the regex-matched URLs below.
      linkHandler: { activate: (_e, uri) => openTerminalUrl(uri) },
      // QL-753: the slim strip down the pane's scrollbar edge. xterm's own
      // overview ruler is used rather than a hand-positioned overlay so tick
      // positions stay proportional through resize, reflow and scrollback
      // eviction for free. Command marks paint into it below; the search
      // addon's existing ruler colours (searchDecorations) only become visible
      // now too — they were configured but had no ruler to draw on.
      overviewRuler: { width: 8 },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    const webLinks = new WebLinksAddon((_e, uri) => openTerminalUrl(uri));
    term.loadAddon(webLinks);
    // QL-751: agent TUIs draw with emoji and box-drawing characters whose
    // widths changed in Unicode 11; on xterm's default table they measure one
    // cell short and every box in the frame tears. Registered before open() so
    // the first paint already uses the right widths.
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.open(el);
    // QL-736: GPU renderer, loaded after open() because it needs the element.
    // A pane streaming a diff repaints far cheaper on WebGL than on the DOM
    // renderer. Activation throws where WebGL2 isn't available (software
    // rendering, blocked driver, remote session) — not fatal, xterm just keeps
    // the DOM renderer, so fail silently rather than warn about something the
    // user can't act on. Context loss (driver reset, GPU sleep) is the same
    // story: dispose and fall back, never take the pane down over a repaint.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch { /* no WebGL2 here — DOM renderer it is */ }
    termRef.current = term;
    fitRef.current = fit;
    searchAddonRef.current = search;
    try { fit.fit(); } catch { /* not measured yet */ }
    // QL-757: starts at the spawn cwd and is replaced by every OSC 9;9 report,
    // so a `cd` inside the pane immediately re-bases relative file links.
    const cwdRef = { current: cwd };
    // Needs term.element, so registered only after open() above.
    const pathLinks = registerPathLinks(term, cwdRef, fontSizeRef);

    // QL-762: the serializer turns this pane's buffer back into the bytes that
    // drew it, so a restored pane comes back with its history instead of a
    // blank screen. Fetched off the cold-start path on purpose — nothing asks
    // for a snapshot until session.ts's first idle refresh, ~20s in, so paying
    // 32KB of parse before the cockpit has painted buys nothing. A failed
    // fetch (offline dev server, torn-down window) costs only this pane's
    // scrollback persistence, never the pane.
    let serializeIdle = 0;
    const loadSerializer = () => {
      serializeIdle = 0;
      if (disposed || serializeAddonRef.current) return;
      import("@xterm/addon-serialize")
        .then(({ SerializeAddon }) => {
          if (disposed || serializeAddonRef.current) return;
          const addon = new SerializeAddon();
          term.loadAddon(addon);
          serializeAddonRef.current = addon;
        })
        .catch(() => { /* no snapshotting for this pane — never fatal */ });
    };
    serializeIdle = window.setTimeout(loadSerializer, 5000);

    // QL-758: OSC 52 clipboard, WRITE ONLY. Registered unconditionally but
    // inert unless this pane opted in — and it always returns handled, so an
    // opted-out pane swallows the sequence rather than printing its base64 as
    // garbage. A read request (`?`) is swallowed and never answered at any
    // setting: replying would let any process that can print to a pane
    // exfiltrate whatever the user last copied.
    term.parser.registerOscHandler(52, (data) => {
      if (!osc52Ref.current) return true;
      const semi = data.indexOf(";");
      const payload = semi >= 0 ? data.slice(semi + 1) : "";
      if (!payload || payload === "?") return true;
      let text = "";
      try {
        const bin = atob(payload);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        return true; // malformed base64 — nothing to copy, nothing to report
      }
      if (!text) return true;
      // Said out loud on purpose: the clipboard changing under you with no
      // explanation is the thing that makes OSC 52 feel like a hijack.
      navigator.clipboard.writeText(text).then(
        () => useUI.getState().pushToast("info", `This pane copied ${text.length} character${text.length === 1 ? "" : "s"} to the clipboard.`),
        () => { /* clipboard denied by the webview — nothing the user can act on */ }
      );
      return true;
    });

    // --- QL-754: quick-select hints ----------------------------------------
    // A mode, not an overlay: focus stays in the terminal and the keys are
    // handled locally (attachCustomKeyEventHandler below), the same way the
    // find box handles its own Escape. Nothing goes on ui.ts's overlay stack —
    // see CLAUDE.md's overlay note for why that's the right side of the line.
    const hintLayer = document.createElement("div");
    hintLayer.className = "xterm-hints";
    hintLayer.style.display = "none";
    hintLayer.setAttribute("aria-hidden", "true");
    const hintBar = document.createElement("div");
    hintBar.className = "xterm-hintbar";
    hintBar.setAttribute("role", "status");
    hintBar.style.display = "none";
    term.element?.append(hintLayer, hintBar);

    let hints: HintTarget[] = [];
    let hintTyped = "";

    /** Pixel size of one cell, plus where the character grid starts inside
     *  term.element. Measured rather than assumed: font size, ligatures and
     *  the app zoom all move it, and the hint chips have to land on the exact
     *  character they label. */
    const cellMetrics = (): { w: number; h: number; x: number; y: number } | null => {
      const host = term.element;
      const screen = host?.querySelector(".xterm-screen") as HTMLElement | null;
      if (!host || !screen || !term.cols || !term.rows) return null;
      const hostRect = host.getBoundingClientRect();
      const rect = screen.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { w: rect.width / term.cols, h: rect.height / term.rows, x: rect.left - hostRect.left, y: rect.top - hostRect.top };
    };

    const renderHints = () => {
      const metrics = cellMetrics();
      hintLayer.textContent = "";
      if (!hints.length || !metrics) { hintLayer.style.display = "none"; hintBar.style.display = "none"; return; }
      const shown = hints.filter((h) => h.label.startsWith(hintTyped));
      for (const h of shown) {
        const chip = document.createElement("span");
        chip.className = "xterm-hint";
        chip.style.left = `${metrics.x + h.match.start * metrics.w}px`;
        chip.style.top = `${metrics.y + h.row * metrics.h}px`;
        chip.style.fontSize = `${Math.max(9, Math.round((term.options.fontSize ?? 12) * 0.82))}px`;
        if (hintTyped) {
          // The part already typed stays visible but recedes, so what's left
          // to press is the loud thing on a screen full of labels.
          const done = document.createElement("em");
          done.textContent = hintTyped;
          chip.appendChild(done);
        }
        chip.appendChild(document.createTextNode(h.label.slice(hintTyped.length)));
        hintLayer.appendChild(chip);
      }
      hintLayer.style.display = "block";
      hintBar.textContent =
        `${shown.length} link${shown.length === 1 ? "" : "s"} — type a label to copy · Shift+label to open · Esc to dismiss`;
      hintBar.style.display = "block";
    };

    const closeHints = () => {
      if (!hints.length) return;
      hints = [];
      hintTyped = "";
      hintLayer.textContent = "";
      hintLayer.style.display = "none";
      hintBar.style.display = "none";
    };

    const activateHint = (h: HintTarget, open: boolean) => {
      const m = h.match;
      closeHints();
      if (open) {
        // Deliberately the SAME two destinations the click path uses: the
        // allowlisted opener for URLs (openTerminalUrl), the editor configured
        // in Settings for paths (editor.ts, which owns its own fallback).
        if (m.kind === "url") openTerminalUrl(m.raw);
        else void openInEditor(resolvePath(m, cwdRef.current), m.line);
        return;
      }
      const text = hintCopyText(m);
      navigator.clipboard.writeText(text).then(
        () => useUI.getState().pushToast("success", `Copied ${text.length > 60 ? `…${text.slice(-57)}` : text}`),
        () => useUI.getState().pushToast("error", "Couldn’t copy — clipboard unavailable.")
      );
    };

    const openHints = (): boolean => {
      closeHints();
      const buf = term.buffer.active;
      const rows: string[] = [];
      for (let r = 0; r < term.rows; r++) rows.push(buf.getLine(buf.viewportY + r)?.translateToString(true) ?? "");
      hints = hintTargets(rows);
      if (!hints.length) {
        // The empty state is a real state: silence here reads as a broken
        // shortcut rather than "there was nothing to label".
        useUI.getState().pushToast("info", "No file paths or links on screen to pick.");
        return false;
      }
      renderHints();
      return true;
    };
    showHintsRef.current = openHints;
    // Any of these invalidate the coordinates the chips were placed at, and a
    // chip pointing at the wrong text is worse than no chip.
    const hintBlur = () => closeHints();
    // Set fully once the sticky strip below exists; both overlays re-measure
    // through it when the pane's font size changes.
    remeasureOverlaysRef.current = closeHints;
    term.textarea?.addEventListener("blur", hintBlur);
    el.addEventListener("mousedown", hintBlur);

    // --- QL-753: command marks ---------------------------------------------
    // One entry per prompt the shell drew. `ran` means a command actually
    // executed (133;C, or a 133;D that carried an exit code) — a bare Enter
    // leaves a prompt behind and must not clutter the ruler or the jump list.
    interface CmdMark { marker: IMarker; dec?: IDecoration; ran: boolean; exit?: number }
    const marks: CmdMark[] = [];
    const MARK_CAP = 500; // ~a session's worth; the oldest are dropped first
    let markCarry = "";
    let colours = markColours();

    const paintMark = (m: CmdMark) => {
      m.dec?.dispose();
      m.dec = undefined;
      if (!m.ran || m.exit === undefined) return; // status unknown yet
      const failed = m.exit !== 0;
      const colour = failed ? colours.err : colours.ok;
      const dec = term.registerDecoration({
        marker: m.marker,
        x: 0,
        width: 1,
        overviewRulerOptions: { color: colour, position: "full" },
      });
      if (!dec) return;
      m.dec = dec;
      dec.onRender((el) => {
        // A bar at the left edge of the first cell, not a filled cell: the
        // prompt character underneath stays readable. Failures get a thicker
        // one so the gutter reads at a glance without relying on hue alone.
        el.style.background = `linear-gradient(to right, ${colour} 0 ${failed ? 3 : 2}px, transparent ${failed ? 3 : 2}px)`;
        // The decoration sits over a real terminal cell — never let it eat a
        // click meant for the pane (selection, mouse-reporting TUIs).
        el.style.pointerEvents = "none";
      });
    };

    const dropMark = (m: CmdMark) => {
      const i = marks.indexOf(m);
      if (i >= 0) marks.splice(i, 1);
      m.dec?.dispose();
      m.marker.dispose();
    };

    const handleMark = (ev: ShellMarkEvent) => {
      if (ev.kind === "cwd") {
        if (!ev.cwd || ev.cwd === cwdRef.current) return;
        cwdRef.current = ev.cwd;
        onCwd?.(ev.cwd);
        return;
      }
      if (ev.kind === "prompt") {
        const marker = term.registerMarker(0);
        if (!marker) return;
        const mark: CmdMark = { marker, ran: false };
        // Scrollback eviction disposes the marker for us; keep the list honest.
        marker.onDispose(() => {
          const i = marks.indexOf(mark);
          if (i >= 0) marks.splice(i, 1);
          mark.dec?.dispose();
        });
        marks.push(mark);
        while (marks.length > MARK_CAP) dropMark(marks[0]);
        return;
      }
      const current = marks[marks.length - 1];
      if (!current) return;
      if (ev.kind === "output") { current.ran = true; return; }
      // "done": the shell reports it at the NEXT prompt, so it belongs to the
      // mark opened at the previous one.
      if (ev.exit === undefined) {
        // Nothing ran at that prompt (bare Enter / Ctrl+C) — drop it rather
        // than leave an unexplained tick on the ruler.
        if (!current.ran) dropMark(current);
        return;
      }
      current.ran = true;
      current.exit = ev.exit;
      paintMark(current);
    };

    // Ctrl+Up / Ctrl+Down jump between command marks. Checked against the
    // shortcut map first: Cockpit owns Ctrl+Alt+Arrows (pane focus) and
    // Ctrl+Alt+Shift+Left/Right (pane move) — both require Alt, so plain
    // Ctrl+Arrow is free. Returning false from the handler also stops xterm
    // sending CSI 1;5A/B to the shell, which would otherwise reach PSReadLine.
    const jumpMark = (dir: 1 | -1): boolean => {
      const lines = marks.filter((m) => m.ran).map((m) => m.marker.line);
      const target = nextMarkLine(lines, term.buffer.active.viewportY, dir);
      if (target === null) return false;
      term.scrollToLine(Math.max(0, target));
      return true;
    };
    jumpMarkRef.current = jumpMark;

    // --- QL-755: sticky command line ---------------------------------------
    // Scrolled back through a long build, the one thing you can't see is which
    // command produced what you're reading. Pin the owning prompt to the top
    // of the pane (VS Code's pattern) while, and only while, the pane is off
    // its live tail and the shell is actually emitting 133 marks.
    const sticky = document.createElement("div");
    sticky.className = "xterm-sticky";
    sticky.style.display = "none";
    sticky.setAttribute("role", "button");
    sticky.tabIndex = -1;
    const stickyText = document.createElement("span");
    stickyText.className = "xterm-sticky-text";
    const stickyJump = document.createElement("span");
    stickyJump.className = "xterm-sticky-jump";
    stickyJump.textContent = "↑ jump";
    sticky.append(stickyText, stickyJump);
    term.element?.appendChild(sticky);

    let stickyLine: number | null = null;
    let stickyShown = "";
    let stickyRaf = 0;
    const updateSticky = () => {
      stickyRaf = 0;
      const buf = term.buffer.active;
      const metrics = cellMetrics();
      const scrolledBack = buf.viewportY < buf.baseY;
      const target = scrolledBack && metrics
        ? stickyMarkLine(marks.filter((m) => m.ran).map((m) => m.marker.line), buf.viewportY)
        : null;
      const text = target === null ? "" : (buf.getLine(target)?.translateToString(true).trim() ?? "");
      if (!text || !metrics) {
        if (stickyLine !== null) { stickyLine = null; stickyShown = ""; sticky.style.display = "none"; }
        return;
      }
      stickyLine = target;
      if (text !== stickyShown) {
        stickyShown = text;
        stickyText.textContent = text;
        sticky.title = `${text} — click to scroll back to this command`;
      }
      sticky.style.display = "flex";
      sticky.style.left = `${metrics.x}px`;
      sticky.style.top = `${metrics.y}px`;
      sticky.style.width = `${metrics.w * term.cols}px`;
      sticky.style.height = `${Math.max(16, metrics.h)}px`;
      sticky.style.fontSize = `${term.options.fontSize ?? 12}px`;
    };
    // Coalesced: onWriteParsed fires per flush on a chatty pane, and this reads
    // layout. One update per frame is plenty for a one-line label.
    const scheduleSticky = () => { if (!stickyRaf) stickyRaf = requestAnimationFrame(updateSticky); };
    remeasureOverlaysRef.current = () => { closeHints(); scheduleSticky(); };
    // mousedown is swallowed so clicking the strip never steals the caret out
    // of the terminal; the click itself scrolls and hands focus straight back.
    sticky.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    sticky.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (stickyLine === null) return;
      term.scrollToLine(Math.max(0, stickyLine));
      term.focus();
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // QL-754: while the hints are up this pane is in a mode — every key
      // belongs to the mode and none of them reach the shell.
      if (hints.length) {
        // Ctrl/Meta combos are the app's, not the mode's — Cockpit's global
        // handler runs in the capture phase and has already seen them, so
        // swallowing one here would fire the app action AND pick a hint. Step
        // out of the mode and let it be what it was.
        if (e.ctrlKey || e.metaKey) { closeHints(); return true; }
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") { closeHints(); return false; }
        if (e.key === "Backspace") {
          if (hintTyped) { hintTyped = hintTyped.slice(0, -1); renderHints(); } else closeHints();
          return false;
        }
        const ch = e.key.length === 1 ? e.key.toLowerCase() : "";
        if (!ch || !HINT_ALPHABET.includes(ch)) { closeHints(); return false; }
        const next = hintTyped + ch;
        const exact = hints.find((h) => h.label === next);
        // Shift is the open modifier: the labels are lowercase letters, so a
        // capital one is unambiguous and needs no extra keystroke.
        if (exact) { activateHint(exact, e.shiftKey || e.altKey); return false; }
        if (!hints.some((h) => h.label.startsWith(next))) { closeHints(); return false; }
        hintTyped = next;
        renderHints();
        return false;
      }
      // Checked against the shortcut map (Settings.tsx FIXED_SHORTCUTS + the
      // Cockpit global handler): nothing binds Ctrl+Shift+Space anywhere.
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === " " || e.code === "Space")) {
        e.preventDefault();
        e.stopPropagation();
        openHints();
        return false;
      }
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return true;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return true;
      e.preventDefault();
      jumpMark(e.key === "ArrowDown" ? 1 : -1);
      return false;
    });

    let paneId = 0;
    let disposed = false;
    let unOut: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let unState: (() => void) | undefined;
    let unProc: (() => void) | undefined;
    // The Rust reader can emit output before pty_spawn's id round-trips back here;
    // buffer anything that arrives while paneId is still 0, then replay it.
    const earlyOut: { pane_id: number; b64: string }[] = [];
    // Same race for the spawn-time `pty://proc` root-name event.
    const earlyProc = new Map<number, string>();

    const decodeB64 = (b64: string): Uint8Array => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    };
    // UI-229: a chatty agent emits many small chunks; writing each one
    // separately makes xterm re-render per event. Coalesce into one write per
    // animation frame (still ordered, still lossless).
    let writeQueue: Uint8Array[] = [];
    let writeRaf = 0;
    // QL-753: marks parsed out of the bytes still queued above. They're applied
    // in term.write's parsed-callback so the cursor is already on the line the
    // mark describes. Batch granularity: two prompts inside one 16ms flush
    // share a line, which is only reachable by a burst of instant commands.
    const pendingMarks: ShellMarkEvent[] = [];
    const hiddenMarks: ShellMarkEvent[] = [];
    const flushWrites = () => {
      writeRaf = 0;
      if (writeQueue.length === 0) return;
      const evs = pendingMarks.splice(0);
      const applyMarks = () => { for (const ev of evs) handleMark(ev); };
      if (writeQueue.length === 1) { term.write(writeQueue[0], applyMarks); writeQueue = []; return; }
      let total = 0;
      for (const b of writeQueue) total += b.length;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const b of writeQueue) { merged.set(b, off); off += b.length; }
      writeQueue = [];
      term.write(merged, applyMarks);
    };
    const writeBytes = (bytes: Uint8Array) => {
      writeQueue.push(bytes);
      if (writeRaf === 0) writeRaf = requestAnimationFrame(flushWrites);
    };
    const writeB64 = (b64: string) => writeBytes(decodeB64(b64));

    // Hidden-pane render throttle: while this pane's container is display:none
    // (a background workspace, or another pane is maximised), don't bother
    // writing to xterm at all — buffer (capped) and flush in one go on reveal.
    let visible = true;
    let hiddenBuf: Uint8Array[] = [];
    let hiddenBytes = 0;
    let truncated = false;
    const pushHidden = (bytes: Uint8Array) => {
      hiddenBuf.push(bytes);
      hiddenBytes += bytes.length;
      while (hiddenBytes > HIDDEN_BUFFER_CAP && hiddenBuf.length > 1) {
        const dropped = hiddenBuf.shift()!;
        hiddenBytes -= dropped.length;
        truncated = true;
      }
    };
    const flushHidden = () => {
      if (hiddenBuf.length === 0) return;
      if (truncated) term.write("\r\n\x1b[2m[…output truncated while this pane was hidden…]\x1b[0m\r\n");
      for (const b of hiddenBuf) writeBytes(b);
      // Marks parsed while hidden ride along with the bytes they came from.
      pendingMarks.push(...hiddenMarks.splice(0));
      hiddenBuf = [];
      hiddenBytes = 0;
      truncated = false;
    };
    // UI-128: on a chatty agent it's easy to scroll up to read something and
    // then lose track of whether output is still arriving. Count what's landed
    // since the user left the bottom.
    let linesBehind = 0;
    const atBottom = () => term.buffer.active.viewportY >= term.buffer.active.baseY - 1;
    const scrollDisp = term.onScroll(() => {
      // QL-754: the chips were placed against the rows that were on screen when
      // the mode opened — once those move, every one of them lies.
      closeHints();
      scheduleSticky(); // QL-755
      if (atBottom()) { linesBehind = 0; onScrollAway?.(0); }
    });
    const writeDisp = term.onWriteParsed(() => {
      scheduleSticky(); // QL-755: a new mark (or reflow) can change the owner
      if (atBottom()) { if (linesBehind !== 0) { linesBehind = 0; onScrollAway?.(0); } return; }
      linesBehind++;
      onScrollAway?.(linesBehind);
    });

    const io = new IntersectionObserver((entries) => {
      const nowVisible = entries[entries.length - 1]?.isIntersecting ?? true;
      if (nowVisible === visible) return;
      visible = nowVisible;
      if (visible) { flushHidden(); try { fit.fit(); } catch { /* mid-teardown */ } }
    }, { threshold: 0 });
    io.observe(el);

    // Frontend-computed "waiting" (configurable quiet-threshold): the backend
    // still tells us starting/running/error/idle, but "waiting" is superseded
    // here so it can be tuned per-pane without a Rust round-trip.
    //
    // UI-2/#220: when the quiet moment arrives, the recent output tail decides
    // whether this is plain "waiting" or a blocked-on-approval "permission"
    // prompt (Warp-style badge). Patterns are vendor-agnostic v1; per-vendor
    // patterns become manifest fields later (#220 full).
    const PERMISSION_PATTERNS = [
      /do you want to/i,
      /would you like to/i,
      /\b(allow|approve|grant|trust) (this|these|it|access|edits?|command)/i,
      /\((y\/n|yes\/no)\)|\[(y\/n|yes\/no)\]/i,
      /❯?\s*1\.\s*yes/i,
      /press enter to (continue|confirm|approve)/i,
      /waiting for (your )?(approval|confirmation|permission)/i,
    ];
    // CSI + OSC stripping so patterns match what the user sees, not the codes.
    const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
    const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
    const textDecoder = new TextDecoder("utf-8", { fatal: false });
    let outTail = "";
    const appendTail = (bytes: Uint8Array) => {
      const text = textDecoder.decode(bytes);
      // UI-135: the agent rang the terminal bell — surface it as a visual pulse
      // (many CLIs ring on "done" or "needs input").
      if (text.includes("\x07")) onBell?.();
      // QL-753/757: command marks and cwd reports (these are stripped out of
      // the tail below as plain OSC, so parse first). A cwd report is
      // position-free and applies immediately; a command mark has to wait
      // until the bytes it arrived with are actually IN the buffer, or
      // registerMarker records the cursor's previous line — see flushWrites.
      const marksSeen = parseShellMarks(text, markCarry);
      markCarry = marksSeen.carry;
      for (const ev of marksSeen.events) {
        if (ev.kind === "cwd") handleMark(ev);
        else (visible ? pendingMarks : hiddenMarks).push(ev);
      }
      outTail = (outTail + text).slice(-600);
      // UI-136: npm, winget and cargo already emit OSC 9;4 progress that
      // Windows Terminal renders on its taskbar. We're a terminal too — read it
      // and show it, rather than making the user guess how far `npm ci` is.
      //   ESC ] 9 ; 4 ; <state> ; <pct> BEL    state: 0 clear, 1 set, 2 error, 3 indeterminate
      // QL-782: the same reading also goes to the app-wide store above, which
      // is what reaches the Windows taskbar. `onProgress` (the pane's own
      // status band) keeps its original null/-1/pct contract.
      for (const m of text.matchAll(/\x1b\]9;4;(\d)(?:;(\d{1,3}))?(?:\x07|\x1b\\)/g)) {
        const state = m[1];
        if (state === "0") {
          onProgress?.(null);
          publishPaneProgress(paneId, null);
        } else if (state === "3") {
          onProgress?.(-1);
          publishPaneProgress(paneId, { state: "indeterminate", percent: 0 });
        } else {
          const pct = Math.min(100, parseInt(m[2] ?? "0", 10));
          onProgress?.(pct);
          publishPaneProgress(paneId, { state: state === "2" ? "error" : "normal", percent: pct });
        }
      }
      // UI-141: keep the last meaningful line for the attention queue.
      const clean = outTail.replace(OSC_RE, "").replace(ANSI_RE, "");
      const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length) onLine?.(lines[lines.length - 1].slice(0, 120));
    };
    const tailShowsPermissionPrompt = () =>
      PERMISSION_PATTERNS.some((re) => re.test(outTail.replace(OSC_RE, "").replace(ANSI_RE, "")));

    let currentlyAlive = false;
    let localWaiting = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const clearQuietTimer = () => { if (quietTimer !== undefined) { clearTimeout(quietTimer); quietTimer = undefined; } };
    const armQuietTimer = () => {
      clearQuietTimer();
      quietTimer = setTimeout(() => {
        if (disposed || !currentlyAlive) return;
        localWaiting = true;
        onState?.(tailShowsPermissionPrompt() ? "permission" : "waiting");
      }, quietThresholdRef.current);
    };
    const bumpActivity = () => {
      // Output IS proof of life. The backend also emits pty://state "running",
      // but relying on that alone means a pane can sit showing "Launching…"
      // while visibly streaming text if that one event is missed — the UI
      // contradicting what the user can plainly see.
      if (!currentlyAlive) {
        currentlyAlive = true;
        onState?.("running");
      }
      if (localWaiting) { localWaiting = false; onState?.("running"); }
      armQuietTimer();
    };

    // QL-762: last session's buffer, painted before the PTY attaches (the
    // serialize addon's own recommendation — a restored frame that renders
    // once beats one that renders as it streams). Written straight through
    // rather than via writeBytes: it is not PTY output, so it must not be
    // parsed for marks, progress or the permission-prompt tail. The separator
    // is the honesty bit — without it there is no way to tell last week's
    // output from this second's.
    if (restoredRef.current) {
      const text = restoredRef.current;
      term.write(text.endsWith("\n") ? text : `${text}\r\n`);
      term.write("\x1b[2m— restored scrollback ends here —\x1b[0m\r\n");
    }

    (async () => {
      unOut = await listen<{ pane_id: number; b64: string }>("pty://output", (e) => {
        if (paneId === 0) { earlyOut.push(e.payload); return; }
        if (e.payload.pane_id !== paneId) return;
        bumpActivity();
        const bytes = decodeB64(e.payload.b64);
        appendTail(bytes);
        if (visible) writeBytes(bytes); else pushHidden(bytes);
      });
      unExit = await listen<{ pane_id: number; crashed: boolean }>("pty://exit", (e) => {
        if (e.payload.pane_id !== paneId) return;
        currentlyAlive = false;
        clearQuietTimer();
        // QL-782: a finished install must not leave 87% on the taskbar forever.
        publishPaneProgress(paneId, null);
        term.write(e.payload.crashed
          ? "\r\n\x1b[31m[process exited — crashed]\x1b[0m\r\n"
          : "\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        onExit?.(e.payload.crashed);
      });
      unState = await listen<{ pane_id: number; state: string }>("pty://state", (e) => {
        if (e.payload.pane_id !== paneId) return;
        if (e.payload.state === "waiting") return; // computed locally instead, see above
        if (e.payload.state === "running") {
          currentlyAlive = true;
          localWaiting = false;
          armQuietTimer();
        } else {
          currentlyAlive = false;
          clearQuietTimer();
        }
        onState?.(e.payload.state);
      });

      unProc = await listen<{ pane_id: number; name: string }>("pty://proc", (e) => {
        if (paneId === 0) { earlyProc.set(e.payload.pane_id, e.payload.name); return; }
        if (e.payload.pane_id !== paneId) return;
        onProc?.(e.payload.name);
      });

      try {
        paneId = await invoke<number>("pty_spawn", { vendor, cwd, cols: term.cols, rows: term.rows, setup: setup ?? null });
        paneIdRef.current = paneId;
      } catch (err) {
        // UI-11: a raw error string tells the user nothing actionable. Name the
        // likely cause and the fix, keeping the technical detail underneath
        // rather than instead of it.
        const raw = String(err);
        const guess = /not found|no such file|cannot find|not recognized/i.test(raw)
          ? `${vendor} doesn't look installed, or isn't on your PATH.`
          : /denied|permission/i.test(raw)
            ? `Windows blocked launching ${vendor} from this folder.`
            : /directory|cwd|path/i.test(raw)
              ? "This pane's folder couldn't be opened — it may have been moved or deleted."
              : `${vendor} couldn't be started.`;
        term.write(
          `\r\n\x1b[31m${guess}\x1b[0m\r\n` +
          `\x1b[2mCheck Settings > Agents for install and sign-in state, then Restart this pane.\x1b[0m\r\n` +
          `\x1b[2m${raw}\x1b[0m\r\n`
        );
        onState?.("error");
        return;
      }
      if (setup) onSetupConsumed?.();
      if (disposed) { invoke("pty_kill", { paneId }); return; }

      // Replay buffered output belonging to this pane, then go live.
      for (const p of earlyOut) {
        if (p.pane_id !== paneId) continue;
        if (visible) writeB64(p.b64); else pushHidden(decodeB64(p.b64));
      }
      earlyOut.length = 0;
      const bufferedProc = earlyProc.get(paneId);
      if (bufferedProc) onProc?.(bufferedProc);
      earlyProc.clear();

      // The container may have resized during the spawn round-trip (the observer
      // fires before onResize is wired), so push the current size once.
      invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows });

      // UX-581: mirror the unsent input line into the store so a restart can
      // restore it. Approximates line editing (it does not follow arrow-key
      // cursor movement), which is enough to not lose a typed-but-unsent
      // prompt. Debounced so a fast typist doesn't thrash the session save.
      if (initialDraft) invoke("pty_write", { paneId, data: initialDraft });
      let draftBuf = initialDraft ?? "";
      let draftTimer: ReturnType<typeof setTimeout> | undefined;
      const saveDraft = () => {
        if (draftTimer) clearTimeout(draftTimer);
        draftTimer = setTimeout(() => useApp.getState().setPaneDraft(paneId, draftBuf), 400);
      };
      term.onData((d) => {
        invoke("pty_write", { paneId, data: d });
        if (d === "\r" || d === "\n") draftBuf = "";
        else if (d === "\x7f" || d === "\b") draftBuf = draftBuf.slice(0, -1);
        else if (!d.startsWith("\x1b")) draftBuf += d;
        saveDraft();
      });
      term.onResize(({ cols, rows }) => invoke("pty_resize", { paneId, cols, rows }));
      term.focus();
    })();

    // A divider dragged to its minimum can leave the container a few pixels
    // wide; fit() only guards "not measured yet", not a genuinely degenerate
    // size, and xterm throws on a zero-column fit.
    const ro = new ResizeObserver(() => {
      if (!visible) return;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) return;
      // Reflow moves every hint chip off its character; the sticky strip just
      // needs re-measuring against the new cell size.
      closeHints();
      try { fit.fit(); } catch { /* mid-teardown */ }
      scheduleSticky();
    });
    ro.observe(el);

    // Live theme sync: Settings flips `data-theme` on <html> with no event of
    // its own, so watch the attribute directly. Mutates xterm's existing
    // theme option in place — same pattern as the fontSize effect below —
    // never remounts/respawns the PTY.
    // UI-28: every data-theme mutation rewrote the whole xterm palette. Flipping
    // themes quickly (or a theme picker previewing on hover) meant a burst of
    // full repaints. Coalesce to one per frame.
    let themeRaf = 0;
    const themeObserver = new MutationObserver(() => {
      if (themeRaf) return;
      themeRaf = requestAnimationFrame(() => {
        themeRaf = 0;
        const next = terminalThemeFor(activeThemeId());
        themeRef.current = next;
        term.options.theme = next;
        // QL-753: command marks are painted in the app's --st-* tokens, which
        // the theme (and colour-blind mode) just changed under them.
        colours = markColours();
        for (const m of marks) paintMark(m);
      });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      disposed = true;
      if (writeRaf) cancelAnimationFrame(writeRaf);
      clearQuietTimer();
      ro.disconnect();
      io.disconnect();
      themeObserver.disconnect();
      if (themeRaf) cancelAnimationFrame(themeRaf);
      pathLinks.dispose();
      // QL-754/755: overlays live in term.element, which term.dispose() takes
      // with it — removed explicitly anyway so nothing survives a partial
      // teardown, and their listeners go with them.
      if (stickyRaf) cancelAnimationFrame(stickyRaf);
      if (serializeIdle) clearTimeout(serializeIdle); // QL-762
      term.textarea?.removeEventListener("blur", hintBlur);
      el.removeEventListener("mousedown", hintBlur);
      hintLayer.remove();
      hintBar.remove();
      sticky.remove();
      for (const m of marks.splice(0)) { m.dec?.dispose(); m.marker.dispose(); }
      jumpMarkRef.current = () => false;
      showHintsRef.current = () => false;
      remeasureOverlaysRef.current = () => {};
      scrollDisp.dispose();
      writeDisp.dispose();
      unOut?.();
      unExit?.();
      unState?.();
      unProc?.();
      publishPaneProgress(paneId, null); // QL-782
      if (paneId) invoke("pty_kill", { paneId });
      paneIdRef.current = 0;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchAddonRef.current = null;
      serializeAddonRef.current = null;
    };
    // fontSize/ligatures/quietThresholdMs deliberately excluded — none of them
    // should remount/respawn the PTY, they're applied live by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor, cwd]);

  // Live font-size zoom: mutate the existing terminal in place, no remount.
  useEffect(() => {
    fontSizeRef.current = fontSize;
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try { fitRef.current?.fit(); } catch { /* mid-teardown */ }
    remeasureOverlaysRef.current(); // QL-754/755: cell size just moved
  }, [fontSize]);

  // Ligatures toggle: load/dispose the addon in place.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (ligatures) {
      const addon = new LigaturesAddon();
      term.loadAddon(addon);
      ligAddonRef.current = addon;
    }
    return () => { ligAddonRef.current?.dispose(); ligAddonRef.current = null; };
  }, [ligatures]);

  // Configurable quiet-threshold: takes effect from the next activity cycle
  // (doesn't retroactively reschedule an already-pending timer).
  useEffect(() => {
    quietThresholdRef.current = quietThresholdMs;
  }, [quietThresholdMs]);

  // QL-758: the pane menu's OSC 52 toggle, live — no remount, no respawn.
  useEffect(() => {
    osc52Ref.current = osc52;
  }, [osc52]);

  return <div ref={elRef} style={{ width: "100%", height: "100%" }} />;
});
