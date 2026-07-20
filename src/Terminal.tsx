import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import type { ILinkProvider, ILink, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { terminalThemeFor } from "./terminal-theme";
import { getTerminalSettings } from "./Settings";

// Reads the app's active theme straight off the DOM — the app dispatches no
// theme-change event, so this (plus the MutationObserver below) is how the
// terminal stays in sync with Settings' theme picker.
function activeThemeId(): string {
  return document.documentElement.getAttribute("data-theme") ?? "dark";
}

// Matches Windows/POSIX-ish file paths in terminal output (with an optional
// trailing :line[:col]), e.g. `D:\proj\src\App.tsx:42:5`, `./src/foo.ts`, `/etc/hosts`.
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)[^\s:"'<>|*?]+(?:\.[A-Za-z0-9]{1,10})?(?::\d+(?::\d+)?)?/g;

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

function registerFilePathLinks(term: XTerm): { dispose(): void } {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      FILE_PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FILE_PATH_RE.exec(text))) {
        if (m[0].length < 3) continue; // skip bare "//" / lone punctuation
        const start = m.index;
        const end = start + m[0].length;
        const target = m[0].replace(/:\d+(?::\d+)?$/, ""); // strip trailing :line:col before revealing
        links.push({
          range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end, y: bufferLineNumber } },
          text: m[0],
          activate: () => { revealItemInDir(target).catch(() => { /* not a real path — ignore */ }); },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
  return term.registerLinkProvider(provider);
}

export interface TerminalHandle {
  findNext: (query: string, opts?: { incremental?: boolean }) => boolean;
  findPrevious: (query: string) => boolean;
  clearSearch: () => void;
  onSearchResults: (cb: (e: ISearchResultChangeEvent) => void) => () => void;
  /** UI-134: wipe the scrollback without restarting the agent. */
  clearScrollback: () => void;
  /** UI-132: selection helpers for the context menu. */
  getSelection: () => string;
  selectAll: () => void;
  copySelection: () => Promise<void>;
  paste: (text: string) => void;
}

interface TerminalProps {
  vendor: string;
  cwd: string;
  /** Worktree setup command to run before the agent (fresh worktrees only).
   *  Captured at mount; `onSetupConsumed` fires once the spawn has taken it so
   *  the store can clear the pane's needsSetup flag (Restart skips setup). */
  setup?: string;
  onSetupConsumed?: () => void;
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
}

// Cap on buffered bytes for a pane hidden behind another workspace / focus mode —
// avoids both wasted xterm writes while invisible and an unbounded memory grow.
const HIDDEN_BUFFER_CAP = 262144; // 256KB

// One live terminal bound to a PTY in the Rust core.
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { vendor, cwd, setup, onSetupConsumed, fontSize = 12.5, ligatures = false, quietThresholdMs = 3000, onExit, onState, onProc, onBell, onLine },
  ref
) {
  const elRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const ligAddonRef = useRef<LigaturesAddon | null>(null);
  const quietThresholdRef = useRef(quietThresholdMs);
  const themeRef = useRef<ITheme>(terminalThemeFor(activeThemeId()));
  // Mirrors the effect-local paneId so imperative handle methods (paste, etc.)
  // can reach the live PTY.
  const paneIdRef = useRef(0);

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
    getSelection: () => termRef.current?.getSelection() ?? "",
    selectAll: () => termRef.current?.selectAll(),
    copySelection: async () => {
      const sel = termRef.current?.getSelection() ?? "";
      if (sel) await navigator.clipboard.writeText(sel);
    },
    paste: (text: string) => { if (paneIdRef.current) invoke("pty_write", { paneId: paneIdRef.current, data: text }); },
  }), []);

  useEffect(() => {
    const el = elRef.current!;
    themeRef.current = terminalThemeFor(activeThemeId());
    // Terminal settings from Settings > Terminal (QOL 319 — they were persisted
    // but never read). fontSize stays a per-pane prop (zoom control).
    const ts = getTerminalSettings();
    const term = new XTerm({
      fontFamily: `'${ts.fontFamily}','JetBrains Mono','Cascadia Code',Consolas,monospace`,
      fontSize,
      cursorBlink: true,
      cursorStyle: ts.cursorStyle,
      scrollback: ts.scrollback,
      theme: themeRef.current,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    const webLinks = new WebLinksAddon((_e, uri) => { openUrl(uri).catch(() => { /* best-effort */ }); });
    term.loadAddon(webLinks);
    const fileLinks = registerFilePathLinks(term);

    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    searchAddonRef.current = search;
    try { fit.fit(); } catch { /* not measured yet */ }

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
    const flushWrites = () => {
      writeRaf = 0;
      if (writeQueue.length === 0) return;
      if (writeQueue.length === 1) { term.write(writeQueue[0]); writeQueue = []; return; }
      let total = 0;
      for (const b of writeQueue) total += b.length;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const b of writeQueue) { merged.set(b, off); off += b.length; }
      writeQueue = [];
      term.write(merged);
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
      hiddenBuf = [];
      hiddenBytes = 0;
      truncated = false;
    };
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
      outTail = (outTail + text).slice(-600);
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
      if (!currentlyAlive) return;
      if (localWaiting) { localWaiting = false; onState?.("running"); }
      armQuietTimer();
    };

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

      term.onData((d) => invoke("pty_write", { paneId, data: d }));
      term.onResize(({ cols, rows }) => invoke("pty_resize", { paneId, cols, rows }));
      term.focus();
    })();

    const ro = new ResizeObserver(() => { if (visible) { try { fit.fit(); } catch { /* mid-teardown */ } } });
    ro.observe(el);

    // Live theme sync: Settings flips `data-theme` on <html> with no event of
    // its own, so watch the attribute directly. Mutates xterm's existing
    // theme option in place — same pattern as the fontSize effect below —
    // never remounts/respawns the PTY.
    const themeObserver = new MutationObserver(() => {
      const next = terminalThemeFor(activeThemeId());
      themeRef.current = next;
      term.options.theme = next;
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      disposed = true;
      if (writeRaf) cancelAnimationFrame(writeRaf);
      clearQuietTimer();
      ro.disconnect();
      io.disconnect();
      themeObserver.disconnect();
      fileLinks.dispose();
      unOut?.();
      unExit?.();
      unState?.();
      unProc?.();
      if (paneId) invoke("pty_kill", { paneId });
      paneIdRef.current = 0;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchAddonRef.current = null;
    };
    // fontSize/ligatures/quietThresholdMs deliberately excluded — none of them
    // should remount/respawn the PTY, they're applied live by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor, cwd]);

  // Live font-size zoom: mutate the existing terminal in place, no remount.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try { fitRef.current?.fit(); } catch { /* mid-teardown */ }
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

  return <div ref={elRef} style={{ width: "100%", height: "100%" }} />;
});
