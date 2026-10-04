// Pure helper: turn a prompt-box draft into the bytes written to the PTY.
// The draft is untrusted text (often pasted), so control characters must not
// reach the agent as keypresses, and newlines must not submit early.

const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";

/** Strips C0 controls (except \t and \n) and DEL; normalises CRLF/CR to \n. */
export function sanitizeDraft(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Bracketed-paste the sanitised text, then Enter. Empty after sanitising -> null. */
export function buildPromptPayload(draft: string): string | null {
  const clean = sanitizeDraft(draft).trim();
  if (!clean) return null;
  return BP_START + clean + BP_END + "\r";
}
