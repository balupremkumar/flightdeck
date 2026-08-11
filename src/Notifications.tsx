import { useEffect, useRef, useState } from "react";
import { useApp, type PaneModel, type PaneState, type Workspace } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { IconBell, IconSettings } from "./Icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, ProgressBarStatus, UserAttentionType } from "@tauri-apps/api/window";
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
import { usePaneProgress, type PaneProgress } from "./Terminal";
import { timeTitle, bytes } from "./format";
import { vendorShort } from "./vendors";
import { useHeavyPanes, useMemoryHealthPoll, type PaneMemory } from "./poll";
import {
  getMemoryCeilingMb,
  MEMORY_CEILING_EVENT,
  HOOKS_CHANGED_EVENT,
  hooksInstalled,
} from "./Settings";
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

// ---------------------------------------------------------------------------
// QL-782: the Windows taskbar progress bar.
//
// Panes report OSC 9;4 progress individually (Terminal.tsx), but the shell
// gives an application ONE progress bar, so several building panes have to be
// folded into a single reading. The rules, in order:
//   · any pane in the error state wins — a red bar is the one thing worth
//     interrupting for, and it carries that pane's own percentage;
//   · otherwise the furthest-along real percentage across reporters. Max, not
//     mean: the bar answers "is anything still going" and an average would
//     crawl backwards every time a new pane started at 0;
//   · otherwise indeterminate, if that's all anyone is reporting;
//   · nobody reporting clears the bar (None), which is also the exit/unmount
//     state — a finished build must not leave a stripe on the taskbar.
// ---------------------------------------------------------------------------
export interface TaskbarProgress { status: ProgressBarStatus; percent: number }

export function aggregateProgress(panes: PaneProgress[]): TaskbarProgress {
  // First error in publish order, deliberately stable: with two failing panes
  // the bar shouldn't flip between their percentages on every update.
  const errored = panes.find((p) => p.state === "error");
  if (errored) return { status: ProgressBarStatus.Error, percent: errored.percent };
  const determinate = panes.filter((p) => p.state === "normal");
  if (determinate.length) {
    return { status: ProgressBarStatus.Normal, percent: Math.max(...determinate.map((p) => p.percent)) };
  }
  if (panes.length) return { status: ProgressBarStatus.Indeterminate, percent: 0 };
  return { status: ProgressBarStatus.None, percent: 0 };
}

/** Push one reading to the shell. Needs `core:window:allow-set-progress-bar`
 *  (src-tauri/capabilities/default.json); like every other taskbar call here it
 *  degrades to nothing rather than throwing where there's no taskbar. */
export async function setTaskbarProgress(p: TaskbarProgress): Promise<void> {
  try {
    await getCurrentWindow().setProgressBar(
      p.status === ProgressBarStatus.None || p.status === ProgressBarStatus.Indeterminate
        ? { status: p.status }
        : { status: p.status, progress: p.percent }
    );
  } catch { /* capability not granted, or not running under Tauri */ }
}

/** A chatty installer emits progress many times a second and each call is an
 *  IPC round-trip plus a shell repaint. 250ms floor = at most 4 updates/sec,
 *  which is smoother than the taskbar animates anyway. */
export const TASKBAR_PROGRESS_MIN_MS = 250;

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

/** QL-742: a pane over the memory ceiling, resolved back to where it lives.
 *  AMBIENT by the 2026-08-01 ruling — a heavy pane is a fact worth seeing, not
 *  an approval, an error or a question, so it is listed here and on the pane
 *  header and touches nothing that rings: no pulse, no chime, no OS toast, no
 *  taskbar count. attention.ts's own ambient tier is derived from pane STATE
 *  (a quiet `waiting` pane) and a heavy pane is usually `running`, so this is
 *  kept as its own list rather than forced through a model it doesn't fit.
 *  Biggest offender first — that's the one to look at. */
export interface HeavyPaneItem { w: Workspace; p: PaneModel; mem: PaneMemory }
export function heavyPaneItems(workspaces: Workspace[], heavy: PaneMemory[]): HeavyPaneItem[] {
  const items: HeavyPaneItem[] = [];
  for (const mem of heavy) {
    for (const w of workspaces) {
      const p = w.panes.find((x) => x.id === mem.paneId);
      // A pane that has closed since the last sample simply drops out.
      if (p) { items.push({ w, p, mem }); break; }
    }
  }
  return items.sort((a, b) => b.mem.memoryMb - a.mem.memoryMb);
}

// ---------------------------------------------------------------------------
// QL-720: hook-driven session state.
//
// Every pane state in Flightdeck is GUESSED from terminal text — a 3s quiet
// timer plus regexes over the last line. Claude Code will simply tell us
// instead, through its own hooks: `Notification` when it needs the user,
// `Stop` when it has finished responding. src-tauri/src/hooks.rs relays those
// to the frontend as `hook://event`; everything below turns one of those into
// a pane state change.
//
// THREE RULES, in order of how easy they are to get wrong:
//
//  1. SAME PATHWAY, NO PARALLEL QUEUE. A hook event ends as a `setPaneState`
//     call and nothing else. It therefore reaches attentionKind() →
//     needsHumanQueue() → the bell exactly like a terminal-derived state does,
//     so there is one ranking, one badge, one feed, and no second notion of
//     "needs you" to keep in sync.
//
//  2. HOOKS WIN, BUT ONLY DOWNWARDS. Where the hook and the terminal heuristic
//     disagree about a Claude pane while hooks are installed, the hook wins:
//     that is the entire point. Re-assertion is deliberately limited to
//     SILENCING a guess (a pane the terminal thinks is asking for approval,
//     which Claude has actually finished with) — never to re-raising one. A
//     stale record can then only ever cost a missed alert, never invent one.
//     Any output after the grace window retires the record entirely and hands
//     the pane back to the heuristic.
//
//  3. IDLE AND STOP NEVER RING (notification ruling, 2026-08-01). A permission
//     hook is a genuine approval and may chime/toast; "Claude is waiting for
//     your input" and "Claude has stopped" are facts, so they update state and
//     the feed and touch nothing that makes a noise.
// ---------------------------------------------------------------------------

/** Emitted by src-tauri/src/hooks.rs for each line the relay appends. Kept in
 *  step with HOOK_EVENT on the Rust side. */
export const HOOK_EVENT = "hook://event";

/** One relayed hook fire. `payload` is Claude Code's own hook stdin JSON,
 *  which is why the field names inside it are snake_case. */
export interface HookEventPayload {
  event?: string;
  ts?: number;
  payload?: {
    cwd?: string;
    session_id?: string;
    message?: string;
    hook_event_name?: string;
  } | null;
}

/** What a hook fire means for the pane it belongs to. */
export type HookKind = "permission" | "idle" | "stop";

/** Where each kind lands in the EXISTING pane-state model (store.ts), which is
 *  what attentionKind() reads:
 *    permission → `permission`, the one kind allowed to ring;
 *    idle       → `waiting`, i.e. ambient unless its last line reads as a
 *                 genuine question — exactly how a quiet pane is treated today;
 *    stop       → `idle`, which attentionKind() scores as null: nothing needs
 *                 you, which is precisely what "Claude finished" means. */
export const HOOK_PANE_STATE: Record<HookKind, PaneState> = {
  permission: "permission",
  idle: "waiting",
  stop: "idle",
};

/** Claude Code sends two shapes of Notification: "Claude needs your permission
 *  to use X" and "Claude is waiting for your input". Anything unrecognised is
 *  treated as idle rather than permission — an unknown notification must not be
 *  able to invent an approval prompt (and so a chime) out of nothing. */
export function classifyHookEvent(e: HookEventPayload | null | undefined): HookKind | null {
  const name = e?.event || e?.payload?.hook_event_name || "";
  if (name === "Stop") return "stop";
  if (name !== "Notification") return null; // SubagentStop, PreToolUse, … aren't ours
  const msg = (e?.payload?.message ?? "").toLowerCase();
  return /permission|approve|approval|allow/.test(msg) ? "permission" : "idle";
}

/** Windows path comparison: case-insensitive, slash-agnostic, no trailing
 *  separator. Claude reports its cwd with the same drive/segments the pane was
 *  spawned with, but not necessarily the same casing or slashes. */
export function normaliseCwd(p: string | undefined | null): string {
  return (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isClaudePane(p: PaneModel): boolean {
  return p.vendor.toLowerCase().includes("claude");
}

/** Resolve a hook's cwd to the ONE Claude pane it can only be.
 *
 *  Ambiguity is answered with null, not a guess: two Claude panes open on the
 *  same folder can't be told apart from the payload (nothing in the pane model
 *  carries Claude's session_id), and marking the wrong one blocked is worse
 *  than falling back to the terminal heuristic for both. */
export function hookTargetPane(
  workspaces: Workspace[],
  cwd: string | undefined | null
): { w: Workspace; p: PaneModel } | null {
  const want = normaliseCwd(cwd);
  if (!want) return null;
  const hits: { w: Workspace; p: PaneModel }[] = [];
  for (const w of workspaces) {
    for (const p of w.panes) {
      if (isClaudePane(p) && normaliseCwd(p.cwd) === want) hits.push({ w, p });
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

export interface HookRecord { kind: HookKind; at: number }

/** How long after a hook fire trailing output is still assumed to belong to
 *  that same turn. Claude prints its last few bytes around the Stop hook, and
 *  that must not count as "the pane started working again". A real new turn is
 *  a user typing, which is seconds away, never inside this window. */
export const HOOK_STALE_GRACE_MS = 1000;

/** Rule 2 above. Given what the terminal heuristic currently claims and the
 *  last thing the hooks said, what should the pane actually be?
 *
 *  `null` = leave it alone. Only the two silencing moves are ever returned:
 *  Claude has stopped, so a "waiting"/"permission" guess is wrong; or Claude
 *  said it is merely idle, so a "permission" guess is wrong. Raising a pane TO
 *  permission happens once, when the hook arrives, and is never re-asserted. */
export function hookOverrideState(state: PaneState, rec: HookRecord | undefined): PaneState | null {
  if (!rec) return null;
  if (rec.kind === "stop" && (state === "permission" || state === "waiting")) return "idle";
  if (rec.kind === "idle" && state === "permission") return "waiting";
  return null;
}

/** Last hook fire per pane, retired as soon as the pane genuinely works again.
 *  Module-level for the same reason `stateSince` is: Notifications is the one
 *  always-mounted surface, so it owns the bookkeeping. */
const hookState = new Map<number, HookRecord>();
/** Panes whose CURRENT state was put there by a non-ringing hook (idle/Stop).
 *  Rule 3: the transition still reaches the feed and the queue, but skips the
 *  pulse/chime/toast block. */
const hookSilent = new Map<number, PaneState>();

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
  const setPaneState = useApp((s) => s.setPaneState);

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

  // QL-720: are Claude's hooks installed? The cached answer is what the last
  // install/uninstall left behind, so the first frame after a restart already
  // behaves correctly; the backend then confirms it (and catches a settings.json
  // the user edited by hand outside Flightdeck). Settings broadcasts on change.
  const [hooksOn, setHooksOn] = useState(hooksInstalled);
  useEffect(() => {
    invoke<{ settingsInstalled: boolean }>("hook_events_status")
      .then((s) => setHooksOn(!!s.settingsInstalled))
      .catch(() => { /* no Tauri backend (browser preview) — keep the cache */ });
    const onChange = (e: Event) => setHooksOn(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(HOOKS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(HOOKS_CHANGED_EVENT, onChange);
  }, []);

  // QL-720: the relay's events, turned into pane state. Read the workspaces
  // through a ref so this subscribes once and still resolves cwds against the
  // live list — re-subscribing on every pane change would drop events.
  const hookWsRef = useRef(workspaces);
  hookWsRef.current = workspaces;
  useEffect(() => {
    if (!hooksOn) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<HookEventPayload>(HOOK_EVENT, (ev) => {
      const kind = classifyHookEvent(ev.payload);
      if (!kind) return;
      const target = hookTargetPane(hookWsRef.current, ev.payload?.payload?.cwd);
      if (!target) return; // unknown or ambiguous folder — heuristic keeps the pane
      const next = HOOK_PANE_STATE[kind];
      hookState.set(target.p.id, { kind, at: Date.now() });
      // Rule 3: idle/Stop update the state silently; a permission hook is
      // allowed to ring, so it must NOT be marked silent.
      if (kind === "permission") hookSilent.delete(target.p.id);
      else hookSilent.set(target.p.id, next);
      if (target.p.state !== next) setPaneState(target.p.id, next);
    })
      .then((un) => { if (cancelled) un(); else stop = un; })
      .catch(() => { /* not running under Tauri */ });
    return () => { cancelled = true; stop?.(); };
  }, [hooksOn, setPaneState]);

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

        // QL-720 rule 2: the terminal heuristic has just moved this pane. If the
        // hooks know better, correct it here — a `setPaneState` that arrives as
        // its own transition on the next pass, so nothing downstream needs to
        // know a hook was involved.
        const rec = hookState.get(p.id);
        if (rec) {
          if (p.state === "running" && Date.now() - rec.at > HOOK_STALE_GRACE_MS) {
            // Real output after the grace window: the turn moved on, so the
            // record is stale and the heuristic is in charge again.
            hookState.delete(p.id);
            hookSilent.delete(p.id);
          } else if (hooksOn) {
            const override = hookOverrideState(p.state, rec);
            if (override) {
              hookSilent.set(p.id, override);
              setPaneState(p.id, override);
              continue;
            }
          }
        }

        if (!notify.notifyOn[p.state]) continue;

        pushNotifyEvent({ wsId: w.id, wsName: w.name, paneId: p.id, vendor: p.vendor, title: p.title, state: p.state });

        // UX-601: the feed above is HISTORY and still records a pane going
        // quiet. Alerts are not history. Everything below this line — pulse,
        // chime, OS toast, taskbar flash — fires only when a human is actually
        // needed, so a pane that merely stopped printing stays silent.
        const kind = attentionKind(p);
        if (!kind) continue;
        // QL-720 rule 3: this state came from an idle/Stop hook, which by the
        // notification ruling is a fact rather than an alert. It has already
        // been recorded in the feed above and it still ranks in the queue; it
        // just never pulses, chimes or toasts.
        if (hookSilent.get(p.id) === p.state) continue;

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
    // QL-720: pane ids are never reused, but a closed pane's hook record would
    // otherwise sit in memory for the rest of the session.
    for (const id of hookState.keys()) if (!live.has(id)) hookState.delete(id);
    for (const id of hookSilent.keys()) if (!live.has(id)) hookSilent.delete(id);
  }, [workspaces, notify, pushNotifyEvent, hooksOn, setPaneState]);

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

  // QL-742: the cockpit's only always-mounted surface, so the app-wide health
  // cycle is driven from here — one pane_health invoke every 30s, none while
  // there are no panes or the window is hidden (poll.ts). The ceiling is read
  // live: Settings broadcasts on change, which re-samples immediately instead
  // of leaving a stale reading for up to 30s.
  const paneCount = workspaces.reduce((n, w) => n + w.panes.length, 0);
  const [memCeiling, setMemCeiling] = useState(getMemoryCeilingMb);
  useEffect(() => {
    const onCeiling = (e: Event) => setMemCeiling((e as CustomEvent<number>).detail);
    window.addEventListener(MEMORY_CEILING_EVENT, onCeiling);
    return () => window.removeEventListener(MEMORY_CEILING_EVENT, onCeiling);
  }, []);
  useMemoryHealthPoll(paneCount, memCeiling);
  const heavy = heavyPaneItems(workspaces, useHeavyPanes());
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

  // QL-782: the same "reach the user when Flightdeck isn't the front window"
  // job, for progress rather than attention. Aggregation rules are above.
  const taskbar = aggregateProgress(usePaneProgress());
  const taskbarSig = `${taskbar.status}:${taskbar.percent}`;
  const taskbarRef = useRef(taskbar);
  taskbarRef.current = taskbar;
  const taskbarSentSig = useRef("");
  const taskbarNextAt = useRef(0);
  useEffect(() => {
    if (taskbarSig === taskbarSentSig.current) return;
    // Send at the earliest allowed moment. A reading that changes again before
    // that moment cancels this timer and re-arms, so the LAST value in a burst
    // is the one that lands and no burst can exceed one send per window.
    const t = setTimeout(() => {
      taskbarSentSig.current = taskbarSig;
      taskbarNextAt.current = Date.now() + TASKBAR_PROGRESS_MIN_MS;
      void setTaskbarProgress(taskbarRef.current);
    }, Math.max(0, taskbarNextAt.current - Date.now()));
    return () => clearTimeout(t);
  }, [taskbarSig]);
  // Leaving the cockpit (window closing, hot reload) must not strand a bar.
  useEffect(() => () => { void setTaskbarProgress({ status: ProgressBarStatus.None, percent: 0 }); }, []);

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
  // QL-742: a heavy pane is ambient context in the tooltip too — stated AFTER
  // "nothing needs you", never instead of it, so the bell keeps meaning
  // "someone is blocked" and nothing else.
  const heavyNote = heavy.length > 0
    ? `${heavy.length} pane${heavy.length === 1 ? "" : "s"} over the memory ceiling`
    : "";
  const restTitle = notify.dnd
    ? "Notifications — Do Not Disturb"
    : needsAttention.length === 0
      ? [
          "Nothing needs you",
          ambient.length > 0 && `${ambient.length} pane${ambient.length === 1 ? "" : "s"} quiet`,
          heavyNote,
        ]
          .filter(Boolean)
          .join(" · ")
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

          {/* QL-742: ambient tier — visible in the queue, silent everywhere
              else. No badge, no chime, no toast; the note says so out loud so
              nobody later "fixes" it into an alert. */}
          {heavy.length > 0 && (
            <div className="ntf-section">
              <div className="ntf-label-row">
                <span className="ntf-label">Heavy on memory</span>
              </div>
              <div className="ntf-note">Nothing to do — worth a look, so it never rings the bell.</div>
              {heavy.map(({ w, p, mem }) => (
                <div
                  className="ntf-item"
                  key={p.id}
                  onClick={() => jump(w.id, p.id)}
                  title={`${bytes(mem.memoryMb * 1024 * 1024)} — over the ${Math.round(mem.memoryWarnMb)} MB ceiling (Settings › Diagnostics). Restarting the pane clears it.`}
                >
                  <span className="ntf-dot waiting" />
                  <span className="ntf-ws">{w.name}</span>
                  <span className="ntf-ag">{p.title || vendorShort(p.vendor)}</span>
                  <span className="ntf-state">{bytes(mem.memoryMb * 1024 * 1024)}</span>
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
