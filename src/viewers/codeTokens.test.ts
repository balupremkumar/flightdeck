import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_TOKEN, MIX, type CodeCategory } from "./codeTokens";

const css = readFileSync(join(__dirname, "..", "theme.css"), "utf8");

// Tokens of one theme: the base :root block, overlaid by the theme's own block.
function tokens(theme: string | null): Record<string, string> {
  const grab = (sel: string) => {
    const i = css.indexOf(sel + " {");
    if (i < 0) throw new Error("no block " + sel);
    const body = css.slice(i, css.indexOf("\n}", i));
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
    return out;
  };
  return { ...grab(":root"), ...(theme ? grab(`:root[data-theme="${theme}"]`) : {}) };
}

// What CodeView paints: the token mixed MIX% towards --text, as sRGB hex.
function mixed(tk: Record<string, string>, cat: CodeCategory): string {
  const a = tk[CODE_TOKEN[cat]], b = tk["text"];
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(ch(a, i) * (100 - MIX) / 100 + ch(b, i) * MIX / 100).toString(16).padStart(2, "0")).join("");
}

function lum(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// Preview drawer background is var(--bg) (preview.css .prv-drawer).
describe.each([
  ["dark", null],
  ["light", "light"],
  ["graphite", "graphite"],
  ["dracula", "dracula"],
  ["nord", "nord"],
])("code colours on %s", (_name, theme) => {
  const tk = tokens(theme);
  const cats = Object.keys(CODE_TOKEN) as CodeCategory[];
  it.each(cats)("%s has >= 4.5:1 on the preview background", (cat) => {
    expect(tk[CODE_TOKEN[cat]], `token --${CODE_TOKEN[cat]} missing`).toBeTruthy();
    expect(ratio(mixed(tk, cat), tk["bg"])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("code colours are distinct", () => {
  it.each([["dark", null], ["light", "light"]])("on %s no two core categories share a colour", (_n, theme) => {
    const tk = tokens(theme);
    const core: CodeCategory[] = ["keyword", "string", "number", "comment", "type", "function", "operator", "property"];
    const vals = core.map((c) => mixed(tk, c));
    expect(new Set(vals).size).toBe(vals.length);
  });
});
