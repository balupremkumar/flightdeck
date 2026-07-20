// diffhighlight.ts — UI-171: modest per-token syntax colour for the patch
// view, chosen by file extension. Deliberately line-scoped: the patch is
// already rendered one line at a time (that's what word-diff operates on
// too), and tracking a comment or string across lines would mean carrying
// state between renders for a benefit that rarely shows up in a diff hunk. An
// unterminated string or block comment just stops being special at EOL —
// a fair trade for staying simple.

export type TokKind = "kw" | "str" | "com" | "num" | "plain";
export interface Tok { text: string; kind: TokKind; }

export type Lang = "js" | "rust" | "css" | "json" | "md";

const EXT_LANG: Record<string, Lang> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  rs: "rust",
  css: "css", scss: "css",
  json: "json",
  md: "md", markdown: "md",
};

/** File extension -> language, or null when highlighting doesn't apply (the
 * caller then renders the line as plain text, same as before this existed). */
export function langFor(path: string): Lang | null {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path);
  return m ? EXT_LANG[m[1].toLowerCase()] ?? null : null;
}

const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break",
  "continue", "new", "class", "extends", "implements", "interface", "type", "import", "export", "from", "default",
  "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "void", "null",
  "undefined", "true", "false", "this", "super", "static", "public", "private", "protected", "readonly", "enum",
  "namespace", "as", "yield", "delete", "get", "set",
]);
const RUST_KEYWORDS = new Set([
  "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "pub", "use", "mod", "crate", "self",
  "Self", "match", "if", "else", "for", "while", "loop", "break", "continue", "return", "as", "where", "ref",
  "move", "unsafe", "async", "await", "dyn", "in", "true", "false", "type",
]);
const JSON_KEYWORDS = new Set(["true", "false", "null"]);

interface LangSpec {
  lineComment?: string;
  blockComment?: [string, string];
  /** Tried in order at the cursor; first sticky match wins. */
  strings?: RegExp[];
  number?: RegExp;
  word?: RegExp;
  keywords?: Set<string>;
  /** Checked before `word` — e.g. CSS at-rules, which aren't identifiers. */
  extra?: RegExp;
}

// `y` (sticky) so a match is only accepted right at the cursor, not the next
// place it happens to occur in the line.
const DQ = /"(?:\\.|[^"\\])*"/y;
const SQ = /'(?:\\.|[^'\\])*'/y;
const BT = /`(?:\\.|[^`\\])*`/y;
const NUM = /\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const RUST_WORD = /[A-Za-z_][A-Za-z0-9_]*/y;

const SPECS: Record<Lang, LangSpec> = {
  js: { lineComment: "//", blockComment: ["/*", "*/"], strings: [DQ, SQ, BT], number: NUM, word: WORD, keywords: JS_KEYWORDS },
  rust: { lineComment: "//", blockComment: ["/*", "*/"], strings: [DQ], number: NUM, word: RUST_WORD, keywords: RUST_KEYWORDS },
  css: { blockComment: ["/*", "*/"], strings: [DQ, SQ], number: NUM, word: WORD, extra: /@[A-Za-z-]+/y },
  json: { strings: [DQ], number: /-?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/y, word: WORD, keywords: JSON_KEYWORDS },
  // Markdown has no real keywords/numbers in the code sense — the one thing
  // worth lifting out is inline code spans, so they read as code, not prose.
  md: { strings: [BT] },
};

function matchAt(re: RegExp, line: string, pos: number): string | null {
  re.lastIndex = pos;
  const m = re.exec(line);
  return m && m.index === pos ? m[0] : null;
}

/** Tokenise one line of source for `lang`. Merges neighbouring same-kind
 * tokens so the caller renders as few spans as possible (the same trick
 * worddiff.ts uses for its segments). */
export function highlightLine(line: string, lang: Lang): Tok[] {
  const spec = SPECS[lang];
  const out: Tok[] = [];
  const push = (text: string, kind: TokKind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };

  let i = 0;
  while (i < line.length) {
    if (spec.lineComment && line.startsWith(spec.lineComment, i)) {
      push(line.slice(i), "com");
      break;
    }
    if (spec.blockComment) {
      const [open, close] = spec.blockComment;
      if (line.startsWith(open, i)) {
        const end = line.indexOf(close, i + open.length);
        // No closing on this line — see the file header for why that's fine.
        const stop = end === -1 ? line.length : end + close.length;
        push(line.slice(i, stop), "com");
        i = stop;
        continue;
      }
    }
    let matchedString = false;
    if (spec.strings) {
      for (const re of spec.strings) {
        const s = matchAt(re, line, i);
        if (s) { push(s, "str"); i += s.length; matchedString = true; break; }
      }
      if (matchedString) continue;
    }
    if (spec.number) {
      const n = matchAt(spec.number, line, i);
      if (n) { push(n, "num"); i += n.length; continue; }
    }
    if (spec.extra) {
      const e = matchAt(spec.extra, line, i);
      if (e) { push(e, "kw"); i += e.length; continue; }
    }
    if (spec.word) {
      const w = matchAt(spec.word, line, i);
      if (w) {
        push(w, spec.keywords?.has(w) ? "kw" : "plain");
        i += w.length;
        continue;
      }
    }
    push(line[i], "plain");
    i++;
  }
  return out;
}

/** Convenience wrapper: null when `path`'s extension isn't recognised, so the
 * caller can fall straight back to plain text with one check. */
export function highlight(line: string, path: string): Tok[] | null {
  const lang = langFor(path);
  return lang ? highlightLine(line, lang) : null;
}
