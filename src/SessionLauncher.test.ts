import { describe, expect, it, vi } from "vitest";

// Same import guard the other component tests use: the module pulls in the
// tauri IPC + store, the pure helpers under test touch neither.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

import type { ClaudeSession, SessionSearchHit } from "./SessionLauncher";

const {
  resumeArgs, resumeArgsFor, canResume, supportsFork, supportsDeepSearch, listCommandFor, modelShort, contextWindowFor, filterSessions, sessionWeight,
  groupHits, highlightParts, hitCwd,
  DEFAULT_CONTEXT_WINDOW, RESUME_VENDOR, MIN_SEARCH_CHARS, SEARCH_DEBOUNCE_MS,
} = await import("./SessionLauncher");

const session = (over: Partial<ClaudeSession> = {}): ClaudeSession => ({
  id: "11111111-2222-3333-4444-555555555555",
  modifiedMs: 1_700_000_000_000,
  title: "fix the token chip",
  gitBranch: "master",
  model: "claude-opus-4-1-20250805",
  turns: 12,
  sizeBytes: 180_000,
  ...over,
});

describe("resumeArgs (QL-764)", () => {
  it("resumes in place by default", () => {
    expect(resumeArgs("abc", false)).toEqual(["--resume", "abc"]);
  });

  it("adds --fork-session for a fork, leaving the original session alone", () => {
    expect(resumeArgs("abc", true)).toEqual(["--resume", "abc", "--fork-session"]);
  });

  it("only ever applies to the Claude vendor", () => {
    expect(RESUME_VENDOR).toBe("claude");
  });
});

describe("per-vendor resume (Codex)", () => {
  it("claude args are unchanged", () => {
    expect(resumeArgsFor("claude", "abc", false)).toEqual(["--resume", "abc"]);
    expect(resumeArgsFor("claude", "abc", true)).toEqual(["--resume", "abc", "--fork-session"]);
  });

  it("codex is `resume <id>` and never forks", () => {
    const id = "0199aaaa-1111-7222-8333-444455556666";
    expect(resumeArgsFor("codex", id, false)).toEqual(["resume", id]);
    expect(resumeArgsFor("codex", id, true)).toEqual(["resume", id]);
  });

  it("gates by vendor", () => {
    expect(canResume("claude") && canResume("codex")).toBe(true);
    expect(canResume("agy") || canResume("pwsh")).toBe(false);
    expect(supportsFork("codex")).toBe(false);
    expect(supportsFork("claude")).toBe(true);
    expect(supportsDeepSearch("codex")).toBe(false);
    expect(listCommandFor("codex")).toBe("list_codex_sessions");
    expect(listCommandFor("claude")).toBe("list_claude_sessions");
  });

  it("a rollout-reported context window beats the model table", () => {
    expect(contextWindowFor("gpt-5-codex", 272_000)).toBe(272_000);
    expect(contextWindowFor("gpt-5-codex", null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor("gpt-5-codex", 0)).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("modelShort (QL-766)", () => {
  it("reads the current family-first ids", () => {
    expect(modelShort("claude-opus-4-1-20250805")).toBe("opus 4.1");
    expect(modelShort("claude-sonnet-4-5-20250929")).toBe("sonnet 4.5");
    expect(modelShort("claude-opus-5")).toBe("opus 5");
  });

  it("reads the older generation-first ids", () => {
    expect(modelShort("claude-3-5-haiku-20241022")).toBe("haiku 3.5");
    expect(modelShort("claude-3-opus-20240229")).toBe("opus 3");
  });

  it("knows fable", () => {
    expect(modelShort("claude-fable-5-20260101")).toBe("fable 5");
  });

  it("never shows the date stamp as a generation", () => {
    expect(modelShort("claude-opus-4-20250514")).toBe("opus 4");
  });

  it("degrades to something readable for an unknown id", () => {
    expect(modelShort("gpt-9-turbo")).toBe("gpt-9-turbo");
    expect(modelShort(null)).toBe("");
    expect(modelShort(undefined)).toBe("");
  });
});

describe("contextWindowFor (QL-765)", () => {
  it("assumes the standard window", () => {
    expect(contextWindowFor("claude-opus-4-1-20250805")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(null)).toBe(200_000);
  });

  it("takes the long-context variants at their word", () => {
    expect(contextWindowFor("claude-sonnet-4-5-20250929[1m]")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-4-1m")).toBe(1_000_000);
  });

  it("gives the 5.x generation and Opus/Sonnet 4.6+ the 1M ceiling, dated variants included", () => {
    for (const id of [
      "claude-opus-5-5", "claude-opus-5-5-20260922", "claude-sonnet-5-5", "claude-sonnet-5",
      "claude-opus-5", "claude-fable-5-1", "claude-opus-4-6", "claude-sonnet-4-6",
    ]) expect(contextWindowFor(id), id).toBe(1_000_000);
  });

  it("keeps 200k for Haiku 4.5 and for Opus/Sonnet before 4.6", () => {
    for (const id of [
      "claude-haiku-4-5-20251001", "claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929",
      "claude-3-5-haiku-20241022", "claude-opus-4-1-20250805",
    ]) expect(contextWindowFor(id), id).toBe(200_000);
  });
});

describe("sessionWeight (QL-764)", () => {
  it("gives the exact turn count when the backend read the whole transcript", () => {
    expect(sessionWeight({ turns: 12, sizeBytes: 180_000 })).toBe("12 turns");
    expect(sessionWeight({ turns: 1, sizeBytes: 900 })).toBe("1 turn");
  });

  it("falls back to the transcript size rather than inventing a count", () => {
    // A 25 MB transcript's turns can't be sampled honestly (usage.rs explains
    // why the byte-scaled estimate was thrown out), so it says how big it is.
    expect(sessionWeight({ turns: null, sizeBytes: 25_649_367 })).toMatch(/transcript$/);
    expect(sessionWeight({ turns: null, sizeBytes: 25_649_367 })).not.toMatch(/turn/);
  });
});

describe("filterSessions (QL-764)", () => {
  const list = [
    session({ id: "aaa", title: "fix the token chip", gitBranch: "master" }),
    session({ id: "bbb", title: "wire the board", gitBranch: "feature/board", model: "claude-3-5-haiku-20241022" }),
  ];

  it("returns everything, in order, for an empty query", () => {
    expect(filterSessions(list, "  ")).toEqual(list);
  });

  it("matches the prompt, the branch, the id and the model", () => {
    expect(filterSessions(list, "token").map((s) => s.id)).toEqual(["aaa"]);
    expect(filterSessions(list, "feature/").map((s) => s.id)).toEqual(["bbb"]);
    expect(filterSessions(list, "bbb").map((s) => s.id)).toEqual(["bbb"]);
    expect(filterSessions(list, "haiku").map((s) => s.id)).toEqual(["bbb"]);
    expect(filterSessions(list, "OPUS").map((s) => s.id)).toEqual(["aaa"]);
  });

  it("says nothing matched rather than falling back to everything", () => {
    expect(filterSessions(list, "zzz")).toEqual([]);
  });
});

describe("groupHits (QL-771)", () => {
  const hit = (over: Partial<SessionSearchHit> = {}): SessionSearchHit => ({
    sessionId: "aaa",
    timestampMs: 1_700_000_000_000,
    role: "user",
    snippet: "…the kraken chip…",
    sessionHits: 1,
    cwd: "",
    ...over,
  });

  it("groups consecutive hits per session, keeping the backend's order", () => {
    const groups = groupHits([
      hit({ sessionId: "new", sessionHits: 2 }),
      hit({ sessionId: "new", sessionHits: 2, role: "assistant" }),
      hit({ sessionId: "old", sessionHits: 1 }),
    ]);
    expect(groups.map((g) => g.sessionId)).toEqual(["new", "old"]);
    expect(groups[0].hits).toHaveLength(2);
    expect(groups[1].hits).toHaveLength(1);
  });

  it("reports the session's own hit count, which can exceed the rows shown", () => {
    // The backend early-exits per file, so count is the session's total as far
    // as it read — never just the length of what came back after the overall cap.
    const groups = groupHits([hit({ sessionId: "big", sessionHits: 20 })]);
    expect(groups[0].count).toBe(20);
    expect(groups[0].hits).toHaveLength(1);
  });

  it("has nothing to group when nothing matched", () => {
    expect(groupHits([])).toEqual([]);
  });
});

describe("highlightParts (QL-771)", () => {
  it("splits the snippet into matched and unmatched runs, case-insensitively", () => {
    expect(highlightParts("The KRAKEN chip", "kraken")).toEqual([
      { text: "The ", hit: false },
      { text: "KRAKEN", hit: true },
      { text: " chip", hit: false },
    ]);
  });

  it("marks every occurrence", () => {
    expect(highlightParts("ab ab", "ab").filter((p) => p.hit)).toHaveLength(2);
  });

  it("keeps the original text exactly — the snippet is never rewritten", () => {
    const s = "…mixed CASE and more case…";
    expect(highlightParts(s, "case").map((p) => p.text).join("")).toBe(s);
    expect(highlightParts(s, "").map((p) => p.text).join("")).toBe(s);
    expect(highlightParts(s, "   ")).toEqual([{ text: s, hit: false }]);
  });

  it("gives up on highlighting rather than misaligning odd Unicode", () => {
    // "İ".toLowerCase() is two code units, so offsets from the lowercased copy
    // would point at the wrong characters in the original.
    const s = "İstanbul kraken";
    expect(highlightParts(s, "kraken")).toEqual([{ text: s, hit: false }]);
  });
});

describe("regex + scope helpers", () => {
  it("highlights regex matches and survives a bad pattern", () => {
    expect(highlightParts("see QL-771 and QL-9 ok", String.raw`QL-\d+`, true).filter((p) => p.hit).map((p) => p.text)).toEqual(["QL-771", "QL-9"]);
    expect(highlightParts("a (b", "(", true)).toEqual([{ text: "a (b", hit: false }]);
    expect(highlightParts("nothing", "zz", true)).toEqual([{ text: "nothing", hit: false }]);
  });

  it("resumes a hit in its own project folder, else the pane's", () => {
    expect(hitCwd({ cwd: "D:\\other" }, "D:\\here")).toBe("D:\\other");
    expect(hitCwd({ cwd: "" }, "D:\\here")).toBe("D:\\here");
  });
});

describe("search knobs (QL-771)", () => {
  it("won't fire a folder-wide read for one character", () => {
    expect(MIN_SEARCH_CHARS).toBe(2);
  });

  it("debounces typing", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
  });
});
