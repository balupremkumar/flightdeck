import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { flightdeckTerminalTheme } from "./terminal-theme";

// One live terminal bound to a PTY in the Rust core.
export function Terminal({ vendor, cwd, fontSize = 12.5, onExit, onState }: { vendor: string; cwd: string; fontSize?: number; onExit?: (crashed: boolean) => void; onState?: (state: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = ref.current!;
    const term = new XTerm({
      fontFamily: "'JetBrains Mono','Cascadia Code',Consolas,monospace",
      fontSize,
      cursorBlink: true,
      theme: flightdeckTerminalTheme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch { /* not measured yet */ }

    let paneId = 0;
    let disposed = false;
    let unOut: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let unState: (() => void) | undefined;
    // The Rust reader can emit output before pty_spawn's id round-trips back here;
    // buffer anything that arrives while paneId is still 0, then replay it.
    const earlyOut: { pane_id: number; b64: string }[] = [];

    const writeB64 = (b64: string) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      term.write(bytes);
    };

    (async () => {
      unOut = await listen<{ pane_id: number; b64: string }>("pty://output", (e) => {
        if (paneId === 0) { earlyOut.push(e.payload); return; }
        if (e.payload.pane_id !== paneId) return;
        writeB64(e.payload.b64);
      });
      unExit = await listen<{ pane_id: number; crashed: boolean }>("pty://exit", (e) => {
        if (e.payload.pane_id !== paneId) return;
        term.write(e.payload.crashed
          ? "\r\n\x1b[31m[process exited — crashed]\x1b[0m\r\n"
          : "\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        onExit?.(e.payload.crashed);
      });
      unState = await listen<{ pane_id: number; state: string }>("pty://state", (e) => {
        if (e.payload.pane_id !== paneId) return;
        onState?.(e.payload.state);
      });

      try {
        paneId = await invoke<number>("pty_spawn", { vendor, cwd, cols: term.cols, rows: term.rows });
      } catch (err) {
        term.write(`\r\n\x1b[31m[failed to start ${vendor}: ${String(err)}]\x1b[0m\r\n`);
        onState?.("error");
        return;
      }
      if (disposed) { invoke("pty_kill", { paneId }); return; }

      // Replay buffered output belonging to this pane, then go live.
      for (const p of earlyOut) if (p.pane_id === paneId) writeB64(p.b64);
      earlyOut.length = 0;

      // The container may have resized during the spawn round-trip (the observer
      // fires before onResize is wired), so push the current size once.
      invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows });

      term.onData((d) => invoke("pty_write", { paneId, data: d }));
      term.onResize(({ cols, rows }) => invoke("pty_resize", { paneId, cols, rows }));
      term.focus();
    })();

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* mid-teardown */ } });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      unOut?.();
      unExit?.();
      unState?.();
      if (paneId) invoke("pty_kill", { paneId });
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // fontSize deliberately excluded — a zoom change must not remount/respawn the PTY,
    // it's applied live by the effect below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor, cwd]);

  // Live font-size zoom: mutate the existing terminal in place, no remount.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try { fitRef.current?.fit(); } catch { /* mid-teardown */ }
  }, [fontSize]);

  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}
