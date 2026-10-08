import { describe, expect, it } from "vitest";
import { CLAUDE_INSTALL_COMMAND, missingCliHint } from "./paneMenu";

describe("missingCliHint", () => {
  it.each([
    "'claude' is not recognized as the name of a cmdlet",
    "claude is not recognized as the name of a cmdlet",
    "CLAUDE is not recognized as the name of a cmdlet",
    "CategoryInfo : ObjectNotFound: (claude:String) [], CommandNotFoundException",
  ])("explains Claude command-not-found output: %s", (line) => {
    expect(missingCliHint("claude", line)).toBe(CLAUDE_INSTALL_COMMAND);
  });

  it("does not offer a Claude installer for another vendor", () => {
    expect(missingCliHint("codex", "CommandNotFoundException")).toBeNull();
    expect(missingCliHint("pwsh", "'claude' is not recognized")).toBeNull();
  });

  it("does not explain unrelated errors or missing output", () => {
    expect(missingCliHint("claude", "Access denied")).toBeNull();
    expect(missingCliHint("claude", "'git' is not recognized")).toBeNull();
    expect(missingCliHint("claude", undefined)).toBeNull();
  });
});
