// Review drawer (Tier 0): what did this agent change, and land it. Right-side
// drawer — a new layout primitive next to the centered dialogs in overlays.css.
// Works for any pane in a git repo; isolated (worktree) panes additionally get
// the "Merge back" action targeting their recorded base branch. Diffs include
// untracked files for isolated panes (backend D8).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { useApp } from "./store";
import { useUI } from "./ui";
import { vendorShort } from "./vendors";
import { IconBranch, IconClose, IconChevron, IconDiff, IconMerge, IconRefresh, IconCopy } from "./Icons";
import type { DiffSummary, DiffFile, MergeOutcome, BranchContext } from "./worktrees";
import { absTime, relTime } from "./format";
import { wordDiffMap } from "./worddiff";
import { toSplitRows } from "./splitdiff";
import { groupByDir } from "./diffgroups";
import { highlightLine, langFor } from "./diffhighlight";
import { invalidateCwd, usePoll } from "./poll";
import { closePaneGuarded } from "./worktrees";
import { useBoardStore } from "./board/boardStore";
import type { Card, ColumnId } from "./board/types";
import "./review.css";

// Patch-line classes for the unified diff view.
function lineClass(l: string): string {
  if (l.startsWith("@@")) return "rv-hunk";
  if (l.startsWith("+") && !l.startsWith("+++")) return "rv-add";
  if (l.startsWith("-") && !l.startsWith("---")) return "rv-del";
  if (l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("+++") || l.startsWith("---")) return "rv-meta";
  return "";
}

// UI-167: past this many changed files a flat list stops being scannable.
const GROUP_THRESHOLD = 15;

// UI-179: a conflict lives in the pane's worktree — open the conflicted file
// there rather than the shared cwd, in case the two ever diverge.
function openConflictFile(pane: { worktreePath?: string | null; cwd: string }, relPath: string, onErr: () => void) {
  const root = pane.worktreePath || pane.cwd;
  const sep = root.includes("/") && !root.includes("\\") ? "/" : "\\";
  void openPath(root.replace(/[\\\/]+$/, "") + sep + relPath.replace(/\//g, sep)).catch(onErr);
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
  // UI-168: files DESELECTED from the merge (empty = everything selected, the
  // default and by far the common case). Tracking the deselected set rather
  // than the selected one means "nothing deselected" is a single cheap check
  // (`size === 0`) that the merge call turns into `files: null` — the exact
  // all-files code path, unchanged from before this feature existed.
  const [deselected, setDeselected] = useState<Set<string>>(() => new Set());
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
  // UI-165: unified is compact; split answers "what did this line become"
  // spatially. Preference sticks — people have a strong habit either way.
  const [split, setSplit] = useState(() => {
    try { return localStorage.getItem("flightdeck-diff-split") === "1"; } catch { return false; }
  });
  const toggleSplit = () => {
    setSplit((v) => {
      try { localStorage.setItem("flightdeck-diff-split", v ? "0" : "1"); } catch { /* non-persistent */ }
      return !v;
    });
  };
  const patchRef = useRef<HTMLPreElement>(null);
  const [hunkIdx, setHunkIdx] = useState(0);
  // UI-167: directories currently open in the grouped file list. Starts empty
  // and picks up the selected file's directory below, so the drawer never
  // opens onto a collapsed group hiding the very file it's showing.
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const filesRef = useRef<HTMLDivElement>(null);

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
      // Drop deselections for files that no longer appear in the diff (e.g.
      // the agent reverted them) — a stale checkbox state shouldn't outlive
      // the file it refers to.
      setDeselected((d) => {
        const next = new Set([...d].filter((p) => s.files.some((f) => f.path === p)));
        return next.size === d.size ? d : next;
      });
    } catch (e) {
      setSummary(null);
      setError(String(e));
    }
  }, [pane?.cwd, pane?.baseBranch, pane?.epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (paneId != null) void load(); }, [paneId, load]);

  // UI-170: the agent keeps working while the drawer is open, so a static diff
  // goes stale in front of you. Poll quietly and flag that it moved.
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const seenTotals = useRef<string>("");
  usePoll(async () => {
    if (!pane) return;
    try {
      const s2 = await invoke<DiffSummary>("git_diff_summary", { cwd: pane.cwd, base: pane.baseBranch ?? null });
      const sig = `${s2.files.length}:${s2.totalAdded}:${s2.totalDeleted}`;
      if (seenTotals.current && seenTotals.current !== sig) setStaleSince(Date.now());
      seenTotals.current = sig;
    } catch { /* drawer stays on what it has */ }
  }, 8000, [pane?.cwd, pane?.baseBranch], paneId != null);

  useEffect(() => { seenTotals.current = ""; setStaleSince(null); }, [paneId, selected]);
  useEffect(() => { setConflict(null); setDeselected(new Set()); }, [paneId]);

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
  // UI-166: which tokens actually changed within each paired -/+ line.
  const wordMarks = useMemo(() => wordDiffMap(lines), [lines]);
  const splitRows = useMemo(() => (split ? toSplitRows(lines) : []), [split, lines]);
  const hunkLines = useMemo(() => lines.reduce<number[]>((acc, l, i) => (l.startsWith("@@") ? [...acc, i] : acc), []), [lines]);
  // UI-171: highlighting is chosen once per selected file, not per line.
  const lang = useMemo(() => (selected ? langFor(selected) : null), [selected]);
  // UI-167: only group once the flat list would actually be unwieldy.
  const groups = useMemo(() => {
    const files = summary?.files ?? [];
    return files.length > GROUP_THRESHOLD ? groupByDir(files) : null;
  }, [summary]);

  // Whatever j/k, a click, or a fresh load selects, make sure its directory
  // is open and it's actually in view — a grouped list is no use if walking
  // it with j/k just selects files you can't see.
  useEffect(() => {
    if (!selected) return;
    const slash = selected.lastIndexOf("/");
    const dir = slash === -1 ? "" : selected.slice(0, slash);
    setExpandedDirs((s) => (s.has(dir) ? s : new Set(s).add(dir)));
  }, [selected]);
  useEffect(() => {
    filesRef.current?.querySelector<HTMLElement>(".rv-file.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected, expandedDirs]);

  const jumpHunk = (dir: 1 | -1) => {
    if (hunkLines.length === 0) return;
    const next = (hunkIdx + dir + hunkLines.length) % hunkLines.length;
    setHunkIdx(next);
    const el = patchRef.current?.querySelector<HTMLElement>(`[data-line="${hunkLines[next]}"]`);
    el?.scrollIntoView({ block: "center" });
  };

  // UI-168: files still selected for the merge, in diff order.
  const selectedFiles = useMemo(
    () => (summary?.files ?? []).map((f) => f.path).filter((p) => !deselected.has(p)),
    [summary, deselected]
  );
  const toggleFileSelected = (path: string) => {
    setDeselected((d) => {
      const next = new Set(d);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const mergeBack = () => {
    if (!pane?.worktreePath || merging) return;
    const allSelected = deselected.size === 0;
    // null = "everything" — the exact call the backend has always taken;
    // a partial selection sends only the paths still checked.
    const files = allSelected ? null : selectedFiles;
    if (files && files.length === 0) return; // guarded by the button's disabled state too
    const n = files?.length ?? 0;
    requestConfirm({
      title: allSelected
        ? `Merge ${pane.branch ?? "this branch"} into ${pane.baseBranch ?? "base"}?`
        : `Merge ${n} of ${fileCount} file${fileCount === 1 ? "" : "s"} from ${pane.branch ?? "this branch"} into ${pane.baseBranch ?? "base"}?`,
      body: allSelected
        ? "Outstanding work is committed to the pane's branch first. A conflict aborts cleanly and leaves both branches untouched."
        : "Only the checked files are committed to the pane's branch and merged. Everything else stays uncommitted in the worktree so the agent can keep working on it. A conflict aborts cleanly and leaves both branches untouched.",
      confirmLabel: allSelected ? "Merge back" : `Merge ${n} file${n === 1 ? "" : "s"}`,
      onConfirm: () => {
        setMerging(true);
        setConflict(null);
        invoke<MergeOutcome>("git_merge_back", { worktreePath: pane.worktreePath, files })
          .then((m) => {
            if (m.status === "merged") {
              pushToast("success", allSelected
                ? `Merged ${pane.branch} into ${pane.baseBranch}.`
                : `Merged ${n} file${n === 1 ? "" : "s"} from ${pane.branch} into ${pane.baseBranch}.`);
              // UI-159: a merge is the ONLY unambiguous "this work landed"
              // signal. The obvious heuristic — the pane's diff going to zero —
              // fires identically on `git reset --hard`, on the agent reverting
              // itself, and after Update-from-base, so it would happily mark
              // lost work as Done. Driving it from here instead.
              // UI-168: a partial merge deliberately leaves work outstanding —
              // the card isn't done and the pane isn't ready to close, so
              // neither of these fires unless everything landed.
              if (allSelected) {
                completeCardForPane(pane.id, pane.branch ?? "this branch");
                // UI-176: a merged pane is usually finished work. Offer the tidy-up
                // in the moment rather than leaving a stale worktree behind for the
                // user to remember about later.
                requestConfirm({
                  title: "Close this pane and clean up its worktree?",
                  body: `${pane.branch} is merged into ${pane.baseBranch}. Closing ends the agent session and removes the isolated worktree; the branch itself stays.`,
                  confirmLabel: "Close & clean up",
                  onConfirm: () => {
                    setReviewPane(null);
                    closePaneGuarded(hit!.wsId, pane);
                  },
                });
              }
            }
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
          if (r.url) {
            setPrUrl(r.url);
            // UI-157: if this pane came from a board card, the card keeps the link.
            useBoardStore.getState().setCardPr(pane.id, r.url);
            void openUrl(r.url).catch(() => pushToast("info", r.url!));
          }
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

  // UI-159: move the board card that dispatched this pane into Done, if any.
  const completeCardForPane = (paneId: number, branch: string) => {
    const board = useBoardStore.getState();
    for (const [colId, list] of Object.entries(board.cards) as [ColumnId, Card[]][]) {
      const card = list.find((c) => c.paneId === paneId);
      if (!card) continue;
      if (colId === "complete") return; // already there
      board.moveCard(card.id, "complete", 0);
      pushToast("success", `"${card.title}" moved to Done — ${branch} is merged.`);
      return;
    }
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

  // Esc closes (matches Settings behavior). UI-172: j/k walk the file list,
  // n/p walk hunks — vim-ish, and consistent with the existing hunk buttons.
  useEffect(() => {
    if (paneId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setReviewPane(null); return; }
      // Never steal keys from a text field inside the drawer.
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      const files = summary?.files.map((f) => f.path) ?? [];
      const at = selected ? files.indexOf(selected) : -1;
      if (e.key === "j" && files.length) { e.preventDefault(); setSelected(files[Math.min(files.length - 1, at + 1)]); }
      else if (e.key === "k" && files.length) { e.preventDefault(); setSelected(files[Math.max(0, at - 1)]); }
      else if (e.key === "n") { e.preventDefault(); jumpHunk(1); }
      else if (e.key === "p") { e.preventDefault(); jumpHunk(-1); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, setReviewPane, summary, selected, hunkLines, hunkIdx]);

  if (paneId == null) return null;
  if (!pane) { setReviewPane(null); return null; }

  const title = pane.title || vendorShort(pane.vendor);
  const fileCount = summary?.files.length ?? 0;
  // UI-168: "Merge back" reads exactly as it always has when nothing is
  // deselected; only a real subset changes the wording.
  const mergeAllSelected = deselected.size === 0;
  const mergeNothingSelected = fileCount > 0 && selectedFiles.length === 0;
  const mergeLabel = mergeAllSelected
    ? "Merge back"
    : `Merge ${selectedFiles.length} of ${fileCount} file${fileCount === 1 ? "" : "s"}`;

  // Shared by the flat and grouped (UI-167) file lists. The checkbox is a
  // sibling of the file button, not nested inside it — a <button> may not
  // contain other interactive content (its existing role="button" span gets
  // away with that because it isn't a real control; a real checkbox needs
  // its own place). Only isolated panes get one: only they can merge back.
  const renderFile = (f: DiffFile) => (
    <div key={f.path} className={"rv-file-row" + (deselected.has(f.path) ? " excluded" : "")}>
      {pane.worktreePath && (
        <input
          type="checkbox"
          className="rv-file-check"
          checked={!deselected.has(f.path)}
          onChange={() => toggleFileSelected(f.path)}
          aria-label={`Include ${f.path} in the merge`}
        />
      )}
      <button
        className={"rv-file" + (selected === f.path ? " sel" : "")}
        onClick={() => setSelected(f.path)}
        title={f.path}
      >
        <span className="rv-file-path">{f.path}</span>
        <span
          className="rv-file-open"
          role="button"
          tabIndex={-1}
          title="Open this file"
          onClick={(e) => {
            e.stopPropagation();
            const sep = pane.cwd.includes("/") && !pane.cwd.includes("\\") ? "/" : "\\";
            void openPath(pane.cwd.replace(/[\\\/]+$/, "") + sep + f.path.replace(/\//g, sep))
              .catch(() => pushToast("error", "Couldn't open that file."));
          }}
        >
          open
        </span>
        {f.binary
          ? <span className="rv-file-bin">binary</span>
          : <span className="rv-file-stat"><em className="add">+{f.added}</em><em className="del">−{f.deleted}</em></span>}
      </button>
    </div>
  );

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
          {staleSince && (
            <button
              className="rv-stale"
              title="The agent has changed files since this diff was loaded"
              onClick={() => { setStaleSince(null); void load(); }}
            >
              changed {relTime(staleSince)} — reload
            </button>
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
            <div className="rv-files" ref={filesRef}>
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
              {groups ? (
                // UI-167: past GROUP_THRESHOLD files a flat list is noise —
                // group by directory so you can collapse the parts you don't
                // need to look at. j/k still walk every file (see the effects
                // above); this only changes what's visible, not the order.
                groups.map((g) => {
                  const open = expandedDirs.has(g.dir);
                  return (
                    <div className="rv-dirgroup" key={g.dir}>
                      <button className="rv-dirhead" onClick={() => setExpandedDirs((s) => {
                        const next = new Set(s);
                        if (next.has(g.dir)) next.delete(g.dir); else next.add(g.dir);
                        return next;
                      })} aria-expanded={open}>
                        <IconChevron size={11} style={{ transform: open ? "rotate(90deg)" : "none" }} />
                        <span className="rv-dirname">{g.dir || "(root)"}</span>
                        <span className="rv-dircount">{g.files.length}</span>
                        <span className="rv-dirstat"><em className="add">+{g.added}</em><em className="del">−{g.deleted}</em></span>
                      </button>
                      {open && g.files.map((f) => renderFile(f))}
                    </div>
                  );
                })
              ) : (
                summary.files.map((f) => renderFile(f))
              )}
            </div>
            <div className="rv-patch-wrap">
              <div className="rv-patch-bar">
                <span className="rv-patch-file" title={selected ?? undefined}>{selected}</span>
                <span className="sp" />
                <span className="rv-hunk-count">{hunkLines.length > 0 ? `hunk ${hunkIdx + 1}/${hunkLines.length}` : ""}</span>
                <button className="rv-ic" onClick={() => jumpHunk(-1)} disabled={hunkLines.length === 0} title="Previous hunk">
                  <IconChevron size={12} style={{ transform: "rotate(-90deg)" }} />
                </button>
                <button
                  className={"rv-ic" + (split ? " on" : "")}
                  onClick={toggleSplit}
                  title={split ? "Show unified diff" : "Show side-by-side diff"}
                  aria-pressed={split}
                >
                  {split ? "║" : "≡"}
                </button>
                <button className="rv-ic" onClick={() => void copyPatch()} disabled={!patch} title="Copy this file's patch">
                  <IconCopy size={12} />
                </button>
                <button className="rv-ic" onClick={() => jumpHunk(1)} disabled={hunkLines.length === 0} title="Next hunk">
                  <IconChevron size={12} style={{ transform: "rotate(90deg)" }} />
                </button>
              </div>
              {split ? (
                <div className="rv-split" ref={patchRef as unknown as React.RefObject<HTMLDivElement>}>
                  {splitRows.map((r, k) => (
                    <div key={k} data-line={r.index} className={"rv-srow " + r.kind}>
                      {r.kind === "hunk" || r.kind === "meta" ? (
                        <div className="rv-sfull">{r.left}</div>
                      ) : (
                        <>
                          <span className="rv-sno">{r.leftNo ?? ""}</span>
                          <span className="rv-sside left">{r.left ?? ""}</span>
                          <span className="rv-sno">{r.rightNo ?? ""}</span>
                          <span className="rv-sside right">{r.right ?? ""}</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
              <pre className="rv-patch" ref={patchRef}>
                {lines.map((l, i) => {
                  const cls = lineClass(l);
                  return (
                    <span key={i} data-line={i} className={"rv-line " + cls}>
                      {wordMarks.has(i) ? (
                        <>
                          {l[0]}
                          {wordMarks.get(i)!.map((seg, k) =>
                            seg.changed
                              ? <em key={k} className="rv-word">{seg.text}</em>
                              : <span key={k}>{seg.text}</span>
                          )}
                        </>
                      ) : cls === "" && lang && l ? (
                        // UI-171: only unmarked context lines get syntax
                        // colour. Add/del lines already carry meaning through
                        // colour (green/red) and, when paired, word-diff's
                        // .rv-word — token colours on top of either would
                        // fight the thing that's supposed to stand out.
                        <>
                          {l[0]}
                          {highlightLine(l.slice(1), lang).map((tok, k) =>
                            tok.kind === "plain"
                              ? <span key={k}>{tok.text}</span>
                              : <span key={k} className={"rv-tok-" + tok.kind}>{tok.text}</span>
                          )}
                        </>
                      ) : (l || " ")}
                      {"\n"}
                    </span>
                  );
                })}
              </pre>
              )}
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
                {conflict.conflictFiles.map((f) => (
                  <li key={f}>
                    <span className="rv-conflict-file-path" title={f}>{f}</span>
                    <span
                      className="rv-conflict-open"
                      role="button"
                      tabIndex={-1}
                      title="Open this file to resolve the conflict"
                      onClick={() => openConflictFile(pane, f, () => pushToast("error", "Couldn't open that file."))}
                    >
                      open
                    </span>
                  </li>
                ))}
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
              <button className="rv-merge" onClick={mergeBack} disabled={merging || fileCount === 0 && !pane.branch || mergeNothingSelected}>
                <IconMerge size={14} /> {merging ? "Merging…" : mergeLabel}
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
