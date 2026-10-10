import { describe, expect, it } from "vitest";
import { buildPromptPayload, sanitizeDraft } from "./send";

describe("sanitizeDraft", () => {
  it("normalises CRLF and lone CR and preserves tabs and newlines", () => {
    expect(sanitizeDraft("a\r\nb\rc\td\ne")).toBe("a\nb\nc\td\ne");
  });
  it("strips all disallowed C0 controls and DEL while preserving ordinary text", () => {
    const controls = Array.from({ length: 32 }, (_, i) => i)
      .filter((i) => i !== 9 && i !== 10 && i !== 13)
      .map((i) => String.fromCharCode(i)).join("");
    expect(sanitizeDraft(`before${controls}\x7fafter`)).toBe("beforeafter");
    expect(sanitizeDraft("  caf\u00e9 \u{1f642}  ")).toBe("  caf\u00e9 \u{1f642}  ");
    expect(sanitizeDraft("")).toBe("");
  });
});

describe("buildPromptPayload", () => {
  it("trims outer whitespace and wraps multiline text in bracketed paste before one Enter", () => {
    expect(buildPromptPayload(" \t first\r\nsecond\tpart \n")).toBe("\x1b[200~first\nsecond\tpart\x1b[201~\r");
  });
  it.each(["", " \t\n", "\x00\x03\x1b\x7f", " \r\n\x00 "])(
    "returns null for drafts empty after sanitising and trimming: %j", (draft) => {
      expect(buildPromptPayload(draft)).toBeNull();
    },
  );
  it("removes pasted escape sequences' control bytes including a paste terminator", () => {
    expect(buildPromptPayload("a\x1b[201~b\x03")).toBe("\x1b[200~a[201~b\x1b[201~\r");
  });
});
