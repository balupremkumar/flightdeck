// codeTokens.ts: which theme token each syntax category uses in CodeView. Kept
// apart from CodeView so a test can check contrast and distinctness from the
// real theme.css without loading CodeMirror.
export const CODE_TOKEN = {
  keyword: "accent",
  string: "aqua",
  number: "st-waiting", // the warm amber/gold of the palette
  comment: "faint",
  type: "agent-claude", // the violet pair, light-safe in both modes
  function: "deepblue",
  operator: "muted",
  property: "text",
  invalid: "red",
} as const;

export type CodeCategory = keyof typeof CODE_TOKEN;
// Each token is pulled MIX% of the way towards the ink colour, which lifts the
// light themes (whose pale accents sit near 4:1 on the preview ground) over 4.5:1.
export const MIX = 30;
export const codeVar = (c: CodeCategory) => `color-mix(in srgb, var(--${CODE_TOKEN[c]}) ${100 - MIX}%, var(--text))`;
