// cmlang.ts — CodeMirror language packages, one dynamic import each so a file
// only pulls the grammar for its own type. Keys match CODE_LANG in registry.ts.
import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  powershell: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => StreamLanguage.define(m.powerShell)),
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => StreamLanguage.define(m.toml)),
  csharp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => StreamLanguage.define(m.csharp)),
  shell: () => import("@codemirror/legacy-modes/mode/shell").then((m) => StreamLanguage.define(m.shell)),
};
