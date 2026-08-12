// applog.ts — frontend half of the flight recorder (see src-tauri/src/applog.rs).
// Everything that used to die invisibly — a render throw, a window.onerror, an
// unhandled promise rejection — now becomes one durable line in
// <app-data>/logs/flightdeck.log via the log_event command. The v0.5.3 release
// failed on Balu's machine with zero on-disk evidence; this file is why that
// can't happen again.
//
// Self-limits, because the writer must never become the problem:
//   - hard cap per session (a crash loop can't grind the disk),
//   - consecutive-duplicate collapse (an errored render that re-throws on every
//     frame logs once, then a "repeated xN" line when something else arrives),
//   - message length cap (the Rust side caps again at 16KB),
//   - silent no-op outside Tauri (browser rigs, tests).

import { invoke } from "@tauri-apps/api/core";

const SESSION_CAP = 200;
const MAX_MESSAGE_CHARS = 8_000;

let sent = 0;
let capNoted = false;
let lastKey = "";
let suppressed = 0;

// globalThis, not window: identical in the webview, and lets the node-env
// vitest suite exercise this module without a DOM shim.
function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

/** Fire-and-forget append to the on-disk log. Never throws. */
export function logEvent(level: "error" | "warn" | "info", source: string, message: string): void {
  if (!inTauri()) return;
  const key = `${level}|${source}|${message}`;
  if (key === lastKey) {
    suppressed++;
    return;
  }
  if (suppressed > 0) {
    // Flush the collapse note about the PREVIOUS message before moving on.
    send("info", "applog", `previous entry repeated x${suppressed}`);
    suppressed = 0;
  }
  lastKey = key;
  send(level, source, message);
}

function send(level: string, source: string, message: string): void {
  if (sent >= SESSION_CAP) {
    if (!capNoted) {
      capNoted = true;
      void invoke("log_event", {
        level: "warn",
        source: "applog",
        message: `session log cap (${SESSION_CAP}) reached; further entries dropped`,
      }).catch(() => {});
    }
    return;
  }
  sent++;
  void invoke("log_event", {
    level,
    source,
    message: message.length > MAX_MESSAGE_CHARS ? message.slice(0, MAX_MESSAGE_CHARS) : message,
  }).catch(() => {});
}

/** One line for an unknown thrown value, stack included when there is one. */
export function logError(source: string, err: unknown, extra?: string): void {
  let message: string;
  if (err instanceof Error) {
    message = err.stack && err.stack.includes(err.message) ? err.stack : `${err.message}\n${err.stack ?? ""}`;
  } else {
    message = typeof err === "string" ? err : safeStringify(err);
  }
  if (extra) message += `\n${extra}`;
  logEvent("error", source, message.trim());
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Install the two global catch-alls. Called once, first thing in main.tsx, so
 *  even a throw inside the rest of the boot sequence gets recorded. */
export function armGlobalErrorLog(): void {
  if (!inTauri() || typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    logError("window.onerror", e.error ?? e.message, `at ${e.filename ?? "?"}:${e.lineno ?? 0}:${e.colno ?? 0}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logError("unhandledrejection", e.reason);
  });
}

/** Test hook: reset the module counters (vitest runs share module state). */
export function _resetForTests(): void {
  sent = 0;
  capNoted = false;
  lastKey = "";
  suppressed = 0;
}
