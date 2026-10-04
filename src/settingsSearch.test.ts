import { describe, expect, it } from "vitest";
import { matchSettings, highlightRuns, type SettingEntry } from "./settingsSearch";

const e = (section: string, label: string, description = ""): SettingEntry => ({ section, label, description });
const ENTRIES = [
  e("Appearance", "Reduced motion", "Minimise animations app-wide"),
  e("Appearance", "Accent colour", "Auto-adjusts for dark or light"),
  e("Terminal", "Font size"),
  e("Terminal", "Scrollback", "Lines kept per pane"),
  e("Agents", "Sound volume", "Chime when a motion sensor trips"),
];

describe("matchSettings (H3)", () => {
  it("is empty for a blank query", () => {
    expect(matchSettings(ENTRIES, "")).toEqual([]);
    expect(matchSettings(ENTRIES, "   ")).toEqual([]);
  });

  it("matches label, description and section name, case-insensitively", () => {
    expect(matchSettings(ENTRIES, "FONT").map((x) => x.label)).toEqual(["Font size"]);
    expect(matchSettings(ENTRIES, "lines kept").map((x) => x.label)).toEqual(["Scrollback"]);
    expect(matchSettings(ENTRIES, "terminal").map((x) => x.label)).toEqual(["Font size", "Scrollback"]);
  });

  it("ranks label hits above description hits above section-only hits", () => {
    const hits = matchSettings(ENTRIES, "motion");
    expect(hits.map((x) => x.label)).toEqual(["Reduced motion", "Sound volume"]);
    const ranked = matchSettings([e("Motion", "Zebra"), e("Other", "Alpha", "about motion"), e("Other", "Motion blur")], "motion");
    expect(ranked.map((x) => x.label)).toEqual(["Motion blur", "Alpha", "Zebra"]);
  });

  it("reports the section each result lives in", () => {
    expect(matchSettings(ENTRIES, "scrollback")[0].section).toBe("Terminal");
  });

  it("returns nothing when nothing matches", () => {
    expect(matchSettings(ENTRIES, "zzz")).toEqual([]);
  });
});

describe("highlightRuns (H3)", () => {
  it("flags every case-insensitive occurrence and keeps the original casing", () => {
    expect(highlightRuns("Reduced Motion, more motion", "MOTION")).toEqual([
      { text: "Reduced ", hit: false },
      { text: "Motion", hit: true },
      { text: ", more ", hit: false },
      { text: "motion", hit: true },
    ]);
  });

  it("returns one plain run when there is nothing to mark", () => {
    expect(highlightRuns("Scrollback", "")).toEqual([{ text: "Scrollback", hit: false }]);
    expect(highlightRuns("Scrollback", "zz")).toEqual([{ text: "Scrollback", hit: false }]);
  });
});
