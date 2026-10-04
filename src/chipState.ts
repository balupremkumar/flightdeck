// chipState.ts — H6: pure logic for the workspace port chips and the PR/CI chip.

export interface PortInfo { port: number; pid: number; processName: string; paneId: number; }
export type ChecksState = "none" | "running" | "passed" | "failed";
export interface PrInfo { number: number; url: string; state: string; checks: ChecksState; }

export const portLabel = (p: PortInfo) => `localhost:${p.port}${p.processName ? ` · ${p.processName}` : ""}`;
export const portUrl = (p: PortInfo) => `http://localhost:${p.port}`;

export function prLabel(pr: PrInfo): string {
  const st = pr.state.toUpperCase();
  if (st === "MERGED") return `PR #${pr.number} · merged`;
  if (st === "CLOSED") return `PR #${pr.number} · closed`;
  if (pr.checks === "none") return `PR #${pr.number}`;
  return `PR #${pr.number} · checks ${pr.checks}`;
}

/** Only http(s) PR links are ever opened. */
export const safePrUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : null);

export interface CiToast { kind: "success" | "error"; text: string; url?: string; }

/**
 * CI-finished state machine. `seen` remembers the last checks state per PR key.
 * A toast fires only on the running -> passed|failed edge, once: the next poll
 * sees passed -> passed and stays quiet, and a PR first seen already finished
 * (app start, workspace switch) never toasts.
 */
export function ciTransition(seen: Map<string, ChecksState>, key: string, pr: PrInfo | null): CiToast | null {
  if (!pr) { seen.delete(key); return null; }
  const prev = seen.get(key);
  seen.set(key, pr.checks);
  if (prev !== "running") return null;
  if (pr.checks === "passed") return { kind: "success", text: `CI passed on PR #${pr.number}`, url: safePrUrl(pr.url) ?? undefined };
  if (pr.checks === "failed") return { kind: "error", text: `CI failed on PR #${pr.number}`, url: safePrUrl(pr.url) ?? undefined };
  return null;
}
