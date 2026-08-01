import { describe, expect, it } from "vitest";
import { splitLinkified } from "./LinkifiedText";

describe("splitLinkified (LinkifiedText.tsx)", () => {
  it("returns a single text part when there's nothing to link", () => {
    expect(splitLinkified("just plain output")).toEqual([{ key: "t0", kind: "text", text: "just plain output" }]);
  });

  it("returns [] for empty text", () => {
    expect(splitLinkified("")).toEqual([]);
  });

  it("splits a url out into its own link part", () => {
    const parts = splitLinkified("see https://example.com/docs for more");
    expect(parts.map((p) => p.kind)).toEqual(["text", "url", "text"]);
    expect(parts[1].href).toBe("https://example.com/docs");
  });

  it("resolves a relative path against cwd", () => {
    const parts = splitLinkified("edit src/App.tsx now", "D:\\Dev\\proj");
    const link = parts.find((p) => p.kind === "path");
    expect(link?.href).toBe("D:\\Dev\\proj\\src\\App.tsx");
  });

  it("leaves a path unresolved (raw) when no cwd is supplied", () => {
    const parts = splitLinkified("edit src/App.tsx now");
    const link = parts.find((p) => p.kind === "path");
    expect(link?.href).toBe("src/App.tsx");
  });

  it("carries a :line suffix through to the part", () => {
    const parts = splitLinkified("boom at src/App.tsx:42", "/repo");
    const link = parts.find((p) => p.kind === "path");
    expect(link?.line).toBe(42);
  });
});
