// cmlang.test.ts guards real grammar imports and coverage of viewer language keys.
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { LANG_LOADERS } from "./cmlang";
import { CODE_LANG } from "./registry";

describe("LANG_LOADERS", () => {
  it.each(Object.entries(LANG_LOADERS))("%s resolves to a CodeMirror extension", async (_key, load) => {
    const extension = await load();
    expect(extension).toBeDefined();
    expect(() => EditorState.create({ extensions: [extension] })).not.toThrow();
  });
});

describe("CODE_LANG coverage", () => {
  it.each([...new Set(Object.values(CODE_LANG))].sort())("%s has a language loader", (key) => {
    expect(LANG_LOADERS).toHaveProperty(key, expect.any(Function));
  });
});
