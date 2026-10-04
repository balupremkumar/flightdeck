// Bounded in-memory record list: drop oldest past the cap.
import type { ChatRecord } from "../chatlog";

export const MAX_RECORDS = 5000;

export function appendBounded(list: ChatRecord[], incoming: ChatRecord[], cap = MAX_RECORDS): { list: ChatRecord[]; dropped: number } {
  if (incoming.length === 0) return { list, dropped: 0 };
  const merged = list.concat(incoming);
  const dropped = Math.max(0, merged.length - cap);
  return { list: dropped ? merged.slice(dropped) : merged, dropped };
}
