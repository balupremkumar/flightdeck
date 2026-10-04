// CodeView.tsx — read-only CodeMirror 6 highlighting (Phase 2, V3). Lazy chunk.
//
// Read-only twice over (EditorState.readOnly and editable false) and keymap-free,
// so nothing here can edit the file or swallow Escape. CodeMirror only mounts the
// lines on screen, which is why find lives here (match offsets over the whole
// document, decorations for the visible ones) rather than in the DOM scan the
// plain text view uses. Colours are CSS variables, so a theme switch repaints
// with no reconfigure.
import { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { findTheme } from "../themes";
import { findOffsets } from "./findInViewer";
import { LANG_LOADERS } from "./cmlang";
import { codeVar } from "./codeTokens";
import { CODE_LANG, extOf } from "./registry";
import type { TreeFind } from "./JsonTree";

// Colours come from codeTokens.ts (tested for contrast and distinctness).
const c = codeVar;
const hl = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword], color: c("keyword"), fontWeight: "600" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: c("string") },
  { tag: [t.number, t.bool, t.null, t.atom], color: c("number") },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c("comment"), fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace], color: c("type") },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: c("function") },
  { tag: [t.propertyName, t.attributeName], color: c("property") },
  { tag: [t.tagName, t.heading], color: c("keyword") },
  { tag: [t.punctuation, t.bracket, t.separator, t.operator], color: c("operator") },
  { tag: [t.meta, t.processingInstruction, t.url, t.link], color: c("operator") },
  { tag: t.invalid, color: c("invalid") },
]);

function baseTheme(dark: boolean): Extension {
  return EditorView.theme({
    "&": { color: "var(--text)", backgroundColor: "transparent", height: "100%", fontSize: "inherit" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55", overflow: "auto" },
    ".cm-content": { padding: "10px 0 24px" },
    ".cm-line": { padding: "0 12px" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none" },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "3.4em", padding: "0 0 0 12px", userSelect: "none" },
    ".cv-hit": { backgroundColor: "color-mix(in srgb, var(--accent) 14%, transparent)" },
    ".cv-find": { backgroundColor: "color-mix(in srgb, var(--azure) 32%, transparent)" },
    ".cv-find-active": { backgroundColor: "var(--accent)", color: "var(--abyss)" },
    ".cm-content ::selection": { backgroundColor: "color-mix(in srgb, var(--azure) 35%, transparent)" },
  }, { dark });
}

// ---- target line (the line a file:line link or a review click asked for) ----
const setTarget = StateEffect.define<number | null>();
const lineMark = Decoration.line({ class: "cv-hit" });
function markFor(doc: EditorState["doc"], n: number | null): DecorationSet {
  return n && n >= 1 && n <= doc.lines ? Decoration.set([lineMark.range(doc.line(n).from)]) : Decoration.none;
}
const targetField = StateField.define<{ n: number | null; deco: DecorationSet }>({
  create: () => ({ n: null, deco: Decoration.none }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setTarget)) return { n: e.value, deco: markFor(tr.state.doc, e.value) };
    return tr.docChanged ? { n: v.n, deco: markFor(tr.state.doc, v.n) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// ---- find matches ----
const MAX_MARKS = 20000; // the count stays exact; painting stops here
interface FindState { offsets: number[]; len: number; active: number }
const setFind = StateEffect.define<FindState | null>();
const matchMark = Decoration.mark({ class: "cv-find" });
const activeMark = Decoration.mark({ class: "cv-find-active" });
const findField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) {
      if (!e.is(setFind)) continue;
      const f = e.value;
      if (!f || f.len === 0) return Decoration.none;
      const ranges = f.offsets.slice(0, MAX_MARKS).map((o, i) => (i === f.active ? activeMark : matchMark).range(o, o + f.len));
      if (f.active >= MAX_MARKS && f.offsets[f.active] !== undefined) {
        ranges.push(activeMark.range(f.offsets[f.active], f.offsets[f.active] + f.len));
        ranges.sort((a, b) => a.from - b.from);
      }
      return Decoration.set(ranges, true);
    }
    return tr.docChanged ? Decoration.none : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function themeDark(): boolean {
  return findTheme(document.documentElement.getAttribute("data-theme") ?? "dark").mode === "dark";
}

export default function CodeView({ text, path, targetLine, wrap = true, find }: {
  text: string; path: string; targetLine?: number; wrap?: boolean; find?: TreeFind;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapC = useRef(new Compartment());
  const langC = useRef(new Compartment());
  // CodeMirror normalises every line break to \n, so offsets must come from the same form.
  const norm = useMemo(() => text.replace(/\r\n?/g, "\n"), [text]);
  const normRef = useRef(norm);
  const targetRef = useRef(targetLine);
  targetRef.current = targetLine;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: normRef.current,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ tabindex: "0", "aria-label": "File contents", "aria-readonly": "true" }),
          lineNumbers(),
          syntaxHighlighting(hl),
          baseTheme(themeDark()),
          wrapC.current.of(EditorView.lineWrapping),
          langC.current.of([]),
          targetField,
          findField,
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, []);

  // New content (follow reload): swap the document, keep the scroll position.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === norm) { normRef.current = norm; return; }
    normRef.current = norm;
    const sc = v.scrollDOM;
    const top = sc.scrollTop;
    const bottom = sc.scrollHeight - top - sc.clientHeight <= 8;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: norm } });
    requestAnimationFrame(() => { sc.scrollTop = bottom ? sc.scrollHeight : top; });
  }, [norm]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapC.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  const langKey = CODE_LANG[extOf(path)];
  useEffect(() => {
    const load = langKey ? LANG_LOADERS[langKey] : undefined;
    if (!load) return;
    let live = true;
    load().then((ext) => { if (live) view.current?.dispatch({ effects: langC.current.reconfigure(ext) }); }, () => { /* plain text is fine */ });
    return () => { live = false; };
  }, [langKey]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: setTarget.of(targetLine ?? null) });
    if (targetLine && targetLine >= 1 && targetLine <= v.state.doc.lines) {
      v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(targetLine).from, { y: "center" }) });
    }
  }, [targetLine, norm]);

  // ---- find ----
  const q = find?.query ?? "";
  const offsets = useMemo(() => findOffsets(norm, q), [norm, q]);
  const onCount = find?.onCount;
  useEffect(() => { onCount?.(offsets.length); }, [offsets, onCount]);
  const active = offsets.length ? (find?.index ?? 0) % offsets.length : -1;
  const lastKey = useRef("");
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (!find || !q || !offsets.length) { v.dispatch({ effects: setFind.of(null) }); lastKey.current = ""; return; }
    v.dispatch({ effects: setFind.of({ offsets, len: q.length, active }) });
    const key = `${q}|${active}`;
    if (lastKey.current !== key) {
      lastKey.current = key;
      v.dispatch({ effects: EditorView.scrollIntoView(offsets[active], { y: "center" }) });
    }
  }, [find, q, offsets, active, norm]);

  return <div className="cv" ref={host} />;
}
