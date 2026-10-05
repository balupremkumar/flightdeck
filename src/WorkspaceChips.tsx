import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cachedInvoke, usePoll } from "./poll";
import { useUI } from "./ui";
import type { Workspace } from "./store";
import { ciTransition, portLabel, portUrl, prLabel, safePrUrl, type ChecksState, type PortInfo, type PrInfo } from "./chipState";
import "./workspacechips.css";

const PORT_POLL_MS = 10_000;
const PR_POLL_MS = 60_000;
/** Survives workspace switches so a switch never re-fires or drops a CI edge. */
const ciSeen = new Map<string, ChecksState>();

/** Port chips (with kill) and the PR/CI chip for the active workspace. Renders nothing when empty. */
export default function WorkspaceChips({ workspace }: { workspace: Workspace }) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [pr, setPr] = useState<PrInfo | null>(null);
  const paneIds = workspace.panes.map((p) => p.id);
  const idsKey = paneIds.join(",");

  // Mounted only for the visible workspace; usePoll also stands down when the window is hidden.
  usePoll(async () => {
    try { setPorts(await cachedInvoke<PortInfo[]>("workspace_ports", { paneIds }, PORT_POLL_MS - 1000)); } catch { setPorts([]); }
  }, PORT_POLL_MS, [idsKey]);

  usePoll(async () => {
    let next: PrInfo | null = null;
    try { next = await cachedInvoke<PrInfo | null>("pr_status", { cwd: workspace.root }, PR_POLL_MS - 5000); } catch { next = null; }
    setPr(next);
    const toast = ciTransition(ciSeen, `${workspace.root}`, next);
    if (toast) useUI.getState().pushToast(toast.kind, toast.text, toast.url ? { url: toast.url } : undefined);
  }, PR_POLL_MS, [workspace.root]);

  const open = (url: string) => { void openUrl(url).catch(() => { /* best-effort */ }); };
  const kill = (p: PortInfo) => useUI.getState().requestConfirm({
    title: `Stop ${p.processName || "process"} on port ${p.port}?`,
    body: `Ends process ${p.pid} and anything it started. Only processes inside this workspace's panes can be stopped.`,
    confirmLabel: "Stop process",
    danger: true,
    onConfirm: () => {
      invoke("kill_port_process", { paneIds, pid: p.pid })
        .then(() => setPorts((cur) => cur.filter((x) => x.pid !== p.pid)))
        .catch((e) => useUI.getState().pushToast("error", `Could not stop process ${p.pid}`, { detail: String(e) }));
    },
  });

  const prUrl = pr ? safePrUrl(pr.url) : null;
  if (ports.length === 0 && !pr) return null;
  return (
    <div className="ws-chips" aria-label="Workspace ports and pull request">
      {ports.map((p) => (
        <span className="wsc" key={`${p.port}:${p.pid}`}>
          <button className="wsc-main" onClick={() => open(portUrl(p))} title={`Open ${portUrl(p)} (pid ${p.pid})`}>{portLabel(p)}</button>
          <button className="wsc-x" onClick={() => kill(p)} title={`Stop process ${p.pid}`} aria-label={`Stop ${p.processName || "process"} on port ${p.port}`}>×</button>
        </span>
      ))}
      {pr && (
        <button
          className={"wsc wsc-pr " + (pr.state.toUpperCase() === "OPEN" ? pr.checks : "done")}
          disabled={!prUrl}
          onClick={() => prUrl && open(prUrl)}
          title={`${prLabel(pr)}${prUrl ? `\n${prUrl}` : ""}`}
        >
          <span className="wsc-dot" /><span className="wsc-text">{prLabel(pr)}</span>
        </button>
      )}
    </div>
  );
}
