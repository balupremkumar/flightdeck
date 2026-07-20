import { useEffect, useRef, useState } from "react";
import { useApp, type PaneState } from "./store";
import { useUI } from "./ui";
import { IconBell, IconSettings } from "./Icons";
import "./Notifications.css";

const STATE_LABEL: Record<PaneState, string> = {
  starting: "Starting",
  running: "Running",
  idle: "Idle",
  waiting: "Waiting",
  permission: "Needs approval",
  error: "Error",
};

// All configurable states, approval/waiting/error first since those are the
// ones most likely to be toggled on.
const CONFIGURABLE_STATES: PaneState[] = ["permission", "waiting", "error", "idle", "running", "starting"];

// Attention-queue rank: an explicit approval prompt outranks everything —
// the agent is blocked purely on the user (UI-2).
const ATTENTION_RANK: Partial<Record<PaneState, number>> = { permission: 0, error: 1, waiting: 2 };

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
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
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
  const pushNotifyEvent = useUI((s) => s.pushNotifyEvent);
  const clearFeed = useUI((s) => s.clearFeed);

  const [panel, setPanel] = useState<Panel>("none");
  const prevStates = useRef(new Map<number, PaneState>());
  // When each pane entered its current state — powers the queue's "waiting 4m"
  // durations and its longest-waiting-first ordering (UI-1).
  const stateSince = useRef(new Map<number, number>());
  const [, setTick] = useState(0);

  // Re-render on a slow tick while the feed is open so durations stay honest.
  useEffect(() => {
    if (panel !== "feed") return;
    const id = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(id);
  }, [panel]);

  // Watch every pane for a state transition into a configured "notify" state.
  useEffect(() => {
    for (const w of workspaces) {
      for (const p of w.panes) {
        const prev = prevStates.current.get(p.id);
        if (prev === p.state) continue;
        prevStates.current.set(p.id, p.state);
        stateSince.current.set(p.id, Date.now());
        // Skip the first observation of a pane (mount) — only real transitions notify.
        if (prev === undefined) continue;
        if (!notify.notifyOn[p.state]) continue;

        pushNotifyEvent({ wsId: w.id, wsName: w.name, paneId: p.id, vendor: p.vendor, state: p.state });

        const muted = notify.dnd || notify.mutedWorkspaces.includes(w.id);
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
    for (const id of stateSince.current.keys()) if (!live.has(id)) stateSince.current.delete(id);
  }, [workspaces, notify, pushNotifyEvent]);

  // The attention QUEUE (UI-1): errors outrank waiting, and within a rank the
  // pane that has needed you longest comes first — a scan order, not a pile.
  const needsAttention = workspaces
    .flatMap((w) =>
      w.panes
        .filter((p) => p.state in ATTENTION_RANK)
        .map((p) => ({ w, p, since: stateSince.current.get(p.id) ?? Date.now() }))
    )
    .sort((a, b) => {
      const ra = ATTENTION_RANK[a.p.state] ?? 9;
      const rb = ATTENTION_RANK[b.p.state] ?? 9;
      return ra === rb ? a.since - b.since : ra - rb;
    });

  const forMins = (since: number) => {
    const m = Math.floor((Date.now() - since) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

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
        {needsAttention.length > 0 && <span className="ntf-badge">{needsAttention.length}</span>}
      </button>

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
              <div className="ntf-label">Needs you now</div>
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
            {feed.slice(0, 12).map((e) => (
              <div className="ntf-item" key={e.id} onClick={() => jump(e.wsId, e.paneId)} title={new Date(e.at).toLocaleString()}>
                <span className={"ntf-dot " + e.state} />
                <span className="ntf-ws">{e.wsName}</span>
                <span className="ntf-ag">{e.vendor}</span>
                <span className="ntf-state">
                  {STATE_LABEL[e.state]} · {forMins(e.at)}
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
