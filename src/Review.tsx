// Review drawer (Tier 0): what did this agent change, and land it. Right-side
// drawer — a new layout primitive next to the centered dialogs in overlays.css.
// Works for any pane in a git repo; isolated (worktree) panes additionally get
// the "Merge back" action targeting their recorded base branch. Diffs include
// untracked files for isolated panes (backend D8).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "./store";
import { useUI } from "./ui";
import { vendorShort } from "./vendors";
import { IconBranch, IconClose, IconChevron, IconDiff, IconMerge, IconRefresh, IconCopy } from "./Icons";
import type { DiffSummary, MergeOutcome, BranchContext } from "./worktrees";
import { absTime } from "./format";
import { invalidateCwd } from "./poll";
import "./review.css";

// Patch-line classes for the unified diff view.
function lineClass(l: string): string {
  if (l.startsWith("@@")) return "rv-hunk";
  if (l.startsWith("+") && !l.startsWith("+++")) return "rv-add";
  if (l.startsWith("-") && !l.startsWith("---")) return "rv-del";
  if (l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("+++") || l.startsWith("---")) return "rv-meta";
  return "";
}

export function Review() {
  const paneId = useUI((s) => s.reviewPaneId);
  const setReviewPane = useUI((s) => s.setReviewPane);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);
  // Subscribe to workspaces so the drawer follows renames/closes live.
  const workspaces = useApp((s) => s.workspaces);
  const hit = useMemo(() => {
    for (const w of workspaces) for (const p of w.panes) if (p.id === paneId) return { wsId: w.id, pane: p };
    return null;
  }, [workspaces, paneId]);

  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<string>("");
  const [merging, setMerging] = useState(false);
  const [handing, setHanding] = useState(false);
  // UI-5: a failed merge surfaces its conflicted files + a way forward here,
  // instead of vanishing into a toast.
  const [conflict, setConflict] = useState<MergeOutcome | null>(null);
  // UI-174/177: what a merge would actually bring, and how far base has drifted.
  const [ctx, setCtx] = useState<BranchContext | null>(null);
  const [showCommits, setShowCommits] = useState(false);
  const [updating, setUpdating] = useState(false);
  // UI-175: the PR page for this branch, remembered so it can be reopened.
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const patchRef = useRef<HTMLPreElement>(null);
  const [hunkIdx, setHunkIdx] = useState(0);

  const pane = hit?.pane ?? null;

  const load = useCallback(async () => {
    if (!pane) return;
    setError(null);
    try {
      const s = await invoke<DiffSummary>("git_diff_summary", { cwd: pane.cwd, base: pane.baseBranch ?? null });
      setSummary(s);
      invoke<BranchContext>("git_branch_context", { cwd: pane.cwd, base: pane.baseBranch ?? null })
        .then(setCtx)
        .catch(() => setCtx(null));
      // Keep the selection if the file is still changed; else pick the first.
      setSelected((sel) => (sel && s.files.some((f) => f.path === sel) ? sel : s.files[0]?.path ?? null));
    } catch (e) {
      setSummary(null);
      setError(String(e));
    }
  }, [pane?.cwd, pane?.baseBranch, pane?.epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (paneId != null) void load(); }, [paneId, load]);
  useEffect(() => { setConflict(null); }, [paneId]);

  // Load the selected file's patch.
  useEffect(() => {
    if (!pane || !selected) { setPatch(""); return; }
    let cancelled = false;
    invoke<string>("git_file_diff", { cwd: pane.cwd, base: pane.baseBranch ?? null, file: selected })
      .then((p) => { if (!cancelled) { setPatch(p); setHunkIdx(0); patchRef.current?.scrollTo({ top: 0 }); } })
      .catch(() => { if (!cancelled) setPatch(""); });
    return () => { cancelled = true; };
  }, [pane?.cwd, pane?.baseBranch, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const lines = useMemo(() => patch.split("\n"), [patch]);
  const hunkLines = useMemo(() => lines.reduce<number[]>((acc, l, i) => (l.startsWith("@@") ? [...acc, i] : acc), []), [lines]);

  const jumpHunk = (dir: 1 | -1) => {
    if (hunkLines.length === 0) return;
    const next = (hunkIdx + dir + hunkLines.length) % hunkLines.length;
    setHunkIdx(next);
    const el = patchRef.current?.querySelector<HTMLElement>(`[data-line="${hunkLines[next]}"]`);
    el?.scrollIntoView({ block: "center" });
  };

  const mergeBack = () => {
    if (!pane?.worktreePath || merging) return;
    requestConfirm({
      title: `Merge ${pane.branch ?? "this branch"} into ${pane.baseBranch ?? "base"}?`,
      body: "Outstanding work is committed to the pane's branch first. A conflict aborts cleanly and leaves both branches untouched.",
      confirmLabel: "Merge back",
      onConfirm: () => {
        setMerging(true);
        setConflict(null);
        invoke<MergeOutcome>("git_merge_back", { worktreePath: pane.worktreePath })
          .then((m) => {
            if (m.status === "merged") pushToast("success", `Merged ${pane.branch} into ${pane.baseBranch}.`);
            else if (m.status === "nothing-to-merge") pushToast("info", "Nothing to merge — the branch has no new work.");
            else if (m.status === "conflict") setConflict(m); // stays in the drawer, not a toast
            else pushToast("error", m.detail || m.status);
            invalidateCwd(pane.cwd); // merge/PR changed git state — force fresh polls
            void load();
          })
          .catch((e) => pushToast("error", `Merge failed: ${String(e)}`))
          .finally(() => setMerging(false));
      },
    });
  };

  // PR handoff (v2 merge path): commit + push the agent branch, open the
  // host's new-PR page. Review and conflicts happen on the host — the local
  // base branch is never touched.
  const createPr = () => {
    if (!pane?.worktreePath || handing) return;
    setHanding(true);
    invoke<{ status: string; url: string | null; detail: string }>("git_pr_handoff", { worktreePath: pane.worktreePath })
      .then((r) => {
        if (r.status === "pushed") {
          pushToast("success", `Pushed ${pane.branch} to origin.${r.url ? "" : ` ${r.detail}`}`);
          if (r.url) { setPrUrl(r.url); void openUrl(r.url).catch(() => pushToast("info", r.url!)); }
        } else if (r.status === "nothing-to-push") {
          pushToast("info", "Nothing to push — the branch has no new work.");
        } else {
          pushToast("error", r.detail || r.status);
        }
        void load();
      })
      .catch((e) => pushToast("error", `PR handoff failed: ${String(e)}`))
      .finally(() => setHanding(false));
  };

  // UI-178: pull the base branch's new work into the agent's branch, so drift
  // is resolved inside the sandbox instead of at merge time.
  const updateFromBase = () => {
    if (!pane?.worktreePath || updating) return;
    setUpdating(true);
    setConflict(null);
    invoke<MergeOutcome>("git_update_from_base", { worktreePath: pane.worktreePath })
      .then((m) => {
        if (m.status === "merged") pushToast("success", `Updated ${pane.branch} from ${pane.baseBranch}.`);
        else if (m.status === "nothing-to-merge") pushToast("info", "Already up to date with the base branch.");
        else if (m.status === "conflict") setConflict(m);
        else pushToast("error", m.detail || m.status);
        invalidateCwd(pane.cwd);
        void load();
      })
      .catch((e) => pushToast("error", `Update failed: ${String(e)}`))
      .finally(() => setUpdating(false));
  };

  // UI-169: hand the whole patch to the clipboard for pasting elsewhere.
  const copyPatch = async () => {
    if (!patch) return;
    try {
      await navigator.clipboard.writeText(patch);
      pushToast("success", `Copied the patch for ${selected}.`);
    } catch {
      pushToast("error", "Couldn't copy — clipboard unavailable.");
    }
  };

  // Esc closes (matches Settings behavior).
  useEffect(() => {
    if (paneId == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setReviewPane(null); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paneId, setReviewPane]);

  if (paneId == null) return null;
  if (!pane) { setReviewPane(null); return null; }

  const title = pane.title || vendorShort(pane.vendor);
  const fileCount = summary?.files.length ?? 0;

  return (
    <div className="rv-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setReviewPane(null); }}>
      <aside className="rv-drawer" role="dialog" aria-label={`Review changes — ${title}`}>
        <div className="rv-head">
          <IconDiff size={15} />
          <span className="rv-title">Review — {title}</span>
          {pane.branch && (
            <span className="rv-branch"><IconBranch size={11} /> {pane.branch} → {pane.baseBranch}</span>
          )}
          {/* UI-177: base moved since the fork — the number that predicts a conflict. */}
          {ctx && ctx.baseAhead > 0 && (
            <span className="rv-drift" title={`${pane.baseBranch} has ${ctx.baseAhead} commit${ctx.baseAhead === 1 ? "" : "s"} this branch doesn't have. Update from base to catch up before merging.`}>
              {pane.baseBranch} +{ctx.baseAhead}
            </span>
          )}
          <span className="sp" />
          <button className="rv-ic" onClick={() => void load()} title="Refresh diff"><IconRefresh size={13} /></button>
          <button className="rv-ic" onClick={() => setReviewPane(null)} title="Close (Esc)"><IconClose size={13} /></button>
        </div>

        {error && <div className="rv-empty">Couldn't read the diff: {error}</div>}
        {!error && summary && fileCount === 0 && (
          <div className="rv-empty">
            No changes yet. {pane.worktreePath ? "The agent hasn't touched anything in its worktree." : "The working tree is clean."}
          </div>
        )}

        {!error && fileCount > 0 && summary && (
          <div className="rv-body">
            <div className="rv-files">
              {/* UI-174: the commits a merge would bring, collapsed by default. */}
              {ctx && ctx.commits.length > 0 && (
                <div className="rv-commits">
                  <button className="rv-commits-t" onClick={() => setShowCommits((v) => !v)} aria-expanded={showCommits}>
                    <IconChevron size={11} style={{ transform: showCommits ? "rotate(90deg)" : "none" }} />
                    {ctx.commits.length} commit{ctx.commits.length === 1 ? "" : "s"} to merge
                  </button>
                  {showCommits && (
                    <ul className="rv-commit-list">
                      {ctx.commits.map((c) => (
                        <li key={c.hash} title={absTime(c.at * 1000)}>
                          <code>{c.hash}</code> {c.subject}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="rv-files-head">
                {fileCount} file{fileCount === 1 ? "" : "s"}
                <span className="rv-stat"><em className="add">+{summary.totalAdded}</em> <em className="del">−{summary.totalDeleted}</em></span>
              </div>
              {summary.files.map((f) => (
                <button
                  key={f.path}
                  className={"rv-file" + (selected === f.path ? " sel" : "")}
                  onClick={() => setSelected(f.path)}
                  title={f.path}
                >
                  <span className="rv-file-path">{f.path}</span>
                  {f.binary
                    ? <span className="rv-file-bin">binary</span>
                    : <span className="rv-file-stat"><em className="add">+{f.added}</em><em className="del">−{f.deleted}</em></span>}
                </button>
              ))}
            </div>
            <div className="rv-patch-wrap">
              <div className="rv-patch-bar">
                <span className="rv-patch-file">{selected}</span>
                <span className="sp" />
                <span className="rv-hunk-count">{hunkLines.length > 0 ? `hunk ${hunkIdx + 1}/${hunkLines.length}` : ""}</span>
                <button className="rv-ic" onClick={() => jumpHunk(-1)} disabled={hunkLines.length === 0} title="Previous hunk">
                  <IconChevron size={12} style={{ transform: "rotate(-90deg)" }} />
                </button>
                <button className="rv-ic" onClick={() => void copyPatch()} disabled={!patch} title="Copy this file's patch">
                  <IconCopy size={12} />
                </button>
                <button className="rv-ic" onClick={() => jumpHunk(1)} disabled={hunkLines.length === 0} title="Next hunk">
                  <IconChevron size={12} style={{ transform: "rotate(90deg)" }} />
                </button>
              </div>
              <pre className="rv-patch" ref={patchRef}>
                {lines.map((l, i) => (
                  <span key={i} data-line={i} className={"rv-line " + lineClass(l)}>{l || " "}{"\n"}</span>
                ))}
              </pre>
            </div>
          </div>
        )}

        {conflict && (
          <div className="rv-conflict" role="alert">
            <div className="rv-conflict-t">
              Merge conflict — {conflict.conflictFiles.length || "some"} file{conflict.conflictFiles.length === 1 ? "" : "s"} clash with {pane.baseBranch}
            </div>
            {conflict.conflictFiles.length > 0 && (
              <ul className="rv-conflict-files">
                {conflict.conflictFiles.map((f) => <li key={f}>{f}</li>)}
              </ul>
            )}
            <div className="rv-conflict-sub">
              Nothing was changed — both branches are intact. Create a PR to resolve it on your git host,
              or pull {pane.baseBranch} into the pane's branch in its terminal and merge again.
            </div>
            <div className="rv-conflict-actions">
              <button className="rv-pr" onClick={createPr} disabled={handing}>
                <IconBranch size={13} /> {handing ? "Pushing…" : "Create PR instead"}
              </button>
              <button className="rv-ic rv-conflict-dismiss" onClick={() => setConflict(null)} title="Dismiss">
                <IconClose size={12} />
              </button>
            </div>
          </div>
        )}
        <div className="rv-foot">
          {pane.worktreePath ? (
            <>
              <span className="rv-foot-note">Merge lands the agent's work on {pane.baseBranch} locally; Create PR pushes the branch and reviews on your git host.</span>
              {ctx && ctx.baseAhead > 0 && (
                <button className="rv-pr" onClick={updateFromBase} disabled={updating} title={`Merge ${pane.baseBranch} into ${pane.branch} so this agent is working on current code`}>
                  <IconRefresh size={13} /> {updating ? "Updating…" : "Update from base"}
                </button>
              )}
              {prUrl && (
                <button className="rv-pr" onClick={() => void openUrl(prUrl).catch(() => pushToast("info", prUrl))} title={prUrl}>
                  <IconBranch size={13} /> Reopen PR
                </button>
              )}
              <button className="rv-pr" onClick={createPr} disabled={handing || fileCount === 0 && !pane.branch} title="Push this branch to origin and open a pull request">
                <IconBranch size={13} /> {handing ? "Pushing…" : "Create PR"}
              </button>
              <button className="rv-merge" onClick={mergeBack} disabled={merging || fileCount === 0 && !pane.branch}>
                <IconMerge size={14} /> {merging ? "Merging…" : "Merge back"}
              </button>
            </>
          ) : (
            <span className="rv-foot-note">This pane runs directly in the shared folder — changes land as you commit them.</span>
          )}
        </div>
      </aside>
    </div>
  );
}
