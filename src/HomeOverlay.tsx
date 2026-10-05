// HomeOverlay.tsx: Phase 5 Home. One sheet listing every agent pane in this
// window by computed state (Needs you, Working, Ready to review, Idle, Merged).
// The model lives in home.ts; this file only renders it. An overlay, not a
// route: terminals underneath stay mounted, Escape closes it through the shared
// overlay stack (ui.ts), and the bell and attention queue are untouched.
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./store";
import { useUI, useOverlayEsc } from "./ui";
import { useFocusTrap } from "./useFocusTrap";
import { KIND_LABEL, lastLine, lastOutputAt, stateSince, forMins } from "./attention";
import { useVendors, vendorMeta, vendorShort } from "./vendors";
import { VendorGlyph } from "./VendorGlyph";
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

const NO_DIFF: HomeCtx["diff"] = {};
const NO_PR: HomeCtx["pr"] = {};

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

  // Keep "4m" honest while open; cards are keyed by pane id so a re-sort never moves focus.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [open]);

  const { columns, needsCount } = useMemo(() => {
    const ctx: HomeCtx = {
      now,
      snoozed,
      lastLine,
      stateSince,
      lastOutputAt,
      diff: NO_DIFF,
      pr: NO_PR,
      merged: mergedPanes,
      isAgent: (v) => vendorMeta(v).kind === "agent",
    };
    return buildHome(workspaces, ctx);
    // `vendors` is a dependency so a manifest hot-reload reclassifies shells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, snoozed, now, vendors]);

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
  useFocusTrap(panelRef, open);

  // Land focus on the most urgent card (or the sheet itself when there is none).
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>("[data-pane-id]");
    (first ?? panelRef.current)?.focus();
    // Only on open; later re-sorts must never move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openPane = (c: HomeCard) => {
    setOpen(false);
    const st = useApp.getState();
    st.switchWorkspace(c.wsId);
    st.focusPane(c.wsId, c.paneId);
  };

  const startAgent = () => {
    setOpen(false);
    useApp.getState().startCreate();
  };

  if (!open) return null;

  const others = otherWindowSummaries();

  const renderCard = (c: HomeCard) => {
    const name = c.title || vendorShort(c.vendor);
    const where = c.branch ? `${c.wsName} / ${c.branch}` : c.wsName;
    return (
      <li key={c.paneId}>
        <div
          className={"hm-card" + (c.kind ? " " + c.kind : "") + (c.snoozedUntil ? " snoozed" : "")}
          data-pane-id={c.paneId}
          tabIndex={0}
          onClick={() => openPane(c)}
        >
          <div className="hm-r1">
            <VendorGlyph id={c.vendor} size={16} />
            <span className="hm-name" title={name}>{name}</span>
            <span className="hm-since" title="Time in this state">{forMins(c.since, now)}</span>
          </div>
          <div className="hm-where" title={where}>{where}</div>
          <div className={"hm-act" + (c.activity ? "" : " none")}>{c.activity ?? "No output yet"}</div>
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
    return (
      <section className={"hm-col " + col} key={col} aria-label={`${COLUMN_LABEL[col]}, ${all.length}`}>
        <h2 className="hm-colhead">
          <span>{COLUMN_LABEL[col]}</span>
          <span className="hm-n">{all.length}</span>
        </h2>
        {all.length === 0 ? (
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
      <div className="hm-panel" role="dialog" aria-label="Home" ref={panelRef} tabIndex={-1}>
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

        {others.length > 0 && (
          <div className="hm-foot">
            {others.map((o) => (
              <span key={o.label}>{o.title}: {o.needsYou} need you, {o.working} working</span>
            ))}
            <span className="hm-ro">(read-only)</span>
          </div>
        )}
      </div>
    </div>
  );
}
