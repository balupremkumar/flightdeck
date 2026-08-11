import { beforeEach, describe, expect, it, vi } from "vitest";

// Node suite: stub the browser/Tauri surfaces the module graph pulls in at
// import time, the same way Explorer.test.ts does. localStorage is real here
// (rather than left to Settings' try/catch fallback) because these tests need
// to set the persisted editor command.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(() => ({ theme: vi.fn() })) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

const { tokenizeCommand, editorArgv, openInEditor } = await import("./editor");
const { EDITOR_PRESETS } = await import("./Settings");
const { invoke } = await import("@tauri-apps/api/core");
const { openPath } = await import("@tauri-apps/plugin-opener");
const { useUI } = await import("./ui");

/** The persisted shape Settings.tsx writes (key: flightdeck-editor-settings). */
function configureEditor(command: string) {
  store.set("flightdeck-editor-settings", JSON.stringify({ editor: "custom", command }));
}
function lastToast() {
  const toasts = useUI.getState().toasts;
  // .at() is ES2022; this project targets ES2020 (see tsconfig.json).
  return toasts[toasts.length - 1];
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(openPath).mockReset();
  vi.mocked(openPath).mockResolvedValue(undefined);
  store.clear();
});

describe("tokenizeCommand (UX-517)", () => {
  it("splits a plain command on whitespace", () => {
    expect(tokenizeCommand("idea64 --line 42 a.ts")).toEqual(["idea64", "--line", "42", "a.ts"]);
  });

  it("keeps a quoted segment together and drops the quotes", () => {
    expect(tokenizeCommand('code --goto "C:\\Program Files\\a.ts:7"')).toEqual([
      "code",
      "--goto",
      "C:\\Program Files\\a.ts:7",
    ]);
  });

  it("treats backslashes as literal path characters, never escapes", () => {
    expect(tokenizeCommand('ed "D:\\repo\\src\\App.tsx"')).toEqual(["ed", "D:\\repo\\src\\App.tsx"]);
  });

  it("joins a quoted part onto the flag it is glued to", () => {
    expect(tokenizeCommand('ed --file="a b.ts" -n')).toEqual(["ed", "--file=a b.ts", "-n"]);
  });

  it("keeps a deliberately empty argument", () => {
    expect(tokenizeCommand('ed "" x')).toEqual(["ed", "", "x"]);
  });

  it("collapses runs of whitespace instead of emitting blank tokens", () => {
    expect(tokenizeCommand("  ed \t\t -n  a.ts ")).toEqual(["ed", "-n", "a.ts"]);
  });

  it("still launches something when the user's quotes are unbalanced", () => {
    expect(tokenizeCommand('ed "a b.ts')).toEqual(["ed", "a b.ts"]);
  });

  it("has nothing to say about an empty command", () => {
    expect(tokenizeCommand("   ")).toEqual([]);
  });
});

describe("editorArgv (UX-517)", () => {
  it("splits the shipped VS Code preset into a program and an argument array", () => {
    expect(editorArgv(EDITOR_PRESETS.vscode.command, "D:\\repo\\src\\App.tsx", 42)).toEqual({
      program: "code",
      args: ["--goto", "D:\\repo\\src\\App.tsx:42"],
    });
  });

  it("resolves every shipped preset to a program plus arguments", () => {
    for (const { command } of Object.values(EDITOR_PRESETS)) {
      const argv = editorArgv(command, "a.ts", 3);
      expect(argv).not.toBeNull();
      expect(argv!.program).not.toContain("{");
      for (const a of argv!.args) expect(a).not.toContain("{");
    }
  });

  it("defaults the line to 1, matching Settings' own preview", () => {
    expect(editorArgv('code --goto "{file}:{line}"', "a.ts")).toEqual({
      program: "code",
      args: ["--goto", "a.ts:1"],
    });
  });

  /** The reason tokenising happens BEFORE substitution: a path with spaces
   *  must land in exactly one argv slot even if the template forgot to quote
   *  the placeholder. */
  it("keeps a spaced path in one argument even with an unquoted placeholder", () => {
    expect(editorArgv("ed {file}", "C:\\Program Files\\My App\\a.ts")).toEqual({
      program: "ed",
      args: ["C:\\Program Files\\My App\\a.ts"],
    });
  });

  /** A quote inside the path can't break out and invent extra arguments, which
   *  is exactly what resolve-then-split would have allowed. */
  it("cannot be made to inject extra arguments through the path", () => {
    const argv = editorArgv('code --goto "{file}:{line}"', 'a.ts" --evil arg', 1);
    expect(argv).toEqual({ program: "code", args: ["--goto", 'a.ts" --evil arg:1'] });
  });

  it("refuses a template with nothing to launch", () => {
    expect(editorArgv("", "a.ts")).toBeNull();
    expect(editorArgv("   ", "a.ts")).toBeNull();
    expect(editorArgv('""', "a.ts")).toBeNull();
  });
});

describe("openInEditor (UX-517)", () => {
  it("launches the configured editor instead of the OS default", async () => {
    configureEditor('code --goto "{file}:{line}"');
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await openInEditor("D:\\repo\\a.ts", 12);
    expect(invoke).toHaveBeenCalledWith("launch_editor", {
      program: "code",
      args: ["--goto", "D:\\repo\\a.ts:12"],
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("uses the default preset when nothing has been configured yet", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await openInEditor("D:\\repo\\a.ts");
    expect(invoke).toHaveBeenCalledWith("launch_editor", { program: "code", args: ["--goto", "D:\\repo\\a.ts:1"] });
  });

  it("falls back to the OS hand-off when no editor command is configured", async () => {
    configureEditor("   ");
    await openInEditor("D:\\repo\\a.ts");
    expect(invoke).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith("D:\\repo\\a.ts");
  });

  it("falls back to the OS hand-off and names the reason when the spawn fails", async () => {
    configureEditor("nope {file}");
    vi.mocked(invoke).mockRejectedValueOnce("nope isn't installed, or isn't on PATH");
    await openInEditor("D:\\repo\\a.ts");
    expect(openPath).toHaveBeenCalledWith("D:\\repo\\a.ts");
    const t = lastToast();
    expect(t?.kind).toBe("error");
    expect(t?.text).toContain("isn't on PATH");
    expect(t?.text).toContain("D:\\repo\\a.ts");
  });

  it("surfaces a total failure as a toast rather than an unhandled rejection", async () => {
    configureEditor("   ");
    vi.mocked(openPath).mockRejectedValueOnce(new Error("no handler"));
    await expect(openInEditor("D:\\repo\\huge.log")).resolves.toBeUndefined();
    const t = lastToast();
    expect(t?.kind).toBe("error");
    expect(t?.text).toContain("D:\\repo\\huge.log");
  });
});
