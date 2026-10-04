// SF1: OSC 9;4 progress (npm, winget, cargo) means "busy, not waiting". The
// local quiet timer must not flip such a pane to "waiting" just because the
// output went quiet. A stuck "busy" (the tool died without sending a clear)
// expires after OSC_BUSY_TTL_MS so the pane cannot stay busy forever.
export const OSC_BUSY_TTL_MS = 60_000;

export type OscBusy = { at: number } | null;

/** Fold one OSC 9;4 state digit into the tracker: 1-3 busy, 0 and 4 clear. */
export function nextOscBusy(prev: OscBusy, state: number, now: number): OscBusy {
  if (state >= 1 && state <= 3) return { at: now };
  if (state === 0 || state === 4) return null;
  return prev;
}

export function isOscBusy(busy: OscBusy, now: number): boolean {
  return busy !== null && now - busy.at < OSC_BUSY_TTL_MS;
}
