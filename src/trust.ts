// trust.ts — K0a: one deliberate consent moment per repo.
//
// Some agents (agy today) refuse to run in a folder until it's in their own
// trusted-workspaces list, and normally prompt for it. Flightdeck writes that
// entry itself before spawning, because six panes launching at once would mean
// six blocking prompts inside six terminals — the cockpit would be unusable.
//
// The cost of that convenience is that Flightdeck answers a security question
// on the user's behalf. For a repo they already work in that's fine. For a repo
// they just cloned and haven't read, it isn't: an unvetted repo is exactly what
// the agent's prompt exists to make you pause on. So we ask once per REPO —
// not per pane, not per worktree — and remember the answer.

import { invoke } from "@tauri-apps/api/core";
import { useUI } from "./ui";
import { vendorMeta } from "./vendors";

const TRUST_KEY = "flightdeck-trusted-repos";

function loadTrusted(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TRUST_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/** Windows paths compare case-insensitively and slash-agnostically. */
function norm(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

export function isRepoTrusted(root: string): boolean {
  const n = norm(root);
  return loadTrusted().some((t) => norm(t) === n);
}

export function trustRepo(root: string) {
  if (isRepoTrusted(root)) return;
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify([...loadTrusted(), root]));
  } catch { /* non-persistent — we'll ask again next launch, which is the safe direction */ }
}

export function untrustRepo(root: string) {
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify(loadTrusted().filter((t) => norm(t) !== norm(root))));
  } catch { /* non-persistent */ }
}

export function trustedRepos(): string[] {
  return loadTrusted();
}

/**
 * Gate a spawn on the user having trusted this repo for a trust-requiring
 * agent. Resolves true when it's safe to proceed.
 *
 * Keyed on the repo root, so all six panes and every worktree of one repo share
 * a single decision. A non-repo folder is keyed on the folder itself — there's
 * no root to generalise to, and it's still a place the agent will read.
 */
export async function ensureTrusted(vendor: string, dir: string): Promise<boolean> {
  if (!vendorMeta(vendor).needsTrust) return true;
  const target = dir.trim();
  if (!target) return true;

  // Prefer the repo root so worktrees and subfolders inherit the decision.
  // Called directly rather than through worktrees.ts, which imports THIS module.
  const key = await invoke<string | null>("git_repo_toplevel", { cwd: target })
    .then((top) => top ?? target)
    .catch(() => target);
  if (isRepoTrusted(key)) return true;

  const label = vendorMeta(vendor).label;
  return new Promise<boolean>((resolve) => {
    useUI.getState().requestConfirm({
      title: `Let ${label} work in this folder?`,
      body:
        `${key}\n\n` +
        `${label} only runs in folders you've marked as trusted, and Flightdeck grants that for you so ` +
        `panes don't each stop to ask. Worth a look first if you didn't write this code — an agent reads ` +
        `whatever is in the repo.\n\n` +
        `Asked once per repo. You can revoke it later in Settings > Agents.`,
      confirmLabel: "Trust this folder",
      onConfirm: () => { trustRepo(key); resolve(true); },
      onCancel: () => resolve(false),
    });
  });
}
