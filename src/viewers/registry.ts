// registry.ts — which viewers can open which file extension (Phase 2, V2a).
//
// Each extension maps to an ordered list of viewer ids, default first. The
// user's pick from the "View" menu is remembered per extension in localStorage.
// Pure on purpose (storage is injectable) so it is testable without a DOM.

export type ViewerId = "text" | "raw" | "rendered" | "json-tree" | "jsonl" | "csv" | "code" | "log";

export const VIEWER_LABEL: Record<ViewerId, string> = {
  text: "Text",
  raw: "Raw",
  rendered: "Rendered",
  "json-tree": "JSON tree",
  jsonl: "JSON lines",
  csv: "Table",
  code: "Code",
  log: "Log",
};

// CsvTable.tsx is built by another stream. A glob (not an import) keeps the
// build green while the file does not exist: it yields {} and the csv viewer is
// simply not offered. Contract: default export, props { text: string; path: string }.
export const csvLoaders = import.meta.glob("./CsvTable.tsx");
// Same for MermaidBlock.tsx. Contract: default export, props
// { source: string; theme: "light" | "dark" }.
export const mermaidLoaders = import.meta.glob("./MermaidBlock.tsx");

export const HAS_CSV = Object.keys(csvLoaders).length > 0;
export const HAS_MERMAID = Object.keys(mermaidLoaders).length > 0;

/** Extension to CodeMirror language key (loaded lazily by CodeView). */
export const CODE_LANG: Record<string, string> = {
  js: "js", jsx: "jsx", mjs: "js", cjs: "js", ts: "ts", tsx: "tsx", mts: "ts", cts: "ts",
  rs: "rust", py: "python", pyw: "python",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  yaml: "yaml", yml: "yaml", toml: "toml", sql: "sql", cs: "csharp",
  html: "html", htm: "html", css: "css", json: "json", xml: "xml", xsd: "xml", csproj: "xml",
  sh: "shell", bash: "shell", zsh: "shell",
};

/** A log file: *.log, or a rotated *.log.N. Keyed as "log" for viewer/follow memory. */
export const LOG_RE = /\.log(\.\d+)?$/i;
export const isLogPath = (path: string) => LOG_RE.test(path);

/** The key a path is remembered under: its extension, with rotated logs folded into "log". */
export function keyOf(path: string): string {
  return isLogPath(path) ? "log" : extOf(path);
}

const BY_EXT: Record<string, ViewerId[]> = {
  ...Object.fromEntries(Object.keys(CODE_LANG).map((e) => [e, ["code", "text"] as ViewerId[]])),
  log: ["log", "text"],
  json: ["json-tree", "code", "text"],
  jsonl: ["jsonl", "text"],
  ndjson: ["jsonl", "text"],
  csv: ["csv", "text"],
  tsv: ["csv", "text"],
  md: ["rendered", "raw"],
  markdown: ["rendered", "raw"],
  mdx: ["rendered", "raw"],
};

export function extOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Ordered viewers for an extension, default first. Unknown extensions: text. */
export function viewersForExt(ext: string, opts: { csv?: boolean } = {}): ViewerId[] {
  const csv = opts.csv ?? HAS_CSV;
  const list = BY_EXT[ext.toLowerCase()] ?? ["text"];
  return list.filter((v) => v !== "csv" || csv);
}

export function viewersFor(path: string): ViewerId[] {
  return viewersForExt(keyOf(path));
}

// ---- persistence ----

export const VIEWER_CHOICE_KEY = "flightdeck-viewer-choice";
export const WRAP_KEY = "flightdeck-preview-wrap";

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

function readChoices(store: Store | null): Record<string, string> {
  if (!store) return {};
  try {
    const v: unknown = JSON.parse(store.getItem(VIEWER_CHOICE_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch { return {}; }
}

/** The viewer to open `path` with: the remembered one if it is still offered
 *  for that extension, otherwise the extension's default. */
export function resolveViewer(path: string, store: Store | null = defaultStore(), opts: { csv?: boolean } = {}): ViewerId {
  const ext = keyOf(path);
  const list = viewersForExt(ext, opts);
  const saved = readChoices(store)[ext];
  return (list.find((v) => v === saved) ?? list[0]) as ViewerId;
}

export function rememberViewer(path: string, id: ViewerId, store: Store | null = defaultStore()) {
  if (!store) return;
  const ext = keyOf(path);
  try { store.setItem(VIEWER_CHOICE_KEY, JSON.stringify({ ...readChoices(store), [ext]: id })); } catch { /* non-persistent */ }
}

/** Word wrap in the text view. On by default: it is how the view always behaved. */
export function getWrap(store: Store | null = defaultStore()): boolean {
  try { return store?.getItem(WRAP_KEY) !== "0"; } catch { return true; }
}
export function setWrap(on: boolean, store: Store | null = defaultStore()) {
  try { store?.setItem(WRAP_KEY, on ? "1" : "0"); } catch { /* non-persistent */ }
}

// ---- follow (QL-704): remembered per extension, on by default for logs ----

export const FOLLOW_KEY = "flightdeck-preview-follow";

export function getFollow(path: string, store: Store | null = defaultStore()): boolean {
  const key = keyOf(path);
  try {
    const v: unknown = JSON.parse(store?.getItem(FOLLOW_KEY) ?? "{}");
    const saved = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
    return typeof saved === "boolean" ? saved : key === "log";
  } catch { return key === "log"; }
}
export function setFollow(path: string, on: boolean, store: Store | null = defaultStore()) {
  const key = keyOf(path);
  try {
    const v: unknown = JSON.parse(store?.getItem(FOLLOW_KEY) ?? "{}");
    const cur = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
    store?.setItem(FOLLOW_KEY, JSON.stringify({ ...cur, [key]: on }));
  } catch { /* non-persistent */ }
}
