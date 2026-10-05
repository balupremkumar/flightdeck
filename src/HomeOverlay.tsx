// HomeOverlay.tsx: Phase 5 Home. One sheet listing every agent pane in this
// window by computed state (Needs you, Working, Ready to review, Idle, Merged).
// The model lives in home.ts; this file only renders it. An overlay, not a
// route: terminals underneath stay mounted, Escape closes it through the shared
// overlay stack (ui.ts), and the bell and attention queue are untouched.
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { isTypingTarget } from "./isTypingTarget";
import { get as getPaneSession } from "./paneSessions";
import { useFocusTrap } from "./useFocusTrap";
import { KIND_LABEL, lastLine, lastOutputAt, stateSince, forMins } from "./attention";
import { useVendors, vendorMeta, vendorShort } from "./vendors";
import { VendorGlyph } from "./VendorGlyph";
import { prLabel } from "./chipState";
import { buildTargets, useHomePoll, useHomePollStore } from "./homePoll";
import { IconClose, IconHome } from "./Icons";
import {
  buildHome, COLUMN_EMPTY, COLUMN_LABEL, HOME_COLUMNS, mergedPanes, otherWindowSummaries,
  type HomeCard, type HomeColumn, type HomeCtx,
} from "./home";
import "./HomeOverlay.css";

/** Merged caps at five rows until "Show all". */
const MERGED_CAP = 5;
/** The workspace filter appears once there are more cards than this. */
const FILTER_ABOVE = 20;

/** Below this width the five columns become stacked sections (spec section 4). */
const STACK_BELOW_PX = 1100;
/** Stacked sections that fold to a header row; Needs you and Working never do. */
const COLLAPSIBLE: HomeColumn[] = ["review", "idle", "merged"];

function useStacked(): boolean {
  const query = `(max-width: ${STACK_BELOW_PX - 1}px)`;
  const [stacked, setStacked] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setStacked(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return stacked;
}

const snoozeLabel = (until: number, now: number) => `Snoozed ${Math.max(1, Math.ceil((until - now) / 60_000))}m`;

export function HomeOverlay() {
  const open = useUI((s) => s.homeOpen);
  const setOpen = useUI((s) => s.setHomeOpen);
  const workspaces = useApp((s) => s.workspaces);
  const snoozed = useUI((s) => s.snoozed);
  const vendors = useVendors((s) => s.vendors);
  const [now, setNow] = useState(() => Date.now());
  const [wsFilter, setWsFilter] = useState<number | null>(null);
  const [showAllMerged, setShowAllMerged] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const stacked = useStacked();
  // Stacked sections the user has folded or unfolded; absent = the default.
  const [folded, setFolded] = useState<Partial<Record<HomeColumn, boolean>>>({});
  // Dismissing returns focus to where it was; opening a pane (or an outside
  // focus change that closes Home) must not pull it back.
  const restoreRef = useRef(true);

  // Keep "4m" honest while open; cards are keyed by pane id so a re-sort never moves focus.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [open]);

  // Diff stat and PR/CI come from the shared poll store, which only polls while
  // Home is open. undefined = not fetched yet (skeleton), null = none (omitted).
  const diff = useHomePollStore((s) => s.diff);
  const pr = useHomePollStore((s) => s.pr);

  const { columns, needsCount } = useMemo(() => {
    const ctx: HomeCtx = {
      now,
      snoozed,
      lastLine,
      stateSince,
      lastOutputAt,
      diff,
      pr,
      merged: mergedPanes,
      isAgent: (v) => vendorMeta(v).kind === "agent",
    };
    return buildHome(workspaces, ctx);
    // `vendors` is a dependency so a manifest hot-reload reclassifies shells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, snoozed, now, vendors, diff, pr]);

  const columnOf = useMemo(() => {
    const m = new Map<number, HomeColumn>();
    for (const c of HOME_COLUMNS) for (const card of columns[c]) m.set(card.paneId, c);
    return m;
  }, [columns]);
  useHomePoll(open, buildTargets(workspaces, columnOf));

  const total = HOME_COLUMNS.reduce((n, c) => n + columns[c].length, 0);
  const visible = useMemo(() => {
    if (wsFilter === null) return columns;
    const out = { ...columns };
    for (const c of HOME_COLUMNS) out[c] = columns[c].filter((x) => x.wsId === wsFilter);
    return out;
  }, [columns, wsFilter]);
  // A filter pointing at a closed workspace would hide everything: fall back to all.
  useEffect(() => {
    if (wsFilter !== null && !workspaces.some((w) => w.id === wsFilter)) setWsFilter(null);
  }, [workspaces, wsFilter]);

  // Escape closes through the shared stack. Focus restore comes from useFocusTrap
  // (back to whatever had focus before Home opened).
  useOverlayEsc(open, () => setOpen(false), { restoreFocus: false });
  useFocusTrap(panelRef, open, () => restoreRef.current);

  // Home closes itself when the active workspace or its focused pane changes
  // from outside (bell row, summon), so no jump path needs to know about Home.
  useEffect(() => {
    if (!open) return;
    const sig = () => {
      const s = useApp.getState();
      return s.activeId + ":" + (s.workspaces.find((w) => w.id === s.activeId)?.focused ?? "");
    };
    const start = sig();
    return useApp.subscribe(() => {
      if (sig() === start) return;
      restoreRef.current = false;
      useUI.getState().setHomeOpen(false);
    });
  }, [open]);

  // Land focus on the most urgent card (or the sheet itself when there is none).
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>("[data-pane-id]");
    (first ?? panelRef.current)?.focus();
    // Only on open; later re-sorts must never move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openPane = (c: HomeCard) => {
    restoreRef.current = false;
    setOpen(false);
    const st = useApp.getState();
    st.switchWorkspace(c.wsId);
    st.focusPane(c.wsId, c.paneId);
    // A terminal-view pane takes keyboard focus; a chat-view pane leaves it to PaneView.
    const pane = st.workspaces.find((w) => w.id === c.wsId)?.panes.find((p) => p.id === c.paneId);
    if (pane?.view !== "chat") requestAnimationFrame(() => getPaneSession(c.paneId)?.term.focus());
  };

  const isFolded = (col: HomeColumn) =>
    stacked && COLLAPSIBLE.includes(col) && (folded[col] ?? (col === "review" ? visible.review.length === 0 : true));

  // Navigation. Cards are found by pane id in the DOM, so a re-sort never moves
  // focus; the visible order is the reading order (Needs you first).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (isTypingTarget(e.target as Element | null)) return;
      const root = panelRef.current;
      if (!root) return;
      const cards = [...root.querySelectorAll<HTMLElement>("[data-pane-id]")];
      const cur = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-pane-id]") ?? null;
      const at = cur ? cards.indexOf(cur) : -1;
      const go = (el: HTMLElement | undefined) => { if (el) el.focus(); };

      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); go(cards[Math.min(cards.length - 1, at + 1)]); return; }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); go(cards[Math.max(0, at - 1)]); return; }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !stacked && cur) {
        e.preventDefault();
        const cols = [...root.querySelectorAll<HTMLElement>(".hm-col")];
        const ci = cols.indexOf(cur.closest<HTMLElement>(".hm-col")!);
        const row = [...cur.closest(".hm-list")!.querySelectorAll("[data-pane-id]")].indexOf(cur);
        const step = e.key === "ArrowRight" ? 1 : -1;
        for (let i = ci + step; i >= 0 && i < cols.length; i += step) {
          const there = cols[i].querySelectorAll<HTMLElement>("[data-pane-id]");
          if (there.length) { go(there[Math.min(row, there.length - 1)]); break; }
        }
        return;
      }
      if (/^[1-5]$/.test(e.key)) {
        e.preventDefault();
        const col = HOME_COLUMNS[parseInt(e.key, 10) - 1];
        if (isFolded(col)) setFolded((f) => ({ ...f, [col]: false }));
        // After any unfold renders: first card, else the column itself.
        requestAnimationFrame(() => {
          const sec = root.querySelector<HTMLElement>(`.hm-col.${col}`);
          (sec?.querySelector<HTMLElement>("[data-pane-id]") ?? sec)?.focus();
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stacked, folded, visible]);

  const startAgent = () => {
    setOpen(false);
    useApp.getState().startCreate();
  };

  if (!open) return null;

  const others = otherWindowSummaries();

  const renderCard = (c: HomeCard) => {
    const name = c.title || vendorShort(c.vendor);
    const where = c.branch ? `${c.wsName} / ${c.branch}` : c.wsName;
    // Row 3: only what is known. A fixed-size bar holds the place of a value
    // still loading; a fetched "none" omits its part.
    const diffPart = c.diff === undefined
      ? <span className="hm-skel" aria-hidden="true" />
      : c.diff && c.diff.files > 0
        ? <span className="hm-diff"><span className="add">+{c.diff.added}</span> <span className="del">-{c.diff.deleted}</span> {c.diff.files} {c.diff.files === 1 ? "file" : "files"}</span>
        : null;
    const prPart = c.pr === undefined
      ? <span className="hm-skel" aria-hidden="true" />
      : c.pr
        ? <span className={"hm-pr " + (c.pr.state.toUpperCase() === "OPEN" ? c.pr.checks : "done")}>{prLabel(c.pr)}</span>
        : null;
    return (
      <li key={c.paneId}>
        <div
          className={"hm-card" + (c.kind ? " " + c.kind : "") + (c.snoozedUntil ? " snoozed" : "")}
          data-pane-id={c.paneId}
          tabIndex={0}
          onClick={() => openPane(c)}
          onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); openPane(c); } }}
        >
          <div className="hm-r1">
            <VendorGlyph id={c.vendor} size={16} />
            <span className="hm-name" title={name}>{name}</span>
            <span className="hm-since" title="Time in this state">{forMins(c.since, now)}</span>
          </div>
          <div className="hm-where" title={where}>{where}</div>
          <div className={"hm-act" + (c.activity ? "" : " none")}>{c.activity ?? "No output yet"}</div>
          {(diffPart || prPart) && (
            <div className="hm-meta" aria-busy={c.diff === undefined || c.pr === undefined}>{diffPart}{prPart}</div>
          )}
          {(c.kind || c.snoozedUntil) && (
            <div className="hm-tags">
              {c.kind && <span className={"hm-kind " + c.kind}><span className={"ntf-dot " + c.kind} />{KIND_LABEL[c.kind]}</span>}
              {c.snoozedUntil && <span className="hm-snooze">{snoozeLabel(c.snoozedUntil, now)}</span>}
            </div>
          )}
          {c.column === "needs" && (
            <div className="hm-actions">
              <button className="hm-btn" onClick={(e) => { e.stopPropagation(); openPane(c); }}>Open</button>
            </div>
          )}
        </div>
      </li>
    );
  };

  const renderColumn = (col: HomeColumn) => {
    const all = visible[col];
    const cards = col === "merged" && !showAllMerged ? all.slice(0, MERGED_CAP) : all;
    const fold = stacked && COLLAPSIBLE.includes(col);
    const closed = isFolded(col);
    const label = (
      <>
        <span>{COLUMN_LABEL[col]}</span>
        <span className="hm-n">{all.length}</span>
      </>
    );
    return (
      <section className={"hm-col " + col} key={col} tabIndex={-1} aria-label={`${COLUMN_LABEL[col]}, ${all.length}`}>
        <h2 className="hm-colhead">
          {fold ? (
            <button className="hm-fold" aria-expanded={!closed} onClick={() => setFolded((f) => ({ ...f, [col]: !closed }))}>
              <span className="hm-chev" aria-hidden="true">{closed ? "+" : "-"}</span>{label}
            </button>
          ) : label}
        </h2>
        {closed ? null : all.length === 0 ? (
          <p className="hm-colempty">{COLUMN_EMPTY[col]}</p>
        ) : (
          <ul className="hm-list">
            {cards.map(renderCard)}
            {cards.length < all.length && (
              <li>
                <button className="hm-more" onClick={() => setShowAllMerged(true)}>Show all {all.length}</button>
              </li>
            )}
          </ul>
        )}
      </section>
    );
  };

  return (
    <div className="hm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className={"hm-panel" + (stacked ? " stacked" : "")} role="dialog" aria-label="Home" ref={panelRef} tabIndex={-1}>
        <div className="hm-head">
          <IconHome size={16} />
          <span className="hm-title">Home</span>
          {total > FILTER_ABOVE && (
            <select
              className="hm-filter"
              aria-label="Filter by workspace"
              value={wsFilter ?? ""}
              onChange={(e) => setWsFilter(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">All workspaces</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <span className="sp" />
          <span className={"hm-count" + (needsCount > 0 ? " hot" : "")} aria-live="polite">
            {needsCount === 0 ? "Nothing needs you" : `${needsCount} ${needsCount === 1 ? "needs" : "need"} you`}
          </span>
          <button className="rv-ic" onClick={() => setOpen(false)} title="Close (Esc)" aria-label="Close Home"><IconClose size={16} /></button>
        </div>

        {total === 0 ? (
          <div className="hm-empty">
            <strong>No agents running.</strong>
            <span>Agents show up here, grouped by what they need from you.</span>
            <button className="hm-btn primary" onClick={startAgent}>New agent</button>
          </div>
        ) : (
          <div className="hm-body">{HOME_COLUMNS.map(renderColumn)}</div>
        )}

        <div className="hm-foot">
          <span>J/K or arrows move, Enter opens, 1-5 jump to a column, Esc closes</span>
          {others.length > 0 && (
            <span className="hm-others">
              {others.map((o) => (
                <span key={o.label}>{o.title}: {o.needsYou} need you, {o.working} working</span>
              ))}
              <span>(read-only)</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
