import { useEffect, useRef, useState } from "react";
import { useApp, type PaneState } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { IconBell, IconSettings } from "./Icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  ambientQueue,
  attentionKind,
  forMins,
  KIND_HEADING,
  KIND_LABEL,
  lastLine,
  needsHumanQueue,
  stateSince,
  STATE_LABEL,
  type AttentionItem,
  type AttentionKind,
} from "./attention";
import { timeTitle } from "./format";
import { vendorShort } from "./vendors";
import "./Notifications.css";

// All configurable states, approval/waiting/error first since those are the
// ones most likely to be toggled on.
const CONFIGURABLE_STATES: PaneState[] = ["permission", "waiting", "error", "idle", "running", "starting"];

// UX-601: the per-state alert settings predate the needs-you/ambient split, so
// each attention KIND borrows the closest existing key. "waiting" can now only
// ever reach an alert path as a genuine question (plain quiet is gated out
// upstream), which is why its default flipped to on in ui.ts. See HANDOFF
// EDITS — the settings shape wants to become per-kind, and Settings.tsx isn't
// ours to reshape.
const KIND_SETTING_KEY: Record<AttentionKind, PaneState> = {
  permission: "permission",
  error: "error",
  question: "waiting",
};

const KIND_ORDER: AttentionKind[] = ["permission", "error", "question"];

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

// QL-778: the count Windows will actually show. `win.setBadgeCount` used to
// live at this call site and is a documented no-op on Windows — the platform
// wants an overlay ICON on the taskbar button, not a number — so the count
// never left the app. `set_attention_overlay` (src-tauri/src/overlay.rs) draws
// it into a small red disc and hands that to the shell instead. 0 clears the
// overlay, which is the same "nothing needs you" condition the old call had.
export async function setAttentionOverlay(count: number): Promise<void> {
  try {
    await invoke("set_attention_overlay", { count: Math.max(0, Math.trunc(count)) });
  } catch { /* no Tauri backend (browser preview), or no taskbar surface */ }
}

// QL-780: emitted by the global summon chord (Ctrl+Alt+F — see
// src-tauri/src/summon.rs) whenever it brings the window forward, never on the
// dismiss leg. Kept in step with SUMMON_EVENT on the Rust side.
export const SUMMON_EVENT = "app://summon";

/** QL-780: where a summon lands. `needsHumanQueue` is already ranked by
 *  urgency in attention.ts (approvals, then errors, then questions; oldest
 *  first within a kind), so "the neediest pane" is simply its head. Null when
 *  nothing needs a human — summoning then leaves focus exactly where the user
 *  left it, rather than yanking them onto a merely-quiet pane. */
export function summonTarget(queue: AttentionItem[]): AttentionItem | null {
  return queue[0] ?? null;
}

type Panel = "none" | "feed" | "settings";

/** UX-601: one row of the "needs you" list. The old row read
 *  "acme-web · Claude · Waiting · just now", which never said what was being
 *  asked. This one leads with the agent's actual last line (the prompt or the
 *  question), then where it is and how long it has been blocked, with a jump
 *  as the row's primary action and snooze as the quiet secondary.
 *
 *  No inline approve: see the report / HANDOFF EDITS. The response key differs
 *  per prompt shape (numbered menu vs y/n vs bare Enter) and a 120-char tail
 *  isn't enough context to approve a command blind, so the action is "take me
 *  there" rather than a guessed keystroke written into a live terminal. */
function NeedsYouRow({ item, onJump, onSnooze }: { item: AttentionItem; onJump: () => void; onSnooze: () => void }) {
  const { w, p, since, kind } = item;
  const ask = lastLine.get(p.id);
  const where = `${w.name} › ${p.title || vendorShort(p.vendor)}`;
  return (
    <div className={"nq-row " + (kind ?? "")}>
      <button className="nq-main" onClick={onJump} title={`Jump to ${where}`}>
        <span className="nq-meta">
          <span className={"ntf-dot " + (kind ?? "")} />
          <span className="nq-kind">{kind ? KIND_LABEL[kind] : STATE_LABEL[p.state]}</span>
          <span className="nq-where">{where}</span>
          <span className="nq-since">{forMins(since)}</span>
        </span>
        <span className={"nq-ask" + (ask ? "" : " none")}>
          {ask || "No output captured yet — open the pane to see."}
        </span>
      </button>
      <button className="nq-snooze" onClick={onSnooze} title="Snooze for 10 minutes">
        Snooze
      </button>
    </div>
  );
}

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
  const setOsToastOn = useUI((s) => s.setOsToastOn);
  const setNotifyDnd = useUI((s) => s.setNotifyDnd);
  const toggleMuteWorkspace = useUI((s) => s.toggleMuteWorkspace);
  const feed = useUI((s) => s.feed);
  // UI-145: a maximised pane means focus mode — alerts stand down, feed keeps recording.
  const focusMode = useUI((s) => s.maximizedPaneId != null);
  const snoozedMap = useUI((s) => s.snoozed);
  const snoozePane = useUI((s) => s.snoozePane);
  const pushNotifyEvent = useUI((s) => s.pushNotifyEvent);
  const clearFeed = useUI((s) => s.clearFeed);

  const [panel, setPanel] = useState<Panel>("none");
  const prevStates = useRef(new Map<number, PaneState>());
  const [, setTick] = useState(0);
  // Owner feedback: calm the bell — no persistent pulsing. `pulse` goes true
  // for a moment when a NEW notifiable event lands, then the bell sits
  // static (badge counts still carry the at-rest state).
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pulseTimer.current), []);

  // Re-render on a slow tick while the feed is open so durations stay honest.
  useEffect(() => {
    if (panel !== "feed") return;
    const id = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(id);
  }, [panel]);

  // Esc closes (UI-30) — the menu previously only closed on mouse-leave,
  // which stranded keyboard/touch users. UX-542/543: registered into the
  // shared overlay stack (ui.ts) rather than its own window listener, so Esc
  // closes this bell menu ONLY when it's the top-most overlay, and focus
  // returns to the bell button on close.
  useOverlayEsc(panel !== "none", () => setPanel("none"));

  // Owner call 2026-08-01: the dropdown used to close on mouse-leave, which
  // was fine when a row was three words but not now they carry the agent's
  // actual question — drifting a few pixels off the panel mid-read threw it
  // away. Click-to-close instead: mousedown anywhere outside the bell and its
  // panel dismisses it, the same local pattern Board's popovers use.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panel === "none") return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setPanel("none");
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
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

        pushNotifyEvent({ wsId: w.id, wsName: w.name, paneId: p.id, vendor: p.vendor, title: p.title, state: p.state });

        // UX-601: the feed above is HISTORY and still records a pane going
        // quiet. Alerts are not history. Everything below this line — pulse,
        // chime, OS toast, taskbar flash — fires only when a human is actually
        // needed, so a pane that merely stopped printing stays silent.
        const kind = attentionKind(p);
        if (!kind) continue;

        // One-shot pulse on arrival — see the `pulse` state comment above.
        setPulse(true);
        clearTimeout(pulseTimer.current);
        pulseTimer.current = setTimeout(() => setPulse(false), 1100);

        const muted = notify.dnd || notify.mutedWorkspaces.includes(w.id) || focusMode;
        if (muted) continue;
        if (notify.sound) playChime();
        if (notify.osToast && notify.osToastOn[KIND_SETTING_KEY[kind]] && !document.hasFocus()) {
          // The toast carries WHAT is being asked, not just that something is:
          // the pane's last output line, same text the bell dropdown shows.
          const ask = lastLine.get(p.id);
          void osToast(
            `${w.name} — ${p.title || vendorShort(p.vendor)}`,
            ask ? `${KIND_LABEL[kind]}: ${ask}` : KIND_LABEL[kind]
          );
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

  // The attention QUEUE (UI-1) — shared ranking in attention.ts. UX-601: this
  // is now the NARROW list (approval / error / genuine question). A pane that
  // has merely gone quiet is in `ambient` instead and never touches the bell.
  const needsAttention = needsHumanQueue(workspaces, snoozedMap);
  const ambient = ambientQueue(workspaces, snoozedMap);
  const approvalCount = needsAttention.filter((x) => x.kind === "permission").length;
  const errCount = needsAttention.filter((x) => x.kind === "error").length;
  const questionCount = needsAttention.filter((x) => x.kind === "question").length;
  // Gold badge = "someone is asking you something" (approvals + questions);
  // red badge = "something broke". Two numbers, two jobs — no third badge.
  const askCount = approvalCount + questionCount;

  // UI-147: when Flightdeck is behind other windows, the in-app bell is
  // invisible. Windows can show a count on the taskbar icon — that's the whole
  // point of the attention queue reaching you when you're not looking at it.
  // QL-778: routed through the overlay-icon command; setBadgeCount never
  // reached Windows at all. Same call site, same condition.
  useEffect(() => {
    void setAttentionOverlay(needsAttention.length);
  }, [needsAttention.length]);

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
    const top = needsAttention.find((x) => x.kind === "permission");
    if (!top || top.p.id === lastFollowed.current) return;
    lastFollowed.current = top.p.id;
    switchWorkspace(top.w.id);
    focusPane(top.w.id, top.p.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAttention, followAttention]);

  // QL-780: the global summon chord (Ctrl+Alt+F) brings the window forward and
  // emits `app://summon`. Land the user on the pane that needs them most —
  // the same switchWorkspace + focusPane pathway the bell rows, the attention
  // queue, and LeftPanel's open-workspace-and-focus-its-neediest-pane all use.
  // Read through a ref so the listener is registered once and still sees the
  // live queue; re-subscribing on every queue change would drop presses.
  const queueRef = useRef(needsAttention);
  queueRef.current = needsAttention;
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen(SUMMON_EVENT, () => {
      const top = summonTarget(queueRef.current);
      if (!top) return;
      switchWorkspace(top.w.id);
      focusPane(top.w.id, top.p.id);
    })
      .then((un) => { if (cancelled) un(); else stop = un; })
      .catch(() => { /* not running under Tauri */ });
    return () => { cancelled = true; stop?.(); };
  }, [switchWorkspace, focusPane]);

  const jump = (wsId: number, paneId: number) => {
    switchWorkspace(wsId);
    focusPane(wsId, paneId);
    setPanel("none");
  };

  // UX-601: at rest the bell says "all calm" and nothing else — no colour, no
  // badge, no motion. The tooltip carries the same sentence a screen reader
  // hears, so hovering answers "do I need to look?" without opening anything.
  const restTitle = notify.dnd
    ? "Notifications — Do Not Disturb"
    : needsAttention.length === 0
      ? ambient.length > 0
        ? `Nothing needs you · ${ambient.length} pane${ambient.length === 1 ? "" : "s"} quiet`
        : "Nothing needs you"
      : [
          approvalCount > 0 && `${approvalCount} waiting on your approval`,
          errCount > 0 && `${errCount} errored`,
          questionCount > 0 && `${questionCount} asked you something`,
        ]
          .filter(Boolean)
          .join(" · ");

  const jumpRow = (item: AttentionItem) => (
    <NeedsYouRow
      key={item.p.id}
      item={item}
      onJump={() => jump(item.w.id, item.p.id)}
      onSnooze={() => snoozePane(item.p.id, 10 * 60_000)}
    />
  );

  return (
    <div className="ntf-wrap" ref={wrapRef}>
      <button
        className={"ntf-bell" + (needsAttention.length ? " on" : "") + (notify.dnd ? " dnd" : "") + (pulse ? " pulse" : "")}
        onClick={() => setPanel((p) => (p === "none" ? "feed" : "none"))}
        title={restTitle}
        aria-label={`Notifications — ${restTitle}`}
      >
        <IconBell size={19} />
        {/* UI-142/UX-601: two numbers, two jobs — red is "something broke",
            gold is "someone is asking you something" (approvals + questions).
            A quiet pane produces no badge at all. */}
        {errCount > 0 && <span className="ntf-badge err">{errCount}</span>}
        {askCount > 0 && <span className={"ntf-badge warn" + (errCount > 0 ? " second" : "")}>{askCount}</span>}
      </button>

      {/* UI-148: the badge is a visual-only signal; announce changes politely
          so a screen-reader user learns an agent needs them. Silent when
          nothing needs a human — see UX-601. */}
      <span className="sr-only" role="status" aria-live="polite">
        {needsAttention.length === 0 ? "" : restTitle}
      </span>

      {panel === "feed" && (
        <div className="ntf-menu" role="menu" aria-label="Notifications">
          <div className="ntf-head">
            <span>Notifications</span>
            <button className="ntf-gear" title="Notification settings" onClick={() => setPanel("settings")}>
              <IconSettings size={15} /> Settings
            </button>
          </div>

          {/* UX-601: grouped by urgency, not chronology — approvals, then
              errors, then questions. Each row carries what is being asked,
              where, and how long it has been blocked. */}
          <div className="ntf-section">
            <div className="ntf-label-row">
              <span className="ntf-label">Needs you</span>
              {needsAttention.length > 0 && (
                <button
                  className="ntf-clear"
                  title="Open the full attention queue (Ctrl+Shift+A)"
                  onClick={() => { setPanel("none"); useUI.getState().setAttentionOpen(true); }}
                >
                  See all
                </button>
              )}
            </div>

            {needsAttention.length === 0 ? (
              <div className="nq-empty">
                <strong>Nothing needs you right now</strong>
                <span>
                  {ambient.length > 0
                    ? `${ambient.length} pane${ambient.length === 1 ? " is" : "s are"} quiet — that's normal, no action needed.`
                    : "Every agent is working."}
                </span>
                <span className="nq-empty-sub">Approvals, errors and questions show up here.</span>
              </div>
            ) : (
              KIND_ORDER.map((kind) => {
                const rows = needsAttention.filter((x) => x.kind === kind);
                if (rows.length === 0) return null;
                return (
                  <div className="nq-group" key={kind}>
                    <div className={"nq-group-head " + kind}>
                      {KIND_HEADING[kind]} <span className="nq-group-n">{rows.length}</span>
                    </div>
                    {rows.map(jumpRow)}
                  </div>
                );
              })
            )}
          </div>

          <div className="ntf-section">
            <div className="ntf-label-row">
              <span className="ntf-label">Recent</span>
              {feed.length > 0 && <button className="ntf-clear" onClick={clearFeed}>Clear</button>}
            </div>
            {feed.length === 0 && <div className="ntf-empty">No notifications yet — they'll show up here.</div>}
            {/* UI-144: rows already name both workspace AND pane (title over
                vendor, same as "Needs you now" below) — repeats within a few
                minutes collapse in the store (ui.ts pushNotifyEvent) rather
                than stacking new rows. */}
            {feed.slice(0, 12).map((e) => (
              <div className="ntf-item" key={e.id} onClick={() => jump(e.wsId, e.paneId)} title={timeTitle(e.at)}>
                <span className={"ntf-dot " + e.state} />
                <span className="ntf-ws">{e.wsName}</span>
                <span className="ntf-ag">{e.title || vendorShort(e.vendor)}</span>
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
        <div className="ntf-menu ntf-settings" role="menu" aria-label="Notification settings">
          <div className="ntf-head">
            <span>Notification settings</span>
            <button className="ntf-back" onClick={() => setPanel("feed")}>Back</button>
          </div>

          <div className="ntf-section">
            <div className="ntf-label">Record in the feed</div>
            {/* UX-601: these gates control the Recent feed (history). The bell
                itself is not configurable by state any more — by ruling it
                lights only for approvals, errors, and questions. Saying so
                here stops the checkboxes reading as a broken promise. */}
            <div className="ntf-note">The bell only lights for approvals, errors and questions.</div>
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
            {/* Owner feedback + UX-601: per-kind toast gate under the master
                switch. Only the three kinds that can reach a human are listed —
                a pane going quiet can no longer toast at all, so a toggle for
                it would be a lie. */}
            {notify.osToast && (
              <div className="ntf-subgroup">
                {KIND_ORDER.filter((k) => notify.notifyOn[KIND_SETTING_KEY[k]]).map((k) => (
                  <label className="ntf-check ntf-check-sub" key={k}>
                    <input
                      type="checkbox"
                      checked={!!notify.osToastOn[KIND_SETTING_KEY[k]]}
                      onChange={(e) => setOsToastOn(KIND_SETTING_KEY[k], e.target.checked)}
                    />
                    <span className={"ntf-dot " + k} />
                    {KIND_LABEL[k]}
                  </label>
                ))}
              </div>
            )}
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
