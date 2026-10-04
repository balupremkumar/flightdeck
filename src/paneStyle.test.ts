import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANE_SWATCHES, swatchToken, normalizePaneName, displayPaneName, parsePaneColors } from "./paneStyle";
import { parseUiPrefs } from "./session";
import { THEMES } from "./themes";
import { contrastRatio } from "./vscodeTheme";

// Tokens read from the real theme.css (same approach as themes.test.ts).
const css = readFileSync(join(process.cwd(), "src", "theme.css"), "utf8");
function blockTokens(selectorRe: RegExp): Record<string, string> | null {
  const m = selectorRe.exec(css);
  if (!m) return null;
  const body = css.slice(m.index + m[0].length, css.indexOf("\n}", m.index + m[0].length));
  const out: Record<string, string> = {};
  for (const d of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
const base = blockTokens(/^:root \{/m)!;
function themeTokens(id: string): Record<string, string> {
  if (id === "dark") return base;
  return { ...base, ...(blockTokens(new RegExp(`:root\\[data-theme="${id}"\\] \\{`)) ?? {}) };
}

describe("pane colour swatches", () => {
  it("has 8 swatches with unique ids", () => {
    expect(PANE_SWATCHES).toHaveLength(8);
    expect(new Set(PANE_SWATCHES.map((s) => s.id)).size).toBe(8);
  });
  for (const { id } of THEMES) {
    for (const sw of PANE_SWATCHES) {
      const tk = themeTokens(id);
      it(`${id} ${sw.token} bar >= 3:1 on header (--surface-2)`, () => {
        expect(contrastRatio(tk[sw.token], tk["--surface-2"])).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe("pane name rules", () => {
  it("empty or blank means default vendor label", () => {
    expect(normalizePaneName("   ")).toBeUndefined();
    expect(displayPaneName(normalizePaneName(""), "claude")).toBe("claude");
  });
  it("trims and caps at 60", () => {
    expect(normalizePaneName("  api  ")).toBe("api");
    expect(normalizePaneName("x".repeat(80))).toHaveLength(60);
  });
});

describe("pane colour persistence", () => {
  it("round-trips through uiPrefs and drops unknown ids and bad keys", () => {
    const stored = { 3: "claude", 4: "ice" };
    expect(parseUiPrefs({ paneColor: stored }).paneColor).toEqual(stored);
    expect(parsePaneColors({ 3: "claude", 4: "url(evil)", x: "ice", 5: 7 })).toEqual({ 3: "claude" });
    expect(parseUiPrefs({}).paneColor).toEqual({});
    expect(swatchToken("nope")).toBeUndefined();
  });
});
