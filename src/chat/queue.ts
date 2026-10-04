// H4: prompts sent from the Chat box while the agent is mid-turn. Claude queues
// them and reads each when the turn ends. Pure helpers; ChatView owns the state.
import type { PaneState } from "../store";

/** Only a running agent queues. "starting" has no input loop yet. */
export function canQueuePrompt(state: PaneState, hasPty: boolean, exited = false): boolean {
  return state === "running" && hasPty && !exited;
}

/** Each real user record that lands in the JSONL means Claude picked up one queued prompt. */
export function drainQueue(queue: string[], newUserRecords: number): string[] {
  return newUserRecords > 0 ? queue.slice(newUserRecords) : queue;
}

/** Nothing can still be waiting once the agent is back at its prompt (or gone). */
export function queueClearsOn(state: PaneState, exited = false): boolean {
  return exited || state === "idle" || state === "waiting" || state === "permission" || state === "error";
}

/** "1 queued" / "3 queued". */
export function queuedLabel(n: number): string {
  return `${n} queued`;
}

/** Tooltip body: the queued prompts, oldest first, each clipped. */
export function queuedTitle(queue: string[]): string {
  return queue.map((q, i) => `${i + 1}. ${q.length > 120 ? q.slice(0, 117) + "..." : q}`).join("\n");
}
