// editor.ts — UX-517: the one canonical "open this file in the user's editor".
//
// Settings has let the user pick an editor (and edit its command template)
// since UX-516/517, but nothing ever ran it — Settings.tsx:202-204 admits as
// much, and every call site in the app handed the path to `openPath`, i.e.
// whatever Windows associates with the extension. That is a fine LAST resort
// and it stays the fallback, but it ignores the setting entirely and can never
// jump to a line.
//
// The split of work: this file owns everything textual (reading the setting,
// tokenising the template, filling the placeholders) and src-tauri/src/editor.rs
// owns only the spawn. Nothing is ever handed to a shell.
//
// Tokenise FIRST, substitute SECOND. Resolving the template into one string and
// splitting it afterwards would let a path containing a space or a quote break
// out of its argument and become extra arguments; doing it in this order means
// {file} always lands in exactly one argv slot no matter what is in the path,
// and the quotes in the shipped presets ('code --goto "{file}:{line}"') simply
// stop mattering.
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { getEditorSettings, resolveEditorCommand } from "./Settings";
import { useUI } from "./ui";

/** Splits a command template into argv-style tokens: whitespace separates,
 *  double quotes group (and are consumed). Backslashes are literal — these are
 *  Windows paths, and treating `\` as an escape would mangle every one of them.
 *  Unbalanced quotes are tolerated rather than rejected: a half-typed custom
 *  command should still launch something. */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let started = false; // distinguishes `""` (a real empty argument) from a gap
  let quoted = false;
  for (const ch of command) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/** The program and argument array for a template, or null when the template
 *  can't launch anything (empty, or whitespace/quotes only). */
export function editorArgv(
  template: string,
  file: string,
  line?: number
): { program: string; args: string[] } | null {
  const tokens = tokenizeCommand(template).map((t) => resolveEditorCommand(t, file, line));
  const [program, ...args] = tokens;
  if (!program) return null;
  return { program, args };
}

/** Opens `path` (optionally at a 1-based `line`) in the editor configured in
 *  Settings > Editor. Falls back to the OS default-app hand-off when no editor
 *  is configured, or when the launch fails — a failure is reported once as a
 *  toast and then degrades to the old behaviour, never to nothing happening.
 *  Never rejects: every call site treats this as fire-and-forget. */
export async function openInEditor(path: string, line?: number): Promise<void> {
  const argv = editorArgv(getEditorSettings().command, path, line);
  if (argv) {
    try {
      await invoke("launch_editor", { program: argv.program, args: argv.args });
      return;
    } catch (e) {
      useUI
        .getState()
        .pushToast("error", `Couldn’t open ${path} in ${argv.program} — ${String(e)}. Trying the default app instead.`);
    }
  }
  await openPath(path).catch((e) => {
    useUI.getState().pushToast("error", `Couldn’t open ${path}: ${String(e)}`);
  });
}
