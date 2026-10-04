// Whether the chat prompt box may write to the PTY. Pure.
import type { PaneState } from "../store";

export type GateReason = "ok" | "permission" | "busy" | "nopty";
export interface PromptGate { canSend: boolean; reason: GateReason; message: string }

export function promptGate(state: PaneState, hasPty: boolean): PromptGate {
  if (state === "permission") {
    return { canSend: false, reason: "permission", message: "Agent is waiting on a prompt, switch to Terminal" };
  }
  if (!hasPty) return { canSend: false, reason: "nopty", message: "Session is not running" };
  if (state === "idle" || state === "waiting") return { canSend: true, reason: "ok", message: "" };
  return { canSend: false, reason: "busy", message: "Agent is working. You can send when it is waiting for input." };
}
