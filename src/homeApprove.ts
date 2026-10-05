// homeApprove.ts: the Approve click's staleness guard, apart from the component so it
// is testable. Approve sends a bare key into a pane, so it must be certain the
// permission prompt it was drawn from is still the one on screen.
import type { PaneModel } from "./store";
import { attentionKind } from "./attention";
import { approveKeyFor } from "./home";
import type { PaneTail } from "./homeTail";

export const APPROVE_STALE = "The prompt changed, so nothing was sent. Check it and approve again.";

export interface ApproveDeps {
  vendor: string;
  /** The tail Approve was drawn from. */
  shown: PaneTail | undefined;
  /** Re-peek the pane (async: this is the gap in which the prompt can change). */
  refresh: () => Promise<PaneTail | null>;
  readPane: () => PaneModel | undefined;
  write: (key: string) => Promise<unknown>;
}

/** Null when the key was sent, else the refusal to show. */
export async function approveGuarded(d: ApproveDeps): Promise<string | null> {
  const stillPermission = () => {
    const pane = d.readPane();
    return !!pane && attentionKind(pane) === "permission";
  };
  const fresh = await d.refresh();
  if (!fresh || !d.shown || fresh.seq !== d.shown.seq || !stillPermission()) return APPROVE_STALE;
  const key = approveKeyFor(d.vendor, fresh.lines);
  if (key === null) return APPROVE_STALE;
  // Last look, with nothing awaited between it and the write.
  if (!stillPermission()) return APPROVE_STALE;
  await d.write(key);
  return null;
}
