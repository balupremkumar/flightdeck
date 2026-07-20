import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type PaneState } from "./store";
import { useUI } from "./ui";
import { IconBell, IconSettings } from "./Icons";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { attentionQueue, forMins, stateSince, STATE_LABEL } from "./attention";
import { timeTitle } from "./format";
import "./Notifications.css";

// All configurable states, approval/waiting/error first since those are the
// ones most likely to be toggled on.
const CONFIGURABLE_STATES: PaneState[] = ["permission", "waiting", "error", "idle", "running", "starting"];

// Short sine chime via WebAudio — no bundled asset, degrades silently if the
// AudioContext API is unavailable (e.g. autoplay-blocked before user gesture).
function playChime() {
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.34);
    osc.onended = () => ctx.close();
  } catch { /* audio unavailable — non-critical, skip */ }
}

// OS toast via the standard web Notification API (no Tauri notification
// plugin is registered in src-tauri; this works inside the webview without
// backend changes). Degrades silently if unsupported or denied.
async function osToast(title: string, body: string) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body });
  } catch { /* no OS notification surface available */ }
}

// Taskbar flash via the Tauri window API. `core:window:allow-request-user-attention`
// isn't in the default capability set, so this throws (permission denied) until
// that's added — caught and skipped, per "degrade gracefully" in the brief.
async function flashTaskbar() {
  try {
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  } catch { /* capability not granted, or not running under Tauri */ }
}

type Panel = "none" | "feed" | "settings";

// Self-contained notification bell: configurable per-state rules, OS toast +
// taskbar flash + sound cue when the window is unfocused, a feed/history,
// and per-workspace mute + do-not-disturb. Mount once: <Notifications />.
export function Notifications() {
  const workspaces = useApp((s) => s.workspaces);
  const switchWorkspace = useApp((s) => s.switchWorkspace);
  const focusPane = useApp((s) => s.focusPane);

  const notify = useUI((s) => s.notify);
  const setNotifyOn = useUI((s) => s.setNotifyOn);
  const setNotifySound = useUI((s) => s.setNotifySound);
  const setNotifyOsToast = useUI((s) => s.setNotifyOsToast);
  const setNotifyDnd = useUI((s) => s.setNotifyDnd);
  const toggleMuteWorkspace = useUI((s) => s.toggleMuteWorkspace);
  const feed = useUI((s) => s.feed);
  // UI-145: a maximised pane means focus mode — alerts stand down, feed keeps recording.
  const focusMode = useUI((s) => s.maximizedPaneId != null);
  const snoozedMap = useUI((s) => s.snoozed);
  const pushNotifyEvent = useUI((s) => s.pushNotifyEvent);
  const clearFeed = useUI((s) => s.clearFeed);

  const [panel, setPanel] = useState<Panel>("none");
  const prevStates = useRef(new Map<number, PaneState>());
  const [, setTick] = useState(0);

  // Re-render on a slow tick while the feed is open so durations stay honest.
  useEffect(() => {
    if (panel !== "feed") return;
    const id = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(id);
  }, [panel]);

  // Esc closes (UI-30) — the menu previously only closed on mouse-leave,
  // which stranded keyboard/touch users.
  useEffect(() => {
    if (panel === "none") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanel("none"); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [panel]);

  // Watch every pane for a state transition into a configured "notify" state.
  useEffect(() => {
    for (const w of workspaces) {
      for (const p of w.panes) {
        const prev = prevStates.current.get(p.id);
        if (prev === p.state) continue;
        prevStates.current.set(p.id, p.state);
        stateSince.set(p.id, Date.now()); // shared with AttentionQueue (attention.ts)
        // Skip the first observation of a pane (mount) — only real transitions notify.
        if (prev === undefined) continue;
        if (!notify.notifyOn[p.state]) continue;

        pushNotifyEvent({ wsId: w.id, wsName: w.name, paneId: p.id, vendor: p.vendor, state: p.state });

        const muted = notify.dnd || notify.mutedWorkspaces.includes(w.id) || focusMode;
        if (muted) continue;
        if (notify.sound) playChime();
        if (notify.osToast && !document.hasFocus()) {
          void osToast(`${w.name} — ${p.vendor}`, `${STATE_LABEL[p.state]}: pane needs you`);
          void flashTaskbar();
        }
      }
    }
    // Prune panes that no longer exist so closed panes don't leak in the map.
    const live = new Set(workspaces.flatMap((w) => w.panes.map((p) => p.id)));
    for (const id of prevStates.current.keys()) if (!live.has(id)) prevStates.current.delete(id);
    for (const id of stateSince.keys()) if (!live.has(id)) stateSince.delete(id);
  }, [workspaces, notify, pushNotifyEvent]);

  // UI-146: when several agents are blocked at once, triage beats one-at-a-time
  // — open the queue. Opt-in, and only on the rising edge so dismissing it
  // doesn't immediately reopen.
  const autoQueue = useUI((s) => s.autoQueue);
  const followAttention = useUI((s) => s.followAttention);
  const prevApprovals = useRef(0);

  // The attention QUEUE (UI-1) — shared ranking in attention.ts.
  const needsAttention = attentionQueue(workspaces, snoozedMap);
  const approvalCount = needsAttention.filter((x) => x.p.state === "permission").length;
  const errCount = needsAttention.filter((x) => x.p.state === "error").length;

  useEffect(() => {
    if (autoQueue && approvalCount >= 3 && prevApprovals.current < 3) {
      useUI.getState().setAttentionOpen(true);
    }
    prevApprovals.current = approvalCount;
  }, [approvalCount, autoQueue]);

  // UI-200: opt-in — jump straight to a pane the moment it asks for approval.
  const lastFollowed = useRef<number | null>(null);
  useEffect(() => {
    if (!followAttention) return;
    const top = needsAttention.find((x) => x.p.state === "permission");
    if (!top || top.p.id === lastFollowed.current) return;
    lastFollowed.current = top.p.id;
    switchWorkspace(top.w.id);
    focusPane(top.w.id, top.p.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAttention, followAttention]);

  // UI-144: collapse consecutive events from the same pane in the same state.
  // A pane that flaps between running and waiting used to bury everything else
  // under near-identical rows.
  const groupedFeed = useMemo(() => {
    const out: (typeof feed[number] & { repeats: number })[] = [];
    for (const e of feed) {
      const last = out[out.length - 1];
      if (last && last.paneId === e.paneId && last.state === e.state) {
        last.repeats++;
        continue;
      }
      out.push({ ...e, repeats: 1 });
    }
    return out;
  }, [feed]);

  const jump = (wsId: number, paneId: number) => {
    switchWorkspace(wsId);
    focusPane(wsId, paneId);
    setPanel("none");
  };

  return (
    <div className="ntf-wrap">
      <button
        className={"ntf-bell" + (needsAttention.length ? " on" : "") + (notify.dnd ? " dnd" : "")}
        onClick={() => setPanel((p) => (p === "none" ? "feed" : "none"))}
        title={notify.dnd ? "Notifications (Do Not Disturb)" : "Notifications"}
        aria-label="Notifications"
      >
        <IconBell size={18} />
        {/* UI-142: approvals and errors are different jobs — one number hid
            which kind was waiting. Errors take the red slot. */}
        {errCount > 0 && <span className="ntf-badge err">{errCount}</span>}
        {approvalCount > 0 && <span className={"ntf-badge warn" + (errCount > 0 ? " second" : "")}>{approvalCount}</span>}
        {errCount === 0 && approvalCount === 0 && needsAttention.length > 0 && (
          <span className="ntf-badge">{needsAttention.length}</span>
        )}
      </button>

      {/* UI-148: the badge is a visual-only signal; announce changes politely
          so a screen-reader user learns an agent needs them. */}
      <span className="sr-only" role="status" aria-live="polite">
        {needsAttention.length === 0
          ? ""
          : `${needsAttention.length} pane${needsAttention.length === 1 ? "" : "s"} need attention` +
            (approvalCount > 0 ? `, ${approvalCount} awaiting approval` : "")}
      </span>

      {panel === "feed" && (
        <div className="ntf-menu" onMouseLeave={() => setPanel("none")} role="menu" aria-label="Notifications">
          <div className="ntf-head">
            <span>Notifications</span>
            <button className="ntf-gear" title="Notification settings" onClick={() => setPanel("settings")}>
              <IconSettings size={13} /> Settings
            </button>
          </div>

          {needsAttention.length > 0 && (
            <div className="ntf-section">
              <div className="ntf-label-row">
                <span className="ntf-label">Needs you now</span>
                <button
                  className="ntf-clear"
                  title="Open the full attention queue (Ctrl+Shift+A)"
                  onClick={() => { setPanel("none"); useUI.getState().setAttentionOpen(true); }}
                >
                  See all
                </button>
              </div>
              {needsAttention.map(({ w, p, since }) => (
                <div className="ntf-item" key={p.id} onClick={() => jump(w.id, p.id)}>
                  <span className={"ntf-dot " + p.state} />
                  <span className="ntf-ws">{w.name}</span>
                  <span className="ntf-ag">{p.title || p.vendor}</span>
                  <span className="ntf-state">
                    {STATE_LABEL[p.state]} · {forMins(since)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="ntf-section">
            <div className="ntf-label-row">
              <span className="ntf-label">Recent</span>
              {feed.length > 0 && <button className="ntf-clear" onClick={clearFeed}>Clear</button>}
            </div>
            {feed.length === 0 && <div className="ntf-empty">No notifications yet — they'll show up here.</div>}
            {groupedFeed.slice(0, 12).map((e) => (
              <div className="ntf-item" key={e.id} onClick={() => jump(e.wsId, e.paneId)} title={timeTitle(e.at)}>
                <span className={"ntf-dot " + e.state} />
                <span className="ntf-ws">{e.wsName}</span>
                <span className="ntf-ag">{e.vendor}</span>
                <span className="ntf-state">
                  {STATE_LABEL[e.state]}
                  {e.repeats > 1 && <em className="ntf-repeat">×{e.repeats}</em>} · {forMins(e.at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {panel === "settings" && (
        <div className="ntf-menu ntf-settings" onMouseLeave={() => setPanel("none")} role="menu" aria-label="Notification settings">
          <div className="ntf-head">
            <span>Notification settings</span>
            <button className="ntf-back" onClick={() => setPanel("feed")}>Back</button>
          </div>

          <div className="ntf-section">
            <div className="ntf-label">Ring the bell on</div>
            {CONFIGURABLE_STATES.map((st) => (
              <label className="ntf-check" key={st}>
                <input type="checkbox" checked={!!notify.notifyOn[st]} onChange={(e) => setNotifyOn(st, e.target.checked)} />
                <span className={"ntf-dot " + st} />
                {STATE_LABEL[st]}
              </label>
            ))}
          </div>

          <div className="ntf-section">
            <div className="ntf-label">Alerts</div>
            <label className="ntf-check">
              <input type="checkbox" checked={notify.osToast} onChange={(e) => setNotifyOsToast(e.target.checked)} />
              OS toast + taskbar flash when unfocused
            </label>
            <label className="ntf-check">
              <input type="checkbox" checked={notify.sound} onChange={(e) => setNotifySound(e.target.checked)} />
              Sound cue
            </label>
            <label className="ntf-check">
              <input type="checkbox" checked={notify.dnd} onChange={(e) => setNotifyDnd(e.target.checked)} />
              Do not disturb (mutes alerts, keeps the feed)
            </label>
            <label className="ntf-check">
              <input type="checkbox" checked={autoQueue} onChange={(e) => useUI.getState().setAutoQueue(e.target.checked)} />
              Open the attention queue when 3+ agents need approval
            </label>
            <label className="ntf-check">
              <input type="checkbox" checked={followAttention} onChange={(e) => useUI.getState().setFollowAttention(e.target.checked)} />
              Jump to a pane as soon as it asks for approval
            </label>
          </div>

          {workspaces.length > 0 && (
            <div className="ntf-section">
              <div className="ntf-label">Muted workspaces</div>
              {workspaces.map((w) => (
                <label className="ntf-check" key={w.id}>
                  <input
                    type="checkbox"
                    checked={notify.mutedWorkspaces.includes(w.id)}
                    onChange={() => toggleMuteWorkspace(w.id)}
                  />
                  {w.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
