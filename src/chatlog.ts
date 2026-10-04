// Phase 3 chat view: typed wrappers over the chatlog.rs commands, plus the
// offset bookkeeping for incremental tailing. All commands are async on the
// Rust side, so none of this blocks other panes.
import { invoke } from "@tauri-apps/api/core";

export type ChatKind = "user" | "assistant_text" | "tool_use" | "tool_result" | "system" | "other";

export interface ChatTool {
  id: string;
  name: string;
  summary: string;
  paths: string[];
  added: number;
  removed: number;
}

export interface ChatResult {
  tool_use_id: string;
  is_error: boolean;
  summary: string;
}

export interface ChatRecord {
  /** Byte offset of the source JSONL line; pass to sessionRecord. */
  index: number;
  /** Content block within that line (a line can yield several records). */
  block: number;
  uuid: string | null;
  parent_uuid: string | null;
  timestamp: string | null;
  kind: ChatKind;
  sidechain: boolean;
  text: string | null;
  tool: ChatTool | null;
  result: ChatResult | null;
}

export interface TailResult {
  records: ChatRecord[];
  next_offset: number;
  truncated: boolean;
  /** The tail started mid-file because the transcript was too large; older history was not read. */
  skipped_head?: boolean;
}

export interface SessionInfo {
  session_id: string | null;
  pinned: boolean;
  jsonl_path: string | null;
  /** The transcript file was rotated/replaced since the last call: offsets are stale. */
  rotated?: boolean;
}

export const TAIL_MAX_RECORDS = 500;

export function paneSessionInfo(ptyId: number): Promise<SessionInfo> {
  return invoke<SessionInfo>("pane_session_info", { ptyId });
}

export function sessionTail(jsonlPath: string, fromOffset: number, maxRecords = TAIL_MAX_RECORDS): Promise<TailResult> {
  return invoke<TailResult>("session_tail", { jsonlPath, fromOffset, maxRecords });
}

export function sessionRecord(jsonlPath: string, index: number): Promise<unknown> {
  return invoke<unknown>("session_record", { jsonlPath, index });
}

/** TN3: one subagent transcript of a session (src-tauri session_subagents). */
export interface SubagentLink {
  id: string;
  /** The parent's Agent/Task tool_use id, when the sidecar says. */
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  jsonlPath: string;
  edits: number;
  commands: number;
  reads: number;
  searches: number;
  other: number;
  finished: boolean;
  lastActivityMs: number;
}

export function sessionSubagents(jsonlPath: string): Promise<SubagentLink[]> {
  return invoke<SubagentLink[]>("session_subagents", { jsonlPath });
}

export type TailFn = (path: string, from: number, max: number) => Promise<TailResult>;

/**
 * Incremental reader state for one transcript: remembers the next offset and
 * drains `truncated` batches in a loop so callers get everything appended
 * since the last poll in one `poll()`.
 */
export class SessionTailer {
  offset = 0;
  /** Set when any batch since the last `reset()` reported `skipped_head`. */
  skippedHead = false;
  constructor(
    readonly path: string,
    private tail: TailFn = sessionTail,
    private maxBatches = 20,
  ) {}

  async poll(): Promise<ChatRecord[]> {
    const out: ChatRecord[] = [];
    for (let i = 0; i < this.maxBatches; i++) {
      const r = await this.tail(this.path, this.offset, TAIL_MAX_RECORDS);
      out.push(...r.records);
      this.offset = r.next_offset;
      if (r.skipped_head) this.skippedHead = true;
      if (!r.truncated) break;
    }
    return out;
  }

  /** Forget the offset (file rotated); the next poll re-reads from the start. */
  reset(): void {
    this.offset = 0;
    this.skippedHead = false;
  }
}
