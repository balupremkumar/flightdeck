// Preview.tsx — UX-505/506/507/508/509/510/513, QL-745/746: read-only file preview
// drawer, opened by clicking a linkified path in a terminal (Terminal.tsx ->
// useUI().openPreview). Markdown renders via markdown.ts's AST — to React
// elements only, never dangerouslySetInnerHTML — so file content can never
// inject raw HTML; that's what makes this safe against untrusted file
// content without a sanitiser dependency. Plain files/code fences get a
// modest syntax colour by reusing the app's own diffhighlight.ts tokenizer
// (already shipped for the Review drawer) rather than adding a highlighting
// library — package.json ships none, and this keeps the same visual
// language as review.css instead of a second one.
//
// Both Rust commands this needs ship: fs_read_text_file and
// fs_read_file_base64 (src-tauri/src/lib.rs). Each enforces a size cap (5MB
// for text, 10MB for images) and fails with "too large to preview (over NMB)"
// past it. That's a refusal, not a fault, so it gets its own state rather than
// the retry-me error line (QL-745/746).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { openInEditor } from "./editor";
import { useUI, useOverlayEsc } from "./ui";
import { revealPath } from "./reveal";
import { requestReveal } from "./revealInTree";
import type { PreviewTab } from "./ui";
import { parseMarkdown, isExternalHref, isBlockedHref, resolveMdLink, parseLinkTarget, makeSlugger, inlineText, slugify } from "./markdown";
import type { BlockNode, InlineNode } from "./markdown";
import { highlightLine, langFor } from "./diffhighlight";
import type { Lang } from "./diffhighlight";
import { useFocusTrap } from "./useFocusTrap";
import { IconClose } from "./Icons";
import "./preview.css";

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const MD_RE = /\.mdx?$/i;

// QL-745/746: the escape hatch offered by every dead-end state below. UX-517:
// it now launches the editor picked in Settings (src/editor.ts), falling back
// to the OS hand-off this used to do on its own. Failures still surface as a
// toast rather than vanishing.

/** True for the backend's size-cap refusal ("too large to preview (over 5MB)"
 *  from fs_read_text_file, "(over 10MB)" from fs_read_file_base64). Retrying
 *  can never help, so these route to their own state instead of the error one. */
export function isTooLargeError(err: unknown): boolean {
  return /too large to preview/i.test(String(err));
}

/** Extensions Flightdeck never tries to show as text (Phase 1 L4). Images are
 *  rendered inside markdown, but a standalone one opens outside. */
const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|exe|dll|msi|zip|7z|rar|gz|tgz|tar|bz2|xz|iso|bin|so|dylib|class|jar|wasm|mp3|mp4|mov|avi|mkv|wav|flac|ogg|webm|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|sqlite|db|pdb|obj|o|lib)$/i;

export function isBinaryPath(path: string): boolean {
  return BINARY_EXT_RE.test(path);
}

/** A lossy-decoded text that is really binary: any NUL, or more than 1% of
 *  the first 8000 chars being U+FFFD replacement characters. */
export function looksBinary(text: string): boolean {
  const head = text.length > 8000 ? text.slice(0, 8000) : text;
  if (head.length === 0) return false;
  if (head.includes("\0")) return true;
  let bad = 0;
  for (let i = 0; i < head.length; i++) if (head.charCodeAt(i) === 0xfffd) bad++;
  return bad / head.length > 0.01;
}

/** Windows answers a read of a folder with "Access is denied (os error 5)";
 *  other platforms say "Is a directory". Either is worth a directory probe. */
export function isDirReadError(err: unknown): boolean {
  return /denied|permission|is a directory|os error 5\b|os error 21\b/i.test(String(err));
}

// `path#heading` links open a tab that may not be loaded yet; the anchor waits
// here until that tab has rendered, then PreviewBody consumes it.
const pendingAnchors = new Map<string, string>();
const ANCHOR_EVENT = "fd-preview-anchor";
const headingId = (slug: string) => "prv-h-" + slug;

/** Scrolls the rendered markdown to the heading an anchor names. Tries the
 *  anchor as typed (lowercased), then re-slugged. Returns whether it found one. */
export function scrollToAnchor(anchor: string): boolean {
  const el =
    document.getElementById(headingId(anchor.toLowerCase())) ??
    document.getElementById(headingId(slugify(anchor)));
  if (!el) return false;
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  return true;
}

function openLocalTarget(t: { path: string; line?: number; anchor?: string }, mdPath: string) {
  const ui = useUI.getState();
  if (t.anchor && t.path === mdPath) {
    if (!scrollToAnchor(t.anchor)) ui.pushToast("info", `No heading “${t.anchor}” in this file.`);
    return;
  }
  if (t.anchor) pendingAnchors.set(t.path, t.anchor);
  ui.openPreview(t.path, t.line !== undefined ? { line: t.line } : undefined);
  if (t.anchor) window.dispatchEvent(new Event(ANCHOR_EVENT));
}

function copyPath(path: string) {
  navigator.clipboard
    .writeText(path)
    .then(() => useUI.getState().pushToast("success", "Path copied"))
    .catch(() => useUI.getState().pushToast("error", "Couldn’t copy the path."));
}

// ---------------------------------------------------------------------
// Plain-text / code view (also used for a markdown file's "Raw" mode)
// ---------------------------------------------------------------------

function renderTokens(text: string, lang: Lang | null): ReactNode {
  if (!lang) return text || " ";
  return highlightLine(text, lang).map((t, k) =>
    t.kind === "plain" ? t.text : <span key={k} className={"prv-tok-" + t.kind}>{t.text}</span>
  );
}

function CodeView({ text, path, targetLine }: { text: string; path: string; targetLine?: number }) {
  const lang = useMemo(() => langFor(path), [path]);
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const hitRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    hitRef.current?.scrollIntoView({ block: "center" });
  }, [targetLine, text]);

  return (
    <pre className="prv-code-view">
      {lines.map((l, i) => {
        const n = i + 1;
        const isHit = n === targetLine;
        return (
          <div key={n} ref={isHit ? hitRef : undefined} className={"prv-line" + (isHit ? " prv-line-hit" : "")}>
            <span className="prv-lno">{n}</span>
            <span className="prv-ltext">{renderTokens(l, lang)}</span>
          </div>
        );
      })}
    </pre>
  );
}

// ---------------------------------------------------------------------
// Rendered markdown
// ---------------------------------------------------------------------

const FENCE_LANG: Record<string, Lang> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", javascript: "js", typescript: "js",
  rust: "rust", rs: "rust",
  css: "css", scss: "css",
  json: "json",
  md: "md", markdown: "md",
};

function CodeFence({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const tokLang = FENCE_LANG[lang.toLowerCase()] ?? null;
  const copy = () => {
    navigator.clipboard
      .writeText(code)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })
      .catch(() => { /* clipboard unavailable — button just does nothing */ });
  };
  return (
    <div className="prv-fence">
      <div className="prv-fence-bar">
        <span>{lang || "text"}</span>
        <button className="prv-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre className="prv-fence-body">
        {code.split("\n").map((l, i) => (
          <div key={i} className="prv-line">{renderTokens(l, tokLang)}</div>
        ))}
      </pre>
    </div>
  );
}

function mimeFor(path: string): string {
  const ext = (/\.([a-zA-Z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp",
  };
  return map[ext] ?? "application/octet-stream";
}

// UX-508: images load from disk relative to the .md file, never the network,
// via fs_read_file_base64. QL-746: a failure here is usually a moved file or a
// 10MB-plus image, so the placeholder carries the way out (retry, open it in
// the editor, find it on disk) instead of a dead line of text.
function ImageNode({ src, alt, mdPath }: { src: string; alt: string; mdPath: string }) {
  const resolved = useMemo(() => resolveMdLink(src, mdPath), [src, mdPath]);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [tooBig, setTooBig] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setFailed(false);
    setTooBig(false);
    invoke<string>("fs_read_file_base64", { path: resolved })
      .then((b64) => { if (!cancelled) setDataUrl(`data:${mimeFor(resolved)};base64,${b64}`); })
      .catch((e) => { if (!cancelled) { setTooBig(isTooLargeError(e)); setFailed(true); } });
    return () => { cancelled = true; };
  }, [resolved, attempt]);

  if (failed) {
    const name = alt || baseName(resolved);
    return (
      <span className="prv-img-broken" title={resolved}>
        {tooBig ? `${name} is over the 10 MB preview limit` : `Image unavailable: ${name}`}{" "}
        {/* Retrying a size refusal can't ever succeed, so it isn't offered. */}
        {!tooBig && (
          <>
            <button className="prv-copy" onClick={() => setAttempt((n) => n + 1)}>Retry</button>{" "}
          </>
        )}
        <button className="prv-copy" onClick={() => { void openInEditor(resolved); }}>Open in editor</button>{" "}
        <button className="prv-copy" onClick={() => { void revealPath(resolved); }}>Show in folder</button>
      </span>
    );
  }
  if (!dataUrl) return <span className="prv-img-loading">Loading image…</span>;
  return <img className="prv-img" src={dataUrl} alt={alt} />;
}

function renderInline(nodes: InlineNode[], mdPath: string): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "strong":
        return <strong key={i}>{renderInline(n.children, mdPath)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.children, mdPath)}</em>;
      case "code":
        return <code key={i} className="prv-icode">{n.text}</code>;
      case "image":
        return <ImageNode key={i} src={n.src} alt={n.alt} mdPath={mdPath} />;
      case "link": {
        const external = isExternalHref(n.href);
        const blocked = isBlockedHref(n.href);
        const onClick = (e: React.MouseEvent) => {
          e.preventDefault();
          // UX-507: http(s)/mailto/tel open the browser; a local path (relative
          // or absolute) opens that file here in the preview. Anything with an
          // untrusted scheme does nothing — previewed markdown is untrusted
          // input and must never reach the shell opener.
          if (blocked) {
            useUI.getState().pushToast("info", "That link uses a scheme Flightdeck won’t open.", { detail: n.href });
            return;
          }
          if (external) openUrl(n.href).catch(() => { /* best-effort */ });
          else openLocalTarget(parseLinkTarget(n.href, mdPath) as { path: string; line?: number; anchor?: string }, mdPath);
        };
        return (
          <a
            key={i}
            href={blocked ? undefined : n.href}
            className={"prv-link" + (blocked ? " prv-link-blocked" : "")}
            title={blocked ? "Blocked link scheme" : undefined}
            onClick={onClick}
          >
            {renderInline(n.children, mdPath)}
          </a>
        );
      }
    }
  });
}

function Heading({ level, id, children }: { level: 1 | 2 | 3 | 4 | 5 | 6; id?: string; children: ReactNode }) {
  switch (level) {
    case 1: return <h1 id={id} className="prv-h prv-h1">{children}</h1>;
    case 2: return <h2 id={id} className="prv-h prv-h2">{children}</h2>;
    case 3: return <h3 id={id} className="prv-h prv-h3">{children}</h3>;
    case 4: return <h4 id={id} className="prv-h prv-h4">{children}</h4>;
    case 5: return <h5 id={id} className="prv-h prv-h5">{children}</h5>;
    default: return <h6 id={id} className="prv-h prv-h6">{children}</h6>;
  }
}

function PreviewTable({ block, mdPath }: { block: Extract<BlockNode, { type: "table" }>; mdPath: string }) {
  return (
    <table className="prv-table">
      <thead>
        <tr>
          {block.header.map((cell, i) => (
            <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>{renderInline(cell, mdPath)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td key={ci} style={{ textAlign: block.align[ci] ?? undefined }}>{renderInline(cell, mdPath)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderBlocks(blocks: BlockNode[], mdPath: string, slug: (t: string) => string): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "heading":
        return <Heading key={i} level={b.level} id={headingId(slug(inlineText(b.children)))}>{renderInline(b.children, mdPath)}</Heading>;
      case "paragraph":
        return <p key={i}>{renderInline(b.children, mdPath)}</p>;
      case "hr":
        return <hr key={i} />;
      case "blockquote":
        return <blockquote key={i} className="prv-quote">{renderBlocks(b.children, mdPath, slug)}</blockquote>;
      case "list": {
        const items = b.items;
        const isTaskList = items.some((it) => it.checked !== undefined);
        const Body = (
          <>
            {items.map((it, j) => (
              <li key={j} className={it.checked !== undefined ? "prv-task" : undefined}>
                {it.checked !== undefined && <input type="checkbox" checked={it.checked} readOnly disabled />}
                <span>{renderInline(it.children, mdPath)}</span>
              </li>
            ))}
          </>
        );
        return b.ordered ? (
          <ol key={i} className="prv-list">{Body}</ol>
        ) : (
          <ul key={i} className={"prv-list" + (isTaskList ? " prv-tasklist" : "")}>{Body}</ul>
        );
      }
      case "table":
        return <PreviewTable key={i} block={b} mdPath={mdPath} />;
      case "code":
        return <CodeFence key={i} lang={b.lang} code={b.code} />;
    }
  });
}

// ---------------------------------------------------------------------
// Per-tab body: loads the file and renders raw/rendered per its state.
// ---------------------------------------------------------------------

type LoadState = "loading" | "loaded" | "error" | "binary";

function guessErrorMessage(err: unknown): string {
  const raw = String(err);
  if (/no such command|not found|unknown command|invoke/i.test(raw)) {
    return "File preview needs one more backend piece that hasn’t shipped yet.";
  }
  if (/no such file|not found|cannot find/i.test(raw)) return "This file isn’t there any more.";
  if (/denied|permission/i.test(raw)) return "Windows blocked reading this file.";
  // The size cap is not routed here: isTooLargeError catches it first and the
  // body renders the dedicated too-large state (QL-745) instead.
  return "Couldn’t read this file.";
}

function PreviewSkeleton() {
  return (
    <div className="prv-skel" aria-hidden="true">
      {[92, 68, 80, 40, 74, 55].map((w, i) => (
        <div key={i} className="prv-skel-bar" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function PreviewBody({ tab }: { tab: PreviewTab }) {
  const isMd = MD_RE.test(tab.path);
  const [state, setState] = useState<LoadState>("loading");
  const [text, setText] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [tooLarge, setTooLarge] = useState(false);
  // A line target (file.md#L12, path:12) only means something in the raw view.
  const [mode, setMode] = useState<"rendered" | "raw">(isMd && !tab.line ? "rendered" : "raw");
  const seq = useRef(0);

  useEffect(() => { if (tab.line) setMode("raw"); }, [tab.line]);

  const load = useCallback(() => {
    const my = ++seq.current;
    setState("loading");
    if (isBinaryPath(tab.path)) { setState("binary"); return; }
    invoke<string>("fs_read_text_file", { path: tab.path })
      .then((t) => {
        if (seq.current !== my) return;
        if (looksBinary(t)) { setState("binary"); return; }
        setText(t);
        setState("loaded");
      })
      .catch(async (e) => {
        if (seq.current !== my) return;
        // A folder is not a failed file: hand it to Explorer and drop the tab.
        if (isDirReadError(e)) {
          const isDir = await invoke("fs_list_dir", { path: tab.path }).then(() => true, () => false);
          if (seq.current !== my) return;
          if (isDir) {
            requestReveal(tab.path); // Explorer panel; falls back to the OS outside its root
            useUI.getState().closePreview(tab.id);
            return;
          }
        }
        const big = isTooLargeError(e);
        setTooLarge(big);
        setErrMsg(big ? "" : guessErrorMessage(e));
        setState("error");
      });
  }, [tab.path, tab.id]);

  useEffect(() => { load(); }, [load]);

  const blocks = useMemo(
    () => (isMd && state === "loaded" ? parseMarkdown(text) : null),
    [isMd, state, text]
  );

  // `other.md#heading` links: scroll once this tab has rendered the markdown.
  const rendered = isMd && state === "loaded" && mode === "rendered";
  useEffect(() => {
    if (!isMd || state !== "loaded") return;
    const consume = () => {
      const a = pendingAnchors.get(tab.path);
      if (!a) return;
      // In raw view: switch first; this effect re-runs once headings exist.
      if (!rendered) { setMode("rendered"); return; }
      pendingAnchors.delete(tab.path);
      requestAnimationFrame(() => { scrollToAnchor(a); });
    };
    consume();
    window.addEventListener(ANCHOR_EVENT, consume);
    return () => window.removeEventListener(ANCHOR_EVENT, consume);
  }, [isMd, state, tab.path, rendered]);

  const mdTree = useMemo(
    () => (rendered && blocks ? renderBlocks(blocks, tab.path, makeSlugger()) : null),
    [rendered, blocks, tab.path]
  );

  return (
    <div className="prv-body-wrap">
      <div className="prv-toolbar">
        <span className="prv-path" title={tab.path}>{tab.path}</span>
        <div className="prv-actions">
          <button className="prv-copy" onClick={() => { void openInEditor(tab.path, tab.line); }}>Open in editor</button>
          <button className="prv-copy" onClick={() => { void revealPath(tab.path); }}>Reveal in Explorer</button>
          <button className="prv-copy" onClick={() => copyPath(tab.path)}>Copy path</button>
        </div>
        {isMd && state === "loaded" && (
          <div className="prv-modes" role="tablist" aria-label="View mode">
            <button className={"prv-mode" + (mode === "rendered" ? " on" : "")} onClick={() => setMode("rendered")}>
              Rendered
            </button>
            <button className={"prv-mode" + (mode === "raw" ? " on" : "")} onClick={() => setMode("raw")}>
              Raw
            </button>
          </div>
        )}
      </div>
      <div className="prv-content" style={tab.fontSize ? { fontSize: `${tab.fontSize}px` } : undefined}>
        {state === "loading" && <PreviewSkeleton />}
        {state === "binary" && (
          <div className="prv-state">
            <code className="prv-icode">{baseName(tab.path)}</code>
            <span>This file type opens outside Flightdeck.</span>
            <div className="prv-actions">
              <button
                className="prv-retry"
                onClick={() => {
                  openPath(tab.path).catch((e) => useUI.getState().pushToast("error", `Couldn’t open ${baseName(tab.path)}: ${String(e)}`));
                }}
              >
                Open externally
              </button>
              <button className="prv-retry" onClick={() => { void revealPath(tab.path); }}>Reveal in Explorer</button>
              <button className="prv-retry" onClick={() => copyPath(tab.path)}>Copy path</button>
            </div>
          </div>
        )}
        {/* QL-745: the 5MB cap is a refusal, not a fault, so no Retry (a second
            read fails identically). Name the file, frame the limit, hand it to
            the editor that can actually open it. */}
        {state === "error" && tooLarge && (
          <div className="prv-state prv-error">
            <code className="prv-icode">{baseName(tab.path)}</code>
            <span>Over the 5&nbsp;MB preview limit, so Flightdeck won’t load it here.</span>
            {/* UX-517/519: the preview knows which line brought the user here
                (Terminal's file:line links, Review's line click), so the editor
                opens there rather than at the top of a huge file. */}
            <button className="prv-retry" onClick={() => { void openInEditor(tab.path, tab.line); }}>Open in editor</button>
          </div>
        )}
        {state === "error" && !tooLarge && (
          <div className="prv-state prv-error">
            {errMsg}
            <button className="prv-retry" onClick={load}>Retry</button>
          </div>
        )}
        {state === "loaded" && text === "" && <div className="prv-state">Empty file.</div>}
        {state === "loaded" && text !== "" && (
          mdTree ? (
            <div className="prv-md">{mdTree}</div>
          ) : (
            <CodeView text={text} path={tab.path} targetLine={tab.line} />
          )
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Drawer shell: tabs + the active tab's body.
// ---------------------------------------------------------------------

export function Preview() {
  const tabs = useUI((s) => s.previewTabs);
  const activeId = useUI((s) => s.activePreviewId);
  const closePreview = useUI((s) => s.closePreview);
  const closeAllPreviews = useUI((s) => s.closeAllPreviews);
  const setActivePreview = useUI((s) => s.setActivePreview);
  const cyclePreview = useUI((s) => s.cyclePreview);
  const drawerRef = useRef<HTMLDivElement>(null);
  const isOpen = tabs.length > 0;
  const active = tabs.find((t) => t.id === activeId) ?? null;

  // UX-513: Ctrl+Tab cycles tabs, Ctrl+W closes the active one — ONLY while
  // focus is inside this drawer, so terminal keys are unaffected. Registered
  // ahead of useFocusTrap below (React runs effects in declaration order) so
  // stopImmediatePropagation here reaches Cockpit's own Ctrl+Tab/Ctrl+W
  // handlers before this hook's plain-Tab trap — see HANDOFF EDITS for the
  // matching guard added on the Cockpit side.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (!drawerRef.current?.contains(document.activeElement)) return;
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        cyclePreview(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.ctrlKey && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (activeId != null) closePreview(activeId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, activeId, cyclePreview, closePreview]);

  useFocusTrap(drawerRef, isOpen);

  // UX-542/543: was a local onKeyDown on the drawer (bubble-phase, only
  // reachable while focus was inside it) — moved onto the shared overlay
  // stack so Esc closes this the same way regardless of what has focus, and
  // only when it's the top-most overlay.
  useOverlayEsc(isOpen, closeAllPreviews);

  if (!isOpen) return null;

  return (
    <div className="prv-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) closeAllPreviews(); }}>
      <div
        className="prv-drawer"
        ref={drawerRef}
        tabIndex={-1}
        role="dialog"
        aria-label="File preview"
      >
        <div className="prv-tabs" role="tablist" aria-label="Open files">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={"prv-tab" + (t.id === activeId ? " active" : "")}
              role="tab"
              aria-selected={t.id === activeId}
              tabIndex={0}
              title={t.path}
              onClick={() => setActivePreview(t.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActivePreview(t.id); } }}
            >
              <span className="prv-tab-name">{baseName(t.path)}</span>
              <button
                className="prv-tab-close"
                onClick={(e) => { e.stopPropagation(); closePreview(t.id); }}
                title="Close (Ctrl+W)"
                aria-label={`Close ${baseName(t.path)}`}
              >
                <IconClose size={11} />
              </button>
            </div>
          ))}
        </div>
        {active && <PreviewBody key={active.id} tab={active} />}
      </div>
    </div>
  );
}
