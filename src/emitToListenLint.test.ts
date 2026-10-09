import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// Tokenise before splitting arguments: commas inside target expressions, strings,
// comments or payloads must not shift the event argument. Ignore Rust raw strings
// as single tokens too (some source files embed whole scripts).
function rustTokens(source: string): string[] {
  return (source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|r(#+)?"[\s\S]*?"\1|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g) ?? [])
    .filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
}

function discoverEmitToEvents(sources: readonly string[]): Set<string> {
  const events = new Set<string>();
  for (const source of sources) {
    const tokens = rustTokens(source);
    const constants = new Map<string, string>();
    const literal = (token: string) => /^"(?:\\.|[^"\\])*"$/.test(token)
      ? token.slice(1, -1) : undefined;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "const" && tokens.slice(i + 2, i + 6).join(" ") === ": & str =") {
        const value = literal(tokens[i + 6] ?? "");
        if (value !== undefined) constants.set(tokens[i + 1], value);
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== "emit_to" || tokens[i + 1] !== "(" || tokens[i - 1] === "fn") continue;
      const eventIndex = tokens[i - 1] === "." ? 1 : 2;
      const args: string[][] = [[]];
      let depth = 0;
      for (let j = i + 2; j < tokens.length; j++) {
        const token = tokens[j];
        if (token === ")" && depth === 0) break;
        if (token === "," && depth === 0) args.push([]);
        else {
          args[args.length - 1].push(token);
          if (["(", "[", "{"].includes(token)) depth++;
          if ([")", "]", "}"].includes(token)) depth--;
        }
      }
      const arg = args[eventIndex];
      if (arg?.length !== 1) continue;
      const event = literal(arg[0]) ?? constants.get(arg[0]);
      if (event !== undefined) events.add(event);
    }
  }
  return events;
}

// The existing TypeScript parser handles generics, multiline calls and comments
// without matching examples in strings or property calls such as win.listen().
function bareListenViolations(source: string, events: ReadonlySet<string>, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "listen" && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0]) && events.has(node.arguments[0].text)) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      violations.push(`${file}:${line}: ${node.arguments[0].text} must use listenHere()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      && file.replace(/\\/g, "/") !== "src/eventScope.ts" ? [file] : [];
  });
}

describe("emit_to listeners", () => {
  const events = discoverEmitToEvents(readdirSync("src-tauri/src", { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .map((entry) => readFileSync(join("src-tauri/src", entry.name), "utf8")));

  it("discovers every known targeted event and excludes broadcast events", () => {
    for (const event of ["drag://state", "drag://end", "drag://drop", "drag://hover",
      "drag://hover-end", "app://summon", "app://focus-pane", "win://adopt"]) {
      expect(events.has(event), `missing emit_to event: ${event}`).toBe(true);
    }
    expect(events.has("hook://event")).toBe(false);
    // windows.rs:1207 sends FLUSH_EVENT with app.emit_to, so it is a targeted event too.
    expect(events.has("app://flush"), "missing emit_to event: app://flush").toBe(true);
  });

  it("rejects all bare listeners for targeted events in frontend sources", () => {
    const violations = typescriptFiles("src").sort().flatMap((file) =>
      bareListenViolations(readFileSync(file, "utf8"), events, file.replace(/\\/g, "/")));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it.each([
    ['listen("win://adopt", h)', "win://adopt"],
    ['listen<Payload>("drag://drop", h)', "drag://drop"],
    ['win.listen("drag://hover", h)', null],
    ['listenHere("drag://end", h)', null],
    ['listen("pty://output", h)', null],
    ['// listen("win://adopt", h)\nconst example = \'listen("win://adopt", h)\';', null],
    ['listen<{ a: string, b: number }>(\n "drag://drop", h)', "drag://drop"],
  ])("checks inline listener %s", (source, event) => {
    expect(bareListenViolations(source, events, "inline.ts")).toEqual(event === null
      ? [] : [`inline.ts:1: ${event} must use listenHere()`]);
  });

  it("discovers constants and literal events in wrappers and methods", () => {
    expect([...discoverEmitToEvents([`
      const EVENT: &str = "test://constant";
      emit_to(app, target(a, b), EVENT, payload);
      app.emit_to(target(a, b), "test://method", payload);
      emit_to(app, label, "test://wrapper", payload);
      // app.emit_to(label, "test://comment", payload);
      const SCRIPT: &str = r#"app.emit_to(label, "test://script", payload)"#;
    `])].sort()).toEqual(["test://constant", "test://method", "test://wrapper"]);
  });
});
