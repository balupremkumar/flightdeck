// Per-pane colour tag + name rules. Pure (no DOM) so the swatch contrast and
// the persistence shape are unit-testable. Colours are theme TOKEN names, not
// hex, so a pane's tint follows the active theme.

export interface PaneSwatch { id: string; label: string; token: string }

/** Every token reads >= 3:1 against --surface-2 (the pane header) in every
 *  shipped theme; paneStyle.test.ts enforces it. */
export const PANE_SWATCHES: PaneSwatch[] = [
  { id: "claude", label: "Claude violet", token: "--agent-claude" },
  { id: "codex", label: "Codex orange", token: "--agent-codex" },
  { id: "accent", label: "Accent", token: "--accent" },
  { id: "aqua", label: "Aqua", token: "--aqua" },
  { id: "blue", label: "Blue", token: "--st-starting" },
  { id: "ice", label: "Ice", token: "--ice" },
  { id: "gold", label: "Gold", token: "--st-waiting" },
  { id: "ink", label: "Ink", token: "--text" },
];

export function swatchToken(id: string | undefined): string | undefined {
  return PANE_SWATCHES.find((s) => s.id === id)?.token;
}

/** The title rule renamePane applies: trimmed, capped at 60, and empty means
 *  "no title" (the header then shows the vendor label). */
export function normalizePaneName(raw: string): string | undefined {
  return raw.trim().slice(0, 60) || undefined;
}

export function displayPaneName(title: string | undefined, vendorLabel: string): string {
  return title || vendorLabel;
}

/** uiPrefs.paneColor: only known swatch ids survive, so a hand-edited or
 *  future-build doc can't inject an arbitrary CSS value. */
export function parsePaneColors(raw: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isFinite(id) || typeof value !== "string" || !swatchToken(value)) continue;
    out[id] = value;
  }
  return out;
}
