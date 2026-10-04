// Phase 3 chat view (C3c): a read-only rendering of the Claude session JSONL
// for one pane. The terminal stays the real input surface; this view only
// writes to the PTY through the small prompt box, and only when the pane is
// idle or waiting (src/chat/gate.ts). Loaded lazily by PaneView.
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { get as getPaneSession } from "./paneSessions";
import { paneSessionInfo, sessionRecord, sessionSubagents, SessionTailer, type ChatRecord, type SessionInfo, type SubagentLink } from "./chatlog";
import { parseMarkdown, isExternalHref, isBlockedHref, isAbsoluteLocalPath } from "./markdown";
import type { BlockNode, InlineNode } from "./markdown";
import { LinkifiedText } from "./LinkifiedText";
import { useUI } from "./ui";
import { getAgentSettings } from "./settingsStore";
import type { PaneState } from "./store";
import { appendBounded } from "./chat/buffer";
import { buildTurns, callKey, changeSummary, foldActivity, itemKey, placeUnlinked, recKey, runningCall, type Activity, type Item, type NormalItem, type ToolCall, type Turn } from "./chat/turns";
import { CHIP_GLYPH, activityIcon, activityLabel, changeLabel, chipIcon, chipLabel, groupLabel, isBareOk, shortPath, subagentLabel, subagentStatus } from "./chat/chips";
import { planFind } from "./chat/find";
import { promptGate } from "./chat/gate";
import { buildPromptPayload } from "./chat/send";
import { canQueuePrompt, drainQueue, queueClearsOn, queuedLabel, queuedTitle } from "./chat/queue";
import { capLines, editPairs, resultText, simpleDiff, toolInput } from "./chat/raw";
import "./chat.css";

const POLL_MS = 1000;
const SUB_POLL_MS = 3000;
const NO_SUBS = new Map<string, SubagentLink>();
const NO_HITS = new Set<string>();
const DIFF_CAP = 40;
const RESULT_CAP = 30;

// ---------------------------------------------------------------------------
// Markdown (prose only): parseMarkdown from markdown.ts, rendered here so
// Preview.tsx stays untouched. Plain text and inline code get clickable paths.
// ---------------------------------------------------------------------------

function openHref(href: string, cwd: string) {
  if (isBlockedHref(href)) return;
  if (isExternalHref(href)) { void openUrl(href).catch(() => { /* best-effort */ }); return; }
  const path = isAbsoluteLocalPath(href) ? href : `${cwd.replace(/[\\/]+$/, "")}\\${href.replace(/\//g, "\\")}`;
  useUI.getState().openPreview(path);
}

function Inline({ nodes, cwd }: { nodes: InlineNode[]; cwd: string }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text": return <LinkifiedText key={i} text={n.text} cwd={cwd} />;
      case "strong": return <strong key={i}><Inline nodes={n.children} cwd={cwd} /></strong>;
      case "em": return <em key={i}><Inline nodes={n.children} cwd={cwd} /></em>;
      case "code": return <code key={i}><LinkifiedText text={n.text} cwd={cwd} /></code>;
      case "link": return (
        <a key={i} href="#" className="lnk" onClick={(e) => { e.preventDefault(); openHref(n.href, cwd); }}>
          <Inline nodes={n.children} cwd={cwd} />
        </a>
      );
      case "image": return <span key={i}>{n.alt}</span>;
    }
  });
}

function Blocks({ blocks, cwd }: { blocks: BlockNode[]; cwd: string }): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "heading": return <p key={i} className="chat-h"><Inline nodes={b.children} cwd={cwd} /></p>;
      case "paragraph": return <p key={i}><Inline nodes={b.children} cwd={cwd} /></p>;
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return <L key={i}>{b.items.map((it, j) => <li key={j}><Inline nodes={it.children} cwd={cwd} /></li>)}</L>;
      }
      case "code": return <pre key={i} className="chat-code"><code>{b.code}</code></pre>;
      case "blockquote": return <blockquote key={i}><Blocks blocks={b.children} cwd={cwd} /></blockquote>;
      case "table": return (
        <div key={i} className="chat-tablewrap">
          <table>
            <thead><tr>{b.header.map((h, j) => <th key={j}><Inline nodes={h} cwd={cwd} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline nodes={c} cwd={cwd} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      case "hr": return <hr key={i} />;
    }
  });
}

const Prose = memo(function Prose({ text, cwd }: { text: string; cwd: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="chat-prose"><Blocks blocks={blocks} cwd={cwd} /></div>;
});

// ---------------------------------------------------------------------------
// Tool call detail: fetched on demand via session_record.
// ---------------------------------------------------------------------------

interface Detail { command: string; pairs: ReturnType<typeof editPairs>; output: string }
const detailCache = new Map<string, Detail>();

async function loadDetail(path: string, call: ToolCall): Promise<Detail> {
  const ck = `${path}|${call.rec.index}|${call.tool.id}`;
  const hit = detailCache.get(ck);
  if (hit) return hit;
  const [callRaw, resRaw] = await Promise.all([
    sessionRecord(path, call.rec.index),
    call.resultRec ? sessionRecord(path, call.resultRec.index) : Promise.resolve(null),
  ]);
  const input = toolInput(callRaw, call.tool.id);
  const d: Detail = {
    command: typeof input?.command === "string" ? input.command : "",
    pairs: editPairs(call.tool.name, input),
    output: resRaw ? resultText(resRaw, call.tool.id) : "",
  };
  detailCache.set(ck, d);
  if (detailCache.size > 60) detailCache.delete(detailCache.keys().next().value as string);
  return d;
}

function Capped({ lines, cap, render }: { lines: string[]; cap: number; render: (l: string, i: number) => ReactNode }) {
  const [all, setAll] = useState(false);
  const { shown, hidden } = capLines(lines, cap, all);
  return (
    <>
      {shown.map(render)}
      {hidden > 0 && <button className="chat-more" onClick={() => setAll(true)}>Show all ({hidden} more lines)</button>}
    </>
  );
}

function CallDetail({ path, call }: { path: string; call: ToolCall }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setErr(null);
    loadDetail(path, call).then((x) => { if (live) setD(x); }, (e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [path, call, nonce]);
  if (err) return <div className="chat-detail err" role="alert">Could not load details. <button className="chat-link" onClick={() => setNonce((n) => n + 1)}>Retry</button></div>;
  if (!d) return <div className="chat-detail dim">Loading details...</div>;
  const diff = d.pairs.flatMap((p) => simpleDiff(p.oldText, p.newText));
  return (
    <div className="chat-detail">
      {d.command && <pre className="chat-cmd">{d.command}</pre>}
      {diff.length > 0 && (
        <pre className="chat-diff">
          <Capped lines={diff.map((l) => l.t + l.s)} cap={DIFF_CAP} render={(l, i) => <div key={i} className={l[0] === "+" ? "add" : "del"}>{l}</div>} />
        </pre>
      )}
      {d.output && (
        <pre className={"chat-out" + (call.result?.is_error ? " err" : "")}>
          <Capped lines={d.output.split("\n")} cap={RESULT_CAP} render={(l, i) => <div key={i}>{l || " "}</div>} />
        </pre>
      )}
      {!d.command && diff.length === 0 && !d.output && <div className="chat-detail dim">No further detail recorded.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

interface Ctx {
  cwd: string;
  path: string | null;
  verbose: boolean;
  open: Set<string>;
  toggle: (k: string) => void;
  hits: Set<string>;
  /** Polling is live (visible and chat selected). */
  active: boolean;
  /** TN3: session_subagents links by the parent Agent/Task tool id. */
  subs: Map<string, SubagentLink>;
}

/** TN3: one line per subagent; expanding tails its own transcript at the same density. */
function SubagentLine({ link, ctx, failed }: { link: SubagentLink; ctx: Ctx; failed?: boolean }) {
  const k = `sa:${link.id}`;
  const open = ctx.open.has(k);
  return (
    <div className="chat-sub" data-ck={k}>
      <button className={"chat-chip sub" + (failed ? " err" : "")} aria-expanded={open} onClick={() => ctx.toggle(k)}>
        <span className="chat-glyph" aria-hidden>{CHIP_GLYPH.agent}</span>
        <span className="chat-chip-text">{subagentLabel(link)}</span>
        {failed && <span className="chat-badge">failed</span>}
        <span className="chat-now">{"·"} {subagentStatus(link, Date.now())}</span>
        <span className="chat-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && <SubagentBody link={link} ctx={ctx} />}
    </div>
  );
}

function SubagentBody({ link, ctx }: { link: SubagentLink; ctx: Ctx }) {
  const [records, setRecords] = useState<ChatRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const tailer = useRef<SessionTailer | null>(null);
  const toggle = useCallback((k: string) => setOpen((p) => {
    const n = new Set(p);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  }), []);

  // Tailed only while this line is expanded (this component is mounted), and
  // only keeps polling while the subagent is unfinished and the chat is live.
  useEffect(() => {
    if (!tailer.current || tailer.current.path !== link.jsonlPath) {
      tailer.current = new SessionTailer(link.jsonlPath);
      setRecords([]); setLoaded(false);
    }
    let live = true;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const recs = await tailer.current!.poll();
        if (!live) return;
        setErr(null); setLoaded(true);
        if (recs.length) setRecords((prev) => appendBounded(prev, recs).list);
      } catch (e) {
        if (live) setErr(String(e));
      } finally {
        busy = false;
      }
    };
    void tick();
    if (link.finished || !ctx.active) return () => { live = false; };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, [link.jsonlPath, link.finished, ctx.active, nonce]);

  // Subagent transcripts mark every line sidechain; here they are the main thread.
  const turns = useMemo(() => buildTurns(records.map((r) => (r.sidechain ? { ...r, sidechain: false } : r))), [records]);
  const sctx: Ctx = useMemo(
    () => ({ ...ctx, path: link.jsonlPath, open, toggle, hits: NO_HITS, subs: NO_SUBS }),
    [ctx, link.jsonlPath, open, toggle],
  );
  return (
    <div className="chat-sub-body">
      {err && <div className="chat-detail err" role="alert">Could not read the subagent. <button className="chat-link" onClick={() => setNonce((n) => n + 1)}>Retry</button></div>}
      {!err && !loaded && <div className="chat-detail dim" role="status">Loading subagent...</div>}
      {!err && loaded && turns.length === 0 && <div className="chat-detail dim">No activity yet</div>}
      {turns.map((t, i) => (
        <SubTurn key={t.key} turn={t} ctx={sctx} live={!link.finished && i === turns.length - 1} />
      ))}
    </div>
  );
}

function SubTurn({ turn, ctx, live }: { turn: Turn; ctx: Ctx; live: boolean }) {
  const items = useMemo(() => (ctx.verbose ? turn.items : foldActivity(turn.items, live)), [turn.items, ctx.verbose, live]);
  return (
    <div className="chat-subturn">
      {turn.prompt && <div className="chat-subprompt">{turn.prompt.text}</div>}
      <Items items={items} ctx={ctx} />
    </div>
  );
}

function CallChip({ call, ctx, nested }: { call: ToolCall; ctx: Ctx; nested?: boolean }) {
  const k = callKey(call);
  const expanded = ctx.open.has(k);
  const failed = !!call.result?.is_error;
  const link = ctx.verbose ? undefined : ctx.subs.get(call.tool.id);
  if (link) {
    return (
      <div className={"chat-call" + (nested ? " nested" : "") + (ctx.hits.has(k) ? " hit" : "")} data-ck={k}>
        <SubagentLine link={link} ctx={ctx} failed={failed} />
      </div>
    );
  }
  return (
    <div className={"chat-call" + (nested ? " nested" : "") + (ctx.hits.has(k) ? " hit" : "")} data-ck={k}>
      <button
        className={"chat-chip" + (failed ? " err" : "")}
        aria-expanded={expanded}
        onClick={() => ctx.toggle(k)}
        title={call.tool.summary}
      >
        <span className="chat-glyph" aria-hidden>{CHIP_GLYPH[chipIcon(call.tool.name)]}</span>
        <span className="chat-chip-text">{chipLabel(call.tool, ctx.cwd)}</span>
        {failed && <span className="chat-badge">failed</span>}
      </button>
      {call.result?.summary && (failed || !expanded || !ctx.path) && (failed || ctx.verbose || !isBareOk(call.result.summary)) && (
        <div className={"chat-result" + (failed ? " err" : "")}>{call.result.summary}</div>
      )}
      {expanded && ctx.path && <CallDetail path={ctx.path} call={call} />}
    </div>
  );
}

function ToolsItem({ item, ctx }: { item: Extract<Item, { kind: "tools" }>; ctx: Ctx }) {
  if (item.calls.length === 1) return <CallChip call={item.calls[0]} ctx={ctx} />;
  const k = itemKey(item);
  const open = ctx.verbose || ctx.open.has(k);
  const anyFailed = item.calls.some((c) => c.result?.is_error);
  return (
    <div className="chat-group" data-ck={k}>
      <button className={"chat-chip" + (anyFailed ? " err" : "")} aria-expanded={open} onClick={() => ctx.toggle(k)}>
        <span className="chat-glyph" aria-hidden>{CHIP_GLYPH[chipIcon(item.name)]}</span>
        <span className="chat-chip-text">{groupLabel(item.name, item.calls, ctx.cwd)}</span>
        {anyFailed && <span className="chat-badge">failed</span>}
        <span className="chat-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && item.calls.map((c) => <CallChip key={callKey(c)} call={c} ctx={ctx} nested />)}
    </div>
  );
}

/** TN2: a whole run of tool steps as one line; click for today's chips. */
function ActivityItem({ item, ctx }: { item: Activity; ctx: Ctx }) {
  const open = ctx.open.has(item.key);
  const failed = item.calls.some((c) => c.result?.is_error);
  const now = runningCall(item);
  const latest = item.narration[item.narration.length - 1];
  return (
    <div className="chat-group chat-activity" data-ck={item.key}>
      <button
        className={"chat-chip" + (failed ? " err" : "")}
        data-running={now ? "1" : undefined}
        aria-expanded={open}
        onClick={() => ctx.toggle(item.key)}
        title={activityLabel(item.calls, item.sideSubagents, ctx.cwd)}
      >
        <span className="chat-glyph" aria-hidden>{CHIP_GLYPH[activityIcon(item.calls, item.sideSubagents)]}</span>
        <span className="chat-chip-text">{activityLabel(item.calls, item.sideSubagents, ctx.cwd)}</span>
        {failed && <span className="chat-badge">failed</span>}
        {now && <span className="chat-now">{"·"} now: {chipLabel(now.tool, ctx.cwd)}</span>}
        {!now && latest && <span className="chat-narr-last" title={latest}>{"·"} {latest}</span>}
        <span className="chat-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="chat-activity-body"><Items items={item.items} ctx={ctx} narr /></div>}
    </div>
  );
}

function Items({ items, ctx, side, narr }: { items: NormalItem[]; ctx: Ctx; side?: boolean; narr?: boolean }) {
  return (
    <>
      {items.map((it) => {
        const k = it.kind === "activity" ? it.key : itemKey(it);
        if (it.kind === "text") {
          const text = it.rec.text ?? "";
          return (
            <div key={k} className={"chat-text" + (narr ? " chat-narr" : "") + (ctx.hits.has(k) ? " hit" : "")} data-ck={k}>
              {side && it.rec.kind === "user" ? <div className="chat-subprompt">{text}</div> : <Prose text={text} cwd={ctx.cwd} />}
            </div>
          );
        }
        if (it.kind === "activity") return <ActivityItem key={it.key} item={it} ctx={ctx} />;
        if (it.kind === "tools") return <ToolsItem key={k} item={it} ctx={ctx} />;
        const open = ctx.verbose || ctx.open.has(k);
        return (
          <div key={k} className="chat-sub" data-ck={k}>
            <button className="chat-chip sub" aria-expanded={open} onClick={() => ctx.toggle(k)}>
              <span className="chat-glyph" aria-hidden>{CHIP_GLYPH.agent}</span>
              <span className="chat-chip-text">Subagent ({it.items.length} step{it.items.length === 1 ? "" : "s"})</span>
              <span className="chat-caret" aria-hidden>{open ? "▾" : "▸"}</span>
            </button>
            {open && <div className="chat-sub-body"><Items items={it.items} ctx={ctx} side /></div>}
          </div>
        );
      })}
    </>
  );
}

const TurnView = memo(function TurnView({ turn, ctx, index, paneId, live, extraSubs }: { turn: Turn; ctx: Ctx; index: number; paneId: number; live: boolean; extraSubs?: SubagentLink[] }) {
  const [filesOpen, setFilesOpen] = useState(false);
  // Normal folds each run of tool steps into one line; Verbose renders the items as built.
  const items = useMemo(() => (ctx.verbose ? turn.items : foldActivity(turn.items, live)), [turn.items, ctx.verbose, live]);
  const change = useMemo(() => changeSummary(turn), [turn]);
  const pk = turn.prompt ? `p:${recKey(turn.prompt)}` : "";
  return (
    <section className="chat-turn" data-turn={index}>
      {turn.prompt && (
        <div className={"chat-user" + (ctx.hits.has(pk) ? " hit" : "")} data-ck={pk}>{turn.prompt.text}</div>
      )}
      <Items items={items} ctx={ctx} />
      {extraSubs?.map((l) => <SubagentLine key={l.id} link={l} ctx={ctx} />)}
      {ctx.verbose && turn.notes.length > 0 && (
        <details className="chat-sysnote">
          <summary>System note{turn.notes.length > 1 ? ` (${turn.notes.length})` : ""}</summary>
          {turn.notes.map((r) => <pre key={recKey(r)}>{r.text}</pre>)}
        </details>
      )}
      {turn.files.length > 0 && (
        <div className="chat-files-wrap">
          <span className="chat-files">
            <button
              className="chat-files-main"
              onClick={() => useUI.getState().setReviewPane(paneId, turn.files[0])}
              title={turn.files.map((f) => shortPath(f, ctx.cwd)).join("\n")}
            >
              {changeLabel(turn.files, change.added, change.removed, ctx.cwd)}
            </button>
            {turn.files.length > 1 && (
              <button
                className="chat-files-caret"
                aria-expanded={filesOpen}
                aria-label={filesOpen ? "Hide changed files" : "Show changed files"}
                onClick={() => setFilesOpen((o) => !o)}
              >
                <span aria-hidden>{filesOpen ? "▾" : "▸"}</span>
              </button>
            )}
          </span>
          {filesOpen && turn.files.length > 1 && (
            <ul className="chat-filelist">
              {turn.files.map((f) => (
                <li key={f}><button className="chat-link" onClick={() => useUI.getState().setReviewPane(paneId, f)}>{shortPath(f, ctx.cwd)}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface ChatViewProps {
  paneId: number;
  cwd: string;
  epoch: number;
  paneState: PaneState;
  /** The pty exited in this epoch (PaneView tracks it; "idle" cannot tell). */
  exited?: boolean;
  onRestart?: () => void;
  /** Visible and chat selected: polling runs only while true. */
  active: boolean;
  onSwitchToTerminal: () => void;
}

export default function ChatView({ paneId, cwd, epoch, paneState, exited, onRestart, active, onSwitchToTerminal }: ChatViewProps) {
  const [records, setRecords] = useState<ReturnType<typeof appendBounded>["list"]>([]);
  const [trimmed, setTrimmed] = useState(false);
  const [skippedHead, setSkippedHead] = useState(false);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [subLinks, setSubLinks] = useState<SubagentLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verbose, setVerbose] = useState(() => getAgentSettings().chatDetail === "verbose");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [sticky, setSticky] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  const [docHidden, setDocHidden] = useState(() => typeof document !== "undefined" && document.hidden);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const tailer = useRef<{ t: SessionTailer; pty: number; pinned: boolean } | null>(null);
  const pinCheck = useRef(0);
  const busy = useRef(false);
  const subPoll = useRef(0);
  const tickRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const f = () => setDocHidden(document.hidden);
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);

  // A restart (epoch bump) means a new pty and usually a new session.
  useEffect(() => {
    tailer.current = null;
    setRecords([]); setTrimmed(false); setSkippedHead(false); setInfo(null); setLoaded(false); setError(null); setOpen(new Set()); setSubLinks([]); subPoll.current = 0;
  }, [epoch, paneId]);

  tickRef.current = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const pty = getPaneSession(paneId)?.ptyId ?? 0;
      if (!pty) return;
      let cur = tailer.current;
      if (cur && cur.pty !== pty) cur = tailer.current = null;
      // Unpinned sessions are re-resolved every tick (the match can change);
      // pinned ones every 5th tick, because /clear starts a new JSONL in the
      // same folder and the backend then reports that newer file.
      pinCheck.current = (pinCheck.current + 1) % 5;
      if (!cur || !cur.pinned || pinCheck.current === 0) {
        const si = await paneSessionInfo(pty);
        if (!si.jsonl_path) { setInfo(si); setError(null); return; }
        if (!cur || cur.t.path !== si.jsonl_path) {
          cur = tailer.current = { t: new SessionTailer(si.jsonl_path), pty, pinned: si.pinned };
          setRecords([]); setTrimmed(false); setSkippedHead(false); setLoaded(false); setSubLinks([]); subPoll.current = 0;
        } else {
          cur.pinned = si.pinned;
          // No reset on si.rotated here: the backend reports rotated for as long as a
          // newer file than the pinned one exists, and it already hands back that newer
          // path, so a real rotation arrives as the path change handled above.
        }
        setInfo(si);
      }
      const recs = await cur.t.poll();
      // TN3: subagent links ride the main tick, at most every SUB_POLL_MS.
      const now = Date.now();
      if (now - subPoll.current >= SUB_POLL_MS) {
        subPoll.current = now;
        const owner = cur;
        sessionSubagents(owner.t.path).then((l) => {
          if (tailer.current !== owner) return;
          setSubLinks((prev) => (JSON.stringify(prev) === JSON.stringify(l) ? prev : l));
        }, () => { /* best-effort: no links means plain Agent chips */ });
      }
      setError(null);
      setLoaded(true);
      if (cur.t.skippedHead) setSkippedHead(true);
      if (recs.length) {
        // H4: each new user record is Claude picking up one queued prompt.
        const picked = recs.filter((r) => r.kind === "user" && !r.sidechain && r.text).length;
        if (picked) setQueued((q) => drainQueue(q, picked));
        setRecords((prev) => {
          const r = appendBounded(prev, recs);
          if (r.dropped) setTrimmed(true);
          return r.list;
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
    }
  };

  const polling = active && !docHidden;
  useEffect(() => {
    if (!polling) return;
    void tickRef.current();
    const id = setInterval(() => void tickRef.current(), POLL_MS);
    return () => clearInterval(id);
  }, [polling, paneId]);

  const turns = useMemo(() => buildTurns(records), [records]);
  const plan = useMemo(() => planFind(turns, findOpen ? query : ""), [turns, findOpen, query]);
  const hits = useMemo(() => new Set(plan.keys), [plan]);
  const openAll = useMemo(() => {
    if (plan.expand.size === 0) return open;
    const s = new Set(open);
    plan.expand.forEach((k) => s.add(k));
    return s;
  }, [open, plan]);
  const toggle = useCallback((k: string) => setOpen((p) => {
    const s = new Set(p);
    if (s.has(k)) s.delete(k); else s.add(k);
    return s;
  }), []);

  const path = tailer.current?.t.path ?? info?.jsonl_path ?? null;
  const subs = useMemo(() => {
    const m = new Map<string, SubagentLink>();
    for (const l of subLinks) if (l.toolUseId) m.set(l.toolUseId, l);
    return m;
  }, [subLinks]);
  // Subagents whose Agent/Task call is not in the loaded records: listed once at the end, never guessed.
  const unlinked = useMemo(() => {
    const ids = new Set<string>();
    for (const r of records) if (r.kind === "tool_use" && r.tool) ids.add(r.tool.id);
    return subLinks.filter((l) => !l.toolUseId || !ids.has(l.toolUseId));
  }, [subLinks, records]);
  // Each one sits in the turn that was running when it started; only the rest get the "Other subagents" list.
  const placed = useMemo(() => placeUnlinked(turns, unlinked), [turns, unlinked]);
  const ctx: Ctx = useMemo(
    () => ({ cwd, path, verbose, open: openAll, toggle, hits, active: polling, subs }),
    [cwd, path, verbose, openAll, toggle, hits, polling, subs],
  );

  // Auto-scroll only when the user is already at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [records, loaded]);

  const updateSticky = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (updateSticky.current) return;
    updateSticky.current = requestAnimationFrame(() => {
      updateSticky.current = 0;
      const nodes = el.querySelectorAll<HTMLElement>("[data-turn]");
      let found: string | null = null;
      for (const n of nodes) {
        if (n.offsetTop - 4 > el.scrollTop) break;
        const idx = Number(n.dataset.turn);
        const t = turns[idx];
        // Only once that turn's own prompt bubble has scrolled out of view.
        found = t?.prompt && el.scrollTop > n.offsetTop + 44 ? t.prompt.text : null;
      }
      setSticky((p) => (p === found ? p : found));
    });
  };
  useEffect(() => () => { if (updateSticky.current) cancelAnimationFrame(updateSticky.current); }, []);

  const jumpLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  };

  // Find: jump to the current match; matches inside collapsed groups are opened by `plan.expand`.
  useEffect(() => { setMatchIdx(0); }, [query]);
  useEffect(() => {
    if (!findOpen || plan.keys.length === 0) return;
    const key = plan.keys[Math.min(matchIdx, plan.keys.length - 1)];
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-ck="${CSS.escape(key)}"]`);
      el?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [findOpen, plan, matchIdx]);

  const stepMatch = (d: 1 | -1) => {
    if (plan.keys.length) setMatchIdx((i) => (i + d + plan.keys.length) % plan.keys.length);
  };

  const openFind = () => { setFindOpen(true); requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); }); };
  const closeFind = () => { setFindOpen(false); setQuery(""); rootRef.current?.focus(); };

  // Take focus off the (still running) terminal while chat is showing, so a
  // stray keypress cannot reach the agent unseen.
  useEffect(() => {
    if (!active) return;
    const ae = document.activeElement as HTMLElement | null;
    // Only this pane's terminal: never steal from a drawer input elsewhere.
    // The terminal is ChatView's sibling inside the same PaneView host element.
    const host = rootRef.current?.parentElement;
    const inTerm = !!ae && !!host && !!ae.closest(".xterm") && host.contains(ae);
    if (inTerm) { ae!.blur(); rootRef.current?.focus({ preventScroll: true }); }
  }, [active]);

  const ptyId = getPaneSession(paneId)?.ptyId ?? 0;
  const gate = promptGate(paneState, ptyId > 0, !!exited);
  const canQueue = canQueuePrompt(paneState, ptyId > 0, !!exited);
  useEffect(() => {
    if (queueClearsOn(paneState, !!exited)) setQueued((q) => (q.length ? [] : q));
  }, [paneState, exited]);
  useEffect(() => { setQueued([]); }, [epoch, paneId]);
  const send = async () => {
    const data = buildPromptPayload(draft);
    if (!data || !(gate.canSend || canQueue)) return;
    setSendErr(null);
    try {
      await invoke("pty_write", { paneId: ptyId, data });
      if (!gate.canSend) setQueued((q) => [...q, draft.trim()]);
      setDraft("");
      jumpLatest();
    } catch (e) {
      setSendErr(`Could not send: ${String(e)}`);
    }
  };

  const noPath = !path;
  return (
    <div
      ref={rootRef}
      className="chat"
      tabIndex={-1}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
          e.preventDefault(); e.stopPropagation(); openFind();
        }
      }}
    >
      <div className="chat-bar">
        <span className="chat-bar-title">Chat</span>
        <span className="sp" />
        <div className="chat-seg" role="group" aria-label="Detail level">
          <button className={!verbose ? "on" : ""} aria-pressed={!verbose} onClick={() => setVerbose(false)}>Normal</button>
          <button className={verbose ? "on" : ""} aria-pressed={verbose} onClick={() => setVerbose(true)}>Verbose</button>
        </div>
        <button className="chat-iconbtn" onClick={() => (findOpen ? closeFind() : openFind())} title="Find in chat (Ctrl+F)" aria-label="Find in chat">Find</button>
      </div>

      {findOpen && (
        <div className="chat-find">
          <input
            ref={findRef}
            value={query}
            placeholder="Find in conversation..."
            aria-label="Find in conversation"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
              e.stopPropagation();
            }}
          />
          <span className="chat-find-count">{query.trim() ? (plan.keys.length ? `${Math.min(matchIdx, plan.keys.length - 1) + 1}/${plan.keys.length}` : "0/0") : ""}</span>
          <button onClick={() => stepMatch(-1)} aria-label="Previous match" title="Previous (Shift+Enter)">{"↑"}</button>
          <button onClick={() => stepMatch(1)} aria-label="Next match" title="Next (Enter)">{"↓"}</button>
          <button onClick={closeFind} aria-label="Close find" title="Close (Esc)">{"✕"}</button>
        </div>
      )}

      {sticky && <div className="chat-sticky" title={sticky}><span>Prompt</span> {sticky}</div>}
      {info && !info.pinned && !!info.jsonl_path && (
        <div className="chat-note" role="status">Matched by folder, may show another pane's session.</div>
      )}
      {error && (
        <div className="chat-note err" role="alert">
          Could not read the session: {error}
          <button className="chat-link" onClick={() => void tickRef.current()}>Retry</button>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {skippedHead && <div className="chat-trim">Older history not loaded</div>}
        {trimmed && <div className="chat-trim">Older history trimmed</div>}
        {noPath && !error && (paneState === "permission" || paneState === "waiting") && (
          // TN1: no session yet and the agent is asking something (e.g. the folder trust prompt): never strand the user here.
          <div className="chat-empty" role="status">
            Claude is asking something in the terminal.
          </div>
        )}
        {noPath && !error && paneState !== "permission" && paneState !== "waiting" && (
          <div className="chat-empty" role="status">Waiting for the session to start</div>
        )}
        {!noPath && !loaded && !error && <div className="chat-empty" role="status">Loading conversation...</div>}
        {!noPath && loaded && turns.length === 0 && <div className="chat-empty" role="status">No messages yet</div>}
        {turns.map((t, i) => (
          <Fragment key={t.key}>
            <TurnView turn={t} ctx={ctx} index={i} paneId={paneId} live={i === turns.length - 1} extraSubs={verbose ? undefined : placed.byTurn.get(i)} />
          </Fragment>
        ))}
        {!verbose && placed.rest.length > 0 && (
          <div className="chat-unlinked">
            {placed.rest.map((l) => <SubagentLine key={l.id} link={l} ctx={ctx} />)}
          </div>
        )}
      </div>

      {!atBottom && turns.length > 0 && (
        <button className="chat-jump" onClick={jumpLatest}>{"↓"} Jump to latest</button>
      )}

      <div className="chat-input">
        {gate.reason === "permission" ? (
          <div className="chat-gate" role="status">
            <span>{gate.message}</span>
            <button onClick={onSwitchToTerminal}>Switch to Terminal</button>
          </div>
        ) : gate.reason === "exited" ? (
          <div className="chat-gate" role="status">
            <span>{gate.message}</span>
            {onRestart && <button onClick={onRestart}>Restart</button>}
          </div>
        ) : (
          <>
            <textarea
              rows={1}
              value={draft}
              disabled={!gate.canSend && !canQueue}
              placeholder={gate.canSend ? "Message the agent (Enter to send, Shift+Enter for a new line)" : canQueue ? "Agent is working. Enter queues this message for when it finishes." : gate.message}
              aria-label="Message the agent"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
                e.stopPropagation();
              }}
            />
            <button onClick={() => void send()} disabled={(!gate.canSend && !canQueue) || !draft.trim()}>{gate.canSend ? "Send" : "Queue"}</button>
          </>
        )}
        {queued.length > 0 && (
          <span className="chat-queued" role="status" title={queuedTitle(queued)} aria-label={`${queuedLabel(queued.length)}: ${queuedTitle(queued)}`}>{queuedLabel(queued.length)}</span>
        )}
        {sendErr && <div className="chat-note err" role="alert">{sendErr}</div>}
      </div>
    </div>
  );
}
