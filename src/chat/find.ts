// Find over ALL records, including content collapsed in the UI. Pure.
import type { NormalItem, ToolCall, Turn } from "./turns";
import { callKey, foldActivity, itemKey, recKey } from "./turns";

const norm = (s: string) => s.toLowerCase();

export function callMatches(c: ToolCall, q: string): boolean {
  const n = norm(q);
  if (!n) return false;
  const hay = [c.tool.name, c.tool.summary, ...c.tool.paths, c.result?.summary ?? ""].join("\n");
  return norm(hay).includes(n);
}

export interface FindPlan {
  /** Match anchors in document order (prompt/text/call keys). */
  keys: string[];
  /** Keys of groups, calls and subagents that must be open to show a match. */
  expand: Set<string>;
}

function walk(items: NormalItem[], q: string, plan: FindPlan): boolean {
  let any = false;
  for (const it of items) {
    if (it.kind === "activity") {
      // TN2: the Normal-density line that folds this run must open too.
      if (walk(it.items, q, plan)) { plan.expand.add(it.key); any = true; }
    } else if (it.kind === "text") {
      if (it.rec.text && norm(it.rec.text).includes(norm(q))) { plan.keys.push(itemKey(it)); any = true; }
    } else if (it.kind === "tools") {
      const hits = it.calls.filter((c) => callMatches(c, q));
      if (hits.length) {
        any = true;
        if (it.calls.length > 1) plan.expand.add(itemKey(it));
        for (const c of hits) { plan.expand.add(callKey(c)); plan.keys.push(callKey(c)); }
      }
    } else if (walk(it.items, q, plan)) {
      plan.expand.add(itemKey(it));
      any = true;
    }
  }
  return any;
}

export function planFind(turns: Turn[], q: string): FindPlan {
  const plan: FindPlan = { keys: [], expand: new Set() };
  if (!q.trim()) return plan;
  for (const t of turns) {
    if (t.prompt?.text && norm(t.prompt.text).includes(norm(q))) plan.keys.push(`p:${recKey(t.prompt)}`);
    walk(foldActivity(t.items), q, plan);
  }
  return plan;
}
