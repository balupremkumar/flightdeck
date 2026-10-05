// Review drawer (Tier 0): what did this agent change, and land it. Right-side
// drawer — a new layout primitive next to the centered dialogs in overlays.css.
// Works for any pane in a git repo; isolated (worktree) panes additionally get
// the "Merge back" action targeting their recorded base branch. Diffs include
// untracked files for isolated panes (backend D8).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openInEditor } from "./editor";
import { useApp } from "./store";
import { writeToPane } from "./paneSessions";
import { useUI, useOverlayEsc } from "./ui";
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
import { mapPatchLines } from "./difflines";
import { nextUnreviewed } from "./reviewstate";
import { buildExplainPrompt, buildLineCommentPrompt } from "./reviewprompt";
import {
  applyFolds, autoCollapseThreshold, AUTO_COLLAPSE_KEY, collapseReason, foldRuns, hashPatch, parseViewed,
  reconcileViewed, shouldAutoCollapse, viewedStorageKey, whitespaceStorageKey, type ViewedMap,
} from "./reviewfold";
import "./review.css";

// Patch-line classes for the unified diff view.
function lineClass(l: string): string {
  if (l.startsWith("@@")) return "rv-hunk";
  if (l.startsWith("+") && !l.startsWith("+++")) return "rv-add";
  if (l.startsWith("-") && !l.startsWith("---")) return "rv-del";
  if (l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("+++") || l.startsWith("---")) return "rv-meta";
  return "";
}

// Shared by the file-list "open" action, conflict-file "open" action and
// UX-519's line-click preview — one place that turns a diff-relative path
// into an absolute one under `root`.
function toAbsPath(root: string, relPath: string): string {
  const sep = root.includes("/") && !root.includes("\\") ? "/" : "\\";
  return root.replace(/[\\\/]+$/, "") + sep + relPath.replace(/\//g, sep);
}

// UI-167: past this many changed files a flat list stops being scannable.
const GROUP_THRESHOLD = 15;

// QL-739: the backend caps an oversized file diff and appends this exact
// marker as its last line (src-tauri/src/worktree.rs:36,505-506). Rendered
// raw it just looks like one more context line and the patch appears to stop
// mid-file for no reason, so strip it out of the body and say so explicitly.
export const DIFF_TRUNCATED_MARKER = "… [diff truncated]";

/** Splits the backend's truncation marker off the end of a patch. Returns the
 *  body to render plus whether the diff was cut short. Tolerant of trailing
 *  blank lines; anything else at the end means the patch is complete. */
export function splitTruncationMarker(patch: string): { body: string; truncated: boolean } {
  const lines = patch.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  if (end === 0 || lines[end - 1].trim() !== DIFF_TRUNCATED_MARKER) return { body: patch, truncated: false };
  return { body: lines.slice(0, end - 1).join("\n"), truncated: true };
}

// UI-179: a conflict lives in the pane's worktree — open the conflicted file
// there rather than the shared cwd, in case the two ever diverge. UX-517: goes
// through the configured editor (src/editor.ts) like every other "open this
// file" in the drawer — resolving a conflict means editing, not previewing in
// whatever the extension is associated with. The helper reports its own
// failures and falls back to the OS hand-off, so there's no error callback.
function openConflictFile(pane: { worktreePath?: string | null; cwd: string }, relPath: string) {
  void openInEditor(toAbsPath(pane.worktreePath || pane.cwd, relPath));
}

// Local — not in Icons.tsx, matches its grid (20x20, strokeWidth 1.6, round
// caps). UX-567's "mark reviewed" affordance.
function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10.5 L8.2 14.8 L16 6" />
    </svg>
  );
}

// Local — UX-568/UX-569's toolbar actions. Same grid/weight as IconCheck
// above; a design pass over the exact glyphs is worth a follow-up (flagged
// in the session report) but these are legible placeholders in the meantime.
function IconSend({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 2.5 L2.5 9 L9 11 L11 17.5 Z" />
    </svg>
  );
}
function IconAsk({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.6 8 a2.4 2.2 0 1 1 3.6 2c-.8.6-1.1 1.1-1.1 2" />
      <circle cx="10" cy="14.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

// UX-568: walks up from wherever the browser selection actually landed (a
// text node inside .rv-lc) to the line span carrying the patch-line index.
function lineIndexFromNode(node: Node | null): number | null {
  let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
  while (el && !el.hasAttribute("data-line")) el = el.parentElement;
  const v = el?.getAttribute("data-line");
  return v != null ? Number(v) : null;
}

export function Review() {
  const paneId = useUI((s) => s.reviewPaneId);
  const setReviewPane = useUI((s) => s.setReviewPane);
  const pushToast = useUI((s) => s.pushToast);
  const requestConfirm = useUI((s) => s.requestConfirm);
  // UX-519: diff lines open the same read-only preview drawer other file
  // links use, jumped to the line's real position in the current file.
  const openPreview = useUI((s) => s.openPreview);
  // Subscribe to workspaces so the drawer follows renames/closes live.
  const workspaces = useApp((s) => s.workspaces);
  const hit = useMemo(() => {
    for (const w of workspaces) for (const p of w.panes) if (p.id === paneId) return { wsId: w.id, pane: p };
    return null;
  }, [workspaces, paneId]);

  // Chat view asks Review to open at a file (absolute or relative path).
  const wantFileRef = useRef<string | null>(null);
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
  // UX-567 / QL-719: files marked reviewed ("Viewed"). Each mark carries a hash
  // of the patch as it was ticked; a refresh that shows a different patch
  // clears the mark (see load). Persisted per repo+branch in localStorage.
  const [viewed, setViewed] = useState<ViewedMap>({});
  const viewedRef = useRef<ViewedMap>({});
  const reviewed = useMemo(() => new Set(Object.keys(viewed)), [viewed]);
  // Files whose mark was just cleared because their diff moved on.
  const [changedSince, setChangedSince] = useState<Set<string>>(() => new Set());
  // Phase 3 C1: explicit per-file collapse choices (true = collapsed). Absent
  // means "whatever the auto rule says". Per drawer session, not persisted.
  const [collapseOv, setCollapseOv] = useState<Map<string, boolean>>(() => new Map());
  // QL-739: paths whose loaded patch carried the truncation marker.
  const [truncatedPaths, setTruncatedPaths] = useState<Set<string>>(() => new Set());
  // QL-715: expanded fold starts for the current file, and "show all".
  const [openFolds, setOpenFolds] = useState<Set<number>>(() => new Set());
  const [showAllFolds, setShowAllFolds] = useState(false);
  const [autoLines] = useState(() => {
    try { return autoCollapseThreshold(localStorage.getItem(AUTO_COLLAPSE_KEY)); } catch { return autoCollapseThreshold(null); }
  });
  // git diff -w, remembered per repo.
  const [hideWs, setHideWs] = useState(false);
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

  // QL-719: viewed marks persist per repo+branch. Writes go through here so
  // state, the ref load() reads, and localStorage never drift apart.
  const viewedKey = pane ? viewedStorageKey(pane.cwd, pane.branch) : null;
  const viewedKeyRef = useRef<string | null>(null);
  viewedKeyRef.current = viewedKey;
  const commitViewed = (next: ViewedMap) => {
    viewedRef.current = next;
    setViewed(next);
    const k = viewedKeyRef.current;
    if (!k) return;
    try {
      if (Object.keys(next).length) localStorage.setItem(k, JSON.stringify(next)); else localStorage.removeItem(k);
    } catch { /* non-persistent */ }
  };
  // Switching pane/branch swaps in that branch's marks. Declared before the
  // load effect so load() sees them.
  useEffect(() => {
    let m: ViewedMap = {};
    if (viewedKey) { try { m = parseViewed(localStorage.getItem(viewedKey)); } catch { /* none */ } }
    viewedRef.current = m;
    setViewed(m);
    setChangedSince(new Set());
    setCollapseOv(new Map());
    setTruncatedPaths(new Set());
    let ws = false;
    if (pane) { try { ws = localStorage.getItem(whitespaceStorageKey(pane.cwd)) === "1"; } catch { /* default */ } }
    setHideWs(ws);
  }, [viewedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bumped by load() so a manual refresh re-reads the open file's patch too.
  const [loadTick, setLoadTick] = useState(0);

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
      const want = wantFileRef.current?.replace(/\\/g, "/").toLowerCase() ?? null;
      wantFileRef.current = null;
      const wanted = want ? s.files.find((f) => want === f.path.toLowerCase() || want.endsWith("/" + f.path.toLowerCase()))?.path ?? null : null;
      setSelected((sel) => wanted ?? (sel && s.files.some((f) => f.path === sel) ? sel : s.files[0]?.path ?? null));
      // Drop deselections for files that no longer appear in the diff (e.g.
      // the agent reverted them) — a stale checkbox state shouldn't outlive
      // the file it refers to.
      setDeselected((d) => {
        const next = new Set([...d].filter((p) => s.files.some((f) => f.path === p)));
        return next.size === d.size ? d : next;
      });
      setLoadTick((t) => t + 1);
      // UX-567: a file that's no longer in the diff (reverted, or the merge
      // that just landed it) can't stay "reviewed". QL-719: and one whose
      // patch changed since it was ticked is no longer reviewed either — it
      // reopens with a "changed since viewed" marker. Hashes are always taken
      // from the plain (not -w) patch so the whitespace toggle can't trip it.
      const present = new Set(s.files.map((f) => f.path));
      if (Object.keys(viewedRef.current).length) {
        const fresh: Record<string, string | null> = {};
        await Promise.all(Object.keys(viewedRef.current).filter((p) => present.has(p)).map(async (p) => {
          try {
            const f = s.files.find((x) => x.path === p);
            fresh[p] = hashPatch(await invoke<string>("git_file_diff", { cwd: pane.cwd, base: pane.baseBranch ?? null, file: p, ignoreWhitespace: false }), f);
          } catch { fresh[p] = null; }
        }));
        const r = reconcileViewed(viewedRef.current, fresh, present);
        if (Object.keys(r.viewed).length !== Object.keys(viewedRef.current).length) commitViewed(r.viewed);
        if (r.invalidated.length) {
          setChangedSince((c) => new Set([...c, ...r.invalidated]));
          setCollapseOv((m) => { const n = new Map(m); for (const p of r.invalidated) n.set(p, false); return n; });
        }
      }
    } catch (e) {
      setSummary(null);
      setError(String(e));
    }
  }, [pane?.cwd, pane?.baseBranch, pane?.epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (paneId == null) return;
    wantFileRef.current = useUI.getState().reviewFile;
    void load();
  }, [paneId, load]);

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
  const [patchPath, setPatchPath] = useState<string | null>(null);
  useEffect(() => {
    if (!pane || !selected) { setPatch(""); setPatchPath(null); return; }
    let cancelled = false;
    invoke<string>("git_file_diff", { cwd: pane.cwd, base: pane.baseBranch ?? null, file: selected, ignoreWhitespace: hideWs })
      .then((p) => { if (!cancelled) { setPatch(p); setPatchPath(selected); setHunkIdx(0); patchRef.current?.scrollTo({ top: 0 }); } })
      .catch(() => { if (!cancelled) { setPatch(""); setPatchPath(selected); } });
    return () => { cancelled = true; };
  }, [pane?.cwd, pane?.baseBranch, selected, hideWs, loadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // QL-739: the marker never reaches the renderers — every view (unified,
  // split, word diff, line numbers, hunk index) works off the real patch body.
  const { body: patchBody, truncated } = useMemo(() => splitTruncationMarker(patch), [patch]);
  // Phase 3 C1: effective collapse = explicit choice, else (viewed or auto
  // rule). A patch that arrives truncated flags its path so it auto-collapses.
  const isTruncated = (path: string) => truncatedPaths.has(path) || (truncated && patchPath === path && selected === path);
  const isCollapsed = (f: DiffFile) =>
    collapseOv.get(f.path) ?? (f.path in viewed || shouldAutoCollapse(f, isTruncated(f.path), autoLines));
  useEffect(() => {
    if (patchPath && truncated) setTruncatedPaths((s) => (s.has(patchPath) ? s : new Set(s).add(patchPath)));
  }, [truncated, patchPath]);
  const selFile = useMemo(() => summary?.files.find((f) => f.path === selected) ?? null, [summary, selected]);
  const selCollapsed = !!selFile && isCollapsed(selFile);
  // A collapsed file renders nothing, so none of the per-line work below runs.
  const lines = useMemo(() => (selCollapsed ? [] : patchBody.split("\n")), [patchBody, selCollapsed]);
  // UI-166: which tokens actually changed within each paired -/+ line.
  const wordMarks = useMemo(() => wordDiffMap(lines), [lines]);
  const splitRows = useMemo(() => (split ? toSplitRows(lines) : []), [split, lines]);
  // QL-715: runs of unchanged context longer than FOLD_MIN_RUN fold in both views.
  const foldRanges = useMemo(
    () => foldRuns(split ? splitRows.map((r) => r.kind === "context") : lines.map((l) => l.startsWith(" "))),
    [split, splitRows, lines]
  );
  const segments = useMemo(
    () => applyFolds(split ? splitRows.length : lines.length, foldRanges, openFolds, showAllFolds),
    [split, splitRows, lines, foldRanges, openFolds, showAllFolds]
  );
  // Fold positions belong to one patch in one view; start fresh when either changes.
  useEffect(() => { setOpenFolds(new Set()); setShowAllFolds(false); }, [patch, split, selected]);
  // UX-519/UI-617: each line's real old/new file line number — drives both
  // the unified view's gutter and the "click a line to preview it" jump.
  const patchLineNos = useMemo(() => mapPatchLines(lines), [lines]);
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

  // UX-519: open the file preview at a specific diff line's real position in
  // the current (new) file. Deleted lines have no such position — the click
  // handler that wires this in only fires when patchLineNos gave one.
  const openAtLine = (line: number) => {
    if (!pane || !selected) return;
    openPreview(toAbsPath(pane.cwd, selected), { line });
  };

  // UX-567: toggle the selected file's reviewed mark, and when it's just been
  // marked (not un-marked), jump on to the next unreviewed file — the same
  // "clear the list" flow j/k already supports, one keystroke shorter.
  // QL-719: ticking records a hash of the file's current patch and collapses
  // it; unticking just drops the mark (the file stays as it is).
  const toggleReviewed = async (path: string) => {
    const cur = viewedRef.current;
    if (path in cur) {
      const { [path]: _gone, ...rest } = cur;
      commitViewed(rest);
      setCollapseOv((m) => { const n = new Map(m); n.delete(path); return n; });
      return;
    }
    if (!pane) return;
    let hash: string;
    try {
      const raw = path === selected && patchPath === path && !hideWs
        ? patch
        : await invoke<string>("git_file_diff", { cwd: pane.cwd, base: pane.baseBranch ?? null, file: path, ignoreWhitespace: false });
      hash = hashPatch(raw, summary?.files.find((x) => x.path === path));
    } catch (e) {
      pushToast("error", `Couldn't mark ${path} viewed.`, { detail: String(e) });
      return;
    }
    commitViewed({ ...viewedRef.current, [path]: hash });
    setChangedSince((c) => { if (!c.has(path)) return c; const n = new Set(c); n.delete(path); return n; });
    setCollapseOv((m) => new Map(m).set(path, true));
    const files = summary?.files.map((f) => f.path) ?? [];
    const next = nextUnreviewed(files, path, new Set(Object.keys(viewedRef.current)));
    if (next) setSelected(next);
  };
  const setCollapsed = (path: string, v: boolean) => setCollapseOv((m) => new Map(m).set(path, v));
  const setAllCollapsed = (v: boolean) => setCollapseOv(new Map((summary?.files ?? []).map((f) => [f.path, v] as const)));
  // j/k/click-through lands on a collapsed file: open it, that's why you went.
  const goToFile = (path: string, expand: boolean) => {
    setSelected(path);
    if (expand) setCollapsed(path, false);
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

  // UX-577: line totals for whatever's actually going into the merge, so the
  // preflight can quote the real delta rather than just a file count.
  const selectedStats = useMemo(() => {
    const files = summary?.files ?? [];
    return files.reduce(
      (acc, f) => (deselected.has(f.path) ? acc : { added: acc.added + f.added, deleted: acc.deleted + f.deleted }),
      { added: 0, deleted: 0 }
    );
  }, [summary, deselected]);

  const mergeBack = () => {
    if (!pane?.worktreePath || merging) return;
    const allSelected = deselected.size === 0;
    // null = "everything" — the exact call the backend has always taken;
    // a partial selection sends only the paths still checked.
    const files = allSelected ? null : selectedFiles;
    if (files && files.length === 0) return; // guarded by the button's disabled state too
    const n = files?.length ?? fileCount;
    // UX-577: one preflight, everything you need to decide in it — how much
    // is landing (files + lines) and whether base has moved since the branch
    // forked — instead of a title that only names the branch.
    const stat = allSelected
      ? `${fileCount} file${fileCount === 1 ? "" : "s"}, +${summary?.totalAdded ?? 0} −${summary?.totalDeleted ?? 0}`
      : `${n} of ${fileCount} file${fileCount === 1 ? "" : "s"}, +${selectedStats.added} −${selectedStats.deleted}`;
    const drift = ctx && ctx.baseAhead > 0
      ? ` ${pane.baseBranch ?? ctx.baseBranch ?? "base"} has moved ${ctx.baseAhead} commit${ctx.baseAhead === 1 ? "" : "s"} ahead since this branch forked.`
      : "";
    requestConfirm({
      title: `Merge ${pane.branch ?? "this branch"} into ${pane.baseBranch ?? "base"}?`,
      body: `${stat}.${drift} Outstanding work is committed to the pane's branch first.` +
        (allSelected ? "" : " Everything else stays uncommitted in the worktree so the agent can keep working on it.") +
        " A conflict aborts cleanly and leaves both branches untouched.",
      confirmLabel: allSelected ? "Merge back" : `Merge ${n} file${n === 1 ? "" : "s"}`,
      onConfirm: () => {
        setMerging(true);
        setConflict(null);
        invoke<MergeOutcome>("git_merge_back", { worktreePath: pane.worktreePath, files })
          .then((m) => {
            if (m.status === "merged") {
              // UX-578: name what actually landed — the same file/line
              // delta the preflight showed — rather than just "merged" —
              // and link straight to the merge commit when the remote is a
              // recognised host, so "what changed" is one click away.
              const commitNote = m.mergeCommit ? ` (${m.mergeCommit})` : "";
              pushToast(
                "success",
                `Merged ${pane.branch} into ${pane.baseBranch} — ${stat}${commitNote}.`,
                { url: m.commitUrl }
              );
              // A merge is the ONLY unambiguous "this work landed" signal (a
              // diff going to zero also happens on reset --hard / agent revert).
              // UI-168: a partial merge deliberately leaves work outstanding,
              // so the pane isn't ready to close unless everything landed.
              if (allSelected) {
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
          .catch((e) => pushToast("error", "Merge failed.", { detail: String(e) }))
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
    // UX-592: belt and braces against a push that never answers. The Rust side
    // now disables git's interactive prompts so it should always come back,
    // but the button must clear even if it doesn't — a control stuck on
    // "Pushing…" with no way out is worse than an honest timeout.
    const bounded = <T,>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed-out")), ms))]);
    bounded(
      invoke<{ status: string; url: string | null; detail: string }>("git_pr_handoff", { worktreePath: pane.worktreePath }),
      35000
    )
      .then((r) => {
        if (r.status === "pushed") {
          pushToast("success", `Pushed ${pane.branch} to origin.${r.url ? "" : ` ${r.detail}`}`);
          if (r.url) {
            setPrUrl(r.url);
            void openUrl(r.url).catch(() => pushToast("info", r.url!));
          }
        } else if (r.status === "nothing-to-push") {
          pushToast("info", "Nothing to push — the branch has no new work.");
        } else {
          pushToast("error", r.detail || r.status);
        }
        void load();
      })
      .catch((e) =>
        String(e).includes("timed-out")
          ? pushToast("error", "Origin didn't respond within 35 seconds. Check your connection, then try again.")
          : pushToast("error", "PR handoff failed.", { detail: String(e) })
      )
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
      .catch((e) => pushToast("error", "Update failed.", { detail: String(e) }))
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

  // UX-568/UX-569: both write straight into the pane's PTY, same mechanism
  // Broadcast uses (pty_write) — a live agent reads it exactly like typed
  // input. UX-591's expandable toast carries the raw error on failure
  // instead of a one-line "failed" with the reason cut off.
  const sendToPane = async (data: string, note: string) => {
    if (!pane) return;
    // Computed locally rather than closing over the render's `title` const
    // (declared further down, after the early pane-null return) — same
    // derivation, just self-contained.
    const label = pane.title || vendorShort(pane.vendor);
    try {
      await writeToPane(pane.id, data + "\r");
      pushToast("success", note);
    } catch (e) {
      pushToast("error", `Couldn't send to ${label} — it may not be running.`, { detail: String(e) });
    }
  };

  // UX-568: comment-to-agent — select one or more diff lines (plain browser
  // text selection inside the unified patch view) and send them back to the
  // pane, prefixed with the file and real line range. Unified-only: split
  // view's row index doesn't map onto a single patch-line index the same
  // way, and re-deriving that mapping isn't worth it for this action.
  const sendSelectionToAgent = () => {
    if (!pane || !selected || split) return;
    const sel = window.getSelection();
    const container = patchRef.current;
    if (!sel || sel.isCollapsed || !container || !sel.anchorNode || !container.contains(sel.anchorNode)) {
      pushToast("info", "Select one or more diff lines above, then try again.");
      return;
    }
    const a = lineIndexFromNode(sel.anchorNode);
    const b = lineIndexFromNode(sel.focusNode);
    if (a == null || b == null) return;
    const prompt = buildLineCommentPrompt(selected, lines, patchLineNos, a, b);
    const n = Math.abs(b - a) + 1;
    const label = pane.title || vendorShort(pane.vendor);
    sel.removeAllRanges();
    void sendToPane(prompt, `Sent ${n} line${n === 1 ? "" : "s"} from ${selected} to ${label}.`);
  };

  // UX-569: one action prompts the pane with its OWN patch for the selected
  // file — reviewprompt.ts caps the size so a huge patch is never pasted in
  // wholesale.
  const explainDiff = () => {
    if (!pane || !selected || !patch) return;
    const label = pane.title || vendorShort(pane.vendor);
    void sendToPane(buildExplainPrompt(selected, patch), `Asked ${label} to explain ${selected}.`);
  };

  // UX-542/543: Esc registered on the shared overlay stack (ui.ts) instead of
  // this listener, so it only closes the drawer when it's the top-most
  // overlay (e.g. a confirm opened from Merge back must eat Esc first).
  useOverlayEsc(paneId != null, () => setReviewPane(null));

  // UI-172: j/k walk the file list, n/p walk hunks — vim-ish, and consistent
  // with the existing hunk buttons.
  useEffect(() => {
    if (paneId == null) return;
    const onKey = (e: KeyboardEvent) => {
      // Never steal keys from a text field inside the drawer.
      // (Checkboxes are fine: ticking Viewed shouldn't strand j/k on it.)
      if ((e.target as HTMLElement)?.closest?.("input:not([type=checkbox]), textarea")) return;
      const files = summary?.files.map((f) => f.path) ?? [];
      const at = selected ? files.indexOf(selected) : -1;
      if (e.key === "j" && files.length) { e.preventDefault(); goToFile(files[Math.min(files.length - 1, at + 1)], true); }
      else if (e.key === "k" && files.length) { e.preventDefault(); goToFile(files[Math.max(0, at - 1)], true); }
      else if (e.key === "n") { e.preventDefault(); jumpHunk(1); }
      else if (e.key === "p") { e.preventDefault(); jumpHunk(-1); }
      // UX-567: mark the current file reviewed without leaving the diff.
      else if (e.key === "r" && selected) { e.preventDefault(); void toggleReviewed(selected); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, setReviewPane, summary, selected, hunkLines, hunkIdx, viewed, patch, patchPath, hideWs]);

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

  // UI-173: the file list's per-row "open" action, lifted out of renderFile so
  // QL-739's truncation banner opens the file exactly the same way. UX-517: it
  // launches the editor chosen in Settings (src/editor.ts), which falls back to
  // the OS hand-off this used to do directly.
  const openFileInEditor = (relPath: string) => {
    void openInEditor(toAbsPath(pane.cwd, relPath));
  };

  // Shared by the flat and grouped (UI-167) file lists. The checkbox and the
  // reviewed mark are siblings of the file button, not nested inside it — a
  // <button> may not contain other interactive content (its existing
  // role="button" span gets away with that because it isn't a real control;
  // a real checkbox needs its own place). Only isolated panes get the merge
  // checkbox: only they can merge back. Every pane gets the reviewed mark —
  // reviewing a diff doesn't require merge capability.
  const renderFile = (f: DiffFile) => (
    <div key={f.path} className={"rv-file-row" + (deselected.has(f.path) ? " excluded" : "")}>
      <button
        className="rv-file-chev"
        onClick={() => setCollapsed(f.path, !isCollapsed(f))}
        aria-expanded={!isCollapsed(f)}
        aria-label={(isCollapsed(f) ? "Expand " : "Collapse ") + f.path}
        title={isCollapsed(f) ? "Expand this file's diff" : "Collapse this file's diff"}
      >
        <IconChevron size={10} style={{ transform: isCollapsed(f) ? "none" : "rotate(90deg)" }} />
      </button>
      <span
        className={"rv-file-reviewed" + (reviewed.has(f.path) ? " on" : "")}
        role="button"
        tabIndex={-1}
        title={reviewed.has(f.path) ? "Mark unreviewed" : "Mark viewed (r)"}
        onClick={(e) => { e.stopPropagation(); void toggleReviewed(f.path); }}
      >
        <IconCheck size={12} />
      </span>
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
        className={"rv-file" + (selected === f.path ? " sel" : "") + (reviewed.has(f.path) ? " reviewed" : "")}
        onClick={() => setSelected(f.path)}
        title={f.path}
      >
        <span className="rv-file-path">{f.path}</span>
        {changedSince.has(f.path) && <span className="rv-file-changed" title="This file changed since you marked it viewed">changed</span>}
        <span
          className="rv-file-open"
          role="button"
          tabIndex={-1}
          title="Open this file"
          onClick={(e) => { e.stopPropagation(); openFileInEditor(f.path); }}
        >
          open
        </span>
        {f.binary
          ? <span className="rv-file-bin">binary</span>
          : <span className="rv-file-stat"><em className="add">+{f.added}</em><em className="del">−{f.deleted}</em></span>}
      </button>
    </div>
  );

  // QL-715: one "N hidden lines" row standing in for a folded run. Display:flex
  // for the unified <pre>, grid-compatible for the split view via .rv-fold.
  const foldRow = (start: number, end: number) => (
    <button
      key={"fold" + start}
      className="rv-fold"
      onClick={() => setOpenFolds((s) => new Set(s).add(start))}
      title="Show the unchanged lines in between"
    >
      Show {end - start} hidden line{end - start === 1 ? "" : "s"}
    </button>
  );

  return (
    <div className="rv-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setReviewPane(null); }}>
      <aside className="rv-drawer" role="dialog" aria-label={`Review changes: ${title}`}>
        <div className="rv-head">
          <IconDiff size={15} />
          <span className="rv-title">Review: {title}</span>
          {pane.branch && (
            <span className="rv-branch"><IconBranch size={11} /> {pane.branch} → {pane.baseBranch}</span>
          )}
          {/* UI-177: base moved since the fork — the number that predicts a conflict.
              Non-isolated panes have no pane.baseBranch; fall back to the branch
              context's base so the pill never renders "undefined". */}
          {ctx && ctx.baseAhead > 0 && (
            <span className="rv-drift" title={`${pane.baseBranch ?? ctx.baseBranch ?? "base"} has ${ctx.baseAhead} commit${ctx.baseAhead === 1 ? "" : "s"} this branch doesn't have. Update from base to catch up before merging.`}>
              {pane.baseBranch ?? ctx.baseBranch ?? "base"} +{ctx.baseAhead}
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
          {fileCount > 0 && (
            <>
              <button
                className={"rv-tb" + (hideWs ? " on" : "")}
                aria-pressed={hideWs}
                title="Hide whitespace-only changes (git diff -w)"
                onClick={() => {
                  setHideWs((v) => {
                    try { localStorage.setItem(whitespaceStorageKey(pane.cwd), v ? "0" : "1"); } catch { /* non-persistent */ }
                    return !v;
                  });
                }}
              >
                Hide whitespace
              </button>
              <button className="rv-tb" onClick={() => setAllCollapsed(true)} title="Collapse every file's diff">Collapse all</button>
              <button className="rv-tb" onClick={() => setAllCollapsed(false)} title="Expand every file's diff">Expand all</button>
            </>
          )}
          <button className="rv-ic" onClick={() => void load()} title="Refresh diff"><IconRefresh size={16} /></button>
          <button className="rv-ic" onClick={() => setReviewPane(null)} title="Close (Esc)"><IconClose size={16} /></button>
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
                {/* UX-567: remaining count — the whole point of marking files
                    reviewed is knowing how much is left. */}
                <span className={"rv-reviewed-count" + (reviewed.size === fileCount ? " done" : "")} title="Reviewed in this pass (r to toggle)">
                  {reviewed.size === fileCount ? "all reviewed" : `${fileCount - reviewed.size} left to review`}
                </span>
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
                {selFile && (
                  <button
                    className="rv-ic rv-patch-chev"
                    onClick={() => setCollapsed(selFile.path, !selCollapsed)}
                    aria-expanded={!selCollapsed}
                    aria-label={selCollapsed ? "Expand this file" : "Collapse this file"}
                    title={selCollapsed ? "Expand this file's diff" : "Collapse this file's diff"}
                  >
                    <IconChevron size={13} style={{ transform: selCollapsed ? "none" : "rotate(90deg)" }} />
                  </button>
                )}
                <span className="rv-patch-file" title={selected ?? undefined}>{selected}</span>
                {selFile && changedSince.has(selFile.path) && (
                  <span className="rv-changed-note" title="The diff for this file changed after you marked it viewed">changed since viewed</span>
                )}
                <span className="sp" />
                {selFile && (
                  <label className="rv-viewed" title="Viewed (r): collapses the file; clears itself if the diff changes">
                    <input
                      type="checkbox"
                      checked={selFile.path in viewed}
                      onChange={() => void toggleReviewed(selFile.path)}
                    />
                    Viewed
                  </label>
                )}
                {!selCollapsed && foldRanges.length > 0 && (
                  <button className="rv-tb" onClick={() => { setShowAllFolds((v) => !v); setOpenFolds(new Set()); }} aria-pressed={showAllFolds}>
                    {showAllFolds ? "Fold unchanged" : "Show all"}
                  </button>
                )}
                <span className="rv-hunk-count">{hunkLines.length > 0 ? `hunk ${hunkIdx + 1}/${hunkLines.length}` : ""}</span>
                <button className="rv-ic" onClick={() => jumpHunk(-1)} disabled={hunkLines.length === 0} title="Previous hunk">
                  <IconChevron size={15} style={{ transform: "rotate(-90deg)" }} />
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
                  <IconCopy size={15} />
                </button>
                {/* UX-568: select lines above (unified view), then send them to the pane as a prompt. */}
                <button
                  className="rv-ic"
                  onClick={sendSelectionToAgent}
                  disabled={split || !patch}
                  title={split ? "Switch to unified diff to select lines" : "Select diff lines above, then send them to the agent"}
                >
                  <IconSend size={14} />
                </button>
                {/* UX-569: prompt the pane with its own (capped) patch for this file. */}
                <button className="rv-ic" onClick={explainDiff} disabled={!patch} title="Ask the agent to explain this file's diff">
                  <IconAsk size={15} />
                </button>
                <button className="rv-ic" onClick={() => jumpHunk(1)} disabled={hunkLines.length === 0} title="Next hunk">
                  <IconChevron size={15} style={{ transform: "rotate(90deg)" }} />
                </button>
              </div>
              {/* QL-739: the backend cut this diff short. Say so where the
                  patch is read, not in a toast that's gone by the time you
                  scroll to the bottom, and offer the one thing that recovers
                  the rest — the file itself, opened the same way the file
                  list's per-row action opens it (UI-173). Styled inline
                  because review.css is outside this change's scope; its
                  proper home is a .rv-truncated rule there. */}
              {truncated && selected && !selCollapsed && (
                <div
                  role="status"
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "7px 10px", borderBottom: "1px solid var(--line)",
                    background: "color-mix(in srgb, var(--st-starting) 10%, transparent)",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 600, color: "var(--st-starting)" }}>
                    Diff truncated — file too large to render fully
                  </span>
                  <button
                    className="rv-pr"
                    style={{ fontSize: 11.5, padding: "5px 11px" }}
                    onClick={() => openFileInEditor(selected)}
                    title={`Open ${selected} to read the whole file`}
                  >
                    Open in editor
                  </button>
                </div>
              )}
              {selCollapsed && selFile ? (
                <div className="rv-collapsed" role="status">
                  <div className="rv-collapsed-t">
                    {collapseReason(selFile, isTruncated(selFile.path), selFile.path in viewed, autoLines)}
                    {!selFile.binary && (
                      <span className="rv-file-stat"> <em className="add">+{selFile.added}</em><em className="del">−{selFile.deleted}</em></span>
                    )}
                  </div>
                  <button className="rv-pr" onClick={() => setCollapsed(selFile.path, false)}>Show diff</button>
                </div>
              ) : !patch && patchPath === selected && hideWs ? (
                <div className="rv-empty">No changes in this file other than whitespace.</div>
              ) : split ? (
                <div className="rv-split" ref={patchRef as unknown as React.RefObject<HTMLDivElement>}>
                  {segments.map((seg) => {
                    if (seg.kind === "fold") return foldRow(seg.start, seg.end);
                    const k = seg.i;
                    const r = splitRows[k];
                    // UX-519: same rule as the unified view — only a row that
                    // has a new-side line number has anywhere to jump to.
                    const clickable = r.kind !== "hunk" && r.kind !== "meta" && r.rightNo != null;
                    return (
                      <div
                        key={k}
                        data-line={r.index}
                        className={"rv-srow " + r.kind + (clickable ? " rv-clickable" : "")}
                        onClick={clickable ? () => openAtLine(r.rightNo!) : undefined}
                        title={clickable ? `Open ${selected} at line ${r.rightNo}` : undefined}
                      >
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
                    );
                  })}
                </div>
              ) : (
              <pre className="rv-patch" ref={patchRef}>
                {segments.map((seg) => {
                  if (seg.kind === "fold") return foldRow(seg.start, seg.end);
                  const i = seg.i;
                  const l = lines[i];
                  const cls = lineClass(l);
                  // UX-519/UI-617: aligned old/new gutters, and a click jumps
                  // the file preview to this line — only where the line
                  // actually exists in the current (new) file. A pure
                  // deletion has nothing to jump to, so it stays inert; that
                  // asymmetry is deliberate rather than a gap (see report).
                  const no = patchLineNos[i];
                  const clickable = cls !== "rv-hunk" && cls !== "rv-meta" && no?.newLine != null;
                  return (
                    <span
                      key={i}
                      data-line={i}
                      className={"rv-line " + cls + (clickable ? " rv-clickable" : "")}
                      onClick={clickable ? () => openAtLine(no!.newLine!) : undefined}
                      title={clickable ? `Open ${selected} at line ${no!.newLine}` : undefined}
                    >
                      <span className="rv-gno rv-gno-old">{no?.oldLine ?? ""}</span>
                      <span className="rv-gno rv-gno-new">{no?.newLine ?? ""}</span>
                      <span className="rv-lc">
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
                      </span>
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
                      onClick={() => openConflictFile(pane, f)}
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
                <IconClose size={15} />
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
