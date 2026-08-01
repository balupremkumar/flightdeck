import { invoke } from "@tauri-apps/api/core";
import { useApp, type PaneModel } from "./store";
import { useUI } from "./ui";
import { vendorShort } from "./vendors";
import { loadSession } from "./persist";
import { ensureTrusted } from "./trust";

// worktrees.ts — frontend side of per-agent git worktree isolation (Tier 0).
// One async spawn path (`spawnPane` / `preparePanes`) owns worktree creation so
// it lives in the user-action path, never in Terminal's mount effect —
// StrictMode's dev double-mount and pane restarts (epoch bump) always REUSE an
// existing worktree, they can't re-create one. Backends: worktree.rs.

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
  created: boolean;
}
export interface DiffFile { path: string; added: number; deleted: number; binary: boolean; }
export interface DiffSummary { base: string; files: DiffFile[]; totalAdded: number; totalDeleted: number; }
export interface MergeOutcome {
  status: string;
  detail: string;
  conflictFiles: string[];
  /** UX-578: short hash of the merge commit, set only when status === "merged". */
  mergeCommit?: string;
  /** UX-578: clickable host URL for mergeCommit, when origin is a recognised host. */
  commitUrl?: string;
}
/** UI-174/177: what a merge would bring, and how far the base has drifted. */
export interface BranchCommit { hash: string; subject: string; at: number; }
export interface BranchContext {
  commits: BranchCommit[];
  baseAhead: number;
  baseBranch: string;
  branch: string;
}
export interface RemoveOutcome { status: string; detail: string; }

const ISOLATE_KEY = "flightdeck-isolate";

/** Last-used isolation preference (NewWorkspace toggle writes it). Default on. */
export function isolationPref(): boolean {
  try { return localStorage.getItem(ISOLATE_KEY) !== "0"; } catch { return true; }
}
export function setIsolationPref(on: boolean) {
  try { localStorage.setItem(ISOLATE_KEY, on ? "1" : "0"); } catch { /* non-persistent */ }
}

/** D12: WSL panes can't isolate — a worktree's .git file embeds an absolute
 *  Windows gitdir: path that git inside WSL can't resolve. */
export function isolationSupported(vendor: string): boolean {
  return vendor !== "wsl";
}

export async function repoToplevel(cwd: string): Promise<string | null> {
  try { return await invoke<string | null>("git_repo_toplevel", { cwd }); } catch { return null; }
}

let slugSeq = 0;
function newSlug(label?: string): string {
  // UI-162: a branch called flightdeck/fix-login-badge beats flightdeck/p1x2f
  // in git log, PR lists and the review drawer. Fall back to the opaque id when
  // there's no label (plain "add pane" with nothing to name it after).
  const slug = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  const uniq = `${Date.now().toString(36).slice(-4)}${(++slugSeq).toString(36)}`;
  return slug ? `${slug}-${uniq}` : `p${uniq}`;
}

/** Resolve the cwd a pane should actually spawn in. Non-repo dirs, WSL panes,
 *  isolation off, or any git failure fall back to the plain base dir (D3) —
 *  isolation degrades visibly (toast) but never blocks a launch. */
async function prepareCwd(
  baseCwd: string,
  vendor: string,
  isolate: boolean,
  label?: string
): Promise<{ cwd: string; wt?: WorktreeInfo }> {
  if (!isolate || !isolationSupported(vendor) || !baseCwd.trim()) return { cwd: baseCwd };
  const top = await repoToplevel(baseCwd);
  if (!top) return { cwd: baseCwd }; // not a repo — runs directly, by design
  try {
    const wt = await invoke<WorktreeInfo>("git_worktree_add", { repoDir: baseCwd, slug: newSlug(label) });
    return { cwd: wt.path, wt };
  } catch (e) {
    // UX-591: short headline in the toast, full error reachable via its
    // expand affordance instead of getting crammed (and cut off) inline.
    useUI.getState().pushToast(
      "error",
      `Worktree isolation failed — ${vendorShort(vendor)} runs in the shared folder instead.`,
      { detail: String(e) }
    );
    return { cwd: baseCwd };
  }
}

/** Spawn one pane, isolated when possible. Returns the new pane's id. */
export async function spawnPane(
  wsId: number,
  vendor: string,
  baseCwd: string,
  isolate: boolean = isolationPref(),
  /** UI-162: names the worktree branch (e.g. a board card's title). */
  label?: string
): Promise<number | null> {
  // K0a: ask before Flightdeck grants this agent trust for the folder. Gated
  // BEFORE the worktree is created, so declining leaves nothing behind.
  if (!(await ensureTrusted(vendor, baseCwd))) return null;
  const prep = await prepareCwd(baseCwd, vendor, isolate, label);
  // Fresh worktree + a configured workspace setup command -> run it pre-agent.
  const ws = useApp.getState().workspaces.find((w) => w.id === wsId);
  const needsSetup = !!(prep.wt?.created && ws?.setupCmd);
  useApp.getState().addPane(wsId, vendor, prep.cwd, prep.wt && {
    worktreePath: prep.wt.path,
    branch: prep.wt.branch,
    baseBranch: prep.wt.baseBranch,
  }, needsSetup);
  return useApp.getState().workspaces.find((w) => w.id === wsId)?.focused ?? null;
}

/** NewWorkspace path: resolve every slot (sequential — the backend serializes
 *  per repo anyway) into the NewPane list createWorkspace expects. */
export async function preparePanes(
  slots: { vendor: string; cwd: string }[],
  isolate: boolean,
  /** UI-112: called after each slot resolves so the caller can show
   *  "worktree 2 of 4…" instead of one opaque spinner. */
  onProgress?: (done: number, total: number) => void
) {
  const out = [];
  for (const s of slots) {
    // K0a: one prompt per repo — the first agy slot asks, the rest inherit the
    // answer. A declined slot is dropped rather than launched untrusted.
    if (!(await ensureTrusted(s.vendor, s.cwd))) {
      onProgress?.(out.length, slots.length);
      continue;
    }
    const prep = await prepareCwd(s.cwd, s.vendor, isolate);
    onProgress?.(out.length + 1, slots.length);
    out.push({
      vendor: s.vendor,
      cwd: prep.cwd,
      worktreePath: prep.wt?.path,
      branch: prep.wt?.branch,
      baseBranch: prep.wt?.baseBranch,
      // createWorkspace ANDs this with its setupCmd — reused worktrees skip setup.
      needsSetup: prep.wt?.created ?? false,
    });
  }
  return out;
}

/** Setup command for a repo: the per-repo remembered value (New Workspace
 *  writes it, including a deliberate blank) wins over the lockfile suggestion.
 *  Used by the headless creation paths (folder drop). */
export async function rememberedOrSuggestedSetup(dir: string): Promise<string | undefined> {
  const top = await repoToplevel(dir);
  if (!top) return undefined;
  try {
    const remembered = localStorage.getItem(`flightdeck-setup:${top.toLowerCase()}`);
    if (remembered != null) return remembered.trim() || undefined;
  } catch { /* non-persistent */ }
  try {
    const suggested = await invoke<string | null>("detect_setup_command", { cwd: dir });
    return suggested ?? undefined;
  } catch { return undefined; }
}

/** Close a pane and clean up its worktree (D6). The remove runs after a short
 *  delay so the PTY kill (Terminal unmount) releases its cwd handle first; the
 *  backend retries once more on top. Dirty worktrees prompt keep/discard —
 *  cancel leaves the worktree in place, and next launch's GC keep-commits it. */
export function closePaneWithCleanup(wsId: number, pane: PaneModel) {
  useApp.getState().closePane(wsId, pane.id);
  const worktreePath = pane.worktreePath;
  if (!worktreePath) return;
  window.setTimeout(() => void cleanupWorktree(worktreePath), 700);
}

/** Workspace close: same contract, all isolated panes at once. */
export function closeWorkspaceWithCleanup(ws: { id: number; panes: PaneModel[] }) {
  const paths = ws.panes.map((p) => p.worktreePath).filter((p): p is string => !!p);
  useApp.getState().closeWorkspace(ws.id);
  if (paths.length === 0) return;
  window.setTimeout(() => { for (const p of paths) void cleanupWorktree(p); }, 700);
}

/** Close a pane WITH the live-session confirm (UI-123). Shared by the pane's
 *  X button, the overflow menu, the command palette and Ctrl+W so the guard
 *  can never be bypassed by adding a new entry point. */
export function closePaneGuarded(wsId: number, pane: PaneModel) {
  const dead = pane.state === "idle" || pane.state === "error";
  if (dead) { closePaneWithCleanup(wsId, pane); return; }
  const name = pane.title || vendorShort(pane.vendor);
  useUI.getState().requestConfirm({
    title: `Close ${name}?`,
    body:
      "This pane is still live. Closing it ends the session — the running agent can't be brought back." +
      (pane.worktreePath ? " Its worktree will be cleaned up (you'll be asked about unmerged work)." : ""),
    confirmLabel: "Close & end session",
    danger: true,
    onConfirm: () => closePaneWithCleanup(wsId, pane),
  });
}

/** Close a workspace WITH the live-session confirm (UI-123). */
export function closeWorkspaceGuarded(ws: { id: number; name: string; panes: PaneModel[] }) {
  const live = ws.panes.some((p) => p.state === "running" || p.state === "starting" || p.state === "waiting" || p.state === "permission");
  if (!live) { closeWorkspaceWithCleanup(ws); return; }
  const n = ws.panes.length;
  useUI.getState().requestConfirm({
    title: `Close ${ws.name}?`,
    body: `${n} pane${n === 1 ? "" : "s"} still live. Closing ends ${n === 1 ? "its session" : "their sessions"} — the running agents can't be brought back.`,
    confirmLabel: "Close & end sessions",
    danger: true,
    onConfirm: () => {
      closeWorkspaceWithCleanup(ws);
      useUI.getState().pushToast("info", `Closed ${ws.name}`);
    },
  });
}

async function cleanupWorktree(worktreePath: string) {
  const ui = useUI.getState();
  try {
    const res = await invoke<RemoveOutcome>("git_worktree_remove", { worktreePath, mode: "ask" });
    if (res.status !== "dirty") return;
    ui.requestConfirm({
      title: "Keep this pane's work?",
      body: `The agent left ${res.detail} in its isolated worktree. "Keep" commits the work to its branch before removing the worktree; closing this dialog leaves everything on disk for next launch.`,
      confirmLabel: "Keep on branch",
      onConfirm: () => {
        invoke("git_worktree_remove", { worktreePath, mode: "keep" })
          .then(() => ui.pushToast("success", "Work committed to the pane's branch."))
          .catch((e) => ui.pushToast("error", "Couldn't clean up the worktree.", { detail: String(e) }));
      },
    });
  } catch (e) {
    ui.pushToast("error", "Couldn't clean up the worktree.", { detail: String(e) });
  }
}

/** Launch-time GC (D6): reap worktrees no persisted or live pane claims.
 *  Stray work is keep-committed to its branch by the backend, never destroyed. */
export async function runWorktreeGc() {
  try {
    const keep = new Set<string>();
    for (const w of useApp.getState().workspaces)
      for (const p of w.panes) if (p.worktreePath) keep.add(p.worktreePath);
    try {
      const doc = await loadSession();
      for (const w of doc?.workspaces ?? [])
        for (const p of w.panes) if (p.worktreePath) keep.add(p.worktreePath);
    } catch { /* corrupt/absent session doc — GC against live panes only */ }
    const removed = await invoke<string[]>("git_worktree_gc", { keep: [...keep] });
    if (removed.length > 0) {
      // UI-199: "cleaned up 3 worktrees" is unverifiable on its own — name what
      // went, so the claim that work was kept can actually be checked.
      const names = removed.map((p) => p.replace(/[\\\/]+$/, "").split(/[\\\/]/).pop()).filter(Boolean);
      useUI.getState().pushToast(
        "info",
        `Cleaned up ${removed.length} leftover worktree${removed.length === 1 ? "" : "s"} — ${names.join(", ")}. ` +
        `Any uncommitted work was committed to its own branch first.`
      );
    }
  } catch { /* browser preview / git missing — nothing to do */ }
}

/** Internals exposed for unit tests only. */
export const __testing = { newSlug };
