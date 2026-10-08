export const CLAUDE_INSTALL_COMMAND = "irm https://claude.ai/install.ps1 | iex";

/** Explain the missing executable only for Claude's command-not-found output. */
export function missingCliHint(vendor: string, lastLine: string | undefined): string | null {
  return vendor === "claude" && /'?claude'? is not recognized|CommandNotFoundException/i.test(lastLine ?? "")
    ? CLAUDE_INSTALL_COMMAND
    : null;
}
