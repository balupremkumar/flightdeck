import { describe, expect, it } from "vitest";
import { MODE_TEXT, paneLabel, parseGhostQuery, parseMode } from "./ghost";

describe("ghost query", () => {
  it("reads name, tint, panes and mode", () => {
    const g = parseGhostQuery("?name=Api%20server&tint=%234aa3ff&panes=3&mode=join");
    expect(g).toEqual({ name: "Api server", tint: "#4aa3ff", panes: 3, mode: "join" });
  });

  it("falls back for missing or hostile values", () => {
    const g = parseGhostQuery("?tint=red%3Bbackground%3Aurl(x)&panes=-4&mode=<b>");
    expect(g.name).toBe("Workspace");
    expect(g.tint).toBeNull();
    expect(g.panes).toBe(0);
    expect(g.mode).toBe("new");
  });

  it("accepts functional colours and caps the name", () => {
    expect(parseGhostQuery("?tint=hsl(210%2C80%25%2C60%25)").tint).toBe("hsl(210,80%,60%)");
    expect(parseGhostQuery(`?name=${"x".repeat(200)}`).name).toHaveLength(80);
  });

  it("keeps markup as plain text for textContent", () => {
    expect(parseGhostQuery("?name=%3Cimg%20onerror%3Dx%3E").name).toBe("<img onerror=x>");
  });

  it("modes and pane label", () => {
    expect(parseMode("cancel")).toBe("cancel");
    expect(parseMode("nope")).toBe("new");
    expect(Object.keys(MODE_TEXT).sort()).toEqual(["cancel", "join", "new"]);
    expect(paneLabel(1)).toBe("1 pane");
    expect(paneLabel(2)).toBe("2 panes");
    expect(paneLabel(0)).toBe("");
  });
});
