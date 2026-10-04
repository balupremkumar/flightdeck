import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useApp } from "./store";
import { Terminal as XTerm } from "@xterm/xterm";
import type { ILinkProvider, ILink, ITheme, IMarker, IDecoration } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
// QL-762: the SerializeAddon TYPE lives in paneSessions.ts. The addon itself is ~32KB of vendor code that is not
// needed to paint a pane — only to snapshot one for the session doc, which
// first happens ~20s in — so it is dynamically imported below and deliberately
// NOT added to vite.config.ts's `xterm` manualChunk (that chunk is eagerly
// loaded; listing it there would put it straight back in the boot payload and
// blow perfbudget.test.ts's cold-start budget).
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { terminalThemeFor } from "./terminal-theme";
import { getTerminalSettings } from "./Settings";
import { linkify, resolvePath, type LinkMatch } from "./linkify";
import { openInEditor } from "./editor";
import { useUI } from "./ui";
import { resolveCandidates } from "./termlinkResolve";
import {
  VAULT_ROOT, candidateBases, stitchLogical, matchRange, rangesOverlap, rangeTouchesRow, hardWrapLink, parseFileUri,
  pickFileHit, createDedupe, type LinkTarget, type Range, type RowInfo,
} from "./termlinks";
import { requestReveal } from "./revealInTree";
import { LinkMenuHost, linkMenuItems, openLinkMenu } from "./LinkMenu";
import {
  acquire, attach, detach, get as getSession, setSessionFactory, fitIfSane, FALLBACK_COLS, FALLBACK_ROWS,
  type PaneHandlers, type PaneSession, type SessionLive, type SpawnSpec,
} from "./paneSessions";

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
// WebLinksAddon (registered alongside this in createSession) — this provider
// only emits `linkify()`'s 'path' matches, so the two never fight over the same
// span. Plain click previews the file in-app (UX-505); Ctrl/Cmd+click opens it in
// the editor configured in Settings (src/editor.ts); a folder reveals in the
// Explorer panel (1.4a); right-click opens LinkMenu (1.4b/c).
// Phase 1 L3: a path is only underlined once a candidate base resolves it on
// disk (pane worktree, last-known cwd, workspace root, vault root; see
// termlinks.ts candidateBases and termlinkResolve.ts) — unresolved text stays
// plain, so there is no "maybe" state and no not-found toast. Rows joined by an
// xterm soft wrap are linked as one logical line (1.3d), and an Ink hard wrap is
// only joined when the joined path resolves.
// QL-757: `cwdRef` is a ref, not a string, because the pane's folder moves —
// the shell reports the live one via OSC 9;9 after every `cd`, and a relative
// path in output must resolve against where the shell actually IS, not where
// the pane was spawned.

/** What createSession hands the link layer for one pane. */
interface PaneLinkCtx {
  modelId: number;
  cwdRef: { current: string };
  /** The hovered link's menu target (set by hover, cleared by leave), so a
   *  right-click knows whether it landed on a link. Shared by all three sources:
   *  this provider, WebLinksAddon and OSC 8. */
  hover: { current: (() => Promise<LinkTarget | null>) | null };
  /** Click behaviour (dedupe + preview/editor/explorer/browser). */
  open: (t: LinkTarget, e: { ctrlKey: boolean; metaKey: boolean }) => void;
  menuDeps: () => Parameters<typeof linkMenuItems>[1];
}

let vaultBase: Promise<string | null> | null = null;
/** The vault root, but only if it exists on this machine. Cached for the app's life. */
function vaultRootIfExists(): Promise<string | null> {
  vaultBase ??= resolveCandidates([VAULT_ROOT], []).then((h) => (h[0]?.isDir ? VAULT_ROOT : null), () => null);
  return vaultBase;
}

/** Bases for a pane's relative paths, in priority order (1.3b). */
async function paneBases(modelId: number, cwd: string): Promise<string[]> {
  let worktree: string | undefined;
  let root: string | undefined;
  for (const w of useApp.getState().workspaces) {
    const p = w.panes.find((x) => x.id === modelId);
    if (p) { worktree = p.worktreePath; root = w.root; break; }
  }
  return candidateBases({ worktree, cwd, root, vault: await vaultRootIfExists() });
}

/** Resolves an OSC 8 `file://` URI to something that exists, or null. */
async function resolveFileLink(uri: string): Promise<LinkTarget | null> {
  const f = parseFileUri(uri);
  if (!f) return null;
  const hit = pickFileHit(f, await resolveCandidates(f.candidates, []));
  return hit ? { kind: "path", path: hit.path, isDir: hit.isDir, line: hit.line, col: hit.col } : null;
}

/** OSC 8 target: http(s) goes to the browser, file:// must exist, anything else is ignored. */
async function resolveOscLink(uri: string): Promise<LinkTarget | null> {
  if (/^https?:\/\//i.test(uri)) return { kind: "url", url: uri };
  if (/^file:/i.test(uri)) return resolveFileLink(uri);
  return null;
}

function registerPathLinks(term: XTerm, pane: PaneLinkCtx): { dispose(): void } {
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

  interface Cand { m: LinkMatch; range: Range; hard: boolean }

  const buildLinks = async (y: number): Promise<ILink[] | undefined> => {
    const buf = term.buffer.active;
    const getRow = (yy: number): RowInfo | undefined => {
      const l = buf.getLine(yy - 1);
      return l ? { text: l.translateToString(false), wrapped: l.isWrapped } : undefined;
    };
    const logical = stitchLogical(getRow, y);
    if (!logical) return undefined;
    const cands: Cand[] = [];
    for (const m of linkify(logical.text)) {
      if (m.kind !== "path") continue;
      const range = matchRange(logical, m.start, m.end);
      if (range && rangeTouchesRow(range, y)) cands.push({ m, range, hard: false });
    }
    // 1.3d: Ink-style hard wraps (rows NOT flagged isWrapped): this row and the
    // next, or the previous row and this one.
    for (const upperY of [y - 1, y]) {
      const upper = buf.getLine(upperY - 1);
      const lower = buf.getLine(upperY);
      if (!upper || !lower || lower.isWrapped) continue;
      const hw = hardWrapLink(upper.translateToString(true), lower.translateToString(true), term.cols, upperY, upperY + 1);
      if (hw && rangeTouchesRow(hw.range, y)) cands.push({ m: hw.match, range: hw.range, hard: true });
    }
    if (!cands.length) return undefined;

    const hits = await resolveCandidates(cands.map((c) => c.m.raw), await paneBases(pane.modelId, pane.cwdRef.current));
    const resolved = cands.flatMap((c, i) => (hits[i] ? [{ c, hit: hits[i]! }] : []));
    // A joined (hard-wrapped) path supersedes any partial match inside it.
    const joined = resolved.filter((r) => r.c.hard).map((r) => r.c.range);
    const final = resolved.filter((r) => r.c.hard || !joined.some((j) => rangesOverlap(j, r.c.range)));
    if (!final.length) return undefined;

    return final.map(({ c, hit }) => {
      const target: LinkTarget = { kind: "path", path: hit.path, isDir: hit.isDir, line: c.m.line, col: c.m.col };
      const resolver = () => Promise.resolve<LinkTarget | null>(target);
      const link: ILink = {
        range: c.range,
        text: c.m.text,
        decorations: { pointerCursor: true, underline: true },
        // xterm fires activate on mouseup of ANY button; only the left one is a click.
        activate: (event) => { if (event.button === 0) pane.open(target, event); },
        hover: (event) => {
          pane.hover.current = resolver;
          showTip(event, hit.isDir
            ? "Click — reveal in Explorer   ·   Right-click — more"
            : "Click — preview   ·   Ctrl+click — open in editor   ·   Right-click — more");
        },
        leave: () => { if (pane.hover.current === resolver) pane.hover.current = null; hideTip(); },
      };
      return link;
    });
  };

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      buildLinks(bufferLineNumber).then(callback, () => callback(undefined));
    },
  };
  const disp = term.registerLinkProvider(provider);

  // 1.4b: right-click over a link opens LinkMenu; anywhere else the event is
  // left completely alone (native/xterm behaviour unchanged).
  const onContextMenu = (e: MouseEvent) => {
    const resolve = pane.hover.current;
    if (!resolve) return;
    e.preventDefault();
    e.stopPropagation();
    const { clientX: x, clientY: y } = e;
    void resolve().then((t) => {
      if (t) openLinkMenu({ modelId: pane.modelId, x, y, items: linkMenuItems(t, pane.menuDeps()) });
    });
  };
  const el = term.element;
  el?.addEventListener("contextmenu", onContextMenu, true);
  return { dispose() { disp.dispose(); el?.removeEventListener("contextmenu", onContextMenu, true); tip.remove(); } };
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
  /** The store's PaneModel.id. NOT the Rust pty id (that is the effect-local
   *  `paneId`): store actions such as setPaneDraft match on the model id. */
  modelId: number;
  vendor: string;
  /** PaneModel.epoch: part of the session's generation, so a Restart (epoch
   *  bump) replaces the PTY while a mere remount does not. */
  epoch?: number;
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

type WebglRef = { current: WebglAddon | null; lost: boolean };

/** QL-736: GPU renderer. Activation throws where WebGL2 isn't available —
 *  not fatal, xterm keeps the DOM renderer. Context loss (driver reset, GPU
 *  sleep) disposes the addon and falls back. R1: a parked / moved pane may
 *  also lose its context to Chromium's per-page cap, so attach re-creates it after a loss. */
function loadWebgl(term: XTerm, ref: WebglRef): void {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => { webgl.dispose(); if (ref.current === webgl) { ref.current = null; ref.lost = true; } });
  term.loadAddon(webgl);
  ref.current = webgl;
}
/** Attach hook: a session creates its WebGL context once, at creation. It only
 *  re-creates one if that context was actually lost; never a second one for a
 *  session that has one (Chromium caps live contexts at ~16 per page). */
function reloadWebglIfLost(term: XTerm, ref: WebglRef): void {
  if (ref.current || !ref.lost) return;
  ref.lost = false;
  try { loadWebgl(term, ref); } catch { /* stay on the DOM renderer */ }
}

/** R1: builds the xterm + PTY for one pane. Registered with paneSessions as the
 *  factory; it runs ONCE per (pane id, gen), not once per React mount, and
 *  everything it sets up is torn down by paneSessions.dispose() through
 *  entry.disposers, never by a component unmounting. */
function createSession(modelId: number, gen: string, spec: SpawnSpec, handlers: PaneHandlers, container: HTMLElement): PaneSession {
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;";
  container.appendChild(host);
  const themeRef = { current: terminalThemeFor(activeThemeId()) as ITheme };
  const live: SessionLive = {
    osc52: { current: spec.osc52 },
    quietMs: { current: spec.quietMs },
    fontSize: { current: spec.fontSize },
    ligatures: { current: false },
  };
  const webglRef: WebglRef = { current: null, lost: false };
    // Phase 1 L3 link plumbing, declared before the XTerm options that close over it.
    // QL-757: starts at the spawn cwd and is replaced by every OSC 9;9 report,
    // so a `cd` inside the pane immediately re-bases relative file links.
    const cwdRef = { current: spec.cwd };
    const hoverRef: PaneLinkCtx["hover"] = { current: null };
    let oscHover: (() => Promise<LinkTarget | null>) | null = null;
    let urlHover: (() => Promise<LinkTarget | null>) | null = null;
    const dedupe = createDedupe(); // 1.3e: Claude Code fullscreen fires one OSC 8 activation twice
    const openTarget: PaneLinkCtx["open"] = (t, e) => {
      if (!dedupe(t.kind === "url" ? t.url : `${t.path}:${t.line ?? ""}`)) return;
      if (t.kind === "url") { openTerminalUrl(t.url); return; }
      if (t.isDir) { requestReveal(t.path); return; } // 1.4a
      if (e.ctrlKey || e.metaKey) { void openInEditor(t.path, t.line); return; }
      useUI.getState().openPreview(t.path, { line: t.line, fontSize: live.fontSize.current });
    };
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
      fontSize: spec.fontSize,
      cursorBlink: true,
      cursorStyle: ts.cursorStyle,
      scrollback: ts.scrollback,
      theme: themeRef.current,
      // QL-756: OSC 8 hyperlinks — agents and modern CLIs (gh, cargo, vitest)
      // emit them so a PR/docs URL is clickable without printing the raw link.
      // xterm hands the URI over verbatim, so it goes through the same
      // allowlisted opener as the regex-matched URLs below.
      // Phase 1 1.3e: Claude Code also emits file:// links. xterm drops every
      // non-http OSC 8 link unless allowNonHttpProtocols is set, so the scheme
      // gate moves HERE: http(s) -> browser, file:// -> only if it exists, and
      // everything else is ignored (resolveOscLink returns null).
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (e, uri) => {
          if (e.button !== 0) return;
          void resolveOscLink(uri).then((t) => { if (t) openTarget(t, e); });
        },
        hover: (_e, uri) => {
          const resolver = () => resolveOscLink(uri);
          hoverRef.current = resolver;
          oscHover = resolver;
        },
        leave: () => { if (hoverRef.current === oscHover) hoverRef.current = null; },
      },
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
    const webLinks = new WebLinksAddon(
      (e, uri) => { if (e.button === 0) openTarget({ kind: "url", url: uri }, e); },
      {
        hover: (_e, uri) => { const r = () => Promise.resolve<LinkTarget | null>({ kind: "url", url: uri }); hoverRef.current = r; urlHover = r; },
        leave: () => { if (hoverRef.current === urlHover) hoverRef.current = null; },
      }
    );
    term.loadAddon(webLinks);
    // QL-751: agent TUIs draw with emoji and box-drawing characters whose
    // widths changed in Unicode 11; on xterm's default table they measure one
    // cell short and every box in the frame tears. Registered before open() so
    // the first paint already uses the right widths.
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.open(host);
    // QL-736: GPU renderer, loaded after open() because it needs the element.
    // A pane streaming a diff repaints far cheaper on WebGL than on the DOM
    // renderer. Activation throws where WebGL2 isn't available (software
    // rendering, blocked driver, remote session) — not fatal, xterm just keeps
    // the DOM renderer, so fail silently rather than warn about something the
    // user can't act on. Context loss (driver reset, GPU sleep) is the same
    // story: dispose and fall back, never take the pane down over a repaint.
    try {
      loadWebgl(term, webglRef);
    } catch { /* no WebGL2 here — DOM renderer it is */ }
    // Spawn waits for the first sane fit (see below), so a cell that
    // react-resizable-panels has not sized yet never sets the PTY's size.
    let spawnReady!: () => void;
    const sized = new Promise<void>((res) => { spawnReady = res; });
    const fitSane = (): boolean => {
      const ok = fitIfSane(fit);
      if (ok) spawnReady();
      return ok;
    };
    fitSane();
    const entry: PaneSession = {
      modelId, gen, term, host, fit, search, serialize: null, ligatures: null, ptyId: 0, handlers, live,
      theme: themeRef,
      api: { jumpMark: () => false, showHints: () => false, remeasure: () => {}, onAttach: () => { fitSane(); reloadWebglIfLost(term, webglRef); } },
      owner: null, saved: { viewportY: 0, atBottom: true, hadFocus: false }, disposers: [], disposed: false,
    };
    // Needs term.element, so registered only after open() above.
    const pathLinks = registerPathLinks(term, {
      modelId,
      cwdRef,
      hover: hoverRef,
      open: openTarget,
      menuDeps: () => ({
        fontSize: live.fontSize.current,
        openUrl: openTerminalUrl,
        // 1.4c: types into THIS pane's PTY, no Enter.
        sendToPane: (text) => {
          if (!entry.ptyId) { useUI.getState().pushToast("error", "This pane isn’t running."); return; }
          void invoke("pty_write", { paneId: entry.ptyId, data: text });
          term.focus();
        },
      }),
    });

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
      if (entry.disposed || entry.serialize) return;
      import("@xterm/addon-serialize")
        .then(({ SerializeAddon }) => {
          if (entry.disposed || entry.serialize) return;
          const addon = new SerializeAddon();
          term.loadAddon(addon);
          entry.serialize = addon;
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
      if (!live.osc52.current) return true;
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
    entry.api.showHints = openHints;
    // Any of these invalidate the coordinates the chips were placed at, and a
    // chip pointing at the wrong text is worse than no chip.
    const hintBlur = () => closeHints();
    // Set fully once the sticky strip below exists; both overlays re-measure
    // through it when the pane's font size changes.
    entry.api.remeasure = closeHints;
    term.textarea?.addEventListener("blur", hintBlur);
    host.addEventListener("mousedown", hintBlur);

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
        entry.handlers.onCwd?.(ev.cwd);
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
    entry.api.jumpMark = jumpMark;

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
    entry.api.remeasure = () => { closeHints(); scheduleSticky(); };
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
      if (atBottom()) { linesBehind = 0; entry.handlers.onScrollAway?.(0); }
    });
    const writeDisp = term.onWriteParsed(() => {
      scheduleSticky(); // QL-755: a new mark (or reflow) can change the owner
      if (atBottom()) { if (linesBehind !== 0) { linesBehind = 0; entry.handlers.onScrollAway?.(0); } return; }
      linesBehind++;
      entry.handlers.onScrollAway?.(linesBehind);
    });

    const io = new IntersectionObserver((entries) => {
      const nowVisible = entries[entries.length - 1]?.isIntersecting ?? true;
      if (nowVisible === visible) return;
      visible = nowVisible;
      if (visible) { flushHidden(); fitSane(); }
    }, { threshold: 0 });
    io.observe(host);

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
      if (text.includes("\x07")) entry.handlers.onBell?.();
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
          entry.handlers.onProgress?.(null);
          publishPaneProgress(paneId, null);
        } else if (state === "3") {
          entry.handlers.onProgress?.(-1);
          publishPaneProgress(paneId, { state: "indeterminate", percent: 0 });
        } else {
          const pct = Math.min(100, parseInt(m[2] ?? "0", 10));
          entry.handlers.onProgress?.(pct);
          publishPaneProgress(paneId, { state: state === "2" ? "error" : "normal", percent: pct });
        }
      }
      // UI-141: keep the last meaningful line for the attention queue.
      const clean = outTail.replace(OSC_RE, "").replace(ANSI_RE, "");
      const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length) entry.handlers.onLine?.(lines[lines.length - 1].slice(0, 120));
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
        if (entry.disposed || !currentlyAlive) return;
        localWaiting = true;
        entry.handlers.onState?.(tailShowsPermissionPrompt() ? "permission" : "waiting");
      }, live.quietMs.current);
    };
    const bumpActivity = () => {
      // Output IS proof of life. The backend also emits pty://state "running",
      // but relying on that alone means a pane can sit showing "Launching…"
      // while visibly streaming text if that one event is missed — the UI
      // contradicting what the user can plainly see.
      if (!currentlyAlive) {
        currentlyAlive = true;
        entry.handlers.onState?.("running");
      }
      if (localWaiting) { localWaiting = false; entry.handlers.onState?.("running"); }
      armQuietTimer();
    };

    // QL-762: last session's buffer, painted before the PTY attaches (the
    // serialize addon's own recommendation — a restored frame that renders
    // once beats one that renders as it streams). Written straight through
    // rather than via writeBytes: it is not PTY output, so it must not be
    // parsed for marks, progress or the permission-prompt tail. The separator
    // is the honesty bit — without it there is no way to tell last week's
    // output from this second's.
    if (spec.restoredScrollback) {
      const text = spec.restoredScrollback;
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
        entry.handlers.onExit?.(e.payload.crashed);
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
        entry.handlers.onState?.(e.payload.state);
      });

      unProc = await listen<{ pane_id: number; name: string }>("pty://proc", (e) => {
        if (paneId === 0) { earlyProc.set(e.payload.pane_id, e.payload.name); return; }
        if (e.payload.pane_id !== paneId) return;
        entry.handlers.onProc?.(e.payload.name);
      });

      try {
        // First sane fit, or after a grace period a sane default: never a
        // degenerate size, and never hold a hidden pane's spawn forever.
        await Promise.race([sized, new Promise<void>((res) => setTimeout(res, 500))]);
        if (entry.disposed) return;
        if (!fitSane()) term.resize(FALLBACK_COLS, FALLBACK_ROWS);
        paneId = await invoke<number>("pty_spawn", { vendor: spec.vendor, cwd: spec.cwd, cols: term.cols, rows: term.rows, setup: spec.setup ?? null });
        entry.ptyId = paneId;
      } catch (err) {
        // UI-11: a raw error string tells the user nothing actionable. Name the
        // likely cause and the fix, keeping the technical detail underneath
        // rather than instead of it.
        const raw = String(err);
        const guess = /not found|no such file|cannot find|not recognized/i.test(raw)
          ? `${spec.vendor} doesn't look installed, or isn't on your PATH.`
          : /denied|permission/i.test(raw)
            ? `Windows blocked launching ${spec.vendor} from this folder.`
            : /directory|cwd|path/i.test(raw)
              ? "This pane's folder couldn't be opened — it may have been moved or deleted."
              : `${spec.vendor} couldn't be started.`;
        term.write(
          `\r\n\x1b[31m${guess}\x1b[0m\r\n` +
          `\x1b[2mCheck Settings > Agents for install and sign-in state, then Restart this pane.\x1b[0m\r\n` +
          `\x1b[2m${raw}\x1b[0m\r\n`
        );
        entry.handlers.onState?.("error");
        return;
      }
      if (spec.setup) entry.handlers.onSetupConsumed?.();
      if (entry.disposed) { entry.ptyId = 0; invoke("pty_kill", { paneId }); return; }

      // Replay buffered output belonging to this pane, then go live.
      for (const p of earlyOut) {
        if (p.pane_id !== paneId) continue;
        if (visible) writeB64(p.b64); else pushHidden(decodeB64(p.b64));
      }
      earlyOut.length = 0;
      const bufferedProc = earlyProc.get(paneId);
      if (bufferedProc) entry.handlers.onProc?.(bufferedProc);
      earlyProc.clear();

      // The container may have resized during the spawn round-trip (the observer
      // fires before onResize is wired), so push the current size once.
      invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows });

      // UX-581: mirror the unsent input line into the store so a restart can
      // restore it. Approximates line editing (it does not follow arrow-key
      // cursor movement), which is enough to not lose a typed-but-unsent
      // prompt. Debounced so a fast typist doesn't thrash the session save.
      if (spec.initialDraft) invoke("pty_write", { paneId, data: spec.initialDraft });
      let draftBuf = spec.initialDraft ?? "";
      let draftTimer: ReturnType<typeof setTimeout> | undefined;
      const saveDraft = () => {
        if (draftTimer) clearTimeout(draftTimer);
        draftTimer = setTimeout(() => useApp.getState().setPaneDraft(modelId, draftBuf), 400);
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
      const r = host.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) return;
      // Reflow moves every hint chip off its character; the sticky strip just
      // needs re-measuring against the new cell size.
      closeHints();
      fitSane();
      scheduleSticky();
    });
    ro.observe(host);

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

    entry.disposers.push(() => {
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
      host.removeEventListener("mousedown", hintBlur);
      hintLayer.remove();
      hintBar.remove();
      sticky.remove();
      for (const m of marks.splice(0)) { m.dec?.dispose(); m.marker.dispose(); }
      scrollDisp.dispose();
      writeDisp.dispose();
      unOut?.();
      unExit?.();
      unState?.();
      unProc?.();
      publishPaneProgress(paneId, null); // QL-782
      entry.api = { jumpMark: () => false, showHints: () => false, remeasure: () => {}, onAttach: () => {} };
    });

    return entry;
}

setSessionFactory(createSession);

// One live terminal bound to a PTY in the Rust core. R1: this component no
// longer OWNS the xterm or the PTY (paneSessions does, keyed by modelId); it
// attaches the session's persistent host into its own container and detaches
// on unmount, so a pane changing grid row moves the same terminal instead of
// killing and respawning the agent.
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { modelId, vendor, cwd, epoch = 0, setup, onSetupConsumed, initialDraft, restoredScrollback, osc52 = false, fontSize = 12.5, ligatures = false, quietThresholdMs = 3000, onExit, onState, onProc, onBell, onLine, onScrollAway, onProgress, onCwd },
  ref
) {
  const elRef = useRef<HTMLDivElement>(null);
  const sess = () => getSession(modelId);

  useImperativeHandle(ref, () => ({
    findNext: (query, opts) =>
      sess()?.search.findNext(query, { ...opts, decorations: searchDecorations(sess()!.theme.current) } as ISearchOptions) ?? false,
    findPrevious: (query) =>
      sess()?.search.findPrevious(query, { decorations: searchDecorations(sess()!.theme.current) } as ISearchOptions) ?? false,
    clearSearch: () => sess()?.search.clearDecorations(),
    onSearchResults: (cb) => {
      const d = sess()?.search.onDidChangeResults(cb);
      return () => d?.dispose();
    },
    clearScrollback: () => sess()?.term.clear(),
    scrollToBottom: () => sess()?.term.scrollToBottom(),
    // UX-546/547: whole scrollback as plain text. Walks the buffer rather than
    // selecting, so it never disturbs the user's own selection.
    getScrollbackText: () => {
      const t = sess()?.term;
      if (!t) return "";
      const buf = t.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n");
    },
    getSelection: () => sess()?.term.getSelection() ?? "",
    selectAll: () => sess()?.term.selectAll(),
    copySelection: async () => {
      const sel = sess()?.term.getSelection() ?? "";
      if (sel) await navigator.clipboard.writeText(sel);
    },
    paste: (text: string) => { const id = sess()?.ptyId; if (id) invoke("pty_write", { paneId: id, data: text }); },
    jumpToCommandMark: (dir) => sess()?.api.jumpMark(dir) ?? false,
    showQuickHints: () => sess()?.api.showHints() ?? false,
    // QL-762: try the biggest window first and step down until the result fits
    // the per-pane byte cap — a pane whose output is mostly colour codes still
    // gets SOME history back rather than none.
    serializeScrollback: () => {
      const addon = sess()?.serialize;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [modelId]);

  // The session's callbacks are replaced every render so events always reach
  // the live PaneView, never a closure from a mount that has since gone.
  const handlers: PaneHandlers = { onExit, onState, onProc, onBell, onLine, onScrollAway, onProgress, onCwd, onSetupConsumed };

  // Layout effect so the host lands in its new container before paint (no
  // blank frame), and so in one commit the old owner's detach runs before the
  // new owner's attach. acquire() is idempotent per (modelId, gen): StrictMode's
  // mount-cleanup-mount reuses the session, one spawn and zero kills. The
  // cleanup only DETACHES; killing is paneSessions.dispose()'s job alone.
  // fontSize/ligatures/quietThresholdMs/osc52 are deliberately not deps (they
  // are creation-time values here): the effects below apply them live.
  useLayoutEffect(() => {
    const el = elRef.current!;
    acquire(
      modelId,
      { vendor, cwd, epoch, setup, initialDraft, restoredScrollback, fontSize, osc52, quietMs: quietThresholdMs },
      handlers,
      el
    );
    const token = attach(modelId, el);
    return () => detach(modelId, token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, vendor, cwd, epoch]);

  useLayoutEffect(() => {
    const s = getSession(modelId);
    if (s) s.handlers = handlers;
  });

  // Live font-size zoom: mutate the existing terminal in place, no remount.
  useEffect(() => {
    const s = getSession(modelId);
    if (!s) return;
    s.live.fontSize.current = fontSize;
    s.term.options.fontSize = fontSize;
    fitIfSane(s.fit);
    s.api.remeasure(); // QL-754/755: cell size just moved
  }, [fontSize, modelId, vendor, cwd, epoch]);

  // Ligatures toggle: load/dispose the addon in place.
  useEffect(() => {
    const s = getSession(modelId);
    if (!s) return;
    s.live.ligatures.current = ligatures;
    if (ligatures) {
      const addon = new LigaturesAddon();
      s.term.loadAddon(addon);
      s.ligatures = addon;
    }
    return () => {
      try { s.ligatures?.dispose(); } catch { /* term already disposed */ }
      s.ligatures = null;
    };
  }, [ligatures, modelId, vendor, cwd, epoch]);

  // Configurable quiet-threshold: takes effect from the next activity cycle
  // (doesn't retroactively reschedule an already-pending timer).
  useEffect(() => {
    const s = getSession(modelId);
    if (s) s.live.quietMs.current = quietThresholdMs;
  }, [quietThresholdMs, modelId, vendor, cwd, epoch]);

  // QL-758: the pane menu's OSC 52 toggle, live — no remount, no respawn.
  useEffect(() => {
    const s = getSession(modelId);
    if (s) s.live.osc52.current = osc52;
  }, [osc52, modelId, vendor, cwd, epoch]);

  return (
    <>
      <div ref={elRef} style={{ width: "100%", height: "100%" }} />
      <LinkMenuHost modelId={modelId} />
    </>
  );
});
