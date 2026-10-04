// LinkMenu.tsx — Phase 1 L3: right-click menu for a link in a terminal pane.
// The pane's xterm lives outside React (paneSessions.ts), so the session opens
// the menu through the tiny module store below and each mounted <LinkMenuHost>
// renders it only when the request belongs to its own pane.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { openInEditor } from "./editor";
import { requestReveal } from "./revealInTree";
import { useUI, useOverlayEsc } from "./ui";
import type { LinkTarget } from "./termlinks";
import "./linkmenu.css";

export interface LinkMenuItem { id: string; label: string; run: () => void }

export interface LinkMenuDeps {
  openUrl: (url: string) => void;
  /** Types text into the owning pane's PTY (no Enter). */
  sendToPane: (text: string) => void;
}

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => useUI.getState().pushToast("success", `Copied ${what}`),
    () => useUI.getState().pushToast("error", "Couldn’t copy: clipboard unavailable.")
  );
}

/** Get the header text: last path segment for paths, hostname for URLs. */
function getHeaderText(target: LinkTarget): string {
  if (target.kind === "url") {
    try {
      return new URL(target.url).hostname;
    } catch {
      return target.url;
    }
  }
  // Last path segment (file or folder name)
  const lastSlash = Math.max(target.path.lastIndexOf("/"), target.path.lastIndexOf("\\"));
  return lastSlash >= 0 ? target.path.slice(lastSlash + 1) : target.path;
}

/** The menu's entries for a target. Folders skip the preview/editor rows: a
 *  folder opens in the Explorer panel, never in a viewer. */
export function linkMenuItems(t: LinkTarget, d: LinkMenuDeps): LinkMenuItem[] {
  if (t.kind === "url") {
    return [
      { id: "browser", label: "Open in browser", run: () => d.openUrl(t.url) },
      { id: "copy", label: "Copy link", run: () => copy(t.url, "link") },
    ];
  }
  const items: LinkMenuItem[] = [];
  if (!t.isDir) {
    items.push(
      { id: "preview", label: "Open in preview", run: () => useUI.getState().openPreview(t.path, { line: t.line }) },
      { id: "editor", label: "Open in editor", run: () => { void openInEditor(t.path, t.line, t.col); } },
    );
  }
  items.push(
    { id: "reveal", label: "Reveal in Explorer", run: () => requestReveal(t.path) },
    { id: "copy", label: "Copy path", run: () => copy(t.path, "path") },
    { id: "send", label: "Send path to agent", run: () => d.sendToPane(`@${t.path} `) },
  );
  return items;
}

interface MenuState { modelId: number; x: number; y: number; items: LinkMenuItem[]; target: LinkTarget }
let state: MenuState | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function openLinkMenu(s: MenuState): void { state = s; emit(); }
export function closeLinkMenu(): void { if (state) { state = null; emit(); } }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const snapshot = () => state;

export function LinkMenuHost({ modelId }: { modelId: number }) {
  const s = useSyncExternalStore(subscribe, snapshot, () => null);
  const mine = s && s.modelId === modelId ? s : null;
  useOverlayEsc(!!mine, closeLinkMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Clamp into the viewport once measured, then focus the first item.
  useLayoutEffect(() => {
    if (!mine) { setPos(null); return; }
    const el = ref.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    let left = mine.x + 2;
    let top = mine.y + 6;
    // Flip above if overflows bottom, shift left if overflows right
    if (top + h > window.innerHeight) top = mine.y - h;
    if (left + w > window.innerWidth) left = mine.x - w;
    setPos({
      left: Math.max(4, left),
      top: Math.max(4, top),
    });
    // Focus first actionable button (skip header)
    const btns = el?.querySelectorAll<HTMLElement>("button[role='menuitem']");
    btns?.[0]?.focus();
  }, [mine]);

  useEffect(() => {
    if (!mine) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) closeLinkMenu(); };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("contextmenu", away, true);
    window.addEventListener("blur", closeLinkMenu);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("contextmenu", away, true);
      window.removeEventListener("blur", closeLinkMenu);
    };
  }, [mine]);

  if (!mine) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const btns = Array.from(ref.current?.querySelectorAll<HTMLElement>("button[role='menuitem']") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); btns[(n + btns.length) % btns.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(btns.length - 1);
    else if (e.key === "Tab") { e.preventDefault(); closeLinkMenu(); }
  };

  const headerText = getHeaderText(mine.target);
  const fullPath = mine.target.kind === "url" ? mine.target.url : mine.target.path;

  return createPortal(
    <div
      ref={ref}
      className="lm-menu"
      role="menu"
      aria-label="Link actions"
      style={{ left: pos?.left ?? mine.x, top: pos?.top ?? mine.y, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="lm-header" title={fullPath}>{headerText}</div>
      {mine.items.slice(0, mine.target.kind === "url" ? 1 : 3).map((it) => (
        <button key={it.id} type="button" role="menuitem" className="lm-item" onClick={() => { closeLinkMenu(); it.run(); }}>
          {it.label}
        </button>
      ))}
      <div className="lm-divider" role="separator" />
      {mine.items.slice(mine.target.kind === "url" ? 1 : 3).map((it) => (
        <button key={it.id} type="button" role="menuitem" className="lm-item" onClick={() => { closeLinkMenu(); it.run(); }}>
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
