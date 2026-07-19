// Review drawer (Tier 0): what did this agent change, and land it. Right-side
// drawer — a new layout primitive next to the centered dialogs in overlays.css.
// Works for any pane in a git repo; isolated (worktree) panes additionally get
// the "Merge back" action targeting their recorded base branch. Diffs include
// untracked files for isolated panes (backend D8).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "./store";
import { useUI } from "./ui";
import { vendorShort } from "./vendors";
import { IconBranch, IconClose, IconChevron, IconDiff, IconMerge, IconRefresh } from "./Icons";
import type { DiffSummary, MergeOutcome } from "./worktrees";
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
  const patchRef = useRef<HTMLPreElement>(null);
  const [hunkIdx, setHunkIdx] = useState(0);

  const pane = hit?.pane ?? null;

  const load = useCallback(async () => {
    if (!pane) return;
    setError(null);
    try {
      const s = await invoke<DiffSummary>("git_diff_summary", { cwd: pane.cwd, base: pane.baseBranch ?? null });
      setSummary(s);
      // Keep the selection if the file is still changed; else pick the first.
      setSelected((sel) => (sel && s.files.some((f) => f.path === sel) ? sel : s.files[0]?.path ?? null));
    } catch (e) {
      setSummary(null);
      setError(String(e));
    }
  }, [pane?.cwd, pane?.baseBranch, pane?.epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (paneId != null) void load(); }, [paneId, load]);

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
        invoke<MergeOutcome>("git_merge_back", { worktreePath: pane.worktreePath })
          .then((m) => {
            if (m.status === "merged") pushToast("success", `Merged ${pane.branch} into ${pane.baseBranch}.`);
            else if (m.status === "nothing-to-merge") pushToast("info", "Nothing to merge — the branch has no new work.");
            else pushToast("error", m.detail || m.status);
            void load();
          })
          .catch((e) => pushToast("error", `Merge failed: ${String(e)}`))
          .finally(() => setMerging(false));
      },
    });
  };

  // Esc closes (matches Settings behavior).
  useEffect(() => {
    if (paneId == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setReviewPane(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

        <div className="rv-foot">
          {pane.worktreePath ? (
            <>
              <span className="rv-foot-note">Merging commits the agent's work and lands it on {pane.baseBranch}.</span>
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
