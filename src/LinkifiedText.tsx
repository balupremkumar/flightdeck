// LinkifiedText.tsx — UX-520/521: one reusable renderer for "this plain text
// may contain clickable urls/paths", reusing linkify.ts's pure detection so
// the rules are identical to the terminal's own clickable output
// (Terminal.tsx's registerPathLinks). Used anywhere a short line of agent
// output or free-text is displayed outside a terminal — Broadcast's
// last-output-line, and (via HANDOFF) the attention queue and board cards.
//
// Behaviour mirrors Terminal.tsx: a path opens the in-app preview drawer, a
// url opens the OS browser. No Ctrl+click-to-editor here — these are compact
// single-line contexts, not a terminal, so one click action is enough.
import type { MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { linkify, resolvePath, type LinkMatch } from "./linkify";
import { useUI } from "./ui";

export interface LinkifiedPart {
  key: string;
  kind: "text" | "url" | "path";
  text: string;
  /** Only set for kind !== "text" — the resolved click target. */
  href?: string;
  line?: number;
}

/** Pure split of `text` into plain-text and link segments, kept separate
 *  from the component below so it's directly unit-testable — this project's
 *  vitest runs in plain Node with no jsdom/RTL (see ui.test.ts). */
export function splitLinkified(text: string, cwd?: string): LinkifiedPart[] {
  if (!text) return [];
  const matches = linkify(text);
  if (matches.length === 0) return [{ key: "t0", kind: "text", text }];
  const parts: LinkifiedPart[] = [];
  let last = 0;
  matches.forEach((m: LinkMatch, i: number) => {
    if (m.start > last) parts.push({ key: `t${i}`, kind: "text", text: text.slice(last, m.start) });
    const href = m.kind === "url" ? m.raw : cwd ? resolvePath(m, cwd) : m.raw;
    parts.push({ key: `m${i}`, kind: m.kind, text: m.text, href, line: m.line });
    last = m.end;
  });
  if (last < text.length) parts.push({ key: "tend", kind: "text", text: text.slice(last) });
  return parts;
}

/** Renders `text` with any detected urls/paths as clickable spans. `cwd` is
 *  needed to resolve relative paths to an absolute one for the preview
 *  drawer — omit it (or leave paths unresolved) in contexts where the raw
 *  string is already absolute or a cwd genuinely isn't known; the path still
 *  renders as a link, just against its raw (possibly relative) form. */
export function LinkifiedText({ text, cwd, className }: { text: string; cwd?: string; className?: string }) {
  const parts = splitLinkified(text, cwd);
  if (parts.length === 0) return null;
  return (
    <span className={className}>
      {parts.map((p) => {
        if (p.kind === "text") return p.text;
        const onClick = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (p.kind === "url") void openUrl(p.href!).catch(() => { /* best-effort */ });
          else useUI.getState().openPreview(p.href!, { line: p.line });
        };
        return (
          <a
            key={p.key}
            href="#"
            className="lnk"
            onClick={onClick}
            title={p.kind === "url" ? `Open ${p.href} in your browser` : `Preview ${p.href}`}
          >
            {p.text}
          </a>
        );
      })}
    </span>
  );
}
