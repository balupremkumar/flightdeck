import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn() }));

import type { ConfigFile } from "./ConfigDoctorView";

const {
  joinPath, claudeConfigPaths, isMissingFileError, positionToLineCol,
  parseSettingsText, unknownTopLevelKeys, effectiveScalars, effectiveRules,
  collectHooks, doctorState, KNOWN_TOP_LEVEL_KEYS,
} = await import("./ConfigDoctorView");

type File = ConfigFile;

function ok(scope: File["scope"], data: Record<string, unknown>, path = `${scope}.json`): File {
  return { scope, path, status: "ok", data };
}

describe("path building (QL-774)", () => {
  it("keeps Windows separators when the base is a Windows path", () => {
    expect(joinPath("C:\\Users\\User", ".claude", "settings.json")).toBe("C:\\Users\\User\\.claude\\settings.json");
  });

  it("tolerates a trailing separator from homeDir()", () => {
    expect(joinPath("C:\\Users\\User\\", ".claude")).toBe("C:\\Users\\User\\.claude");
  });

  it("uses forward slashes for posix bases", () => {
    expect(joinPath("/home/u", ".claude", "settings.json")).toBe("/home/u/.claude/settings.json");
  });

  it("covers exactly the three documented scopes, lowest precedence first", () => {
    const paths = claudeConfigPaths("C:\\Users\\U", "D:\\repo");
    expect(paths.map((p) => p.scope)).toEqual(["user", "project", "local"]);
    expect(paths[0].path).toBe("C:\\Users\\U\\.claude\\settings.json");
    expect(paths[2].path).toBe("D:\\repo\\.claude\\settings.local.json");
  });

  it("drops a scope rather than inventing a path when home or cwd is unknown", () => {
    expect(claudeConfigPaths(null, "D:\\repo").map((p) => p.scope)).toEqual(["project", "local"]);
    expect(claudeConfigPaths("C:\\U", null).map((p) => p.scope)).toEqual(["user"]);
    expect(claudeConfigPaths(null, null)).toEqual([]);
  });
});

describe("read-error classification", () => {
  it("treats a missing file as normal, not a fault", () => {
    expect(isMissingFileError("The system cannot find the file specified. (os error 2)")).toBe(true);
    expect(isMissingFileError("The system cannot find the path specified. (os error 3)")).toBe(true);
    expect(isMissingFileError("No such file or directory (os error 2)")).toBe(true);
  });

  it("keeps a real read failure as a problem worth naming", () => {
    expect(isMissingFileError("Access is denied. (os error 5)")).toBe(false);
    expect(isMissingFileError("too large to preview (over 5MB)")).toBe(false);
  });
});

describe("JSON validation (QL-774)", () => {
  it("parses a normal settings object", () => {
    const r = parseSettingsText('{"model":"opus"}');
    expect(r.bom).toBe(false);
    expect(r.data).toEqual({ model: "opus" });
    expect(r.error).toBeUndefined();
  });

  it("detects the UTF-8 BOM trap explicitly, even when the JSON underneath is perfect", () => {
    const r = parseSettingsText('\uFEFF{"model":"opus"}');
    expect(r.bom).toBe(true);
    // Still parsed, so the panel can show what the file WOULD contribute.
    expect(r.data).toEqual({ model: "opus" });
  });

  it("reports a line and column for a syntax error", () => {
    const raw = '{\n  "a": 1,\n  "b": 2,\n}\n';
    const r = parseSettingsText(raw);
    expect(r.data).toBeUndefined();
    expect(r.error?.line).toBe(4);
    expect(r.error?.column).toBeGreaterThan(0);
  });

  it("rejects valid JSON that isn't an object", () => {
    expect(parseSettingsText("[1,2]").error?.message).toMatch(/not an object/);
    expect(parseSettingsText('"hi"').error?.message).toMatch(/not an object/);
  });

  it("maps a character offset onto a 1-based line and column", () => {
    expect(positionToLineCol("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
    expect(positionToLineCol("ab\ncd", 3)).toEqual({ line: 2, column: 1 });
    expect(positionToLineCol("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });

  it("warns only about genuinely unknown top-level keys", () => {
    expect(unknownTopLevelKeys({ permissions: {}, hooks: {}, model: "x" })).toEqual([]);
    expect(unknownTopLevelKeys({ permision: {} })).toEqual(["permision"]);
  });

  it("knows the keys the merge itself reads", () => {
    for (const k of ["permissions", "hooks", "apiKeyHelper", "enableAllProjectMcpServers"]) {
      expect(KNOWN_TOP_LEVEL_KEYS).toContain(k);
    }
  });
});

describe("effective merge (QL-774)", () => {
  it("gives the highest-precedence file the win and records who it beat", () => {
    const rows = effectiveScalars([
      ok("user", { permissions: { defaultMode: "acceptEdits" } }),
      ok("project", { permissions: { defaultMode: "plan" } }),
      ok("local", { permissions: { defaultMode: "default" } }),
    ]);
    expect(rows).toEqual([
      { key: "permissions.defaultMode", value: "default", source: "local", overridden: ["user", "project"] },
    ]);
  });

  it("falls back down the chain when higher scopes are silent", () => {
    const rows = effectiveScalars([ok("user", { permissions: { defaultMode: "plan" } }), ok("project", {})]);
    expect(rows[0].source).toBe("user");
    expect(rows[0].overridden).toEqual([]);
  });

  it("ignores files Claude Code itself ignores", () => {
    const broken: File = { scope: "local", path: "x", status: "invalid", data: { permissions: { defaultMode: "bypassPermissions" } } };
    const rows = effectiveScalars([ok("user", { permissions: { defaultMode: "plan" } }), broken]);
    expect(rows[0].value).toBe("plan");
    expect(rows[0].source).toBe("user");
  });

  it("unions rule lists instead of overriding them, tracking every source", () => {
    const rows = effectiveRules([
      ok("user", { permissions: { allow: ["Bash(ls:*)"], deny: ["Read(.env)"] } }),
      ok("project", { permissions: { allow: ["Bash(ls:*)", "Edit"] } }),
    ]);
    const allow = rows.filter((r) => r.key === "permissions.allow");
    expect(allow.map((r) => r.rule)).toEqual(["Bash(ls:*)", "Edit"]);
    expect(allow[0].sources).toEqual(["user", "project"]);
    expect(allow[1].sources).toEqual(["project"]);
    expect(rows.find((r) => r.key === "permissions.deny")?.rule).toBe("Read(.env)");
  });

  it("flags a rule entry that isn't a string", () => {
    const rows = effectiveRules([ok("user", { permissions: { allow: [{ tool: "Bash" }] } })]);
    expect(rows[0].invalid).toBe(true);
  });

  it("flags a rule list that isn't a list at all", () => {
    const rows = effectiveRules([ok("user", { permissions: { deny: "Read(.env)" } })]);
    expect(rows[0]).toMatchObject({ key: "permissions.deny", invalid: true });
  });
});

describe("hook inspector (QL-773, view-only)", () => {
  const hooksDoc = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "pwsh ./guard.ps1" }] },
      ],
    },
  };

  it("lists event, matcher, command and source file", () => {
    const { hooks, problems } = collectHooks([ok("project", hooksDoc)]);
    expect(problems).toEqual([]);
    expect(hooks).toEqual([
      { event: "PreToolUse", matcher: "Bash", command: "pwsh ./guard.ps1", source: "project", issues: [] },
    ]);
  });

  it("lists hooks from every scope, not just the winning one", () => {
    const { hooks } = collectHooks([ok("user", hooksDoc), ok("local", hooksDoc)]);
    expect(hooks.map((h) => h.source)).toEqual(["user", "local"]);
  });

  it("flags a non-string command as a hook that never runs", () => {
    const { hooks } = collectHooks([ok("user", { hooks: { Stop: [{ hooks: [{ type: "command", command: ["a"] }] }] } })]);
    expect(hooks[0].issues.join(" ")).toMatch(/command must be a string/);
  });

  it("flags a missing command", () => {
    const { hooks } = collectHooks([ok("user", { hooks: { Stop: [{ hooks: [{ type: "command" }] }] } })]);
    expect(hooks[0].command).toBe("(none)");
    expect(hooks[0].issues.join(" ")).toMatch(/does nothing/);
  });

  it("flags an event name it doesn't know, gently", () => {
    const { hooks } = collectHooks([ok("user", { hooks: { PreToolUsage: [{ hooks: [{ command: "x" }] }] } })]);
    expect(hooks[0].issues.join(" ")).toMatch(/isn’t an event this build knows/);
  });

  it("flags a matcher that isn't a string", () => {
    const { hooks } = collectHooks([ok("user", { hooks: { PreToolUse: [{ matcher: ["Bash"], hooks: [{ command: "x" }] }] } })]);
    expect(hooks[0].issues.join(" ")).toMatch(/matcher must be a string/);
  });

  it("flags a matcher that can never match", () => {
    const { hooks } = collectHooks([ok("user", { hooks: { PreToolUse: [{ matcher: "Bash(", hooks: [{ command: "x" }] }] } })]);
    expect(hooks[0].issues.join(" ")).toMatch(/valid regular expression/);
  });

  it("says when an event ignores the matcher it was given", () => {
    const { hooks } = collectHooks([ok("user", { hooks: { Stop: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } })]);
    expect(hooks[0].issues.join(" ")).toMatch(/ignores matchers/);
  });

  it("keeps a clean hook clean", () => {
    const { hooks } = collectHooks([ok("user", { hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "npm run lint" }] }] } })]);
    expect(hooks[0].issues).toEqual([]);
  });

  it("reports a malformed hooks block as a file problem rather than crashing", () => {
    expect(collectHooks([ok("user", { hooks: [] })]).problems[0].message).toMatch(/should be an object/);
    expect(collectHooks([ok("user", { hooks: { Stop: "x" } })]).problems[0].message).toMatch(/list of matcher groups/);
    expect(collectHooks([ok("user", { hooks: { Stop: [{ }] } })]).problems[0].message).toMatch(/missing its `hooks` list/);
  });

  it("returns nothing when no file declares hooks", () => {
    expect(collectHooks([ok("user", { model: "opus" })])).toEqual({ hooks: [], problems: [] });
  });
});

describe("doctorState (the five UI states)", () => {
  const missing = (scope: File["scope"]): File => ({ scope, path: `${scope}.json`, status: "missing" });

  it("is empty when no settings file exists anywhere", () => {
    expect(doctorState([missing("user"), missing("project"), missing("local")])).toBe("empty");
  });

  it("is ideal when every file present parsed", () => {
    expect(doctorState([ok("user", {}), missing("project")])).toBe("ideal");
  });

  it("is partial when a file exists but Claude Code can't use it", () => {
    const bom: File = { scope: "local", path: "x", status: "invalid", bom: true };
    expect(doctorState([ok("user", {}), bom])).toBe("partial");
    const locked: File = { scope: "project", path: "y", status: "unreadable", readError: "Access is denied. (os error 5)" };
    expect(doctorState([ok("user", {}), locked])).toBe("partial");
  });

  it("is partial even when nothing readable survived, so the copy never claims a clean merge", () => {
    const bad: File = { scope: "user", path: "x", status: "invalid" };
    expect(doctorState([bad])).toBe("partial");
  });
});
