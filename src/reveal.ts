// reveal.ts — "Reveal in Explorer" (Phase 1 audit item 1.1). Routes through
// the custom `reveal_in_explorer` Rust command instead of the plugin-opener
// `revealItemInDir`, which silently no-ops on a repeat reveal of the same
// item after its Explorer window was closed (stale shell window cache — see
// src-tauri/src/reveal.rs). Every call site swaps to this so failures surface
// as a toast instead of vanishing.
import { invoke } from "@tauri-apps/api/core";
import { useUI } from "./ui";

export function revealPath(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path }).catch((e) => {
    useUI.getState().pushToast("error", `Couldn't reveal ${path}: ${String(e)}`);
  });
}
